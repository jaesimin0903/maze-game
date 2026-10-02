// The simulation backend of `tune`: the exactness gate, calibration, certification and the
// coarse ranking of search points, each on top of the resumable runner.

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CurveParams } from '@maze/shared';
import { ASSUMPTIONS, type Assumptions } from './assumptions';
import { calibrateCandidate, type CalibrationSpec, type TierCalibration } from './calibrate';
import { cacheKey } from './cache';
import { certifyTable, type TierCertification } from './certify';
import { hashFiles, simPackageRoot } from './codehash';
import { tierEngagement, type PopulationRtp } from './engagement';
import { BOT_VARIANTS, exactGate, type ExactGateReport } from './exact';
import type { Trajectories } from './lsm';
import { byTier } from './profile';
import type { CellResult, Runner } from './runner';
import {
  GATE1_BPS,
  refundTableFor,
  SEARCH_A_BPS,
  SEARCH_PHI,
  writeJsonFile,
  type ReportPaths,
  type TierMeta,
} from './tables';
import { inSampleRtp, largestMultiplierBelow, trajectoryCache } from './trajectory-cache';
import type { CandidateRun, Evaluation, PointEstimate, TierSummary, TuneBackend, TuneResult } from './tune';

/** The coarse ranking prices each grid point on at most this many recorded walks. */
const RANKING_WALKS = 1_000_000;

function cashRate(cash: readonly number[], games: number): number[] {
  return cash.map((count) => count / games);
}

/** Summary of a certified tier. */
export function summarizeCertified(tier: TierCertification, meta: TierMeta): TierSummary {
  const cell = (prefix: string): TierCertification['cells'][number] => {
    const found = tier.cells.find((entry) => entry.bot === prefix || entry.bot.startsWith(`${prefix}(`));
    if (found === undefined) throw new RangeError(`certification of tier ${tier.tier} has no ${prefix} cell`);
    return found;
  };
  const nervous = cell('nervous');
  const failedGates: string[] = [];
  if (!tier.gates.gate1.pass) failedGates.push(`fixed gate 1 (${tier.gates.gate1.worst} UCB ${(100 * tier.gates.gate1.value).toFixed(3)}%)`);
  if (!tier.gates.gate2.pass) failedGates.push(`fixed gate 2 (${tier.gates.gate2.worst} UCB ${(100 * tier.gates.gate2.value).toFixed(3)}%)`);
  if (!tier.calibration.pass) failedGates.push(`calibration claim on stream A (${tier.calibration.status})`);
  if (!tier.gates.bestPoint.pass) {
    const value = tier.gates.bestPoint.value;
    failedGates.push(`best bot point estimate on stream A ${value === null ? 'unavailable' : `${(100 * value).toFixed(3)}%`} outside [94%, 96%]`);
  }
  if (!tier.gates.playPremium.pass) failedGates.push(`N1 play premium ${(100 * tier.gates.playPremium.value).toFixed(3)}% not positive`);
  if (!tier.gates.startSymmetry.pass) failedGates.push('start-direction symmetry (AC-X8)');
  return {
    tier: tier.tier,
    n: tier.n,
    curve: meta.curve,
    multiplierBps: tier.multiplierBps,
    ceilingBps: meta.ceilingBps,
    games: tier.games,
    basis: 'certified',
    stream: 'B',
    sampleGames: tier.games,
    population: tier.population,
    bestBot: tier.best.bot,
    bestRtp: tier.best.rtp,
    bestHalfWidth: tier.best.ucb975 - tier.best.rtp,
    bestUcb: tier.best.ucb975,
    engagement: tier.engagement,
    windowMissed: tier.calibration.windowMissed,
    pass: tier.pass,
    failedGates,
    gate1Value: tier.gates.gate1.value,
    gate1Limit: tier.gates.gate1.limit,
    adversaries: tier.pairs.map((pair) => ({
      name: pair.adversary,
      rtp: pair.rtp,
      ucb975: pair.ucb975,
      meanDiff: pair.meanDiff,
      diffLcb: pair.diffLcb,
      halfWidthDiff: pair.halfWidthDiff,
      pairs: pair.pairs,
      capped: pair.capped,
    })),
    winRates: { naive: cell('naive-greedy').winRate, sloppy: cell('sloppy-greedy').winRate, randomWalk: cell('random-walk').winRate, nervous: nervous.winRate },
    nervousCashRate: cashRate(nervous.cash, nervous.games),
  };
}

