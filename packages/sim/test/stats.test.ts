// Statistical helpers: every confidence bound of the simulator comes from these functions.

import { describe, expect, it } from 'vitest';
import { PRODUCTION, resolveCertGames, resolvePairGames } from '../src/profile';
import {
  addMoments,
  estimate,
  halfWidth95,
  median,
  normalQuantile,
  requiredSamples,
  scaleMoments,
  sumOfIndependent,
  tostProportions,
  varianceOf,
  Z_975,
  type Moments,
} from '../src/stats';

function momentsOf(values: number[]): Moments {
  return { n: values.length, sum: values.reduce((a, b) => a + b, 0), sumSq: values.reduce((a, b) => a + b * b, 0) };
}

describe('stats: estimates from measured variance', () => {
  it('reproduces the mean, unbiased variance and 95% interval of a hand-computed sample', () => {
    // Establishes: the interval is mean ± 1.96 × s / √n with s the n − 1 sample deviation.
    const e = estimate(momentsOf([2, 4, 4, 4, 5, 5, 7, 9]));
    expect(e.mean).toBeCloseTo(5, 12);
    expect(e.sd).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(e.se).toBeCloseTo(Math.sqrt(32 / 7 / 8), 12);
    expect(e.halfWidth).toBeCloseTo(Z_975 * Math.sqrt(32 / 7 / 8), 12);
    expect(e.ucb).toBeCloseTo(e.mean + e.halfWidth, 12);
    expect(e.ci).toEqual([e.lcb, e.ucb]);
  });

  it('merging and scaling moments equals computing on the pooled, scaled sample', () => {
    // Establishes: chunk results can be added, and bps payouts converted to fractions, without bias.
    const a = [1, 5, 2, 8];
    const b = [3, 3, 9];
    const pooled = estimate(momentsOf([...a, ...b].map((x) => x / 10)));
    const merged = estimate(scaleMoments(addMoments(momentsOf(a), momentsOf(b)), 1 / 10));
    expect(merged.mean).toBeCloseTo(pooled.mean, 12);
    expect(merged.sd).toBeCloseTo(pooled.sd, 12);
  });

  it('a constant sample has zero variance and never a negative one', () => {
    expect(varianceOf(momentsOf([0.95, 0.95, 0.95, 0.95]))).toBe(0);
  });

  it('normalQuantile inverts the normal distribution at the levels the gates use', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.99)).toBeCloseTo(2.326348, 5);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.01)).toBeCloseTo(-2.326348, 5);
    expect(() => normalQuantile(1)).toThrow(RangeError);
  });

  it('sample-size arithmetic matches the table of plan §9.3', () => {
    // σ ≈ 1.16 / 2.19 / 4.97: 1,000 games give ±7.2 / ±13.6 / ±30.8 points; 3M / 5M / 11M give ±0.13 / ±0.19 / ±0.29.
    expect(halfWidth95(1.16, 1000)).toBeCloseTo(0.072, 3);
    expect(halfWidth95(2.19, 1000)).toBeCloseTo(0.136, 3);
    expect(halfWidth95(4.97, 1000)).toBeCloseTo(0.308, 3);
    expect(halfWidth95(1.16, 3_000_000)).toBeCloseTo(0.0013, 4);
    expect(halfWidth95(2.19, 5_000_000)).toBeCloseTo(0.0019, 4);
    expect(halfWidth95(4.97, 11_000_000)).toBeCloseTo(0.0029, 4);
    expect(requiredSamples(1.16, 0.0015)).toBe(Math.ceil(((Z_975 * 1.16) / 0.0015) ** 2));
  });

  it('the certification count never falls below the plan minimum and grows with the measured σ', () => {
    // Establishes: there is no path to a smaller N.
    expect(resolveCertGames(PRODUCTION, 0, null)).toBe(3_000_000);
    expect(resolveCertGames(PRODUCTION, 0, 0)).toBe(3_000_000);
    expect(resolveCertGames(PRODUCTION, 0, 1.16)).toBe(3_000_000);
    expect(resolveCertGames(PRODUCTION, 1, 2.19)).toBe(5_000_000);
    expect(resolveCertGames(PRODUCTION, 2, 4.97)).toBe(11_000_000);
    expect(resolveCertGames(PRODUCTION, 2, 6)).toBe(requiredSamples(6, 0.003));
    expect(resolveCertGames(PRODUCTION, 2, 6)).toBeGreaterThan(11_000_000);
    expect(resolveCertGames(PRODUCTION, 7, 4.97)).toBe(11_000_000);
  });

  it('AC-T10 pair counts are min(1,000,000, max(floor, (1.96 sd / 0.005)²))', () => {
    expect(resolvePairGames(PRODUCTION, 2, 0)).toBe(400_000);
    expect(resolvePairGames(PRODUCTION, 0, 0)).toBe(100_000);
    expect(resolvePairGames(PRODUCTION, 1, 1.0)).toBe(requiredSamples(1.0, 0.005));
    expect(resolvePairGames(PRODUCTION, 2, 1.8)).toBe(requiredSamples(1.8, 0.005));
    expect(resolvePairGames(PRODUCTION, 2, 5)).toBe(1_000_000);
  });

  it('the sum of two independent estimates adds means and variances', () => {
    const s = sumOfIndependent({ mean: 0.957, se: 0.0015 }, { mean: 0.004, se: 0.002 });
    expect(s.mean).toBeCloseTo(0.961, 12);
    expect(s.se).toBeCloseTo(0.0025, 12);
    expect(s.ucb).toBeCloseTo(0.961 + Z_975 * 0.0025, 12);
  });

  it('TOST declares equivalence only when the whole interval is inside the margin', () => {
    // Establishes: equal rates with a large sample pass; a 10% relative gap, or a small sample, does not.
    const large = tostProportions({ successes1: 29_000, n1: 1_000_000, successes2: 29_050, n2: 1_000_000, relativeMargin: 0.03, alpha: 0.01 });
    expect(large.equivalent).toBe(true);
    expect(large.margin).toBeCloseTo(0.03 * 0.029025, 9);
    const apart = tostProportions({ successes1: 29_000, n1: 1_000_000, successes2: 32_000, n2: 1_000_000, relativeMargin: 0.03, alpha: 0.01 });
    expect(apart.equivalent).toBe(false);
    const small = tostProportions({ successes1: 290, n1: 10_000, successes2: 290, n2: 10_000, relativeMargin: 0.03, alpha: 0.01 });
    expect(small.equivalent).toBe(false);
  });

  it('median handles odd and even lengths without modifying its input', () => {
    const values = [5, 1, 4];
    expect(median(values)).toBe(4);
    expect(values).toEqual([5, 1, 4]);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(() => median([])).toThrow(RangeError);
  });
});
