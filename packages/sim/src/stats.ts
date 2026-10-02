// Statistical helpers (plan §3.8, §9.3). Every bound is computed from the measured variance.

/** Two-sided 95% / one-sided 97.5% normal quantile. */
export const Z_975 = 1.959963984540054;

export interface Moments {
  /** Number of observations. */
  n: number;
  /** Sum of the observations. */
  sum: number;
  /** Sum of their squares. */
  sumSq: number;
}

export function emptyMoments(): Moments {
  return { n: 0, sum: 0, sumSq: 0 };
}

export function addMoments(a: Moments, b: Moments): Moments {
  return { n: a.n + b.n, sum: a.sum + b.sum, sumSq: a.sumSq + b.sumSq };
}

/** Moments of `scale × X` given the moments of `X`. */
export function scaleMoments(m: Moments, scale: number): Moments {
  return { n: m.n, sum: m.sum * scale, sumSq: m.sumSq * scale * scale };
}

export function meanOf(m: Moments): number {
  if (m.n <= 0) throw new RangeError('mean of an empty sample');
  return m.sum / m.n;
}

/** Unbiased sample variance (divisor `n - 1`). Never negative. */
export function varianceOf(m: Moments): number {
  if (m.n < 2) throw new RangeError('variance needs at least two observations');
  const mean = m.sum / m.n;
  return Math.max(0, (m.sumSq - m.n * mean * mean) / (m.n - 1));
}

export function sdOf(m: Moments): number {
  return Math.sqrt(varianceOf(m));
}

/** Standard error of the mean. */
export function seOf(m: Moments): number {
  return Math.sqrt(varianceOf(m) / m.n);
}

export interface Estimate {
  n: number;
  mean: number;
  sd: number;
  se: number;
  /** Half-width of the two-sided 95% confidence interval. */
  halfWidth: number;
  /** Two-sided 95% confidence interval. */
  ci: [number, number];
  /** One-sided 97.5% upper confidence bound: `mean + 1.96 × se`. */
  ucb: number;
  /** One-sided 97.5% lower confidence bound. */
  lcb: number;
}

export function estimate(m: Moments): Estimate {
  const mean = meanOf(m);
  const sd = sdOf(m);
  const se = sd / Math.sqrt(m.n);
  const halfWidth = Z_975 * se;
  return {
    n: m.n,
    mean,
    sd,
    se,
    halfWidth,
    ci: [mean - halfWidth, mean + halfWidth],
    ucb: mean + halfWidth,
    lcb: mean - halfWidth,
  };
}

/** Half-width of the 95% interval of a mean of `n` observations with standard deviation `sd`. */
export function halfWidth95(sd: number, n: number): number {
  return (Z_975 * sd) / Math.sqrt(n);
}

/** Smallest `n` whose 95% half-width is at most `halfWidth`: `ceil((1.96 × sd / h)²)`. */
export function requiredSamples(sd: number, halfWidth: number): number {
  if (!(sd >= 0) || !(halfWidth > 0)) throw new RangeError('requiredSamples: sd >= 0 and halfWidth > 0');
  return Math.ceil(((Z_975 * sd) / halfWidth) ** 2);
}

/**
 * Sum of two independent estimates (`RTP_adversary = RTP_value-lsm + mean(D)`): the means add and
 * the standard error is the root of the summed variances.
 */
export function sumOfIndependent(
  a: { mean: number; se: number },
  b: { mean: number; se: number },
): { mean: number; se: number; halfWidth: number; ucb: number; lcb: number } {
  const mean = a.mean + b.mean;
  const se = Math.sqrt(a.se * a.se + b.se * b.se);
  const halfWidth = Z_975 * se;
  return { mean, se, halfWidth, ucb: mean + halfWidth, lcb: mean - halfWidth };
}

/** Inverse of the standard normal distribution function (Acklam's rational approximation, relative error < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`normalQuantile: p must be inside (0, 1), got ${p}`);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

export interface TostResult {
  /** `p1 - p2`. */
  diff: number;
  se: number;
  /** The equivalence margin that was applied (absolute). */
  margin: number;
  /** Two-sided `1 - 2α` interval of the difference. */
  ci: [number, number];
  /** True when both one-sided tests reject at level `alpha`, i.e. the interval lies inside ±margin. */
  equivalent: boolean;
}

/**
 * Two one-sided tests for the equivalence of two proportions. `relativeMargin` is a fraction
 * of the pooled proportion (AC-X8: 3% of the pooled win rate, α = 0.01).
 */
export function tostProportions(p: {
  successes1: number;
  n1: number;
  successes2: number;
  n2: number;
  relativeMargin: number;
  alpha: number;
}): TostResult {
  const { successes1, n1, successes2, n2, relativeMargin, alpha } = p;
  if (n1 <= 0 || n2 <= 0) throw new RangeError('tostProportions: both samples must be non-empty');
  const p1 = successes1 / n1;
  const p2 = successes2 / n2;
  const pooled = (successes1 + successes2) / (n1 + n2);
  const margin = relativeMargin * pooled;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  const z = normalQuantile(1 - alpha);
  const diff = p1 - p2;
  const ci: [number, number] = [diff - z * se, diff + z * se];
  return { diff, se, margin, ci, equivalent: margin > 0 && ci[0] > -margin && ci[1] < margin };
}

/** Median of a list (mean of the two middle values when the length is even). Does not modify its argument. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of an empty list');
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
