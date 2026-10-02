// Game engine of the simulator (plan §4.1 rules, §9.3 statistics).
//
// A game: the player starts on cell 0 and sees the open sides of every cell it stands on. It may
// cash out for `refundBps[k]` after `k` moves, or move through an open side to a cell it has not
// visited. Arriving at the exit pays `multiplierBps`; arriving at any other cell with no way
// forward pays nothing. All payouts are kept in basis points of the bet, so sums are exact
// integers and do not depend on the order in which games are added.

import { generateGridFromRng, type Rng } from '@maze/shared';
import type { Bot } from './bots/types';
import { gameRng, sizeBase, type RngMode, type StreamName } from './streams';

/** Returned by `Bot.decide` to cash out. Any other return value is an index into the children. */
export const CASH_OUT = -1;

/** `Game.status` values. A head is an unvisited cell behind a known open side of a visited cell. */
export const FREE = 0;
export const VISITED = 1;
export const HEAD = 2;

/** Same numbering as the contract's `outcome`. */
export const OUTCOME_EXIT = 0;
export const OUTCOME_CASH = 1;
export const OUTCOME_LOSS = 2;

/** Bit of each direction (N, E, S, W) in an open-side mask. */
export const BIT = [1, 2, 4, 8] as const;
const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;

/** The economics of one tier: what the simulator needs from a tuning table. */
export interface TierEconomics {
  w: number;
  h: number;
  multiplierBps: number;
  /** Length `w × h`; `refundBps[k]` is paid for cashing out after `k` moves. */
  refundBps: readonly number[];
}

const NO_RNG: Rng = { nextU32: () => 0, nextBelow: () => 0 };

/**
 * The state of one game. One instance is reused for every game of a run.
 *
 * Legal bots read `open` only at visited cells (`status[cell] === VISITED`); the engine exposes
 * the current cell's forward openings as `childCell` / `childDir`.
 */
export class Game {
  readonly w: number;
  readonly h: number;
  readonly cells: number;
  readonly exit: number;
  /** Length of the shortest possible path, `w + h - 2`. */
  readonly shortest: number;
  readonly multiplierBps: number;
  readonly refund: Float64Array;
  /** Geometric neighbour of `cell` in direction `dir` at `cell * 4 + dir`, or -1 outside the grid. */
  readonly nbr: Int32Array;
  readonly xs: Uint8Array;
  readonly ys: Uint8Array;
  /** Remaining horizontal plus vertical distance to the exit. */
  readonly dist: Uint8Array;

  open: Uint8Array;
  rng: Rng = NO_RNG;
  cell = 0;
  /** Moves made so far. */
  k = 0;
  /** Number of forward openings of the current cell. */
  nc = 0;
  /** Forward openings of the current cell in the order N, E, S, W. */
  readonly childCell = new Int32Array(4);
  readonly childDir = new Int32Array(4);
  readonly status: Uint8Array;
  /** For a head: the bit of the side that leads back to its visited parent. */
  readonly back: Uint8Array;
  /** `path[i]` is the cell after `i` moves. */
  readonly path: Int32Array;
  /** Direction of the start cell's only opening (1 = E, 2 = S). */
  startDir = 0;
  outcome = OUTCOME_LOSS;
  payoutBps = 0;
  /**
   * Set by value bots at a junction on the second cell: estimated continuation value minus
   * `refund(1)`, in bps. NaN when the game had no such decision.
   */
  m1Value = Number.NaN;

  constructor(econ: TierEconomics) {
    const { w, h } = econ;
    if (econ.refundBps.length !== w * h) {
      throw new RangeError(`refund table has ${econ.refundBps.length} entries, expected ${w * h}`);
    }
    this.w = w;
    this.h = h;
    this.cells = w * h;
    this.exit = this.cells - 1;
    this.shortest = w + h - 2;
    this.multiplierBps = econ.multiplierBps;
    this.refund = Float64Array.from(econ.refundBps);
    this.nbr = new Int32Array(this.cells * 4);
    this.xs = new Uint8Array(this.cells);
    this.ys = new Uint8Array(this.cells);
    this.dist = new Uint8Array(this.cells);
    for (let cell = 0; cell < this.cells; cell++) {
      const x = cell % w;
      const y = (cell - x) / w;
      this.xs[cell] = x;
      this.ys[cell] = y;
      this.dist[cell] = w - 1 - x + (h - 1 - y);
      for (let dir = 0; dir < 4; dir++) {
        const nx = x + DX[dir];
        const ny = y + DY[dir];
        this.nbr[cell * 4 + dir] = nx < 0 || nx >= w || ny < 0 || ny >= h ? -1 : ny * w + nx;
      }
    }
    this.open = new Uint8Array(this.cells);
    this.status = new Uint8Array(this.cells);
    this.back = new Uint8Array(this.cells);
    this.path = new Int32Array(this.cells);
  }

