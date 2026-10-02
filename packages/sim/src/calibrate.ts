// Calibration (plan §3.8, §9.3): per tier, find the largest evaluated multiplier at which the
// largest 97.5% upper confidence bound of the certified suite on stream A does not exceed the
// ceiling. The policy is retrained at every multiplier that is evaluated.
//
//   1. starting multiplier from the trajectory cache (point estimate only)
//   2. coarse bisection on the first N/16 games of stream A (N/8 for the last tier, which is also
//      the screening sample): point estimate of value-lsm against `ceiling − half-width at N`,
//      warm-starting the table from the previous step, until the bracket is within 1%
//   3. the θ of param-search is searched once at that multiplier and fixed; the whole suite is
//      run on the coarse sample and the bots within 2 points of the leader become contenders
//   4. the contenders are run on all N games of stream A with the canonical (from-scratch) table
//      of that multiplier. U > ceiling → step down by (U − ceiling) / slope + 10 bps and repeat,
//      at most five times. The first multiplier with U <= ceiling is adopted; it is the largest
//      evaluated one that passes because every step goes down.

import { join } from 'node:path';
import { tableHash, type CurveParams, type TuningTable } from '@maze/shared';
import { certifiedSuite, type SuiteMember } from './bots/index';
import { certGamesFromSd, referenceSd } from './bench';
import { cacheKey, canonicalJson, sha256Hex } from './cache';
import { hashFiles, simPackageRoot } from './codehash';
import { BOT_VARIANTS, type BotVariant } from './exact';
import { byTier } from './profile';
import { Blocked, botLabel, tierRef, type BotDef, type CellResult, type Runner, type TierRef } from './runner';
import { searchTheta } from './search';
import { halfWidth95 } from './stats';
import {
  assembleTable,
  makeTier,
  refundTableFor,
  WINDOW_BPS,
  writeMeta,
  writeTableFile,
  type FullEvaluation,
  type ReportPaths,
  type TableMeta,
  type TierMeta,
} from './tables';
import { multiplierForInSample, trajectoryCache } from './trajectory-cache';

/** Bots within this of the coarse-stage leader are evaluated on all of stream A. */
const CONTENDER_MARGIN = 0.02;
/** A step whose observed change in U differs from the slope's prediction by more than this is recorded. */
const DISCONTINUITY = 0.0005;

/**
 * The certified suite of a tier with every table resolved: the canonical value table of the
 * tier's multiplier (shared by value-table and value-lsm), the harmonic-lsm table and the
 * region table. Tables that are not cached yet are trained here.
 */
export async function suiteBots(
  runner: Runner,
  tier: TierRef,
  tierIndex: number,
  variant: BotVariant,
  theta: number[],
): Promise<BotDef[]> {
  const games = byTier(runner.profile.trainGames, tierIndex);
  const valueTable = await runner.valueTableScratch(tier, variant.hyper, variant.rBins, games);
  const harmonicLsm = await runner.harmonicLsm(tier, games);
  const region = await runner.regionTable(tier.econ.w, tier.econ.h, games);
  return certifiedSuite(tier.econ.w + tier.econ.h - 2).map((member: SuiteMember): BotDef => {
    switch (member.bot) {
      case 'region-heuristic':
        return { bot: member.bot, table: region };
      case 'param-search':
        return { bot: member.bot, theta };
      case 'harmonic-lsm':
        return { bot: member.bot, table: harmonicLsm.key };
      case 'value-table':
        return { bot: member.bot, table: valueTable };
      case 'value-lsm':
        return { bot: member.bot, table: valueTable, hyper: variant.hyper };
      case 'value-lookahead-all':
        return { bot: member.bot, table: valueTable };
      case 'rollout':
        return { bot: member.bot, samples: member.samples, table: valueTable };
      default:
        return member;
    }
  });
}

