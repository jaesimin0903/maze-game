// Exact computation on small grids (plan §3.3 exactness gate): every maze of the grid is
// enumerated, so nothing here has Monte Carlo error.

import { join } from 'node:path';
import { buildRefundTable, type CurveParams, type TuningTable } from '@maze/shared';
import { canonicalHyper, VALUE_LSM_HYPER, type ValueHyper } from './bots/index';
import { cacheKey, canonicalJson } from './cache';
import { hashFiles, simPackageRoot } from './codehash';
import type { TierEconomics } from './engine';
import { REGION_BINS } from './lsm';
import { Blocked, tierRef, type Runner } from './runner';

const BIT_N = 1;
const BIT_E = 2;
const BIT_S = 4;
const BIT_W = 8;

export interface EnumeratedMazes {
  w: number;
  h: number;
  /** Number of mazes. */
  count: number;
  /** `count × w × h` open-side masks; maze `i` occupies `[i × cells, (i + 1) × cells)`. Backed by a SharedArrayBuffer. */
  mazes: Uint8Array;
}

/**
 * Every spanning tree of the `w × h` grid whose start cell has exactly one opening, i.e. every
 * maze the generator can produce, each exactly once.
 *
 * The edges are decided in row-major order (a cell's east edge, then its south edge). A partial
 * choice is abandoned as soon as it closes a cycle or seals off a component: when the last edge
 * of a cell has been decided and its component contains no cell with an undecided edge, that
 * component can never join the rest.
 */
export function enumerateCorridorMazes(w: number, h: number): EnumeratedMazes {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2) {
    throw new RangeError(`enumerateCorridorMazes: grid must be at least 2x2, got ${w}x${h}`);
  }
  const cells = w * h;
  const edgeA: number[] = [];
  const edgeB: number[] = [];
  const edgeBitA: number[] = [];
  const edgeBitB: number[] = [];
  for (let cell = 0; cell < cells; cell++) {
    if (cell % w < w - 1) {
      edgeA.push(cell);
      edgeB.push(cell + 1);
      edgeBitA.push(BIT_E);
      edgeBitB.push(BIT_W);
    }
    if (cell + w < cells) {
      edgeA.push(cell);
      edgeB.push(cell + w);
      edgeBitA.push(BIT_S);
      edgeBitB.push(BIT_N);
    }
  }
  const edges = edgeA.length;
  // Cells whose last incident edge is edge `e` become "closed" once `e` is decided.
  const lastEdge = new Int32Array(cells).fill(-1);
  for (let e = 0; e < edges; e++) {
    lastEdge[edgeA[e]] = e;
    lastEdge[edgeB[e]] = e;
  }
  const closing: number[][] = Array.from({ length: edges }, () => []);
  for (let cell = 0; cell < cells; cell++) closing[lastEdge[cell]].push(cell);

  const parent = new Int32Array(cells);
  const size = new Int32Array(cells).fill(1);
  /** Cells of the component that still have an undecided edge (valid at roots). */
  const live = new Int32Array(cells).fill(1);
  for (let cell = 0; cell < cells; cell++) parent[cell] = cell;
  const open = new Uint8Array(cells);

  let capacity = 1024;
  let buffer = new Uint8Array(new SharedArrayBuffer(capacity * cells));
  let count = 0;

  const find = (cell: number): number => {
    while (parent[cell] !== cell) cell = parent[cell];
    return cell;
  };

  /** Closes the cells whose last edge is `e`; false when that seals off a component. */
  const close = (e: number): boolean => {
    let ok = true;
    for (const cell of closing[e]) {
      const root = find(cell);
      live[root] -= 1;
      if (live[root] === 0 && size[root] < cells) ok = false;
    }
    return ok;
  };
  const reopen = (e: number): void => {
    for (const cell of closing[e]) live[find(cell)] += 1;
  };

  const decide = (e: number): void => {
    if (e === edges) {
      if (count === capacity) {
        capacity *= 2;
        const grown = new Uint8Array(new SharedArrayBuffer(capacity * cells));
        grown.set(buffer);
        buffer = grown;
      }
      buffer.set(open, count * cells);
      count += 1;
      return;
    }
    const a = edgeA[e];
    const b = edgeB[e];
    // Start corridor: edges 0 and 1 are the start cell's east and south edges; exactly one is open.
    const eastOpen = (open[0] & BIT_E) !== 0;
    const mayInclude = e !== 1 || !eastOpen;
    const mayExclude = e !== 1 || eastOpen;

    if (mayInclude) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) {
        const big = size[ra] >= size[rb] ? ra : rb;
        const small = big === ra ? rb : ra;
        parent[small] = big;
        size[big] += size[small];
        live[big] += live[small];
        open[a] |= edgeBitA[e];
        open[b] |= edgeBitB[e];
        if (close(e)) decide(e + 1);
        reopen(e);
        open[a] &= ~edgeBitA[e];
        open[b] &= ~edgeBitB[e];
        live[big] -= live[small];
        size[big] -= size[small];
        parent[small] = small;
      }
    }
    if (mayExclude) {
      if (close(e)) decide(e + 1);
      reopen(e);
    }
  };
  decide(0);

  const mazes = new Uint8Array(new SharedArrayBuffer(Math.max(1, count * cells)));
  mazes.set(buffer.subarray(0, count * cells));
  return { w, h, count, mazes };
}