  /** Puts the player on the start cell of `open`. */
  begin(open: Uint8Array, rng: Rng): void {
    this.open = open;
    this.rng = rng;
    this.status.fill(FREE);
    this.cell = 0;
    this.k = 0;
    this.path[0] = 0;
    this.status[0] = VISITED;
    this.m1Value = Number.NaN;
    this.setChildren(0);
    this.startDir = this.childDir[0];
  }

  /** Moves to child `i` of the current cell. */
  advance(i: number): void {
    const next = this.childCell[i];
    const dir = this.childDir[i];
    this.cell = next;
    this.k += 1;
    this.path[this.k] = next;
    this.status[next] = VISITED;
    this.setChildren(BIT[(dir + 2) & 3]);
  }

  private setChildren(backBit: number): void {
    const cell = this.cell;
    const mask = this.open[cell] & ~backBit;
    let nc = 0;
    for (let dir = 0; dir < 4; dir++) {
      if ((mask & BIT[dir]) === 0) continue;
      const child = this.nbr[cell * 4 + dir];
      this.childCell[nc] = child;
      this.childDir[nc] = dir;
      this.status[child] = HEAD;
      this.back[child] = BIT[(dir + 2) & 3];
      nc += 1;
    }
    this.nc = nc;
  }

  /** Copies the position of `other` (same grid) so that a simulated continuation can start from it. */
  copyFrom(other: Game): void {
    this.open = other.open;
    this.rng = other.rng;
    this.cell = other.cell;
    this.k = other.k;
    this.nc = other.nc;
    this.childCell.set(other.childCell);
    this.childDir.set(other.childDir);
    this.status.set(other.status);
    this.back.set(other.back);
    this.path.set(other.path);
    this.startDir = other.startDir;
    this.m1Value = Number.NaN;
  }
}

/** Plays the rest of a game that is at a decision point. The result is in `g.outcome` and `g.payoutBps`. */
export function finish(g: Game, bot: Bot): void {
  for (;;) {
    const action = bot.decide(g);
    if (action === CASH_OUT) {
      g.outcome = OUTCOME_CASH;
      g.payoutBps = g.refund[g.k];
      return;
    }
    g.advance(action);
    if (g.cell === g.exit) {
      g.outcome = OUTCOME_EXIT;
      g.payoutBps = g.multiplierBps;
      return;
    }
    if (g.nc === 0) {
      g.outcome = OUTCOME_LOSS;
      g.payoutBps = 0;
      return;
    }
  }
}

/** Plays one whole game of `bot` on the maze `open`. */
export function play(g: Game, bot: Bot, open: Uint8Array, rng: Rng): void {
  g.begin(open, rng);
  bot.begin(g);
  finish(g, bot);
}

/** Where the mazes of a run come from. */
export type MazeSource =
  | { kind: 'rng'; mode: RngMode; stream: StreamName }
  /** Every enumerated maze in turn: game `i` plays maze `i mod count`. `mazes` holds `count × cells` masks. */
  | { kind: 'enum'; stream: StreamName; mazes: Uint8Array; count: number };

/** Yields the maze and the generator of game `index`. */
export class MazeFeed {
  private readonly base: bigint;
  private readonly cells: number;
  open: Uint8Array = new Uint8Array(0);
  rng: Rng = NO_RNG;

  constructor(
    private readonly source: MazeSource,
    private readonly w: number,
    private readonly h: number,
  ) {
    this.base = sizeBase(source.stream, w, h);
    this.cells = w * h;
  }

