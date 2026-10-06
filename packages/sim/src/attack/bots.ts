// Attack-lane players: stronger searches built on the certified value-lsm table.
//
// Every player here is legal: it reads the walls of visited cells only (through `Game.status`,
// the children of the current cell, and `open` at visited cells) and draws no number from the
// game's generator. The search players copy the position into their own scratch games whose
// maze array holds nothing but the walls of the visited cells, so a branch of the search can
// never see an unobserved wall.
//
//   expectimax(d)  exact expectimax over moves and observation patterns, d moves deep, with
//                  value-lsm's afterstate table A[k][q][d] at the horizon:
//                    V(s, 0) = max(refund(k), max_c A[k+1][q_c][d_c])
//                    V(s, r) = max(refund(k), max_c Q(s, c, r)),  Q(s, c, r) = Σ_m P(m) V(s'_m, r - 1)
//                  depth 1 is value-lookahead-all; children with q = 0 (no exit below them) are
//                  never entered. A pure function of the information state.
//   rollout        one step of policy improvement over expectimax(base): at a decision where
//                  the base's best and second-best actions are within `margin` of each other,
//                  draws mazes from the exact posterior with the player's own generator (seeded
//                  per game), plays each contested action followed by the base policy on the
//                  same mazes (common random numbers), and takes the best mean. Sampling stops
//                  early once the leader is ahead by 3 standard errors of the paired difference.
//   param(θ)       expectimax(1) whose child scores and cash-out rule are shifted by a linear
//                  function of features (θ = 0 is expectimax(1)); θ is searched by CMA-ES.

import { fastRng, type Rng } from '@maze/shared';
import { Q_TIE } from '../bots/harmonic';
import { Region } from '../bots/region';
import type { Bot } from '../bots/types';
import { BIT, CASH_OUT, FREE, Game, type TierEconomics } from '../engine';
import { lookup, type ValueTable } from '../lsm';
import { Posterior, samplePosteriorMaze, WilsonScratch } from '../posterior';

/** Values closer than this fraction of the multiplier are equal. */
const VALUE_TIE = 1e-9;

function econOf(g: Game): TierEconomics {
  return { w: g.w, h: g.h, multiplierBps: g.multiplierBps, refundBps: Array.from(g.refund) };
}

/**
 * Expectimax search over information states. `evaluate(g, out)` writes Q(s, c) of every child of
 * the real position `g` into `out` (bps; -1 for a child that is never worth entering).
 */
export class ExpectimaxSearch {
  private readonly games: Game[];
  private readonly posts: Posterior[];
  private readonly qs: Float64Array[];
  private readonly dirs: Int32Array[];
  private readonly probs: Float64Array[];
  private readonly pq: Float64Array[];
  /** The search's only maze array: the walls of the visited cells of the position and of the branch. */
  readonly open: Uint8Array;
  /** Posterior of the children of the last evaluated position. */
  readonly rootQ: Float64Array;
  /** Positions factorised by the last `evaluate`. */
  nodes = 0;

  constructor(
    g: Game,
    private readonly table: ValueTable,
    readonly depth: number,
  ) {
    if (!Number.isInteger(depth) || depth < 0 || depth > 8) throw new RangeError(`expectimax: depth must be 0 .. 8, got ${depth}`);
    if (table.cells !== g.cells || table.shortest !== g.shortest) throw new RangeError('expectimax: the table was trained for a different grid');
    const econ = econOf(g);
    this.open = new Uint8Array(g.cells);
    this.games = [];
    this.posts = [];
    this.qs = [];
    this.dirs = [];
    this.probs = [];
    this.pq = [];
    for (let t = 0; t <= depth + 1; t++) {
      const game = new Game(econ);
      game.open = this.open;
      this.games.push(game);
      this.posts.push(new Posterior(g.w, g.h));
      this.qs.push(new Float64Array(4));
      this.dirs.push(new Int32Array(4));
      this.probs.push(new Float64Array(16));
      this.pq.push(new Float64Array(16 * 3));
    }
    this.rootQ = this.qs[0];
  }

