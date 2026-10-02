// Trajectory cache (plan §9.3): harmonic walks recorded on stream E.
//
// Because harmonic's moves do not depend on the curve or the multiplier, one recorded set
// prices any (curve, multiplier) by backward induction without a new simulation. That value is
// in-sample and belongs to harmonic-lsm, not to value-lsm, so it is used for two things only:
// the starting multiplier of a calibration and the coarse ranking of search points. Calibration
// and certification always run fresh simulations.

import type { TierEconomics } from './engine';
import { harmonicLsmTable, type Trajectories } from './lsm';
import { byTier } from './profile';
import type { Runner } from './runner';

/** The stream E trajectory set of a tier. */
export async function trajectoryCache(runner: Runner, n: number, tierIndex: number): Promise<Trajectories> {
  const { data } = await runner.trajectories(n, n, 'E', byTier(runner.profile.trajectoryGames, tierIndex));
  return data;
}

/** In-sample RTP of harmonic-lsm on the recorded walks under the given economics. */
export function inSampleRtp(trajectories: Trajectories, econ: TierEconomics, minSamples: number): number {
  return harmonicLsmTable(trajectories, econ, minSamples).inSampleBps / 10_000;
}

/**
 * The largest multiplier (integer bps, at least 1.0) at which `rtpAt` does not exceed `target`,
 * for a function that does not decrease with the multiplier. Interpolation steps alternate with
 * bisection steps so that the bracket always shrinks.
 */
export function largestMultiplierBelow(rtpAt: (multiplierBps: number) => number, target: number, startBps: number): number {
  let lo = 10_000;
  let fLo = rtpAt(lo);
  if (fLo > target) return lo;
  let hi = Math.max(lo + 1, Math.round(startBps));
  let fHi = rtpAt(hi);
  while (!(fHi > target)) {
    lo = hi;
    fLo = fHi;
    hi = Math.ceil(hi * 1.25);
    fHi = rtpAt(hi);
    if (hi > 100_000_000) return lo;
  }
  for (let step = 0; hi - lo > 1 && step < 64; step++) {
    let mid = Math.floor((lo + hi) / 2);
    if (step % 2 === 0 && fHi > fLo) {
      mid = Math.round(lo + ((hi - lo) * (target - fLo)) / (fHi - fLo));
      mid = Math.min(hi - 1, Math.max(lo + 1, mid));
    }
    const fMid = rtpAt(mid);
    if (fMid > target) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
      // Close enough: within 0.01 percentage points below the target.
      if (target - fLo < 1e-4) break;
    }
  }
  return lo;
}

/** Multiplier at which harmonic-lsm's in-sample RTP on the recorded walks reaches `target`. */
export function multiplierForInSample(
  trajectories: Trajectories,
  grid: { w: number; h: number; refundBps: readonly number[] },
  target: number,
  minSamples: number,
): number {
  let wins = 0;
  for (let i = 0; i < trajectories.games; i++) wins += trajectories.win[i];
  const winRate = Math.max(wins / Math.max(1, trajectories.games), 1e-6);
  return largestMultiplierBelow(
    (multiplierBps) => inSampleRtp(trajectories, { ...grid, multiplierBps }, minSamples),
    target,
    (target / winRate) * 10_000,
  );
}
