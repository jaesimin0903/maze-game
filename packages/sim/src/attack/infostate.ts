// Exact value of the game by dynamic programming over information states (AI-attack lane).
//
// An information state is everything the player has seen: the cells walked, in order, and their
// walls. Under the uniform-spanning-tree prior the unseen part of the maze is a uniform spanning
// tree of the graph whose root is the visited cells plus the heads (posterior.ts). Given that
// root, the connected components of the free cells are independent of each other, so the
// future of the game depends only on
//
//   k   the moves made so far (the refund),
//   S   the free components that can still matter,
//   C   the children of the current cell that can still matter,
//   H   the other heads next to S (root edges that are not children).
//
// The visited cells next to S are implied: a neighbour of S that is neither free nor a head is
// visited. Two information states with the same (k, S, C, H) have the same value, and a player
// whose decisions depend on the posterior only decides the same way in both, so the key is a
// valid memo for the optimum and for the evaluation of such a player.
//
//   optimal: S = the exit's component X plus the components next to the children that touch X,
//            C = the children that touch X. A child that does not touch X has q = 0; entering it
//            pays at most refund(k + 1) < refund(k), so the optimum never does.
//   policy:  S = X plus the components next to every child, C = every child: the evaluated
//            player may enter a hopeless branch, and the rest of that game must be followed.
//
//   V(s)    = max( refund(k), max over c in C of Q(s, c) )             (optimal)
//           = refund(k) or Q(s, π(s))                                   (policy π)
//   Q(s, c) = M when c is the exit, else Σ over non-empty patterns m of c's unknown edges of
//             P(m) · V(s'), where P(m) is the exact spanning-tree count ratio of
//             `Posterior.pattern` and the empty pattern (a dead end) pays 0.
//
// Pruning (optimal only, exact): entering c wins with probability at most q_c and otherwise
// pays at most refund(k + 1), so Q(s, c) <= refund(k + 1) (1 - q_c) + M q_c. Children are tried
// in decreasing q and a child whose bound does not beat the best value found is skipped.

import type { Rng } from '@maze/shared';
import type { Bot } from '../bots/types';
import { BIT, CASH_OUT, FREE, Game, HEAD, type TierEconomics } from '../engine';
import { Posterior } from '../posterior';
import { KeyTable } from './keytable';

const NO_RNG: Rng = { nextU32: () => 0, nextBelow: () => 0 };

/** Raised when the state count passes `maxStates`: the grid is too large for the memory budget. */
export class StateLimit extends Error {
  constructor(readonly states: number) {
    super(`information-state DP: more than ${states} states`);
    this.name = 'StateLimit';
  }
}

export interface InfoStateOptions {
  /** Stop with `StateLimit` beyond this many memoised states. */
  maxStates?: number;
  /** Square grids only: solve the east start and reuse it for the south start (they are mirror images). */
  mirror?: boolean;
  /**
   * Policy mode only: key the memo by the whole information state (step, current cell, its walls
   * and the status of every cell) instead of (k, S, C, H). Needed for players whose decisions use
   * more than the posterior, such as the region feature or the coordinates of the current cell.
   */
  fullKey?: boolean;
  /** Called every `progressEvery` new states. */
  progress?: (states: number) => void;
  progressEvery?: number;
}

export interface InfoStateResult {
  w: number;
  h: number;
  multiplierBps: number;
  mode: 'optimal' | 'policy';
  /** Value per start direction, as a fraction of the bet. */
  east: number;
  south: number;
  /** Probability of reaching the exit per start direction. */
  eastWin: number;
  southWin: number;
  /** Share of corridor mazes whose start opens east (tree-count ratio); 1/2 on square grids. */
  eastWeight: number;
  /** Mean over the corridor mazes, every maze equally likely (as `exact.ts` enumerates them). */
  rtp: number;
  /** Mean with each start direction drawn with probability 1/2 (as the generator draws it). Equal to `rtp` on square grids. */
  rtpGenerator: number;
  winRate: number;
  states: number;
  bytes: number;
  seconds: number;
}