export interface CalibrateTierInput {
  tierIndex: number;
  n: number;
  curve: CurveParams;
  ceilingBps: number;
  /** Certification games of the tier (`N`). */
  games: number;
  variant: BotVariant;
  /** The coarse stage uses N/8 instead of N/16 (last tier: the screening sample). */
  wideCoarse: boolean;
  /** Stop after the reduced-sample stage: no full-`N` evaluation, the tier is only screened. */
  screen: boolean;
}

export interface TierCalibration {
  meta: TierMeta;
  /** The whole suite at the coarse multiplier on the coarse sample of stream A. */
  coarseCells: CellResult[];
}

interface CoarsePoint {
  multiplierBps: number;
  table: string;
  point: number;
  target: number;
}

let startHash: string | null = null;

async function startingMultiplier(runner: Runner, input: CalibrateTierInput, refundBps: number[]): Promise<number> {
  const { n, tierIndex, ceilingBps } = input;
  const target = ceilingBps / 10_000 - byTier(runner.profile.targetHalfWidth, tierIndex);
  startHash ??= hashFiles([join(simPackageRoot(), 'src', 'calibrate.ts'), join(simPackageRoot(), 'src', 'trajectory-cache.ts')], simPackageRoot());
  const key = cacheKey(sha256Hex(canonicalJson({ n, refundBps })), `${runner.codeHash}|${startHash}`, {
    kind: 'starting-multiplier',
    profile: runner.profile.name,
    rng: runner.rngMode,
    games: byTier(runner.profile.trajectoryGames, tierIndex),
    minSamples: runner.profile.minSamples,
    target,
  });
  const cached = runner.store.readArtifact(key);
  if (cached !== null) return cached.meta.multiplierBps as number;
  const trajectories = await trajectoryCache(runner, n, tierIndex);
  runner.checkpoint(`starting multiplier ${n}x${n}`);
  const multiplierBps = multiplierForInSample(trajectories, { w: n, h: n, refundBps }, target, runner.profile.minSamples);
  runner.store.writeArtifact(key, { meta: { kind: 'starting-multiplier', multiplierBps }, arrays: {} });
  return multiplierBps;
}

