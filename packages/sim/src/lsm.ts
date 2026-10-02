// Value tables of the learning bots and the loops that train them (plan §3.3).
//
// An afterstate is "the player has just decided to move to child c": it is described by the
// step count after the move `k'`, the posterior `q_c` in bins of width 1 / qBins, the distance
// `d_c` of the child to the exit and, when the region feature is on, the share of the unvisited
// cells reachable from the child. A table holds, for every afterstate, the mean payout (bps of
// the bet) of the games that passed through it and then followed the policy.

import {
  markSolution,
  MazeFeed,
  SolutionScratch,
  type Game,
  type MazeSource,
  type TierEconomics,
} from './engine';
import { harmonicChoice } from './bots/harmonic';
import { regionMove } from './bots/region-heuristic';
import type { Region } from './bots/region';
import { Posterior } from './posterior';

/** Width-0.05 posterior bins. */
export const Q_BINS = 20;
/** A table cell with fewer games than this is replaced by a pooled estimate. */
export const MIN_SAMPLES = 200;
/** An exploring training game deviates at junction number 1 .. 6, chosen uniformly. */
export const EXPLORE_JUNCTIONS = 6;
/** Bins of the optional region feature (exactness-gate improvement (c)). */
export const REGION_BINS = 4;
/** Keeps values such as 0.5 in the bin they belong to despite rounding. */
const BIN_EPS = 1e-9;

export interface TableShape {
  cells: number;
  /** `w + h - 2`; distances run from 0 to this. */
  shortest: number;
  qBins: number;
  /** 1 when the region feature is off. */
  rBins: number;
}

export function shapeOf(w: number, h: number, rBins = 1): TableShape {
  return { cells: w * h, shortest: w + h - 2, qBins: Q_BINS, rBins };
}

export function tableLength(s: TableShape): number {
  return s.cells * s.qBins * (s.shortest + 1) * s.rBins;
}

export function qBinOf(q: number, qBins: number): number {
  const bin = Math.floor(q * qBins + BIN_EPS);
  return bin >= qBins ? qBins - 1 : bin < 0 ? 0 : bin;
}

export function ratioBinOf(ratio: number, rBins: number): number {
  if (rBins === 1) return 0;
  const bin = Math.floor(ratio * rBins + BIN_EPS);
  return bin >= rBins ? rBins - 1 : bin < 0 ? 0 : bin;
}

/** Index of afterstate `(k, qBin, d, rBin)`. */
export function tableIndex(s: TableShape, k: number, qBin: number, d: number, rBin: number): number {
  return ((k * s.qBins + qBin) * (s.shortest + 1) + d) * s.rBins + rBin;
}

export interface ValueTable extends TableShape {
  /** Mean payout in bps per afterstate; NaN where every pooled estimate was too thin as well. */
  values: Float64Array;
  /** `S[d]`: how often harmonic, standing on a solution-path cell at distance `d`, went on to win. */
  winAtDistance: Float64Array;
  /** The last-resort estimate uses the centre of the posterior bin instead of the posterior itself. */
  binCentreFallback: boolean;
}

/**
 * Value of afterstate `(k, q, d, rBin)`. Where the table has no estimate the last resort of
 * plan §3.3 applies: `q × M × S[d]`.
 */
export function lookup(t: ValueTable, k: number, q: number, d: number, rBin: number, multiplierBps: number): number {
  const qBin = qBinOf(q, t.qBins);
  const value = t.values[((k * t.qBins + qBin) * (t.shortest + 1) + d) * t.rBins + rBin];
  if (value === value) return value;
  const posterior = t.binCentreFallback ? (qBin + 0.5) / t.qBins : q;
  return posterior * multiplierBps * t.winAtDistance[d];
}

/** Mergeable sums of a training pass. Counts and bps payouts are integers, so merging is exact. */
export interface TableAccumulator {
  sum: Float64Array;
  cnt: Float64Array;
  /** Per distance: harmonic visits to solution-path cells, and how many of those games were won. */
  cntAt: Float64Array;
  winAt: Float64Array;
}