export class InfoStateSolver {
  readonly w: number;
  readonly h: number;
  readonly cells: number;
  readonly econ: TierEconomics;
  readonly memo: KeyTable;
  private readonly games: Game[];
  private readonly posts: Posterior[];
  private readonly qs: Float64Array[];
  private readonly keys: Uint32Array[];
  private readonly dirs: Int32Array[];
  private readonly probs: Float64Array[];
  private readonly order: Int32Array[];
  /** The only maze array of the solver: holds the walls of the cells visited along the current branch. */
  readonly open: Uint8Array;
  private readonly mark: Uint8Array;
  private readonly stack: Int32Array;
  private readonly maskWords: number;
  private readonly fullKey: boolean;
  private readonly maxStates: number;
  private readonly progress: ((states: number) => void) | null;
  private readonly progressEvery: number;
  private nextReport: number;
  /** Win probability of the value returned last. */
  private win = 0;

  constructor(
    econ: TierEconomics,
    /**
     * null: the optimum. Otherwise the player to evaluate, which must be deterministic and
     * stateless: each decision a function of the current position only (no memory between
     * decisions; `begin` is called once per start direction).
     */
    private readonly bot: Bot | null,
    options: InfoStateOptions = {},
  ) {
    this.econ = econ;
    this.w = econ.w;
    this.h = econ.h;
    this.cells = econ.w * econ.h;
    this.maskWords = Math.ceil(this.cells / 32);
    this.fullKey = options.fullKey === true;
    if (this.fullKey && bot === null) throw new RangeError('information-state DP: fullKey applies to policy evaluation only');
    const keyWords = this.fullKey ? 3 + Math.ceil(this.cells / 16) : 1 + 3 * this.maskWords;
    this.memo = new KeyTable(keyWords);
    this.games = [];
    this.posts = [];
    this.qs = [];
    this.keys = [];
    this.dirs = [];
    this.probs = [];
    this.order = [];
    this.open = new Uint8Array(this.cells);
    for (let d = 0; d <= this.cells; d++) {
      const g = new Game(econ);
      g.open = this.open;
      this.games.push(g);
      this.posts.push(new Posterior(econ.w, econ.h));
      this.qs.push(new Float64Array(4));
      this.keys.push(new Uint32Array(keyWords));
      this.dirs.push(new Int32Array(4));
      this.probs.push(new Float64Array(16));
      this.order.push(new Int32Array(4));
    }
    this.mark = new Uint8Array(this.cells);
    this.stack = new Int32Array(this.cells);
    this.maxStates = options.maxStates ?? Number.POSITIVE_INFINITY;
    this.progress = options.progress ?? null;
    this.progressEvery = options.progressEvery ?? 1_000_000;
    this.nextReport = this.progressEvery;
  }

  /** Marks the free component of `from` with 1 in `mark`. */
  private flood(g: Game, from: number): void {
    const { mark, stack } = this;
    const { status, nbr } = g;
    let top = 0;
    stack[0] = from;
    mark[from] = 1;
    while (top >= 0) {
      const cell = stack[top--];
      for (let dir = 0; dir < 4; dir++) {
        const u = nbr[cell * 4 + dir];
        if (u >= 0 && status[u] === FREE && mark[u] === 0) {
          mark[u] = 1;
          stack[++top] = u;
        }
      }
    }
  }

  /**
   * Writes the memo key of the position of `g` into `key` and returns the children that matter
   * as a bitmask over `g.childCell` (every child when `all`).
   */
  computeKey(g: Game, all: boolean, key: Uint32Array): number {
    const { mark, maskWords } = this;
    const { status, nbr, cells, exit } = g;
    mark.fill(0);
    key.fill(0);
    key[0] = g.k + 1;
    if (status[exit] === FREE) this.flood(g, exit);
    let relevant = 0;
    for (let i = 0; i < g.nc; i++) {
      const child = g.childCell[i];
      let touches = all;
      for (let dir = 0; dir < 4 && !touches; dir++) {
        const u = nbr[child * 4 + dir];
        if (u >= 0 && mark[u] === 1) touches = true;
      }
      if (touches) relevant |= 1 << i;
    }
    for (let i = 0; i < g.nc; i++) {
      if (((relevant >> i) & 1) === 0) continue;
      const child = g.childCell[i];
      for (let dir = 0; dir < 4; dir++) {
        const u = nbr[child * 4 + dir];
        if (u >= 0 && status[u] === FREE && mark[u] === 0) this.flood(g, u);
      }
    }
    for (let i = 0; i < g.nc; i++) {
      if (((relevant >> i) & 1) === 0) continue;
      const child = g.childCell[i];
      mark[child] = 2;
      key[1 + maskWords + (child >>> 5)] |= 1 << (child & 31);
    }
    for (let cell = 0; cell < cells; cell++) {
      if (mark[cell] === 1) {
        key[1 + (cell >>> 5)] |= 1 << (cell & 31);
      } else if (mark[cell] === 0 && status[cell] === HEAD) {
        for (let dir = 0; dir < 4; dir++) {
          const u = nbr[cell * 4 + dir];
          if (u >= 0 && mark[u] === 1) {
            key[1 + 2 * maskWords + (cell >>> 5)] |= 1 << (cell & 31);
            break;
          }
        }
      }
    }
    return relevant;
  }

