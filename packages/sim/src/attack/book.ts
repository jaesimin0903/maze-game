// Opening book: rollout-based policy improvement over the early information states.
//
// The decisions of the first few moves are made in few information states, and each of them is
// reached by a large share of all games, so they can be settled with far more samples than a
// player could afford at every decision. For every information state with k <= maxK whose
// observation sequence has probability >= minProbability (given the moves that lead to it):
//
//   Q(s, a) = mean over `samples` mazes drawn from the exact posterior of s (conditional
//             Wilson, the book's own generator, seeded by the book seed and the state) of the
//             payout of "take a, then follow expectimax(baseDepth)"; the same mazes serve every
//             action (common random numbers). Cash out is exact: refund(k).
//
// The book overrides the base policy in s only when the best action beats the base policy's
// action by more than `zOverride` standard errors of the paired difference. The book is keyed
// by the information-state key of `infostate.ts` (policy mode), so a book player is a
// deterministic function of that key and the exact DP can evaluate it.

import { fastRng } from '@maze/shared';
import type { Bot } from '../bots/types';
import { BIT, CASH_OUT, FREE, Game, type TierEconomics } from '../engine';
import type { ValueTable } from '../lsm';
import { Posterior, samplePosteriorMaze, WilsonScratch } from '../posterior';
import { chooseChild, ExpectimaxBot } from './bots';
import { InfoStateSolver } from './infostate';

export interface BookOptions {
  baseDepth: number;
  maxK: number;
  minProbability: number;
  samples: number;
  /** Override the base action only when the best action leads it by more than this many standard errors. */
  zOverride: number;
  seed: number;
}

/** One information state of the book: the walked cells and their walls. */
export interface BookState {
  key: string;
  path: number[];
  walls: number[];
  /** Probability of the observations along the path, given its moves. */
  probability: number;
}

export interface BookJob {
  kind: 'attack-book';
  econ: TierEconomics;
  table: ValueTable;
  baseDepth: number;
  samples: number;
  seed: number;
  state: BookState;
}

export interface BookResult {
  key: string;
  k: number;
  probability: number;
  /** Action of the base policy (child index or -1 for cash out). */
  baseAction: number;
  /** Sample mean payout (bps) per action: children 0 .. nc - 1 (NaN when never worth entering), then cash out. */
  means: number[];
  /** Best action by sample mean, its lead over the base action (bps) and the standard error of that lead. */
  bestAction: number;
  lead: number;
  leadSe: number;
  seconds: number;
}

export interface Book {
  options: BookOptions;
  /** key → action to take (child index or -1). Only states where the book overrides the base policy. */
  overrides: Record<string, number>;
  states: BookResult[];
}

const NO_RNG = { nextU32: () => 0, nextBelow: () => 0 };

/** Key of the position of `g` as the book stores it. */
export class BookKeyer {
  private readonly solver: InfoStateSolver;
  private readonly key: Uint32Array;
  private readonly scratch: Game;
  private readonly open: Uint8Array;

  constructor(econ: TierEconomics) {
    this.solver = new InfoStateSolver(econ, null);
    this.key = new Uint32Array(1 + 3 * Math.ceil((econ.w * econ.h) / 32));
    this.scratch = new Game(econ);
    this.open = new Uint8Array(econ.w * econ.h);
  }

  keyOf(g: Game): string {
    // The key depends on the status of the cells only; no wall is copied.
    this.scratch.copyFrom(g);
    this.scratch.open = this.open;
    this.solver.computeKey(this.scratch, true, this.key);
    return Array.from(this.key).join('.');
  }
}

/** Puts `g` on the position of `state`, with `open` holding the walls of its visited cells only. */
export function replayState(g: Game, open: Uint8Array, state: { path: number[]; walls: number[] }): void {
  open.fill(0);
  for (let t = 0; t < state.path.length; t++) open[state.path[t]] = state.walls[t];
  g.begin(open, NO_RNG);
  for (let t = 1; t < state.path.length; t++) {
    let i = 0;
    while (i < g.nc && g.childCell[i] !== state.path[t]) i += 1;
    if (i === g.nc) throw new Error(`book: cell ${state.path[t]} is not a child of the position after ${t - 1} moves`);
    g.advance(i);
  }
}

/**
 * The information states of the book: every decision point with k <= maxK reachable by moving
 * into children that can lead to the exit, whose observations have probability >= minProbability.
 */
export function bookStates(econ: TierEconomics, maxK: number, minProbability: number): BookState[] {
  const cells = econ.w * econ.h;
  const keyer = new BookKeyer(econ);
  const open = new Uint8Array(cells);
  const games: Game[] = [];
  const posts: Posterior[] = [];
  for (let d = 0; d <= maxK + 1; d++) {
    const g = new Game(econ);
    g.open = open;
    games.push(g);
    posts.push(new Posterior(econ.w, econ.h));
  }
  const q = new Float64Array(4);
  const seen = new Set<string>();
  const out: BookState[] = [];
  const visit = (d: number, probability: number): void => {
    const g = games[d];
    const key = keyer.keyOf(g);
    if (!seen.has(key)) {
      seen.add(key);
      const path: number[] = [];
      const walls: number[] = [];
      for (let t = 0; t <= g.k; t++) {
        path.push(g.path[t]);
        walls.push(open[g.path[t]]);
      }
      out.push({ key, path, walls, probability });
    }
    if (d === maxK) return;
    const post = posts[d];
    post.childPosterior(g, q);
    for (let i = 0; i < g.nc; i++) {
      const child = g.childCell[i];
      if (child === g.exit || !(q[i] > 0)) continue;
      const r = post.prepareChild(g, child);
      const dirs: number[] = [];
      for (let dir = 0; dir < 4; dir++) {
        const u = g.nbr[child * 4 + dir];
        if (u >= 0 && g.status[u] === FREE) dirs.push(dir);
      }
      const probs: number[] = [0];
      for (let mask = 1; mask < 1 << r; mask++) probs.push(post.pattern(mask));
      for (let mask = 1; mask < 1 << r; mask++) {
        const p = probability * probs[mask];
        if (!(p >= minProbability)) continue;
        let bits = g.back[child];
        for (let a = 0; a < r; a++) if ((mask >> a) & 1) bits |= BIT[dirs[a]];
        const next = games[d + 1];
        next.copyFrom(g);
        next.open = open;
        open[child] = bits;
        next.advance(i);
        if (next.cell !== next.exit && next.nc > 0) visit(d + 1, p);
      }
    }
  };
  for (const east of [true, false]) {
    const g = games[0];
    open.fill(0);
    open[0] = east ? BIT[1] : BIT[2];
    g.begin(open, NO_RNG);
    // Each start direction is half of all games.
    visit(0, 0.5);
  }
  return out;
}