  load(index: number): void {
    const source = this.source;
    if (source.kind === 'rng') {
      const rng = gameRng(source.mode, source.stream, this.w, this.h, this.base, index);
      this.open = generateGridFromRng(rng, this.w, this.h).open;
      this.rng = rng;
    } else {
      const at = (index % source.count) * this.cells;
      this.open = source.mazes.subarray(at, at + this.cells);
      this.rng = gameRng('fast', source.stream, this.w, this.h, this.base, index);
    }
  }
}

/** Scratch space of `markSolution`, one per run. */
export class SolutionScratch {
  readonly onPath: Uint8Array;
  readonly parent: Int32Array;
  readonly stack: Int32Array;

  constructor(cells: number) {
    this.onPath = new Uint8Array(cells);
    this.parent = new Int32Array(cells);
    this.stack = new Int32Array(cells);
  }
}

/**
 * Marks the cells of the start-to-exit path of `open` in `scratch.onPath` (1 on the path, 0
 * elsewhere) and returns the probability that a walk choosing uniformly among forward openings
 * follows it: the product of `1 / (forward openings)` over the path's cells before the exit.
 * This reads the whole maze, so only diagnostics and exact expectations may use it.
 */
export function markSolution(g: Game, open: Uint8Array, scratch: SolutionScratch): number {
  const { nbr, exit } = g;
  const { onPath, parent, stack } = scratch;
  // Depth-first walk over the tree from the start; `parent` doubles as the visited marker.
  parent.fill(-1);
  parent[0] = 0;
  let top = 0;
  stack[0] = 0;
  while (top >= 0 && parent[exit] === -1) {
    const cell = stack[top--];
    const mask = open[cell];
    for (let dir = 0; dir < 4; dir++) {
      if ((mask & BIT[dir]) === 0) continue;
      const next = nbr[cell * 4 + dir];
      if (parent[next] !== -1) continue;
      parent[next] = cell;
      stack[++top] = next;
    }
  }
  if (parent[exit] === -1) throw new RangeError('markSolution: the exit is not reachable from the start');
  onPath.fill(0);
  let probability = 1;
  let cell = exit;
  onPath[cell] = 1;
  while (cell !== 0) {
    cell = parent[cell];
    onPath[cell] = 1;
    const mask = open[cell];
    const openings = (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
    probability /= cell === 0 ? openings : openings - 1;
  }
  return probability;
}

/** Sufficient statistics of a run of games. Counts are exact; payouts are in basis points of the bet. */
export interface ChunkStats {
  n: number;
  sum: number;
  sumSq: number;
  /** Games that reached the exit (a sum of probabilities for an `expected` run). */
  wins: number;
  losses: number;
  /** `cash[k]`: games cashed out after `k` moves. */
  cash: number[];
  /** Sum of the number of moves made. */
  steps: number;
  /** Losses that ended within distance 2 of the exit. */
  nearMiss: number;
  /** Games whose start cell opened east, and how many of those were won. */
  startE: number;
  winsE: number;
  /** Junctions on the second cell at which a value bot reported its continuation margin, and the sum of those margins (bps). */
  m1N: number;
  m1Sum: number;
  /** True when each game contributed its exact conditional expectation given the maze instead of a sampled payout. */
  expected: boolean;
}

export function emptyStats(cells: number, expected = false): ChunkStats {
  return {
    n: 0,
    sum: 0,
    sumSq: 0,
    wins: 0,
    losses: 0,
    cash: new Array<number>(cells).fill(0),
    steps: 0,
    nearMiss: 0,
    startE: 0,
    winsE: 0,
    m1N: 0,
    m1Sum: 0,
    expected,
  };
}

/** Adds `b` into `a`. */
export function mergeStats(a: ChunkStats, b: ChunkStats): void {
  if (a.cash.length !== b.cash.length || a.expected !== b.expected) {
    throw new RangeError('mergeStats: the two runs are of different kinds');
  }
  a.n += b.n;
  a.sum += b.sum;
  a.sumSq += b.sumSq;
  a.wins += b.wins;
  a.losses += b.losses;
  for (let k = 0; k < a.cash.length; k++) a.cash[k] += b.cash[k];
  a.steps += b.steps;
  a.nearMiss += b.nearMiss;
  a.startE += b.startE;
  a.winsE += b.winsE;
  a.m1N += b.m1N;
  a.m1Sum += b.m1Sum;
}

function record(stats: ChunkStats, g: Game): void {
  stats.n += 1;
  stats.steps += g.k;
  const east = g.startDir === 1;
  if (east) stats.startE += 1;
  if (g.outcome === OUTCOME_EXIT) {
    stats.wins += 1;
    if (east) stats.winsE += 1;
  } else if (g.outcome === OUTCOME_CASH) {
    stats.cash[g.k] += 1;
  } else {
    stats.losses += 1;
    if (g.dist[g.cell] <= 2) stats.nearMiss += 1;
  }
  if (g.m1Value === g.m1Value) {
    stats.m1N += 1;
    stats.m1Sum += g.m1Value;
  }
}

/**
 * Fills `sum` and `sumSq` of a sampled run from its exact counts, in a fixed order, so the
 * totals do not depend on how the games were split between workers.
 */
export function closeStats(stats: ChunkStats, econ: TierEconomics): void {
  if (stats.expected) return;
  const m = econ.multiplierBps;
  let sum = stats.wins * m;
  let sumSq = stats.wins * m * m;
  for (let k = 0; k < stats.cash.length; k++) {
    const refund = econ.refundBps[k];
    sum += stats.cash[k] * refund;
    sumSq += stats.cash[k] * refund * refund;
  }
  stats.sum = sum;
  stats.sumSq = sumSq;
}

/** Plays games `from .. to - 1` of `source` with `bot`. */
export function runGames(g: Game, bot: Bot, source: MazeSource, from: number, to: number): ChunkStats {
  const feed = new MazeFeed(source, g.w, g.h);
  if (bot.winProbability !== undefined) {
    const stats = emptyStats(g.cells, true);
    for (let index = from; index < to; index++) {
      feed.load(index);
      const p = bot.winProbability(g, feed.open);
      const payout = p * g.multiplierBps;
      stats.n += 1;
      stats.wins += p;
      stats.losses += 1 - p;
      stats.sum += payout;
      stats.sumSq += payout * payout;
      if ((feed.open[0] & 2) !== 0) {
        stats.startE += 1;
        stats.winsE += p;
      }
    }
    return stats;
  }
  const stats = emptyStats(g.cells);
  for (let index = from; index < to; index++) {
    feed.load(index);
    play(g, bot, feed.open, feed.rng);
    record(stats, g);
  }
  closeStats(stats, { w: g.w, h: g.h, multiplierBps: g.multiplierBps, refundBps: Array.from(g.refund) });
  return stats;
}

/** Sufficient statistics of a paired run: bot A and bot B on the same mazes, `D = A - B`. */
export interface PairStats {
  n: number;
  a: ChunkStats;
  b: ChunkStats;
  sumD: number;
  sumSqD: number;
}

export function emptyPairStats(cells: number): PairStats {
  return { n: 0, a: emptyStats(cells), b: emptyStats(cells), sumD: 0, sumSqD: 0 };
}

export function mergePairStats(x: PairStats, y: PairStats): void {
  x.n += y.n;
  mergeStats(x.a, y.a);
  mergeStats(x.b, y.b);
  x.sumD += y.sumD;
  x.sumSqD += y.sumSqD;
}

/**
 * Plays games `from .. to - 1` twice, once with each bot, on identical mazes. Both bots must be
 * deterministic given what they observe: neither may draw from the game's generator, because
 * the second bot would then see a different generator state than the first.
 */
export function runPairs(g: Game, botA: Bot, botB: Bot, source: MazeSource, from: number, to: number): PairStats {
  const feed = new MazeFeed(source, g.w, g.h);
  const stats = emptyPairStats(g.cells);
  for (let index = from; index < to; index++) {
    feed.load(index);
    play(g, botA, feed.open, feed.rng);
    const payoutA = g.payoutBps;
    record(stats.a, g);
    play(g, botB, feed.open, feed.rng);
    record(stats.b, g);
    const d = payoutA - g.payoutBps;
    stats.n += 1;
    stats.sumD += d;
    stats.sumSqD += d * d;
  }
  const econ = { w: g.w, h: g.h, multiplierBps: g.multiplierBps, refundBps: Array.from(g.refund) };
  closeStats(stats.a, econ);
  closeStats(stats.b, econ);
  return stats;
}