  /** The whole information state as a key: step, current cell, its walls, two status bits per cell. */
  private computeFullKey(g: Game, key: Uint32Array): void {
    key.fill(0);
    key[0] = g.k + 1;
    key[1] = g.cell;
    key[2] = this.open[g.cell];
    for (let cell = 0; cell < g.cells; cell++) key[3 + (cell >>> 4)] |= g.status[cell] << ((cell & 15) * 2);
  }

  /** Value (bps) of the decision point `games[d]`; its win probability is left in `this.win`. */
  private value(d: number): number {
    const g = this.games[d];
    const key = this.keys[d];
    const bot = this.bot;
    const m = g.multiplierBps;
    const k = g.k;
    let relevant = 0;
    if (this.fullKey) this.computeFullKey(g, key);
    else relevant = this.computeKey(g, bot !== null, key);
    if (bot === null) {
      for (let i = 0; i < g.nc; i++) {
        if (g.childCell[i] === g.exit) {
          this.win = 1;
          return m;
        }
      }
      if (relevant === 0) {
        this.win = 0;
        return g.refund[k];
      }
    }
    const known = this.memo.get(key);
    if (known === known) {
      this.win = this.memo.found2;
      return known;
    }

    let best = g.refund[k];
    let bestWin = 0;
    if (bot === null) {
      const q = this.qs[d];
      this.posts[d].childPosterior(g, q);
      const order = this.order[d];
      let n = 0;
      for (let i = 0; i < g.nc; i++) {
        if (((relevant >> i) & 1) === 0) continue;
        let at = n++;
        while (at > 0 && q[order[at - 1]] < q[i]) {
          order[at] = order[at - 1];
          at -= 1;
        }
        order[at] = i;
      }
      const refundNext = g.refund[k + 1];
      for (let j = 0; j < n; j++) {
        const i = order[j];
        if (refundNext * (1 - q[i]) + m * q[i] <= best) continue;
        const value = this.childValue(d, i);
        if (value > best) {
          best = value;
          bestWin = this.win;
        }
      }
    } else {
      const action = bot.decide(g);
      if (action !== CASH_OUT) {
        if (!(action >= 0 && action < g.nc)) throw new RangeError(`information-state DP: the player chose child ${action} of ${g.nc}`);
        this.posts[d].childPosterior(g, this.qs[d]);
        best = this.childValue(d, action);
        bestWin = this.win;
      }
    }
    this.memo.set(key, best, bestWin);
    if (this.memo.size > this.maxStates) throw new StateLimit(this.maxStates);
    if (this.progress !== null && this.memo.size >= this.nextReport) {
      this.nextReport += this.progressEvery;
      this.progress(this.memo.size);
    }
    this.win = bestWin;
    return best;
  }

  /** Q (bps) of moving to child `i` of `games[d]`; requires `posts[d]` factorised for that position. */
  private childValue(d: number, i: number): number {
    const g = this.games[d];
    const child = g.childCell[i];
    if (child === g.exit) {
      this.win = 1;
      return g.multiplierBps;
    }
    const post = this.posts[d];
    const r = post.prepareChild(g, child);
    const dirs = this.dirs[d];
    let n = 0;
    for (let dir = 0; dir < 4; dir++) {
      const u = g.nbr[child * 4 + dir];
      if (u >= 0 && g.status[u] === FREE) dirs[n++] = dir;
    }
    if (n !== r) throw new Error('information-state DP: pattern cells disagree with the posterior');
    const probs = this.probs[d];
    for (let mask = 1; mask < 1 << r; mask++) probs[mask] = post.pattern(mask);
    const back = g.back[child];
    const next = this.games[d + 1];
    let total = 0;
    let win = 0;
    for (let mask = 1; mask < 1 << r; mask++) {
      const p = probs[mask];
      if (p === 0) continue;
      let bits = back;
      for (let a = 0; a < r; a++) if ((mask >> a) & 1) bits |= BIT[dirs[a]];
      next.copyFrom(g);
      next.open = this.open;
      this.open[child] = bits;
      next.advance(i);
      total += p * this.value(d + 1);
      win += p * this.win;
    }
    this.win = win;
    return total;
  }