export interface ExactValue {
  /** Mazes enumerated. */
  count: number;
  /** Sum over all mazes of the payout in bps. Exact: every term is an integer. */
  totalBps: number;
  /** The same restricted to mazes whose start cell opens east / south. */
  eastCount: number;
  eastBps: number;
  southCount: number;
  southBps: number;
}

/** Mean payout as a fraction of the bet. */
export function exactRtp(v: ExactValue): number {
  return v.totalBps / v.count / 10_000;
}

/**
 * `exact-optimal`: expectimax over every information state. A state is the set of mazes that
 * agree with everything the player has seen; its value is the larger of cashing out now and of
 * the best child, where a child's value is the sum over what the child's walls can turn out to
 * be. Values are kept as sums of bps over the mazes of the state, which are integers.
 */
export function exactOptimal(e: EnumeratedMazes, econ: TierEconomics): ExactValue {
  const { w, h, count, mazes } = e;
  const cells = w * h;
  if (econ.w !== w || econ.h !== h) throw new RangeError('exactOptimal: economics are for a different grid');
  const exit = cells - 1;
  const m = econ.multiplierBps;
  const refund = econ.refundBps;
  const order = new Int32Array(count);
  const scratch = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  const offset = [-w, 1, w, -1];
  const bit = [BIT_N, BIT_E, BIT_S, BIT_W];
  const backOf = [BIT_S, BIT_W, BIT_N, BIT_E];
  // One set of bucket bounds per depth of the recursion.
  const bounds: Int32Array[] = Array.from({ length: cells + 1 }, () => new Int32Array(17));

  /** Groups `order[lo .. hi)` by the mask at `cell`; fills `bound` with the 17 bucket limits. */
  const partition = (lo: number, hi: number, cell: number, bound: Int32Array): void => {
    bound.fill(0);
    for (let i = lo; i < hi; i++) bound[mazes[order[i] * cells + cell] + 1] += 1;
    let at = lo;
    for (let v = 0; v <= 16; v++) {
      const n = bound[v];
      bound[v] = at;
      at += n;
    }
    // bound[v + 1] is now the start of bucket v; advance it while scattering.
    for (let i = lo; i < hi; i++) {
      const v = mazes[order[i] * cells + cell];
      scratch[bound[v + 1]++] = order[i];
    }
    for (let i = lo; i < hi; i++) order[i] = scratch[i];
    // After the scatter bound[v + 1] is the end of bucket v and bound[v] its start.
  };

  /** Value (sum of bps) of the state `order[lo .. hi)` standing on `cell` after `k` moves. */
  const value = (lo: number, hi: number, cell: number, backBit: number, k: number): number => {
    const forward = mazes[order[lo] * cells + cell] & ~backBit;
    let best = refund[k] * (hi - lo);
    for (let dir = 0; dir < 4; dir++) {
      if ((forward & bit[dir]) === 0) continue;
      const child = cell + offset[dir];
      let total = 0;
      if (child === exit) {
        total = m * (hi - lo);
      } else {
        const bound = bounds[k + 1];
        partition(lo, hi, child, bound);
        const childBack = backOf[dir];
        for (let v = 0; v < 16; v++) {
          const from = bound[v];
          const to = bound[v + 1];
          // A child with no opening besides the one we came through is a dead end: nothing.
          if (to > from && (v & ~childBack) !== 0) total += value(from, to, child, childBack, k + 1);
        }
      }
      if (total > best) best = total;
    }
    return best;
  };

  const top = new Int32Array(17);
  partition(0, count, 0, top);
  const result: ExactValue = { count, totalBps: 0, eastCount: 0, eastBps: 0, southCount: 0, southBps: 0 };
  const starts = Int32Array.from(top);
  for (let v = 0; v < 16; v++) {
    const from = starts[v];
    const to = starts[v + 1];
    if (to === from) continue;
    const total = value(from, to, 0, 0, 0);
    result.totalBps += total;
    if (v === BIT_E) {
      result.eastCount = to - from;
      result.eastBps = total;
    } else if (v === BIT_S) {
      result.southCount = to - from;
      result.southBps = total;
    } else {
      throw new RangeError('exactOptimal: a maze has a start cell without a start corridor');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Exactness gate (plan §3.3, AC-T1, AC-X8)
// ---------------------------------------------------------------------------------------------

/** The grids on which the optimum can be computed exactly. */
export const EXACT_GRIDS: readonly (readonly [number, number])[] = [
  [3, 3],
  [4, 4],
  [5, 4],
];
/** value-lsm is calibrated to this exact RTP before the optimum is measured. */
export const EXACT_TARGET_BPS = 9600;
/** The gate passes when the optimum exceeds the target by at most this on every grid. */
export const EXACT_GAP_LIMIT = 0.005;
/** Failure branch 2 is available up to this gap … */
export const EXACT_GAP_HARD_LIMIT = 0.02;
/** … provided the gap does not grow from 4×4 to 5×4 by more than this. */
export const EXACT_GAP_GROWTH_LIMIT = 0.0025;
/** AC-X8: start directions are symmetric on square grids, and measurably not on 5×4. */
export const SYMMETRY_TOLERANCE = 1e-9;
export const ASYMMETRY_MINIMUM = 1e-6;

/**
 * value-lsm and its improvements, in the fixed order of failure branch 1: (a) lookahead at
 * every decision, (b) near-tie threshold 0.4, (c) region feature in the afterstate. They are
 * cumulative. Under (a) every child is already looked ahead, so (b) cannot change a decision;
 * level 2 therefore has the same canonical hyperparameters, and the same cached results, as
 * level 1.
 */
export interface BotVariant {
  level: 0 | 1 | 2 | 3;
  label: string;
  hyper: ValueHyper;
  rBins: number;
}

export const BOT_VARIANTS: readonly BotVariant[] = [
  { level: 0, label: 'production (lookahead on near-ties within 0.2)', hyper: VALUE_LSM_HYPER, rBins: 1 },
  { level: 1, label: '(a) lookahead at every decision', hyper: canonicalHyper({ lookahead: 'all', threshold: 0.2 }), rBins: 1 },
  { level: 2, label: '(a) + (b) threshold 0.4 (no effect under (a))', hyper: canonicalHyper({ lookahead: 'all', threshold: 0.4 }), rBins: 1 },
  { level: 3, label: '(a) + (b) + (c) region feature', hyper: canonicalHyper({ lookahead: 'all', threshold: 0.4 }), rBins: REGION_BINS },
];

export interface GridGate {
  w: number;
  h: number;
  mazes: number;
  curve: CurveParams;
  /** Largest evaluated multiplier at which value-lsm's exact RTP does not exceed the target. */
  multiplierBps: number;
  /** Exact RTP of value-lsm at that multiplier. */
  botRtp: number;
  /** Exact RTP of the optimal policy at that multiplier. */
  optimalRtp: number;
  /** `g` of the plan: optimal RTP minus the 96.00% target. */
  gap: number;
  /** Optimal RTP minus the bot's RTP. Equals `gap` up to the resolution of the calibration. */
  gapToBot: number;
  /** Optimal value by start direction, as a fraction of the bet. */
  optimalEast: number;
  optimalSouth: number;
  trainGames: number;
  evaluations: { multiplierBps: number; botRtp: number }[];
}

const enumerations = new Map<string, EnumeratedMazes>();

/** Enumerations are deterministic and reused within a process. */
export function enumeratedGrid(w: number, h: number): EnumeratedMazes {
  const id = `${w}x${h}`;
  let e = enumerations.get(id);
  if (e === undefined) {
    e = enumerateCorridorMazes(w, h);
    enumerations.set(id, e);
  }
  return e;
}

/**
 * The gate on one grid for one curve. The curve's (e0, a, φ) is applied to the grid with
 * `L = w + h - 2`. value-lsm is trained with production hyperparameters on the full set of
 * mazes (every maze equally often, at least `profile.exactTrainGames` games per pass) and the
 * multiplier is moved until its exact RTP is the target; then the exact optimum is measured.
 */
export async function exactGateGrid(runner: Runner, curve: CurveParams, w: number, h: number, variant: BotVariant): Promise<GridGate> {
  const resultKey = cacheKey('exact-gate', `${runner.codeHash}|${exactSourceHash()}`, {
    profile: runner.profile.name,
    curve,
    w,
    h,
    hyper: variant.hyper,
    rBins: variant.rBins,
    targetBps: EXACT_TARGET_BPS,
    trainGames: runner.profile.exactTrainGames,
    trainPasses: runner.profile.trainPasses,
    minSamples: runner.profile.minSamples,
  });
  const cached = runner.store.readArtifact(resultKey);
  if (cached !== null) return cached.meta.result as GridGate;

  const e = enumeratedGrid(w, h);
  const cells = w * h;
  const refundBps = buildRefundTable({ cells, shortestPath: w + h - 2, curve });
  const trainGames = Math.ceil(runner.profile.exactTrainGames / e.count) * e.count;
  const target = EXACT_TARGET_BPS / 10_000;
  const evaluations: { multiplierBps: number; botRtp: number }[] = [];

  const botRtpAt = async (multiplierBps: number): Promise<number> => {
    const tier = tierRef({ w, h, multiplierBps, refundBps });
    const table = await runner.valueTableScratch(tier, variant.hyper, variant.rBins, trainGames, e);
    const cell = await runner.evalCell(tier, { bot: 'value-lsm', table, hyper: variant.hyper }, 'B', e.count, e);
    const rtp = cell.stats.sum / e.count / 10_000;
    evaluations.push({ multiplierBps, botRtp: rtp });
    return rtp;
  };

  // Harmonic without a cash-out rule returns M × p, so the answer lies near (and below) target / p.
  const harmonic = await runner.evalCell(tierRef({ w, h, multiplierBps: 10_000, refundBps }), { bot: 'harmonic' }, 'B', e.count, e);
  let hi = Math.max(10_001, Math.ceil((target / harmonic.winRate) * 10_000));
  let fHi = await botRtpAt(hi);
  let lo = -1;
  let fLo = 0;
  while (!(fHi > target)) {
    lo = hi;
    fLo = fHi;
    hi = Math.ceil(hi * 1.05);
    fHi = await botRtpAt(hi);
  }
  if (lo === -1) {
    lo = Math.max(10_000, Math.floor(hi * 0.9));
    fLo = await botRtpAt(lo);
    while (fLo > target) {
      if (lo === 10_000) throw new Blocked('economic', `exactness gate ${w}x${h}: value-lsm exceeds the target even at a multiplier of 1.0`);
      hi = lo;
      fHi = fLo;
      lo = Math.max(10_000, Math.floor(lo * 0.9));
      fLo = await botRtpAt(lo);
    }
  }
  // Alternate interpolation and bisection until the bracket is one basis point wide or the
  // lower end is within 0.002 percentage points of the target.
  for (let step = 0; hi - lo > 1 && target - fLo > 2e-5 && step < 80; step++) {
    let mid = Math.floor((lo + hi) / 2);
    if (step % 2 === 0 && fHi > fLo) {
      mid = Math.round(lo + ((hi - lo) * (target - fLo)) / (fHi - fLo));
      mid = Math.min(hi - 1, Math.max(lo + 1, mid));
    }
    const fMid = await botRtpAt(mid);
    if (fMid > target) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }

  const optimal = exactOptimal(e, { w, h, multiplierBps: lo, refundBps });
  const optimalRtp = exactRtp(optimal);
  const result: GridGate = {
    w,
    h,
    mazes: e.count,
    curve,
    multiplierBps: lo,
    botRtp: fLo,
    optimalRtp,
    gap: optimalRtp - target,
    gapToBot: optimalRtp - fLo,
    optimalEast: optimal.eastBps / optimal.eastCount / 10_000,
    optimalSouth: optimal.southBps / optimal.southCount / 10_000,
    trainGames,
    evaluations,
  };
  runner.store.writeArtifact(resultKey, { meta: { kind: 'exact-gate', result }, arrays: {} });
  return result;
}

export type ExactBranch = 'pass' | 'improve-bot' | 'lower-ceiling' | 'blocked';

export interface ExactGateReport {
  schema: 1;
  profile: string;
  simCodeHash: string;
  variant: BotVariant;
  targetBps: number;
  grids: GridGate[];
  /** Largest gap per grid over the table's curves, keyed `3x3`, `4x4`, `5x4`. */
  gaps: Record<string, number>;
  gapMax: number;
  /** All gaps are within 0.50 percentage points. */
  pass: boolean;
  /**
   * What the result means: `pass`; `improve-bot` (a stronger variant has not been tried yet);
   * `lower-ceiling` (branch 2: calibrate to `ceilingBps` with `e0Bps`); `blocked` (branch 3).
   */
  branch: ExactBranch;
  /** Branch 2 values: `min(9600, 9650 - gapMax)` and `max(500, 10000 - ceilingBps + 100)`. */
  ceilingBps: number;
  e0Bps: number;
  /** AC-X8: optimal values by start direction agree on square grids and differ on 5×4. */
  symmetry: { pass: boolean; squareMaxDifference: number; rectangleMinDifference: number };
}

/** Distinct curves of a table, in tier order. */
export function distinctCurves(table: TuningTable): CurveParams[] {
  const seen = new Set<string>();
  const out: CurveParams[] = [];
  for (const tier of table.tiers) {
    const id = canonicalJson(tier.curve);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(tier.curve);
    }
  }
  return out;
}

/**
 * The verdict of the gate from the largest gap per grid (`3x3`, `4x4`, `5x4`) and the bot level
 * that produced them (plan §3.3):
 *   every gap <= 0.50 points                                   → pass
 *   otherwise, a bot improvement is still untried (level < 3)   → improve-bot   (branch 1)
 *   otherwise, largest gap <= 2.0 points and the 5×4 gap is at
 *   most the 4×4 gap + 0.25 points                              → lower-ceiling (branch 2)
 *   otherwise                                                   → blocked       (branch 3)
 * Branch 2 calibrates to `min(9600, 9650 − largest gap)` bps and raises e0 to
 * `max(500, 10000 − ceiling + 100)` bps so that the play premium stays positive.
 */
export function exactBranch(
  gaps: Record<string, number>,
  level: number,
): { gapMax: number; pass: boolean; branch: ExactBranch; ceilingBps: number; e0Bps: number } {
  const gapMax = Math.max(...Object.values(gaps));
  const pass = gapMax <= EXACT_GAP_LIMIT;
  let branch: ExactBranch = 'pass';
  if (!pass) {
    if (level < 3) branch = 'improve-bot';
    else if (gapMax <= EXACT_GAP_HARD_LIMIT && gaps['5x4'] <= gaps['4x4'] + EXACT_GAP_GROWTH_LIMIT) branch = 'lower-ceiling';
    else branch = 'blocked';
  }
  const ceilingBps = Math.min(EXACT_TARGET_BPS, Math.floor(9650 - Math.max(0, gapMax) * 10_000));
  return { gapMax, pass, branch, ceilingBps, e0Bps: Math.max(500, 10_000 - ceilingBps + 100) };
}

/** The exactness gate for a set of curves at one bot variant. */
export async function exactGate(runner: Runner, curves: readonly CurveParams[], variant: BotVariant): Promise<ExactGateReport> {
  const grids: GridGate[] = [];
  for (const curve of curves) {
    for (const [w, h] of EXACT_GRIDS) grids.push(await exactGateGrid(runner, curve, w, h, variant));
  }
  const gaps: Record<string, number> = {};
  let squareMaxDifference = 0;
  let rectangleMinDifference = Number.POSITIVE_INFINITY;
  for (const grid of grids) {
    const id = `${grid.w}x${grid.h}`;
    gaps[id] = Math.max(gaps[id] ?? Number.NEGATIVE_INFINITY, grid.gap);
    const difference = Math.abs(grid.optimalEast - grid.optimalSouth);
    if (grid.w === grid.h) squareMaxDifference = Math.max(squareMaxDifference, difference);
    else rectangleMinDifference = Math.min(rectangleMinDifference, difference);
  }
  const verdict = exactBranch(gaps, variant.level);
  return {
    schema: 1,
    profile: runner.profile.name,
    simCodeHash: runner.codeHash,
    variant,
    targetBps: EXACT_TARGET_BPS,
    grids,
    gaps,
    ...verdict,
    symmetry: {
      pass: squareMaxDifference <= SYMMETRY_TOLERANCE && rectangleMinDifference > ASYMMETRY_MINIMUM,
      squareMaxDifference,
      rectangleMinDifference,
    },
  };
}

let exactHash: string | null = null;

/** Hash of this file: gate results are cached, and this file is outside the simulator code hash. */
function exactSourceHash(): string {
  exactHash ??= hashFiles([join(simPackageRoot(), 'src', 'exact.ts')], simPackageRoot());
  return exactHash;
}