  /** Copies the position of `g` into scratch game 0, keeping only the walls of visited cells. */
  private load(g: Game): void {
    const s = this.games[0];
    s.copyFrom(g);
    s.open = this.open;
    this.open.fill(0);
    for (let t = 0; t <= g.k; t++) this.open[g.path[t]] = g.open[g.path[t]];
  }

  evaluate(g: Game, out: Float64Array): void {
    this.nodes = 0;
    this.load(g);
    const s = this.games[0];
    const q = this.qs[0];
    this.posts[0].childPosterior(s, q);
    this.nodes += 1;
    const m = s.multiplierBps;
    for (let i = 0; i < s.nc; i++) {
      const child = s.childCell[i];
      if (child === s.exit) out[i] = m;
      else if (!(q[i] > 0)) out[i] = -1;
      else if (this.depth === 0) out[i] = lookup(this.table, s.k + 1, q[i], s.dist[child], 0, m);
      else out[i] = this.childQ(0, i, this.depth);
    }
  }

  /** V(games[t], r): factorises games[t]. */
  private stateValue(t: number, r: number): number {
    const s = this.games[t];
    const q = this.qs[t];
    this.posts[t].childPosterior(s, q);
    this.nodes += 1;
    const m = s.multiplierBps;
    let best = s.refund[s.k];
    for (let i = 0; i < s.nc; i++) {
      const child = s.childCell[i];
      if (child === s.exit) return m;
      if (!(q[i] > 0)) continue;
      const v = r === 0 ? lookup(this.table, s.k + 1, q[i], s.dist[child], 0, m) : this.childQ(t, i, r);
      if (v > best) best = v;
    }
    return best;
  }

  /** Q(games[t], child i, r) for r >= 1; requires posts[t] factorised for games[t]. */
  private childQ(t: number, i: number, r: number): number {
    const s = this.games[t];
    const child = s.childCell[i];
    const m = s.multiplierBps;
    if (child === s.exit) return m;
    const post = this.posts[t];
    const n = post.prepareChild(s, child);
    const dirs = this.dirs[t];
    let found = 0;
    for (let dir = 0; dir < 4; dir++) {
      const u = s.nbr[child * 4 + dir];
      if (u >= 0 && s.status[u] === FREE) dirs[found++] = dir;
    }
    const probs = this.probs[t];
    const pq = this.pq[t];
    for (let mask = 1; mask < 1 << n; mask++) {
      probs[mask] = post.pattern(mask);
      for (let a = 0; a < n; a++) pq[mask * 3 + a] = post.patternQ[a];
    }
    const k1 = s.k + 1;
    const refundNext = s.refund[k1];
    let total = 0;
    for (let mask = 1; mask < 1 << n; mask++) {
      const p = probs[mask];
      if (p === 0) continue;
      let v: number;
      if (r === 1) {
        // Horizon: the opened neighbours are the next position's children, with posterior patternQ.
        v = refundNext;
        for (let a = 0; a < n; a++) {
          if (((mask >> a) & 1) === 0) continue;
          const next = post.patternCell[a];
          const qa = pq[mask * 3 + a];
          const value = next === s.exit ? m : qa > 0 ? lookup(this.table, k1 + 1, qa, s.dist[next], 0, m) : 0;
          if (value > v) v = value;
        }
      } else {
        let bits = s.back[child];
        for (let a = 0; a < n; a++) if ((mask >> a) & 1) bits |= BIT[dirs[a]];
        const next = this.games[t + 1];
        next.copyFrom(s);
        next.open = this.open;
        this.open[child] = bits;
        next.advance(i);
        v = this.stateValue(t + 1, r - 1);
      }
      total += p * v;
    }
    return total;
  }
}

/** Index of the best child by `value` (ties: larger q, smaller distance, earlier direction), or CASH_OUT. */
export function chooseChild(g: Game, value: Float64Array, q: Float64Array): number {
  const tolerance = VALUE_TIE * g.multiplierBps;
  let best = -1;
  for (let i = 0; i < g.nc; i++) {
    if (value[i] < 0) continue;
    if (best === -1) {
      best = i;
      continue;
    }
    const dv = value[i] - value[best];
    if (dv > tolerance) best = i;
    else if (dv >= -tolerance) {
      const dq = q[i] - q[best];
      if (dq > Q_TIE || (dq >= -Q_TIE && g.dist[g.childCell[i]] < g.dist[g.childCell[best]])) best = i;
    }
  }
  if (best === -1 || value[best] < g.refund[g.k]) return CASH_OUT;
  return best;
}