  /** Puts `games[0]` on the start cell with the start corridor opening east (`east`) or south. */
  private start(east: boolean): Game {
    const g = this.games[0];
    this.open.fill(0);
    this.open[0] = east ? BIT[1] : BIT[2];
    g.begin(this.open, NO_RNG);
    return g;
  }

  /** Value (fraction of the bet) and win probability of a game that starts east or south. */
  solveStart(east: boolean): { value: number; win: number } {
    const g = this.start(east);
    this.bot?.begin(g);
    const value = this.value(0);
    return { value: value / 10_000, win: this.win };
  }

  /** Share of corridor mazes whose start opens east: T_E / (T_E + T_S). */
  eastWeight(): number {
    const post = this.posts[0];
    post.factor(this.start(true).status);
    const logEast = post.logTrees;
    post.factor(this.start(false).status);
    const logSouth = post.logTrees;
    return 1 / (1 + Math.exp(logSouth - logEast));
  }

  /**
   * Q (bps) of every child of a real game position for the optimum, in `out` (length >= nc).
   * Reads only the walls of visited cells.
   */
  childValues(g: Game, out: Float64Array): void {
    if (this.bot !== null) throw new Error('childValues: only for the optimum');
    const k = g.k;
    const at = this.games[k];
    const load = (): number => {
      at.copyFrom(g);
      at.open = this.open;
      for (let t = 0; t <= k; t++) this.open[g.path[t]] = g.open[g.path[t]];
      const relevant = this.computeKey(at, false, this.keys[k]);
      this.posts[k].childPosterior(at, this.qs[k]);
      return relevant;
    };
    const relevant = load();
    for (let i = 0; i < at.nc; i++) {
      if (at.childCell[i] === at.exit) out[i] = at.multiplierBps;
      else if (((relevant >> i) & 1) === 0) out[i] = 0;
      else {
        out[i] = this.childValue(k, i);
        load();
      }
    }
  }
}

/** Solves both start directions. `bot` null: the Bayes-optimal player; otherwise the exact value of `bot`. */
export function solveInfoStates(econ: TierEconomics, bot: Bot | null, options: InfoStateOptions = {}): InfoStateResult {
  const started = Date.now();
  const solver = new InfoStateSolver(econ, bot, options);
  const eastWeight = solver.eastWeight();
  const east = solver.solveStart(true);
  const mirror = options.mirror === true && econ.w === econ.h;
  const south = mirror ? east : solver.solveStart(false);
  return {
    w: econ.w,
    h: econ.h,
    multiplierBps: econ.multiplierBps,
    mode: bot === null ? 'optimal' : 'policy',
    east: east.value,
    south: south.value,
    eastWin: east.win,
    southWin: south.win,
    eastWeight,
    rtp: eastWeight * east.value + (1 - eastWeight) * south.value,
    rtpGenerator: (east.value + south.value) / 2,
    winRate: eastWeight * east.win + (1 - eastWeight) * south.win,
    states: solver.memo.size,
    bytes: solver.memo.bytes(),
    seconds: (Date.now() - started) / 1000,
  };
}

/**
 * The Bayes-optimal player as a bot (diagnostics: playing it on sampled mazes must reproduce the
 * value the DP computes). It keeps one solver, so states computed in one game serve the next.
 * Ties go to cashing out, then to the earlier child.
 */
export class OptimalBot implements Bot {
  readonly solver: InfoStateSolver;
  private readonly q = new Float64Array(4);

  constructor(econ: TierEconomics, options: InfoStateOptions = {}) {
    this.solver = new InfoStateSolver(econ, null, options);
  }

  begin(): void {}

  decide(g: Game): number {
    this.solver.childValues(g, this.q);
    let best = CASH_OUT;
    let value = g.refund[g.k];
    for (let i = 0; i < g.nc; i++) {
      if (this.q[i] > value + 1e-9 * g.multiplierBps) {
        value = this.q[i];
        best = i;
      }
    }
    return best;
  }
}
