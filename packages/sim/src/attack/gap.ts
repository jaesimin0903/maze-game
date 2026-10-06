// The exact gap trend beyond the exactness gate's grids (3×3, 4×4, 5×4).
//
// For a grid and a refund curve: value-lsm (production hyperparameters, its table retrained at
// every multiplier from scratch on stream C, as the exactness gate does) is calibrated so that
// its EXACT return, computed by the information-state DP, is 96.00%; the exact optimum is then
// computed at that multiplier. The bisection follows `exactGateGrid` in exact.ts: the result is
// the largest evaluated multiplier at which value-lsm does not exceed the target, and the search
// stops when the bracket is one basis point wide or that multiplier is within 0.002 points.

import { buildRefundTable, type CurveParams } from '@maze/shared';
import { VALUE_LSM_HYPER } from '../bots/index';
import type { ChunkStats, TierEconomics } from '../engine';
import { tierRef, type Runner } from '../runner';
import type { InfoStateResult } from './infostate';
import { TRAIN_FIRST, TRAIN_STREAM } from './paired';
import type { AttackExecutor } from './pool';

export const TREND_TARGET = 0.96;

export interface TrendSpec {
  w: number;
  h: number;
  curve: CurveParams;
  curveLabel: string;
  /** Stream C games per training pass of value-lsm. */
  trainGames: number;
  maxStates: number;
}

export interface TrendEvaluation {
  multiplierBps: number;
  botRtp: number;
  states: number;
  seconds: number;
}

export interface TrendResult {
  w: number;
  h: number;
  curveLabel: string;
  curve: CurveParams;
  trainGames: number;
  multiplierBps: number;
  /** Exact RTP of value-lsm and of the optimum at that multiplier. */
  botRtp: number;
  optimalRtp: number;
  /** Optimum minus the 96.00% target, and optimum minus value-lsm. */
  gap: number;
  gapToBot: number;
  botWin: number;
  optimalWin: number;
  optimalStates: number;
  optimalBytes: number;
  optimalSeconds: number;
  evaluations: TrendEvaluation[];
  seconds: number;
}

/** Win rate of `harmonic` (never cashes out) on `games` training-range mazes: brackets the multiplier. */
export async function harmonicWinRate(pool: AttackExecutor, econ: TierEconomics, games: number): Promise<number> {
  const parts = 8;
  const size = Math.ceil(games / parts);
  const stats: ChunkStats[] = await Promise.all(
    Array.from({ length: parts }, (_, p) =>
      pool.run({
        kind: 'eval',
        econ,
        bot: { bot: 'harmonic' },
        source: { kind: 'rng', mode: 'fast', stream: TRAIN_STREAM },
        from: TRAIN_FIRST + p * size,
        to: TRAIN_FIRST + (p + 1) * size,
      }),
    ),
  );
  let wins = 0;
  let n = 0;
  for (const s of stats) {
    wins += s.wins;
    n += s.n;
  }
  return wins / n;
}

export async function calibrateTrend(
  pool: AttackExecutor,
  runner: Runner,
  spec: TrendSpec,
  log: (line: string) => void,
): Promise<TrendResult> {
  const started = Date.now();
  const { w, h, curve } = spec;
  const cells = w * h;
  const refundBps = buildRefundTable({ cells, shortestPath: w + h - 2, curve });
  const label = `${w}x${h} ${spec.curveLabel}`;
  const evaluations: TrendEvaluation[] = [];
  const results = new Map<number, InfoStateResult>();

  const botAt = async (multiplierBps: number): Promise<number> => {
    const econ: TierEconomics = { w, h, multiplierBps, refundBps };
    const key = await runner.valueTableScratch(tierRef(econ), VALUE_LSM_HYPER, 1, spec.trainGames);
    const table = runner.loadTable(key);
    const result = await pool.runAttack({ kind: 'attack-dp', econ, bot: { kind: 'value-lsm', table }, options: { maxStates: spec.maxStates } });
    results.set(multiplierBps, result);
    evaluations.push({ multiplierBps, botRtp: result.rtp, states: result.states, seconds: result.seconds });
    log(`trend ${label}: value-lsm at ${multiplierBps} bps = ${(100 * result.rtp).toFixed(5)}% (${result.states} states, ${result.seconds.toFixed(1)}s)`);
    return result.rtp;
  };

  const target = TREND_TARGET;
  const win = await harmonicWinRate(pool, { w, h, multiplierBps: 10_000, refundBps }, 200_000);
  let hi = Math.max(10_001, Math.ceil((target / win) * 10_000));
  let fHi = await botAt(hi);
  let lo = -1;
  let fLo = 0;
  while (!(fHi > target)) {
    lo = hi;
    fLo = fHi;
    hi = Math.ceil(hi * 1.05);
    fHi = await botAt(hi);
  }
  if (lo === -1) {
    lo = Math.max(10_000, Math.floor(hi * 0.9));
    fLo = await botAt(lo);
    while (fLo > target) {
      if (lo === 10_000) throw new Error(`trend ${label}: value-lsm exceeds the target even at a multiplier of 1.0`);
      hi = lo;
      fHi = fLo;
      lo = Math.max(10_000, Math.floor(lo * 0.9));
      fLo = await botAt(lo);
    }
  }
  for (let step = 0; hi - lo > 1 && target - fLo > 2e-5 && step < 80; step++) {
    let mid = Math.floor((lo + hi) / 2);
    if (step % 2 === 0 && fHi > fLo) {
      mid = Math.round(lo + ((hi - lo) * (target - fLo)) / (fHi - fLo));
      mid = Math.min(hi - 1, Math.max(lo + 1, mid));
    }
    const fMid = await botAt(mid);
    if (fMid > target) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  const econ: TierEconomics = { w, h, multiplierBps: lo, refundBps };
  const optimum = await pool.runAttack({ kind: 'attack-dp', econ, bot: null, options: { maxStates: spec.maxStates, mirror: w === h } });
  const bot = results.get(lo)!;
  log(
    `trend ${label}: multiplier ${lo} bps, value-lsm ${(100 * bot.rtp).toFixed(5)}%, optimum ${(100 * optimum.rtp).toFixed(5)}% ` +
      `(gap ${(100 * (optimum.rtp - target)).toFixed(4)}%p, ${optimum.states} states, ${optimum.seconds.toFixed(1)}s)`,
  );
  return {
    w,
    h,
    curveLabel: spec.curveLabel,
    curve,
    trainGames: spec.trainGames,
    multiplierBps: lo,
    botRtp: bot.rtp,
    optimalRtp: optimum.rtp,
    gap: optimum.rtp - target,
    gapToBot: optimum.rtp - bot.rtp,
    botWin: bot.winRate,
    optimalWin: optimum.winRate,
    optimalStates: optimum.states,
    optimalBytes: optimum.bytes,
    optimalSeconds: optimum.seconds,
    evaluations,
    seconds: (Date.now() - started) / 1000,
  };
}