/** Selective deepening: search `shallow` moves deep everywhere, and the full depth only where it matters. */
export interface Deepening {
  shallow: number;
  /** The full search runs when an action other than the best is within this fraction of the bet of it. */
  margin: number;
}

/** True when the second-best action (cash out included) is within `margin` bps of the best. */
function contested(g: Game, value: Float64Array, marginBps: number): boolean {
  let first = g.refund[g.k];
  let second = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < g.nc; i++) {
    const v = value[i];
    if (v < 0) continue;
    if (v > first) {
      second = first;
      first = v;
    } else if (v > second) second = v;
  }
  return first - second <= marginBps;
}

/**
 * Opening search: at decisions with k <= maxK, search `depth` moves deep instead. The early
 * information states are few and recur in many games, so each one's decision is computed once
 * and kept, keyed by `key(g)` (the information-state key: the decision is a function of it).
 */
export interface Opening {
  maxK: number;
  depth: number;
}

export class ExpectimaxBot implements Bot {
  readonly search: ExpectimaxSearch;
  private readonly shallow: ExpectimaxSearch | null;
  private readonly marginBps: number;
  private readonly opening: ExpectimaxSearch | null;
  private readonly openingMaxK: number;
  private readonly openingCache = new Map<string, number>();
  private readonly value = new Float64Array(4);
  /** Decisions, and decisions that ran the full-depth search. */
  decisions = 0;
  deepened = 0;

  constructor(
    g: Game,
    table: ValueTable,
    depth: number,
    deepening: Deepening | null = null,
    opening: Opening | null = null,
    private readonly key: ((g: Game) => string) | null = null,
  ) {
    this.search = new ExpectimaxSearch(g, table, depth);
    if (deepening !== null && !(deepening.shallow < depth && deepening.margin >= 0)) {
      throw new RangeError('expectimax: selective deepening needs shallow < depth and margin >= 0');
    }
    if (opening !== null && (key === null || !(opening.depth > depth && opening.maxK >= 0))) {
      throw new RangeError('expectimax: an opening needs a state key, a depth above the main depth and maxK >= 0');
    }
    this.shallow = deepening === null ? null : new ExpectimaxSearch(g, table, deepening.shallow);
    this.marginBps = deepening === null ? 0 : deepening.margin * 10_000;
    this.opening = opening === null ? null : new ExpectimaxSearch(g, table, opening.depth);
    this.openingMaxK = opening === null ? -1 : opening.maxK;
  }

  begin(): void {}

  decide(g: Game): number {
    this.decisions += 1;
    if (this.opening !== null && g.k <= this.openingMaxK) {
      const id = this.key!(g);
      const known = this.openingCache.get(id);
      if (known !== undefined) return known;
      this.opening.evaluate(g, this.value);
      const choice = chooseChild(g, this.value, this.opening.rootQ);
      this.openingCache.set(id, choice);
      return choice;
    }
    if (this.shallow !== null) {
      this.shallow.evaluate(g, this.value);
      if (!contested(g, this.value, this.marginBps)) return chooseChild(g, this.value, this.shallow.rootQ);
    }
    this.deepened += 1;
    this.search.evaluate(g, this.value);
    return chooseChild(g, this.value, this.search.rootQ);
  }
}

export interface RolloutOptions {
  /** Depth of the expectimax base policy (and of the values that decide whether a decision is contested). */
  baseDepth: number;
  /** A decision is contested when an action is within this fraction of the bet of the best one. */
  margin: number;
  /** Samples per batch, and the most samples per decision. */
  batch: number;
  maxSamples: number;
  /** Seed of the player's own generator; `reseed(game)` mixes in the game index. */
  seed: number;
}

