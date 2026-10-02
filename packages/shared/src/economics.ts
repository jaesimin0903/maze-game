// Refund curve and payouts (plan §3.1, §3.6).
//
// The only floating-point arithmetic is in `buildRefundTable`, which runs when a table is built.
// Everything used while a game runs is integer arithmetic on basis points and wei.

import type { CurveParams, TuningTable } from './types';

const BPS = 10_000;
const BPS_WEI = 10_000n;

/** Fixed constraint: curves flatter than this make "walk until bad news, then quit" the best play. */
export const PHI_MAX = 0.7;
/** Below this the 10×10 tail cannot stay strictly decreasing at basis-point precision. */
export const PHI_MIN = 0.3;

/** Throws unless `curve` is a buildable two-stage geometric curve. */
export function assertCurveParams(curve: CurveParams): void {
  if (curve.family !== 'two-stage-geometric') {
    throw new RangeError(`unknown refund curve family: ${String(curve.family)}`);
  }
  const { e0Bps, aBps, phi } = curve;
  if (!Number.isInteger(e0Bps) || e0Bps < 1 || e0Bps > BPS) {
    // refundBps[0] = 10000 - e0Bps must be below 10000 (contract constructor) and not negative.
    throw new RangeError(`e0Bps must be an integer in 1 .. ${BPS}, got ${e0Bps}`);
  }
  if (!Number.isInteger(aBps) || aBps < 0) {
    throw new RangeError(`aBps must be a non-negative integer, got ${aBps}`);
  }
  if (aBps >= BPS - e0Bps) {
    throw new RangeError(`aBps (${aBps}) must be below 10000 - e0Bps (${BPS - e0Bps})`);
  }
  if (typeof phi !== 'number' || !Number.isFinite(phi)) {
    throw new RangeError(`phi must be a finite number, got ${phi}`);
  }
  if (phi > PHI_MAX) throw new RangeError(`phi (${phi}) must not exceed ${PHI_MAX}`);
  if (phi < PHI_MIN) throw new RangeError(`phi (${phi}) must not be below ${PHI_MIN}`);
}

/** Throws unless `table[k + 1] < table[k]` for every `k`. */
export function assertStrictlyDecreasing(table: number[]): void {
  for (let k = 1; k < table.length; k++) {
    if (!(table[k] < table[k - 1])) {
      throw new RangeError(
        `refund table is not strictly decreasing at k = ${k}: ${table[k - 1]} then ${table[k]}`,
      );
    }
  }
}

/**
 * Refund table in basis points; entry `k` applies after `k` moves.
 *
 *   raw[0] = 10000 - e0Bps
 *   raw[k] = floor(aBps * phi^((k - 1) / L)),  k = 1 .. cells - 1,  L = shortestPath
 *   table[0] = raw[0],  table[k] = min(raw[k], table[k - 1] - 1)
 *
 * `cells` is `n * n` and `shortestPath` is `2 * (n - 1)` for a game tier (`w * h` and
 * `w + h - 2` for a rectangle). Throws when the parameters are out of range or any entry
 * would be negative.
 */
export function buildRefundTable(p: {
  cells: number;
  shortestPath: number;
  curve: CurveParams;
}): number[] {
  const { cells, shortestPath, curve } = p;
  if (!Number.isInteger(cells) || cells < 2) {
    throw new RangeError(`cells must be an integer of at least 2, got ${cells}`);
  }
  if (!Number.isInteger(shortestPath) || shortestPath < 1) {
    throw new RangeError(`shortestPath must be a positive integer, got ${shortestPath}`);
  }
  assertCurveParams(curve);

  const table = new Array<number>(cells);
  table[0] = BPS - curve.e0Bps;
  for (let k = 1; k < cells; k++) {
    const raw = Math.floor(curve.aBps * Math.pow(curve.phi, (k - 1) / shortestPath));
    table[k] = Math.min(raw, table[k - 1] - 1);
    if (table[k] < 0) throw new RangeError(`refund table would be negative at k = ${k}`);
  }
  assertStrictlyDecreasing(table);
  return table;
}

function tierOf(t: TuningTable, tier: number): TuningTable['tiers'][number] {
  if (!Number.isInteger(tier) || tier < 0 || tier >= t.tiers.length) {
    throw new RangeError(`tier ${tier} is not in the tuning table`);
  }
  return t.tiers[tier];
}

function assertBet(betWei: bigint): void {
  if (betWei < 0n) throw new RangeError('betWei must not be negative');
}

/** Refund in basis points after `k` moves. `tier` is the index into `t.tiers` (the contract's tier). */
export function refundBps(t: TuningTable, tier: number, k: number): number {
  const table = tierOf(t, tier).refundBps;
  if (!Number.isInteger(k) || k < 0 || k >= table.length) {
    throw new RangeError(`step ${k} is outside the refund table of tier ${tier}`);
  }
  return table[k];
}

/** `bet * refundBps[tier][k] / 10000`, rounded down. Depends on nothing but its four arguments. */
export function refundWei(t: TuningTable, betWei: bigint, tier: number, k: number): bigint {
  assertBet(betWei);
  return (betWei * BigInt(refundBps(t, tier, k))) / BPS_WEI;
}

/** `bet * multiplierBps[tier] / 10000`, rounded down: the payout for reaching the exit. */
export function exitPayoutWei(t: TuningTable, betWei: bigint, tier: number): bigint {
  assertBet(betWei);
  return (betWei * BigInt(tierOf(t, tier).multiplierBps)) / BPS_WEI;
}