export async function calibrateTier(runner: Runner, input: CalibrateTierInput): Promise<TierCalibration> {
  const { tierIndex, n, curve, ceilingBps, games, variant } = input;
  const profile = runner.profile;
  const refundBps = refundTableFor(n, curve);
  const tierAt = (multiplierBps: number): TierRef => tierRef({ w: n, h: n, multiplierBps, refundBps });
  const trainGames = byTier(profile.trainGames, tierIndex);
  const coarseGames = Math.max(1, Math.floor(games / (input.wideCoarse ? profile.screenDivisor : profile.coarseDivisor)));
  const ceiling = ceilingBps / 10_000;

  // 1. Starting multiplier.
  const initialMultiplierBps = await startingMultiplier(runner, input, refundBps);

  // 2. Coarse bisection on value-lsm's point estimate.
  const coarse: CoarsePoint[] = [];
  const evaluate = async (multiplierBps: number, parent: string | null): Promise<CoarsePoint> => {
    const tier = tierAt(multiplierBps);
    const table =
      parent === null
        ? await runner.valueTableScratch(tier, variant.hyper, variant.rBins, trainGames)
        : await runner.valueTableWarm(tier, variant.hyper, variant.rBins, trainGames, parent);
    const cell = await runner.evalCell(tier, { bot: 'value-lsm', table, hyper: variant.hyper }, 'A', coarseGames);
    // Where the point estimate sits when U touches the ceiling at the full N.
    const target = ceiling - halfWidth95(cell.rtp.sd, games);
    const point: CoarsePoint = { multiplierBps, table, point: cell.rtp.mean, target };
    coarse.push(point);
    return point;
  };
  let current = await evaluate(initialMultiplierBps, null);
  let lo: CoarsePoint | null = current.point > current.target ? null : current;
  let hi: CoarsePoint | null = current.point > current.target ? current : null;
  for (let step = 0; (lo === null || hi === null) && step < 60; step++) {
    const next = hi !== null ? Math.floor(hi.multiplierBps * 0.97) : Math.ceil(lo!.multiplierBps * 1.03);
    if (next < 10_000) break;
    current = await evaluate(next, current.table);
    if (current.point > current.target) hi = current;
    else lo = current;
  }
  if (lo === null || hi === null) {
    throw new Blocked('economic', `calibration of the ${n}x${n} tier: no multiplier of at least 1.0 brackets the ceiling ${ceilingBps} bps`);
  }
  while (hi.multiplierBps - lo.multiplierBps > 0.01 * lo.multiplierBps) {
    current = await evaluate(Math.floor((lo.multiplierBps + hi.multiplierBps) / 2), current.table);
    if (current.point > current.target) hi = current;
    else lo = current;
  }
  // Interpolate inside the bracket: the excess over the target is close to linear in the multiplier.
  const excessLo = lo.point - lo.target;
  const excessHi = hi.point - hi.target;
  let coarseMultiplierBps = lo.multiplierBps;
  if (excessHi > excessLo) {
    coarseMultiplierBps = Math.floor(lo.multiplierBps - (excessLo * (hi.multiplierBps - lo.multiplierBps)) / (excessHi - excessLo));
    coarseMultiplierBps = Math.min(hi.multiplierBps, Math.max(lo.multiplierBps, coarseMultiplierBps));
  }

  // 3. θ, then the whole suite on the coarse sample.
  const coarseTier = tierAt(coarseMultiplierBps);
  const search = await searchTheta(runner, coarseTier);
  const coarseCells: CellResult[] = [];
  for (const def of await suiteBots(runner, coarseTier, tierIndex, variant, search.theta)) {
    coarseCells.push(await runner.evalCell(coarseTier, def, 'A', coarseGames));
  }
  const leader = Math.max(...coarseCells.map((cell) => cell.rtp.mean));
  const contenders = coarseCells
    .filter((cell) => cell.rtp.mean >= leader - CONTENDER_MARGIN || cell.bot.bot === 'value-lsm')
    .map((cell) => cell.label);

  const meta: TierMeta = {
    tier: tierIndex,
    n,
    curve,
    multiplierBps: coarseMultiplierBps,
    ceilingBps,
    games,
    screened: true,
    coarseGames,
    theta: search.theta,
    thetaMultiplierBps: coarseMultiplierBps,
    initialMultiplierBps,
    coarse: coarse.map(({ multiplierBps, point, target }) => ({ multiplierBps, point, target })),
    contenders,
    evaluations: [],
    windowMissed: false,
    discontinuities: [],
  };
  if (input.screen) return { meta, coarseCells };

  // 4. Full N on stream A.
  const evaluations: FullEvaluation[] = [];
  let multiplierBps = coarseMultiplierBps;
  let adopted: FullEvaluation | null = null;
  for (let attempt = 0; attempt < profile.maxFullEvaluations && multiplierBps >= 10_000; attempt++) {
    const tier = tierAt(multiplierBps);
    const suite = await suiteBots(runner, tier, tierIndex, variant, search.theta);
    let best: CellResult | null = null;
    for (const def of suite) {
      if (!contenders.includes(botLabel(def))) continue;
      const cell = await runner.evalCell(tier, def, 'A', games);
      if (best === null || cell.rtp.ucb > best.rtp.ucb) best = cell;
    }
    if (best === null) throw new RangeError('calibration: no contender to evaluate');
    const evaluation: FullEvaluation = {
      multiplierBps,
      u: best.rtp.ucb,
      best: best.label,
      bestRtp: best.rtp.mean,
      slope: best.winRate,
      pass: best.rtp.ucb <= ceiling,
    };
    const previous = evaluations[evaluations.length - 1];
    if (previous !== undefined) {
      const predicted = (previous.slope * (previous.multiplierBps - multiplierBps)) / 10_000;
      const observed = previous.u - evaluation.u;
      if (Math.abs(observed - predicted) > DISCONTINUITY) {
        meta.discontinuities.push({ fromBps: previous.multiplierBps, toBps: multiplierBps, predicted, observed });
      }
    }
    evaluations.push(evaluation);
    if (evaluation.pass) {
      adopted = evaluation;
      break;
    }
    if (!(evaluation.slope > 0)) {
      throw new Blocked(
        'economic',
        `calibration of the ${n}x${n} tier: ${best.label} has U = ${(100 * evaluation.u).toFixed(3)}% above the ceiling and does not depend on the multiplier`,
      );
    }
    multiplierBps -= Math.ceil(((evaluation.u - ceiling) / evaluation.slope) * 10_000) + 10;
  }
  meta.evaluations = evaluations;
  if (adopted === null) {
    throw new Blocked(
      'economic',
      `calibration of the ${n}x${n} tier: none of the ${evaluations.length} evaluated multipliers has U <= ${ceilingBps} bps ` +
        `(${evaluations.map((e) => `${e.multiplierBps}: ${(100 * e.u).toFixed(3)}%`).join(', ')})`,
    );
  }
  meta.multiplierBps = adopted.multiplierBps;
  meta.screened = false;
  meta.windowMissed = adopted.u < ceiling - WINDOW_BPS / 10_000;
  return { meta, coarseCells };
}