/** Counters of a rollout player, summed over the games it played. */
export interface RolloutCounters {
  decisions: number;
  contested: number;
  samples: number;
  /** Contested decisions where the rollouts overturned the base policy. */
  changed: number;
}

/** Actions of a rollout decision: children 0 .. 3, and cash out. */
const ACTIONS = 5;
const CASH_SLOT = 4;

export class RolloutBot implements Bot {
  private readonly base: ExpectimaxBot;
  private readonly baseValue = new Float64Array(4);
  private readonly inner: Game;
  private readonly innerBase: ExpectimaxBot;
  private readonly wilson: WilsonScratch;
  private readonly sampled: Uint8Array;
  private readonly view: Game;
  private readonly viewOpen: Uint8Array;
  private rng: Rng;
  private readonly sum = new Float64Array(ACTIONS);
  /** Sums of products of the payoffs of two actions on the same sample, `a * ACTIONS + b`. */
  private readonly prod = new Float64Array(ACTIONS * ACTIONS);
  private readonly payoff = new Float64Array(ACTIONS);
  private readonly slots = new Int32Array(ACTIONS);
  readonly counters: RolloutCounters = { decisions: 0, contested: 0, samples: 0, changed: 0 };

  constructor(
    g: Game,
    table: ValueTable,
    private readonly options: RolloutOptions,
  ) {
    if (!(options.batch >= 1 && options.maxSamples >= options.batch)) throw new RangeError('rollout: need 1 <= batch <= maxSamples');
    const econ = econOf(g);
    this.base = new ExpectimaxBot(g, table, options.baseDepth);
    this.inner = new Game(econ);
    this.innerBase = new ExpectimaxBot(this.inner, table, options.baseDepth);
    this.wilson = new WilsonScratch(g.cells);
    this.sampled = new Uint8Array(g.cells);
    this.view = new Game(econ);
    this.viewOpen = new Uint8Array(g.cells);
    this.view.open = this.viewOpen;
    this.rng = fastRng(BigInt(options.seed >>> 0));
  }

  /** Private randomness of game `index`: independent of the maze, different for every game. */
  reseed(index: number): void {
    this.rng = fastRng((BigInt(this.options.seed >>> 0) << 40n) ^ BigInt(index));
  }

  begin(): void {}

  decide(g: Game): number {
    const { options, baseValue, sum, prod, payoff, slots, inner, view } = this;
    this.counters.decisions += 1;
    this.base.search.evaluate(g, baseValue);
    const baseChoice = chooseChild(g, baseValue, this.base.search.rootQ);
    const nc = g.nc;
    const cash = g.refund[g.k];
    let bestValue = cash;
    for (let i = 0; i < nc; i++) if (baseValue[i] > bestValue) bestValue = baseValue[i];
    const floor = bestValue - options.margin * 10_000;
    // Contested actions: children within the margin, and cash out when it is within the margin.
    let count = 0;
    for (let i = 0; i < nc; i++) if (baseValue[i] >= 0 && baseValue[i] >= floor) slots[count++] = i;
    if (cash >= floor) slots[count++] = CASH_SLOT;
    if (count < 2) return baseChoice;
    this.counters.contested += 1;

    // The posterior is sampled from a copy of the position that holds only the visited walls.
    view.copyFrom(g);
    view.open = this.viewOpen;
    this.viewOpen.fill(0);
    for (let t = 0; t <= g.k; t++) this.viewOpen[g.path[t]] = g.open[g.path[t]];
    sum.fill(0);
    prod.fill(0);
    let n = 0;
    let leader = slots[0];
    while (n < options.maxSamples) {
      for (let b = 0; b < options.batch; b++) {
        samplePosteriorMaze(view, this.rng, this.wilson, this.sampled);
        for (let j = 0; j < count; j++) {
          const a = slots[j];
          if (a === CASH_SLOT) {
            payoff[a] = cash;
            continue;
          }
          inner.copyFrom(view);
          inner.open = this.sampled;
          inner.advance(a);
          payoff[a] = inner.cell === inner.exit ? inner.multiplierBps : inner.nc > 0 ? this.playBase() : 0;
        }
        for (let j = 0; j < count; j++) {
          const a = slots[j];
          sum[a] += payoff[a];
          for (let l = 0; l < count; l++) prod[a * ACTIONS + slots[l]] += payoff[a] * payoff[slots[l]];
        }
        n += 1;
      }
      let first = -1;
      let second = -1;
      for (let j = 0; j < count; j++) {
        const a = slots[j];
        if (first === -1 || sum[a] > sum[first]) {
          second = first;
          first = a;
        } else if (second === -1 || sum[a] > sum[second]) {
          second = a;
        }
      }
      leader = first;
      // Paired standard error of (leader - runner-up) over the common samples.
      const meanD = (sum[first] - sum[second]) / n;
      const sumSqD = prod[first * ACTIONS + first] - 2 * prod[first * ACTIONS + second] + prod[second * ACTIONS + second];
      const varD = n > 1 ? Math.max(0, (sumSqD - n * meanD * meanD) / (n - 1)) : 0;
      if (meanD > 3 * Math.sqrt(varD / n)) break;
    }
    this.counters.samples += n;
    const choice = leader === CASH_SLOT ? CASH_OUT : leader;
    if (choice !== baseChoice) this.counters.changed += 1;
    return choice;
  }