export function newAccumulator(s: TableShape): TableAccumulator {
  const length = tableLength(s);
  return {
    sum: new Float64Array(length),
    cnt: new Float64Array(length),
    cntAt: new Float64Array(s.shortest + 1),
    winAt: new Float64Array(s.shortest + 1),
  };
}

export function addAccumulator(into: TableAccumulator, from: TableAccumulator): void {
  for (let i = 0; i < into.sum.length; i++) {
    into.sum[i] += from.sum[i];
    into.cnt[i] += from.cnt[i];
  }
  for (let d = 0; d < into.cntAt.length; d++) {
    into.cntAt[d] += from.cntAt[d];
    into.winAt[d] += from.winAt[d];
  }
}

/**
 * `S[d]` from the visit counts. A distance with fewer than `minSamples` visits takes the value
 * of the nearest distance that has enough (the smaller distance on a tie); with none anywhere
 * the pooled rate is used.
 */
export function winAtDistanceOf(cntAt: Float64Array, winAt: Float64Array, minSamples = MIN_SAMPLES): Float64Array {
  const length = cntAt.length;
  const out = new Float64Array(length);
  let pooledCnt = 0;
  let pooledWin = 0;
  for (let d = 0; d < length; d++) {
    pooledCnt += cntAt[d];
    pooledWin += winAt[d];
  }
  const pooled = pooledCnt > 0 ? pooledWin / pooledCnt : 0;
  for (let d = 0; d < length; d++) {
    let value = pooled;
    for (let delta = 0; delta < length; delta++) {
      const lower = d - delta;
      const upper = d + delta;
      if (lower >= 0 && cntAt[lower] >= minSamples) {
        value = winAt[lower] / cntAt[lower];
        break;
      }
      if (upper < length && cntAt[upper] >= minSamples) {
        value = winAt[upper] / cntAt[upper];
        break;
      }
    }
    out[d] = value;
  }
  // Standing on the exit is a win.
  out[0] = 1;
  return out;
}

/**
 * Turns sums into a table. `scale` multiplies every mean (the harmonic pass records wins, so
 * its scale is the multiplier). A cell with fewer than `minSamples` games falls back, in this
 * order, to: the cell pooled over the region feature, pooled over `d`, pooled over `d` and
 * `k' ± 2`, and finally NaN, which `lookup` resolves as `q × M × S[d]`.
 */
export function finalizeTable(
  s: TableShape,
  acc: TableAccumulator,
  winAtDistance: Float64Array,
  scale: number,
  minSamples = MIN_SAMPLES,
): ValueTable {
  const { cells, qBins, rBins } = s;
  const distances = s.shortest + 1;
  const values = new Float64Array(tableLength(s));
  // Pooled over d and r, per (k, qBin).
  const sumKQ = new Float64Array(cells * qBins);
  const cntKQ = new Float64Array(cells * qBins);
  for (let k = 0; k < cells; k++) {
    for (let qb = 0; qb < qBins; qb++) {
      let sum = 0;
      let cnt = 0;
      const base = tableIndex(s, k, qb, 0, 0);
      for (let i = 0; i < distances * rBins; i++) {
        sum += acc.sum[base + i];
        cnt += acc.cnt[base + i];
      }
      sumKQ[k * qBins + qb] = sum;
      cntKQ[k * qBins + qb] = cnt;
    }
  }
  for (let k = 0; k < cells; k++) {
    for (let qb = 0; qb < qBins; qb++) {
      let sumWide = 0;
      let cntWide = 0;
      for (let k2 = Math.max(0, k - 2); k2 <= Math.min(cells - 1, k + 2); k2++) {
        sumWide += sumKQ[k2 * qBins + qb];
        cntWide += cntKQ[k2 * qBins + qb];
      }
      const sumQ = sumKQ[k * qBins + qb];
      const cntQ = cntKQ[k * qBins + qb];
      for (let d = 0; d < distances; d++) {
        const base = tableIndex(s, k, qb, d, 0);
        let sumD = 0;
        let cntD = 0;
        for (let rb = 0; rb < rBins; rb++) {
          sumD += acc.sum[base + rb];
          cntD += acc.cnt[base + rb];
        }
        for (let rb = 0; rb < rBins; rb++) {
          const cnt = acc.cnt[base + rb];
          let mean = Number.NaN;
          if (cnt >= minSamples) mean = acc.sum[base + rb] / cnt;
          else if (cntD >= minSamples) mean = sumD / cntD;
          else if (cntQ >= minSamples) mean = sumQ / cntQ;
          else if (cntWide >= minSamples) mean = sumWide / cntWide;
          values[base + rb] = mean * scale;
        }
      }
    }
  }
  return { ...s, values, winAtDistance, binCentreFallback: false };
}

