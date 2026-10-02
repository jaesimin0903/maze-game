// Sample sizes and limits (plan §3.6, §8.2, §9.3).
//
// `PRODUCTION` holds the numbers the plan fixed before any run. Nothing in the simulator lowers
// them: the certification count of a tier is the larger of the plan's minimum and the count the
// measured standard deviation asks for (`resolveCertGames`).
//
// `SMOKE` exists to prove that every command works end to end in minutes, on small grids
// (`--sizes 4,5,6`). Its results are written under a separate directory, are labelled with the
// profile name, never mark a table as calibrated, and cannot satisfy a production cache key
// (the profile name and every count are part of each key).

import { requiredSamples } from './stats';

export interface ParamSearchPlan {
  /** Uniform points in [-range, range]^6. */
  initial: number;
  range: number;
  /** Points kept after each stage. */
  top: number;
  /** Gaussian perturbations drawn around each kept point per round. */
  perTop: number;
  rounds: number;
  sigma: number;
  /** Stream C games per fitness evaluation. */
  games: number;
}

export interface Profile {
  name: 'production' | 'smoke';
  /** Minimum certification games per cell, by tier index (S, M, L). */
  certMinGames: readonly number[];
  /** Target half-width of the 95% interval of the reference bot, by tier index. */
  targetHalfWidth: readonly number[];
  /** Games per cached chunk of a cell. */
  chunkGames: number;
  /** Stream C games per training pass, by tier index. */
  trainGames: readonly number[];
  /** Policy-iteration passes after the harmonic pass. */
  trainPasses: number;
  /** Table cells with fewer games are replaced by pooled estimates. */
  minSamples: number;
  /** Stream E games of the trajectory cache, by tier index. */
  trajectoryGames: readonly number[];
  paramSearch: ParamSearchPlan;
  /** Paired comparison on stream D. */
  pairPilot: number;
  pairChunk: number;
  pairFloor: readonly number[];
  pairCap: number;
  pairHalfWidth: number;
  /** Coarse bisection uses the first `N / coarseDivisor` games of stream A; the last tier uses `N / screenDivisor`. */
  coarseDivisor: number;
  screenDivisor: number;
  /** Full-`N` evaluations per calibration: the first plus at most five step-downs. */
  maxFullEvaluations: number;
  /** Minimum games per training pass on an enumerated grid (every maze equally often). */
  exactTrainGames: number;
  /** AC-X8: the start-direction equivalence test of a tier needs at least this many harmonic games, by tier index. */
  symmetryMinGames: readonly number[];
  /** Bankroll sessions simulated for E11. */
  sessions: number;
  /** `sim:bench`: stream C games per training pass, and timed games per bot class. */
  benchTrainGames: number;
  benchGames: { fast: number; posterior: number; lookahead: number; lookaheadAll: number; rollout: number };
  /** A command works at most this long per call, then exits with code 2. */
  sliceMinutes: number;
  /** A cell that has run longer than this in total is BLOCKED(runtime). */
  cellHours: number;
  /** `tune` as a whole may run this long in total before BLOCKED(economic). */
  campaignHours: number;
}

export const PRODUCTION: Profile = {
  name: 'production',
  certMinGames: [3_000_000, 5_000_000, 11_000_000],
  targetHalfWidth: [0.0015, 0.002, 0.003],
  chunkGames: 2_000_000,
  trainGames: [1_000_000, 2_000_000, 4_000_000],
  trainPasses: 3,
  minSamples: 200,
  trajectoryGames: [1_000_000, 2_000_000, 4_000_000],
  paramSearch: { initial: 256, range: 4, top: 8, perTop: 16, rounds: 3, sigma: 0.5, games: 200_000 },
  pairPilot: 20_000,
  pairChunk: 5_000,
  pairFloor: [100_000, 100_000, 400_000],
  pairCap: 1_000_000,
  pairHalfWidth: 0.005,
  coarseDivisor: 16,
  screenDivisor: 8,
  maxFullEvaluations: 6,
  exactTrainGames: 1_000_000,
  symmetryMinGames: [2_000_000, 4_000_000, 8_000_000],
  sessions: 10_001,
  benchTrainGames: 200_000,
  benchGames: { fast: 400_000, posterior: 160_000, lookahead: 160_000, lookaheadAll: 40_000, rollout: 800 },
  sliceMinutes: 100,
  cellHours: 6,
  campaignHours: 30,
};

export const SMOKE: Profile = {
  name: 'smoke',
  certMinGames: [150_000, 250_000, 500_000],
  targetHalfWidth: [0.0045, 0.0045, 0.0045],
  chunkGames: 100_000,
  trainGames: [40_000, 60_000, 80_000],
  trainPasses: 3,
  minSamples: 100,
  trajectoryGames: [40_000, 60_000, 80_000],
  paramSearch: { initial: 16, range: 4, top: 4, perTop: 2, rounds: 1, sigma: 0.5, games: 5_000 },
  pairPilot: 1_000,
  pairChunk: 1_000,
  pairFloor: [30_000, 30_000, 30_000],
  pairCap: 60_000,
  pairHalfWidth: 0.005,
  coarseDivisor: 4,
  screenDivisor: 2,
  maxFullEvaluations: 6,
  exactTrainGames: 20_000,
  // The production sample sizes of the symmetry test cannot be met at smoke counts.
  symmetryMinGames: [0, 0, 0],
  sessions: 501,
  benchTrainGames: 20_000,
  benchGames: { fast: 40_000, posterior: 16_000, lookahead: 16_000, lookaheadAll: 4_000, rollout: 80 },
  sliceMinutes: 100,
  cellHours: 6,
  campaignHours: 30,
};

/** Entry of a per-tier array; tables with more than three tiers reuse the last entry. */
export function byTier<T>(values: readonly T[], tierIndex: number): T {
  return values[Math.min(tierIndex, values.length - 1)];
}

/**
 * Certification games of a tier: the plan's minimum, or the count the measured standard
 * deviation needs for the target half-width when that is larger. There is no smaller result.
 */
export function resolveCertGames(profile: Profile, tierIndex: number, measuredSd: number | null): number {
  const floor = byTier(profile.certMinGames, tierIndex);
  if (measuredSd === null) return floor;
  return Math.max(floor, requiredSamples(measuredSd, byTier(profile.targetHalfWidth, tierIndex)));
}

/** Pairs of an adversary comparison: `min(cap, max(floor, (1.96 × sd / h)²))`. */
export function resolvePairGames(profile: Profile, tierIndex: number, pilotSd: number): number {
  const needed = requiredSamples(pilotSd, profile.pairHalfWidth);
  return Math.min(profile.pairCap, Math.max(byTier(profile.pairFloor, tierIndex), needed));
}