/** What to calibrate: one curve and one ceiling per tier. */
export interface CalibrationSpec {
  name: string;
  sizes: number[];
  curves: CurveParams[];
  ceilingsBps: number[];
  variantLevel: number;
  /** Screen the last tier on the reduced sample instead of calibrating it at the full `N`. */
  screenLast: boolean;
}

export interface CandidateCalibration {
  spec: CalibrationSpec;
  table: TuningTable;
  tablePath: string;
  meta: TableMeta;
  tiers: TierCalibration[];
}

/** Certification games of every tier of a spec, from the measured standard deviations. */
export async function specGames(runner: Runner, paths: ReportPaths, spec: CalibrationSpec): Promise<number[]> {
  const games: number[] = [];
  for (let i = 0; i < spec.sizes.length; i++) {
    games.push(certGamesFromSd(runner.profile, i, await referenceSd(runner, paths, i, spec.sizes[i], spec.curves[i])));
  }
  return games;
}

/**
 * Calibrates every tier of a spec and writes `candidates/<name>.json` (a complete table) and its
 * metadata. The table is marked `calibrated` only when every tier was calibrated at its full `N`
 * under the production profile.
 */
export async function calibrateCandidate(runner: Runner, paths: ReportPaths, spec: CalibrationSpec): Promise<CandidateCalibration> {
  const variant = BOT_VARIANTS[spec.variantLevel];
  const games = await specGames(runner, paths, spec);
  const tiers: TierCalibration[] = [];
  const last = spec.sizes.length - 1;
  for (let i = 0; i < spec.sizes.length; i++) {
    tiers.push(
      await calibrateTier(runner, {
        tierIndex: i,
        n: spec.sizes[i],
        curve: spec.curves[i],
        ceilingBps: spec.ceilingsBps[i],
        games: games[i],
        variant,
        wideCoarse: i === last && spec.sizes.length > 1,
        screen: spec.screenLast && i === last,
      }),
    );
  }
  const fullyCalibrated = tiers.every((tier) => !tier.meta.screened) && runner.profile.name === 'production';
  const table = assembleTable(
    tiers.map((tier, i) => makeTier(i, spec.sizes[i], spec.curves[i], tier.meta.multiplierBps)),
    {
      calibrated: fullyCalibrated,
      ceilingBps: Math.max(...spec.ceilingsBps),
      simCodeHash: runner.codeHash,
      profileName: runner.profile.name,
    },
  );
  const meta: TableMeta = {
    schema: 1,
    tableHash: tableHash(table),
    name: spec.name,
    profile: runner.profile.name,
    simCodeHash: runner.codeHash,
    variantLevel: spec.variantLevel,
    tiers: tiers.map((tier) => tier.meta),
  };
  const tablePath = join(paths.candidates, `${spec.name}.json`);
  writeTableFile(tablePath, table);
  writeMeta(paths, meta);
  return { spec, table, tablePath, meta, tiers };
}