/**
 * The table policy iteration starts from: the harmonic pass (which recorded wins) priced at a
 * multiplier, together with `S[d]` measured in the same pass.
 */
export function tableFromHarmonicPass(s: TableShape, acc: TableAccumulator, multiplierBps: number, minSamples: number): ValueTable {
  return finalizeTable(s, acc, winAtDistanceOf(acc.cntAt, acc.winAt, minSamples), multiplierBps, minSamples);
}

/** The table of one policy-iteration pass. Payouts were recorded in bps; `S[d]` is carried over from the policy's table. */
export function tableFromValuePass(s: TableShape, acc: TableAccumulator, policyTable: ValueTable, minSamples: number): ValueTable {
  return finalizeTable(s, acc, policyTable.winAtDistance, 1, minSamples);
}

/** What a training pass needs from a policy at each decision point. */
export interface PlanningPolicy {
  /** Plans the decision at the game's current position and fills the fields below. */
  plan(g: Game): void;
  /** Child the move rule picks. */
  move: number;
  /** Whether the policy would cash out here instead of moving. */
  stop: boolean;
  /** Posterior of every child. */
  readonly q: Float64Array;
  /** Region-feature bin of every child (zeros when the feature is off). */
  readonly rb: Int32Array;
}

/**
 * One training pass over games `from .. to - 1`.
 *
 * Each game is walked to its end by the policy's move rule; the cash-out rule never cuts the
 * walk. Every recorded afterstate is credited with the payout the policy, cash-outs included,
 * would have collected from that afterstate on.
 *
 * Half of the games are greedy and record every afterstate. The other half explore: at junction
 * number `j` (uniform in 1 .. 6) a uniformly random child is taken instead of the policy's, and
 * the afterstates from that move on are recorded. An exploring game that ends before it reaches
 * junction `j` records nothing. Recording its afterstates as if it had been a greedy game would
 * select games by how they end (walks that stop early have few junctions and are mostly
 * losses), which biases the early afterstates downward: with that rule the exactness gate
 * measured gaps of 0.00 / 1.30 / 2.52 percentage points on 3×3 / 4×4 / 5×4 for candidate (ii),
 * against 0.00 / 0.04 / 0.14 with this one.
 *
 * Which games explore, and where, depends only on the game's own generator, so every pass over
 * the same games makes the same exploratory choices.
 *
 * `winValue` is the payout credited for reaching the exit: the multiplier in bps, or 1 for the
 * multiplier-free harmonic pass. With `solution` given, the pass also counts `S[d]` over the
 * greedy games.
 */