function hashString(text: string): bigint {
  let a = 0x811c9dc5 | 0;
  let b = 0x9e3779b9 | 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b + c, 0x85ebca6b);
    b ^= b >>> 13;
  }
  return (BigInt(a >>> 0) << 32n) | BigInt(b >>> 0);
}

/** Settles one book state by rollouts. */
export function runBookJob(job: BookJob): BookResult {
  const started = Date.now();
  const { econ, state } = job;
  const cells = econ.w * econ.h;
  const g = new Game(econ);
  const open = new Uint8Array(cells);
  replayState(g, open, state);
  const base = new ExpectimaxBot(g, job.table, job.baseDepth);
  const baseValue = new Float64Array(4);
  base.search.evaluate(g, baseValue);
  const baseAction = chooseChild(g, baseValue, base.search.rootQ);

  const inner = new Game(econ);
  const innerBot = new ExpectimaxBot(inner, job.table, job.baseDepth);
  const wilson = new WilsonScratch(cells);
  const sampled = new Uint8Array(cells);
  const rng = fastRng(hashString(`${job.seed}|${state.key}`));
  const nc = g.nc;
  const cash = g.refund[g.k];
  const actions = nc + 1;
  const sum = new Float64Array(actions);
  const prod = new Float64Array(actions * actions);
  const payoff = new Float64Array(actions);
  const live: number[] = [];
  for (let i = 0; i < nc; i++) if (baseValue[i] >= 0) live.push(i);

  for (let s = 0; s < job.samples; s++) {
    samplePosteriorMaze(g, rng, wilson, sampled);
    for (const i of live) {
      inner.copyFrom(g);
      inner.open = sampled;
      inner.advance(i);
      let value = 0;
      if (inner.cell === inner.exit) value = inner.multiplierBps;
      else if (inner.nc > 0) {
        for (;;) {
          const action = innerBot.decide(inner);
          if (action === CASH_OUT) {
            value = inner.refund[inner.k];
            break;
          }
          inner.advance(action);
          if (inner.cell === inner.exit) {
            value = inner.multiplierBps;
            break;
          }
          if (inner.nc === 0) break;
        }
      }
      payoff[i] = value;
    }
    payoff[nc] = cash;
    for (let a = 0; a < actions; a++) {
      sum[a] += payoff[a];
      for (let b = 0; b < actions; b++) prod[a * actions + b] += payoff[a] * payoff[b];
    }
  }
  const n = job.samples;
  const slot = (action: number): number => (action === CASH_OUT ? nc : action);
  let best = nc;
  for (const i of live) if (sum[i] > sum[best]) best = i;
  const b0 = slot(baseAction);
  const lead = (sum[best] - sum[b0]) / n;
  const sumSqD = prod[best * actions + best] - 2 * prod[best * actions + b0] + prod[b0 * actions + b0];
  const varD = n > 1 ? Math.max(0, (sumSqD - n * lead * lead) / (n - 1)) : 0;
  const means: number[] = [];
  for (let a = 0; a < actions; a++) means.push(a < nc && baseValue[a] < 0 ? Number.NaN : sum[a] / n);
  return {
    key: state.key,
    k: g.k,
    probability: state.probability,
    baseAction,
    means,
    bestAction: best === nc ? CASH_OUT : best,
    lead,
    leadSe: Math.sqrt(varD / n),
    seconds: (Date.now() - started) / 1000,
  };
}

/** The book from settled states: overrides where the lead is significant. */
export function bookOf(options: BookOptions, states: BookResult[]): Book {
  const overrides: Record<string, number> = {};
  for (const s of states) {
    if (s.bestAction !== s.baseAction && s.lead > options.zOverride * s.leadSe) overrides[s.key] = s.bestAction;
  }
  return { options, overrides, states };
}

/** expectimax(baseDepth) that follows the book where it overrides. */
export class BookBot implements Bot {
  private readonly base: ExpectimaxBot;
  private readonly keyer: BookKeyer;

  constructor(
    g: Game,
    table: ValueTable,
    private readonly book: Pick<Book, 'options' | 'overrides'>,
  ) {
    this.base = new ExpectimaxBot(g, table, book.options.baseDepth);
    this.keyer = new BookKeyer({ w: g.w, h: g.h, multiplierBps: g.multiplierBps, refundBps: Array.from(g.refund) });
  }

  begin(): void {}

  decide(g: Game): number {
    if (g.k <= this.book.options.maxK) {
      const action = this.book.overrides[this.keyer.keyOf(g)];
      if (action !== undefined) return action;
    }
    return this.base.decide(g);
  }
}