  /** Plays the base policy on `inner` from its current position; returns the payout (bps). */
  private playBase(): number {
    const g = this.inner;
    for (;;) {
      const action = this.innerBase.decide(g);
      if (action === CASH_OUT) return g.refund[g.k];
      g.advance(action);
      if (g.cell === g.exit) return g.multiplierBps;
      if (g.nc === 0) return 0;
    }
  }
}

/** Number of parameters of `ParamBot`. */
export const PARAM_DIM = 6;

/**
 * expectimax(1) with shifted scores. For child c with posterior q, distance d, region share ρ
 * (unvisited cells reachable from c over unvisited cells, over all unvisited cells) at step k:
 *   score_c = Q_c / M + s (θ0 q + θ1 d / L + θ2 ρ + θ3 (k / L) q)
 *   move    = argmax score_c
 *   cash out when M · score_move < refund(k) · (1 + s θ4) + s θ5 · M · q_move (1 - q_move)
 * with s = 0.01, so that the search works on numbers of order 1. θ = 0 is expectimax(1).
 */
export class ParamBot implements Bot {
  private readonly search: ExpectimaxSearch;
  private readonly value = new Float64Array(4);
  private readonly score = new Float64Array(4);
  private readonly region: Region;
  private readonly theta: Float64Array;

  constructor(g: Game, table: ValueTable, theta: readonly number[]) {
    if (theta.length !== PARAM_DIM) throw new RangeError(`param: θ needs ${PARAM_DIM} entries`);
    this.search = new ExpectimaxSearch(g, table, 1);
    this.region = new Region(g.cells);
    this.theta = Float64Array.from(theta, (x) => 0.01 * x);
  }

  begin(): void {}

  decide(g: Game): number {
    const { value, score, theta, region } = this;
    this.search.evaluate(g, value);
    const q = this.search.rootQ;
    const m = g.multiplierBps;
    const unvisited = g.cells - g.k - 1;
    let best = -1;
    for (let i = 0; i < g.nc; i++) {
      const child = g.childCell[i];
      if (child === g.exit) return i;
      if (value[i] < 0) continue;
      region.fill(g, child);
      score[i] =
        value[i] / m +
        theta[0] * q[i] +
        (theta[1] * g.dist[child]) / g.shortest +
        (theta[2] * region.size) / unvisited +
        ((theta[3] * g.k) / g.shortest) * q[i];
      if (best === -1 || score[i] > score[best] + VALUE_TIE || (score[i] >= score[best] - VALUE_TIE && q[i] > q[best] + Q_TIE)) best = i;
    }
    if (best === -1) return CASH_OUT;
    const threshold = g.refund[g.k] * (1 + theta[4]) + theta[5] * m * q[best] * (1 - q[best]);
    return m * score[best] < threshold ? CASH_OUT : best;
  }
}