export function trainGames(
  g: Game,
  policy: PlanningPolicy,
  s: TableShape,
  source: MazeSource,
  from: number,
  to: number,
  acc: TableAccumulator,
  winValue: number,
  solution: SolutionScratch | null,
): void {
  const feed = new MazeFeed(source, g.w, g.h);
  const index = new Int32Array(g.cells);
  const stopAt = new Uint8Array(g.cells);
  const perQ = (s.shortest + 1) * s.rBins;
  const perK = s.qBins * perQ;
  for (let game = from; game < to; game++) {
    feed.load(game);
    const rng = feed.rng;
    const explore = rng.nextBelow(2) === 1;
    const target = 1 + rng.nextBelow(EXPLORE_JUNCTIONS);
    g.begin(feed.open, rng);
    const trackSolution = solution !== null && !explore;
    if (trackSolution) markSolution(g, feed.open, solution);

    let steps = 0;
    let junctions = 0;
    // An exploring game records nothing until its exploratory move.
    let recordFrom = explore ? g.cells : 0;
    let payout = 0;
    for (;;) {
      policy.plan(g);
      let move = policy.move;
      if (g.nc >= 2) {
        junctions += 1;
        if (explore && junctions === target) {
          move = rng.nextBelow(g.nc);
          recordFrom = steps;
        }
      }
      const child = g.childCell[move];
      index[steps] = (g.k + 1) * perK + qBinOf(policy.q[move], s.qBins) * perQ + g.dist[child] * s.rBins + policy.rb[move];
      stopAt[steps] = policy.stop ? 1 : 0;
      steps += 1;
      g.advance(move);
      if (g.cell === g.exit) {
        payout = winValue;
        break;
      }
      if (g.nc === 0) break;
    }

    if (trackSolution) {
      const won = payout > 0 ? 1 : 0;
      for (let t = 0; t <= g.k; t++) {
        const cell = g.path[t];
        if (solution.onPath[cell] === 0) break;
        acc.cntAt[g.dist[cell]] += 1;
        acc.winAt[g.dist[cell]] += won;
      }
    }
    // Walk back: `payout` is the value of the state after move `t`, under the policy.
    for (let t = steps - 1; t >= 0; t--) {
      if (t >= recordFrom) {
        acc.sum[index[t]] += payout;
        acc.cnt[index[t]] += 1;
      }
      if (stopAt[t] === 1) payout = g.refund[t];
    }
  }
}

/** Harmonic walks recorded step by step: the input of the harmonic-lsm backward induction and of the coarse ranking. */
export interface Trajectories {
  games: number;
  /** Moves made by each game. */
  len: Uint8Array;
  /** Moves each game made while still on the solution path. */
  onPath: Uint8Array;
  win: Uint8Array;
  /** Per move, `qBin × 256 + d` of the child moved to; games are concatenated. */
  steps: Uint16Array;
}

/** Records pure harmonic walks (no cash-out, no exploration) of games `from .. to - 1`. */
export function recordTrajectories(g: Game, source: MazeSource, from: number, to: number): Trajectories {
  if (g.cells > 256) throw new RangeError('recordTrajectories: grids above 256 cells are not supported');
  const feed = new MazeFeed(source, g.w, g.h);
  const posterior = new Posterior(g.w, g.h);
  const q = new Float64Array(4);
  const solution = new SolutionScratch(g.cells);
  const games = to - from;
  const len = new Uint8Array(games);
  const onPath = new Uint8Array(games);
  const win = new Uint8Array(games);
  let steps = new Uint16Array(Math.max(16, games * 8));
  let total = 0;
  for (let i = 0; i < games; i++) {
    feed.load(from + i);
    g.begin(feed.open, feed.rng);
    markSolution(g, feed.open, solution);
    if (total + g.cells > steps.length) {
      const grown = new Uint16Array(steps.length * 2 + g.cells);
      grown.set(steps.subarray(0, total));
      steps = grown;
    }
    for (;;) {
      posterior.childPosterior(g, q);
      const move = harmonicChoice(g, q);
      steps[total++] = qBinOf(q[move], Q_BINS) * 256 + g.dist[g.childCell[move]];
      g.advance(move);
      if (g.cell === g.exit) {
        win[i] = 1;
        break;
      }
      if (g.nc === 0) break;
    }
    len[i] = g.k;
    let followed = 0;
    while (followed < g.k && solution.onPath[g.path[followed + 1]] === 1) followed += 1;
    onPath[i] = followed;
  }
  return { games, len, onPath, win, steps: steps.slice(0, total) };
}

export function concatTrajectories(parts: readonly Trajectories[]): Trajectories {
  let games = 0;
  let total = 0;
  for (const part of parts) {
    games += part.games;
    total += part.steps.length;
  }
  const out: Trajectories = {
    games,
    len: new Uint8Array(games),
    onPath: new Uint8Array(games),
    win: new Uint8Array(games),
    steps: new Uint16Array(total),
  };
  let atGame = 0;
  let atStep = 0;
  for (const part of parts) {
    out.len.set(part.len, atGame);
    out.onPath.set(part.onPath, atGame);
    out.win.set(part.win, atGame);
    out.steps.set(part.steps, atStep);
    atGame += part.games;
    atStep += part.steps.length;
  }
  return out;
}

