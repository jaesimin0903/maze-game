// Coarse ranking of search points (plan §9.3 step 4). Found by the campaign: at a calibrated
// multiplier harmonic-lsm prefers to cash out before the first move, so its in-sample value is
// exactly refund(0) over a whole range of multipliers and cannot be used to match a point's
// multiplier to the baseline's. The ranking matches the value of playing instead.

import { describe, expect, it } from 'vitest';
import { matchMultiplier, playValue, rankPoints } from '../src/campaign';
import { ASSUMPTIONS } from '../src/assumptions';
import { Game, type MazeSource } from '../src/engine';
import { recordTrajectories } from '../src/lsm';
import { refundTableFor } from '../src/tables';
import { inSampleRtp } from '../src/trajectory-cache';
import type { CandidateRun, TierSummary } from '../src/tune';
import { CURVE_II, econFor, temporaryDirectory, testRunner } from './helpers';

const SOURCE: MazeSource = { kind: 'rng', mode: 'fast', stream: 'E' };

describe('matchMultiplier', () => {
  it('finds the multiplier of an increasing function to within 0.02%, from a start on either side', () => {
    const value = (bps: number): number => bps / 100_000;
    for (const start of [12_000, 50_000, 300_000]) {
      const found = matchMultiplier(value, 0.5, start);
      expect(value(found)).toBeLessThanOrEqual(0.5);
      expect(found).toBeGreaterThan(50_000 * (1 - 3e-4));
    }
  });

  it('on a plateau returns its upper end, whatever the start', () => {
    // Flat at 0.95 up to 95,000 bps, rising after: the largest multiplier whose value is not above 0.95.
    const value = (bps: number): number => Math.max(0.95, bps / 100_000);
    for (const start of [20_000, 94_000, 200_000]) {
      const found = matchMultiplier(value, 0.95, start);
      expect(found).toBeLessThanOrEqual(95_000);
      expect(found).toBeGreaterThan(95_000 * (1 - 3e-4));
    }
  });

  it('never goes below a multiplier of 1.0', () => {
    expect(matchMultiplier(() => 2, 0.5, 30_000)).toBe(10_000);
  });
});

describe('play value', () => {
  const g = new Game(econFor(5, 5, 10_000));
  const walks = recordTrajectories(g, SOURCE, 0, 60_000);
  const grid = { w: 5, h: 5 };
  const refundBps = refundTableFor(5, CURVE_II);

  it('keeps rising with the multiplier where the policy value is stuck at refund(0)', () => {
    // Establishes why the ranking cannot match on the policy value: at 2.2x .. 2.4x harmonic-lsm
    // cashes out before the first move (value exactly 95%), while the value of playing still moves.
    const multipliers = [22_000, 23_000, 24_000];
    const policy = multipliers.map((multiplierBps) => inSampleRtp(walks, { ...grid, multiplierBps, refundBps }, 200));
    const playing = multipliers.map((multiplierBps) => playValue(walks, { ...grid, multiplierBps, refundBps }, 200));
    expect(policy).toEqual([0.95, 0.95, 0.95]);
    expect(playing[0]).toBeLessThan(playing[1]);
    expect(playing[1]).toBeLessThan(playing[2]);
    expect(playing[2]).toBeLessThan(0.95);
    // Above the threshold the two agree: the policy plays.
    const high = { ...grid, multiplierBps: 27_500, refundBps };
    expect(playValue(walks, high, 200)).toBeCloseTo(inSampleRtp(walks, high, 200), 12);
  });

  it('matching a curve against itself returns the baseline multiplier, also on the plateau', () => {
    for (const baseBps of [23_500, 26_088]) {
      const reference = playValue(walks, { ...grid, multiplierBps: baseBps, refundBps }, 200);
      const matched = matchMultiplier((multiplierBps) => playValue(walks, { ...grid, multiplierBps, refundBps }, 200), reference, baseBps);
      expect(Math.abs(matched - baseBps)).toBeLessThanOrEqual(Math.ceil(baseBps / 5000) + 1);
    }
  });

  it('a curve with smaller refunds needs a larger multiplier for the same value of playing', () => {
    const baseBps = 26_088;
    const reference = playValue(walks, { ...grid, multiplierBps: baseBps, refundBps }, 200);
    const stingy = refundTableFor(5, { ...CURVE_II, aBps: 6500, phi: 0.3 });
    const generous = refundTableFor(5, { ...CURVE_II, aBps: 9000, phi: 0.7 });
    const at = (table: number[]): number =>
      matchMultiplier((multiplierBps) => playValue(walks, { ...grid, multiplierBps, refundBps: table }, 200), reference, baseBps);
    expect(at(stingy)).toBeGreaterThan(baseBps);
    expect(at(generous)).toBeLessThan(baseBps);
  });
});

describe('rankPoints', () => {
  it('prices all grid points of a tier with sane multipliers and the exact naive-greedy relation', async () => {
    const runner = testRunner(temporaryDirectory(), { trajectoryGames: [40_000, 40_000, 40_000] });
    const tier = {
      tier: 0,
      n: 5,
      curve: CURVE_II,
      multiplierBps: 26_088,
      population: {
        'naive-greedy': { rtp: 0.8728, se: 0 },
        'sloppy-greedy': { rtp: 0.7702, se: 0 },
        // Consistent with the behaviour below: nervous wins 12% of its games and never cashes out here.
        nervous: { rtp: 0.12 * 2.6088, se: 0 },
        'random-walk': { rtp: 0.2258, se: 0 },
        best: { rtp: 0.958, se: 0 },
      },
      winRates: { naive: 0.8728 / 2.6088, sloppy: 0.7702 / 2.6088, randomWalk: 0.2258 / 2.6088, nervous: 0.12 },
      nervousCashRate: new Array<number>(25).fill(0),
    } as unknown as TierSummary;
    const baseline = { name: 'ii', tableHash: 'test', tiers: [tier] } as unknown as CandidateRun;
    const estimates = await rankPoints(runner, baseline, ASSUMPTIONS);
    // 7 × 5 grid points minus the baseline's own (7300, 0.5).
    expect(estimates).toHaveLength(34);
    for (const estimate of estimates) {
      // No point collapses to a multiplier of 1.0 or to the baseline multiplier plus one basis point.
      expect(estimate.multiplierBps).toBeGreaterThan(20_000);
      expect(estimate.multiplierBps).toBeLessThan(32_000);
      expect(estimate.naiveRtp).toBeCloseTo((estimate.multiplierBps / 10_000) * tier.winRates.naive, 12);
    }
    // Smaller refunds → larger multiplier → casual players get more back and the house less.
    const at = (aBps: number, phi: number): (typeof estimates)[number] => estimates.find((e) => e.aBps === aBps && e.phi === phi)!;
    expect(at(6500, 0.3).multiplierBps).toBeGreaterThan(at(7300, 0.3).multiplierBps);
    expect(at(7300, 0.3).multiplierBps).toBeGreaterThan(26_088);
    expect(at(9000, 0.7).multiplierBps).toBeLessThan(26_088);
    expect(at(6500, 0.3).deltaH).toBeLessThan(0);
    expect(at(9000, 0.7).deltaH).toBeGreaterThan(0);
    // The ranking is cached: a second call returns the same estimates.
    expect(await rankPoints(runner, baseline, ASSUMPTIONS)).toEqual(estimates);
  }, 300_000);
});