/** Summary of a tier that was only screened: point estimates on the reduced sample of stream A, no gate judged. */
export function summarizeScreened(calibration: TierCalibration, assumptions: Assumptions, sessions: number): TierSummary {
  const meta = calibration.meta;
  const cells = calibration.coarseCells;
  const cell = (name: string): CellResult => {
    const found = cells.find((entry) => entry.bot.bot === name);
    if (found === undefined) throw new RangeError(`screening of tier ${meta.tier} has no ${name} cell`);
    return found;
  };
  const best = cells.reduce((a, b) => (b.rtp.ucb > a.rtp.ucb ? b : a));
  const naive = cell('naive-greedy');
  const sloppy = cell('sloppy-greedy');
  const nervous = cell('nervous');
  const randomWalk = cell('random-walk');
  const econ = { w: meta.n, h: meta.n, multiplierBps: meta.multiplierBps, refundBps: refundTableFor(meta.n, meta.curve) };
  const population: PopulationRtp = {
    'naive-greedy': { rtp: naive.rtp.mean, se: naive.rtp.se },
    'sloppy-greedy': { rtp: sloppy.rtp.mean, se: sloppy.rtp.se },
    nervous: { rtp: nervous.rtp.mean, se: nervous.rtp.se },
    'random-walk': { rtp: randomWalk.rtp.mean, se: randomWalk.rtp.se },
    best: { rtp: best.rtp.mean, se: best.rtp.se },
  };
  return {
    tier: meta.tier,
    n: meta.n,
    curve: meta.curve,
    multiplierBps: meta.multiplierBps,
    ceilingBps: meta.ceilingBps,
    games: meta.games,
    basis: 'screened',
    stream: 'A',
    sampleGames: meta.coarseGames,
    population,
    bestBot: best.label,
    bestRtp: best.rtp.mean,
    bestHalfWidth: best.rtp.halfWidth,
    bestUcb: best.rtp.ucb,
    engagement: tierEngagement(
      meta.tier,
      econ,
      { naive: naive.stats, sloppy: sloppy.stats, best: best.stats, reference: cell('value-lsm').stats },
      assumptions,
      sessions,
    ),
    windowMissed: false,
    pass: null,
    failedGates: [],
    gate1Value: null,
    gate1Limit: GATE1_BPS / 10_000,
    adversaries: [],
    winRates: { naive: naive.winRate, sloppy: sloppy.winRate, randomWalk: randomWalk.winRate, nervous: nervous.winRate },
    nervousCashRate: cashRate(nervous.stats.cash, nervous.stats.n),
  };
}

function prefix(t: Trajectories, games: number): Trajectories {
  if (t.games <= games) return t;
  let steps = 0;
  for (let i = 0; i < games; i++) steps += t.len[i];
  return { games, len: t.len.subarray(0, games), onPath: t.onPath.subarray(0, games), win: t.win.subarray(0, games), steps: t.steps.subarray(0, steps) };
}

let campaignHash: string | null = null;

/**
 * Coarse ranking of the grid points of every tier against a finalized baseline. A point's
 * multiplier is the one at which harmonic-lsm's in-sample value on the trajectory cache equals
 * what the baseline's certified multiplier gives under the baseline curve; the casual bots'
 * RTP then follows from their curve-independent behaviour (win rates and nervous's cash-out
 * steps) measured in the baseline's cells. The best bot is taken as unchanged.
 */