/** `S[d]` measured on recorded harmonic walks. */
export function winAtDistanceFromTrajectories(t: Trajectories, shortest: number, minSamples = MIN_SAMPLES): Float64Array {
  const cntAt = new Float64Array(shortest + 1);
  const winAt = new Float64Array(shortest + 1);
  let at = 0;
  for (let i = 0; i < t.games; i++) {
    const won = t.win[i];
    cntAt[shortest] += 1;
    winAt[shortest] += won;
    for (let step = 0; step < t.onPath[i]; step++) {
      const d = t.steps[at + step] & 255;
      cntAt[d] += 1;
      winAt[d] += won;
    }
    at += t.len[i];
  }
  return winAtDistanceOf(cntAt, winAt, minSamples);
}

/**
 * The harmonic-lsm cash-out table by backward induction over recorded harmonic walks.
 *
 * Levels are processed from the last move to the first. At level `k'` every walk that made at
 * least `k'` moves contributes its current value to the cell of its afterstate; the cell means
 * are the continuation values of that level; then every such walk whose continuation value is
 * below `refund(k' - 1)` takes the refund as its value for the earlier levels. Thin cells fall
 * back to the level pooled over `d`, then to levels `k' .. k' + 2` pooled over `d` (later levels
 * only, because earlier ones are not known yet), then to `binCentre × M × S[d]`.
 *
 * Returns the table and the in-sample mean payout of the resulting policy in bps.
 */
export function harmonicLsmTable(
  t: Trajectories,
  econ: TierEconomics,
  minSamples = MIN_SAMPLES,
): { table: ValueTable; inSampleBps: number } {
  const s = shapeOf(econ.w, econ.h);
  const distances = s.shortest + 1;
  const m = econ.multiplierBps;
  const winAtDistance = winAtDistanceFromTrajectories(t, s.shortest, minSamples);
  const values = new Float64Array(tableLength(s)).fill(Number.NaN);
  const offset = new Float64Array(t.games + 1);
  let maxLen = 0;
  for (let i = 0; i < t.games; i++) {
    offset[i + 1] = offset[i] + t.len[i];
    if (t.len[i] > maxLen) maxLen = t.len[i];
  }
  const value = new Float64Array(t.games);
  for (let i = 0; i < t.games; i++) value[i] = t.win[i] === 1 ? m : 0;

  const cellsPerLevel = s.qBins * distances;
  const sum = new Float64Array(cellsPerLevel);
  const cnt = new Float64Array(cellsPerLevel);
  // Pooled over d for levels k', k' + 1, k' + 2 (ring of three).
  const pooledSum = [new Float64Array(s.qBins), new Float64Array(s.qBins), new Float64Array(s.qBins)];
  const pooledCnt = [new Float64Array(s.qBins), new Float64Array(s.qBins), new Float64Array(s.qBins)];
  const level = new Float64Array(cellsPerLevel);

  for (let k = maxLen; k >= 1; k--) {
    sum.fill(0);
    cnt.fill(0);
    for (let i = 0; i < t.games; i++) {
      if (t.len[i] < k) continue;
      const code = t.steps[offset[i] + k - 1];
      const cell = (code >> 8) * distances + (code & 255);
      sum[cell] += value[i];
      cnt[cell] += 1;
    }
    const ring = k % 3;
    for (let qb = 0; qb < s.qBins; qb++) {
      let ps = 0;
      let pc = 0;
      for (let d = 0; d < distances; d++) {
        ps += sum[qb * distances + d];
        pc += cnt[qb * distances + d];
      }
      pooledSum[ring][qb] = ps;
      pooledCnt[ring][qb] = pc;
      const wideSum = pooledSum[0][qb] + pooledSum[1][qb] + pooledSum[2][qb];
      const wideCnt = pooledCnt[0][qb] + pooledCnt[1][qb] + pooledCnt[2][qb];
      for (let d = 0; d < distances; d++) {
        const cell = qb * distances + d;
        let mean = Number.NaN;
        if (cnt[cell] >= minSamples) mean = sum[cell] / cnt[cell];
        else if (pc >= minSamples) mean = ps / pc;
        else if (wideCnt >= minSamples) mean = wideSum / wideCnt;
        values[tableIndex(s, k, qb, d, 0)] = mean;
        level[cell] = mean === mean ? mean : ((qb + 0.5) / s.qBins) * m * winAtDistance[d];
      }
    }
    const refund = econ.refundBps[k - 1];
    for (let i = 0; i < t.games; i++) {
      if (t.len[i] < k) continue;
      const code = t.steps[offset[i] + k - 1];
      if (level[(code >> 8) * distances + (code & 255)] < refund) value[i] = refund;
    }
  }
  let total = 0;
  for (let i = 0; i < t.games; i++) total += value[i];
  return {
    table: { ...s, values, winAtDistance, binCentreFallback: true },
    inSampleBps: t.games > 0 ? total / t.games : 0,
  };
}

