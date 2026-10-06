// Prospect-theory valuation of "keep going" against "cash out now" (Tversky & Kahneman 1992).
//
// MODELLING ASSUMPTION, not a fact about this game's players. The functional forms and the
// default parameters are the median estimates of the 1992 laboratory study (money gambles with
// stated probabilities); nothing here was measured on people playing this game.
//
// Outcomes are framed against the stake, which is the natural reference point once the bet is
// placed: reaching the exit gains `M − 1` bets, a dead end loses 1, cashing out loses
// `1 − refund`. Cashing out is therefore a sure loss. Going on is a gamble with three outcomes:
// the exit (felt chance p), bailing out later for a smaller refund r' when the branch turns bad
// (felt chance (1 − p) s, s = the share of bad games the player expects to see coming), and a
// dead end (the rest). It is valued with cumulative prospect theory: losses are ranked from the
// worst, so the dead end gets the weight w⁻(q_L) and the later bail-out w⁻(q_L + q_B) − w⁻(q_L).
//
//   v(x) = x^α for x >= 0, −λ (−x)^β for x < 0          (λ > 1: losses loom larger: quit earlier)
//   w(p) = p^c / (p^c + (1 − p)^c)^(1/c)                  (c < 1: small chances are over-weighted)
//   U(go on)    = w⁺(p) v(M − 1) + [w⁻(q_L + q_B) − w⁻(q_L)] v(r' − 1) + w⁻(q_L) v(−1)
//   U(cash out) = v(refund − 1)
//
// With α = β = λ = γ = δ = 1 the comparison is the risk-neutral one:
// go on when p M + (1 − p) s r' > refund.

export interface ProspectParams {
  /** Curvature of gains. */
  alpha: number;
  /** Curvature of losses. */
  beta: number;
  /** Loss aversion: how much more a loss weighs than a gain of the same size. */
  lambda: number;
  /** Probability weighting of gains; below 1 over-weights the small chance of the big win. */
  gamma: number;
  /** Probability weighting of losses. */
  delta: number;
}

/** Median estimates of Tversky & Kahneman (1992). */
export const TK1992: ProspectParams = { alpha: 0.88, beta: 0.88, lambda: 2.25, gamma: 0.61, delta: 0.69 };

/** Expected value: no distortion at all. */
export const RISK_NEUTRAL: ProspectParams = { alpha: 1, beta: 1, lambda: 1, gamma: 1, delta: 1 };

export function weight(p: number, c: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (c === 1) return p;
  const a = p ** c;
  return a / (a + (1 - p) ** c) ** (1 / c);
}

export function value(x: number, pt: ProspectParams): number {
  return x >= 0 ? x ** pt.alpha : -pt.lambda * (-x) ** pt.beta;
}

/**
 * Felt value of going on: felt chance `p` of an exit that pays `multiplier` times the bet;
 * otherwise, with chance `salvage`, a later bail-out for `laterRefund` times the bet, else nothing.
 */
export function goOnUtility(p: number, multiplier: number, salvage: number, laterRefund: number, pt: ProspectParams): number {
  const bail = (1 - p) * salvage;
  const lose = (1 - p) * (1 - salvage);
  const worst = weight(lose, pt.delta);
  return weight(p, pt.gamma) * value(multiplier - 1, pt) + (weight(lose + bail, pt.delta) - worst) * value(laterRefund - 1, pt) + worst * value(-1, pt);
}

/** Felt value of cashing out for `refund` times the bet. */
export function cashOutUtility(refund: number, pt: ProspectParams): number {
  return value(refund - 1, pt);
}

/**
 * The felt chance at which going on and cashing out feel the same: going on feels better above
 * it. `goOnUtility` increases with the chance, so bisection finds it; 1 when cashing out feels
 * better even at certainty.
 */
export function indifferenceChance(refund: number, multiplier: number, salvage: number, laterRefund: number, pt: ProspectParams): number {
  const target = cashOutUtility(refund, pt);
  if (goOnUtility(1, multiplier, salvage, laterRefund, pt) <= target) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (goOnUtility(mid, multiplier, salvage, laterRefund, pt) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}