export async function rankPoints(runner: Runner, baseline: CandidateRun, assumptions: Assumptions): Promise<PointEstimate[]> {
  campaignHash ??= hashFiles([join(simPackageRoot(), 'src', 'campaign.ts'), join(simPackageRoot(), 'src', 'trajectory-cache.ts')], simPackageRoot());
  const key = cacheKey(baseline.tableHash ?? baseline.name, `${runner.codeHash}|${campaignHash}`, {
    kind: 'point-ranking',
    profile: runner.profile.name,
    rng: runner.rngMode,
    assumptions,
    aBps: SEARCH_A_BPS,
    phi: SEARCH_PHI,
    walks: RANKING_WALKS,
  });
  const cached = runner.store.readArtifact(key);
  if (cached !== null) return cached.meta.estimates as PointEstimate[];

  const minSamples = runner.profile.minSamples;
  const estimates: PointEstimate[] = [];
  for (const tier of baseline.tiers) {
    const walks = prefix(await trajectoryCache(runner, tier.n, tier.tier), RANKING_WALKS);
    runner.checkpoint(`coarse ranking of the search points of tier ${tier.tier}`);
    const grid = { w: tier.n, h: tier.n };
    const reference = inSampleRtp(walks, { ...grid, multiplierBps: tier.multiplierBps, refundBps: refundTableFor(tier.n, tier.curve) }, minSamples);
    const share = byTier(assumptions.tierShare, tier.tier);
    const weights = assumptions.population;
    for (const aBps of SEARCH_A_BPS) {
      for (const phi of SEARCH_PHI) {
        if (aBps === tier.curve.aBps && phi === tier.curve.phi) continue;
        const curve: CurveParams = { ...tier.curve, aBps, phi };
        let refundBps: number[];
        try {
          refundBps = refundTableFor(tier.n, curve);
        } catch {
          // Not a buildable curve for this e0 (aBps too large, or the tail cannot stay strictly decreasing).
          continue;
        }
        const multiplierBps = largestMultiplierBelow(
          (candidate) => inSampleRtp(walks, { ...grid, multiplierBps: candidate, refundBps }, minSamples),
          reference,
          tier.multiplierBps,
        );
        const m = multiplierBps / 10_000;
        const naiveRtp = m * tier.winRates.naive;
        const sloppyRtp = m * tier.winRates.sloppy;
        const randomRtp = m * tier.winRates.randomWalk;
        let nervousRtp = m * tier.winRates.nervous;
        for (let k = 0; k < tier.nervousCashRate.length; k++) nervousRtp += (tier.nervousCashRate[k] * refundBps[k]) / 10_000;
        const deltaH =
          share *
          (weights['naive-greedy'] * (tier.population['naive-greedy'].rtp - naiveRtp) +
            weights['sloppy-greedy'] * (tier.population['sloppy-greedy'].rtp - sloppyRtp) +
            weights.nervous * (tier.population.nervous.rtp - nervousRtp) +
            weights['random-walk'] * (tier.population['random-walk'].rtp - randomRtp));
        estimates.push({
          tier: tier.tier,
          aBps,
          phi,
          multiplierBps,
          deltaH,
          naiveRtp,
          sloppyRtp,
          refund1Bps: refundBps[1],
          refundAtShortestBps: refundBps[2 * (tier.n - 1)],
        });
      }
    }
  }
  runner.store.writeArtifact(key, { meta: { kind: 'point-ranking', estimates }, arrays: {} });
  runner.newUnits += 1;
  return estimates;
}

/** The backend that simulates. */
export function simulationBackend(
  runner: Runner,
  paths: ReportPaths,
  log: (line: string) => void,
  assumptions: Assumptions = ASSUMPTIONS,
): TuneBackend {
  return {
    profileName: runner.profile.name,
    simCodeHash: runner.codeHash,
    log,

    async exactGate(curves: CurveParams[], variantLevel: number): Promise<ExactGateReport> {
      return exactGate(runner, curves, BOT_VARIANTS[variantLevel]);
    },

    async evaluate(spec: CalibrationSpec): Promise<Evaluation> {
      const calibration = await calibrateCandidate(runner, paths, spec);
      const lastTier = spec.sizes.length - 1;
      const certifiedTiers = spec.sizes.map((_, i) => i).filter((i) => !(spec.screenLast && i === lastTier));
      const certification = await certifyTable(runner, paths, calibration.tablePath, calibration.table, calibration.meta, certifiedTiers);
      const tiers: TierSummary[] = spec.sizes.map((_, i) => {
        const certified = certification.tiers.find((tier) => tier.tier === i);
        return certified !== undefined
          ? summarizeCertified(certified, calibration.meta.tiers[i])
          : summarizeScreened(calibration.tiers[i], assumptions, runner.profile.sessions);
      });
      return { tablePath: calibration.tablePath, tableHash: calibration.meta.tableHash, table: calibration.table, tiers };
    },

    rankPoints(baseline: CandidateRun): Promise<PointEstimate[]> {
      return rankPoints(runner, baseline, assumptions);
    },

    publish(kind: 'candidate' | 'house-max', run: CandidateRun): void {
      if (run.tablePath === null) throw new RangeError(`cannot publish ${run.name}: it has no table`);
      const target = kind === 'candidate' ? paths.candidateTable : paths.houseMaxTable;
      mkdirSync(dirname(target), { recursive: true });
      // Byte for byte: the table hash and with it the certification stay valid.
      copyFileSync(run.tablePath, target);
    },

    progress(result: TuneResult): void {
      writeJsonFile(paths.tuneJson, result);
    },
  };
}