/** `Ŵ[k][d]` of region-heuristic: the win rate of its walks that, after `k` moves, chose a child at distance `d`. */
export interface RegionTable {
  cells: number;
  shortest: number;
  /** Win probability at `k × (shortest + 1) + d`. */
  win: Float64Array;
}

export interface RegionAccumulator {
  win: Float64Array;
  cnt: Float64Array;
}

export function newRegionAccumulator(cells: number, shortest: number): RegionAccumulator {
  return { win: new Float64Array(cells * (shortest + 1)), cnt: new Float64Array(cells * (shortest + 1)) };
}

export function addRegionAccumulator(into: RegionAccumulator, from: RegionAccumulator): void {
  for (let i = 0; i < into.win.length; i++) {
    into.win[i] += from.win[i];
    into.cnt[i] += from.cnt[i];
  }
}

/**
 * Walks games `from .. to - 1` with region-heuristic's move rule and no cash-out rule, counting
 * for every decision `(k, d of the chosen child)` whether the walk went on to reach the exit. A
 * walk ends without a win when it reaches a dead end or no child's region contains the exit.
 */
export function trainRegionGames(
  g: Game,
  region: Region,
  source: MazeSource,
  from: number,
  to: number,
  acc: RegionAccumulator,
): void {
  const feed = new MazeFeed(source, g.w, g.h);
  const distances = g.shortest + 1;
  const visited = new Int32Array(g.cells);
  for (let game = from; game < to; game++) {
    feed.load(game);
    g.begin(feed.open, feed.rng);
    let steps = 0;
    let won = 0;
    for (;;) {
      const move = regionMove(g, region);
      if (move < 0) break;
      visited[steps++] = g.k * distances + g.dist[g.childCell[move]];
      g.advance(move);
      if (g.cell === g.exit) {
        won = 1;
        break;
      }
      if (g.nc === 0) break;
    }
    for (let t = 0; t < steps; t++) {
      acc.cnt[visited[t]] += 1;
      acc.win[visited[t]] += won;
    }
  }
}

/**
 * `Ŵ` from the counts. A cell with fewer than `minSamples` walks takes the value of the nearest
 * `k` (same `d`) that has enough, the smaller `k` on a tie; when no `k` has enough, the rate
 * pooled over every `k` of that `d` (0 when that `d` was never chosen).
 */
export function finalizeRegionTable(acc: RegionAccumulator, cells: number, shortest: number, minSamples = MIN_SAMPLES): RegionTable {
  const distances = shortest + 1;
  const win = new Float64Array(cells * distances);
  for (let d = 0; d < distances; d++) {
    let pooledWin = 0;
    let pooledCnt = 0;
    for (let k = 0; k < cells; k++) {
      pooledWin += acc.win[k * distances + d];
      pooledCnt += acc.cnt[k * distances + d];
    }
    const pooled = pooledCnt > 0 ? pooledWin / pooledCnt : 0;
    for (let k = 0; k < cells; k++) {
      let value = pooled;
      for (let delta = 0; delta < cells; delta++) {
        const lower = (k - delta) * distances + d;
        const upper = (k + delta) * distances + d;
        if (k - delta >= 0 && acc.cnt[lower] >= minSamples) {
          value = acc.win[lower] / acc.cnt[lower];
          break;
        }
        if (k + delta < cells && acc.cnt[upper] >= minSamples) {
          value = acc.win[upper] / acc.cnt[upper];
          break;
        }
      }
      win[k * distances + d] = value;
    }
  }
  return { cells, shortest, win };
}
