import { describe, expect, it } from 'vitest';
import {
  assertCurveParams,
  assertStrictlyDecreasing,
  buildRefundTable,
  exitPayoutWei,
  parseTuning,
  PHI_MAX,
  PHI_MIN,
  refundBps,
  refundWei,
  type CurveParams,
} from '../src';
import fixtureJson from './fixtures/tuning.fixture.json';

const table = parseTuning(fixtureJson);

const curve = (e0Bps: number, aBps: number, phi: number): CurveParams => ({
  family: 'two-stage-geometric',
  e0Bps,
  aBps,
  phi,
});

/** The refund table of an `n × n` game tier. */
const tierTable = (n: number, c: CurveParams): number[] =>
  buildRefundTable({ cells: n * n, shortestPath: 2 * (n - 1), curve: c });

// The tuning grid of plan §3.1.
const GRID_A = [9000, 8500, 8000, 7600, 7300, 7000, 6500];
const GRID_PHI = [0.3, 0.4, 0.5, 0.6, 0.7];
const SIZES = [5, 7, 10];

describe('buildRefundTable', () => {
  it('follows raw[0] = 10000 - e0Bps, raw[k] = floor(aBps * phi^((k - 1) / L)) (plan §2.3 values)', () => {
    const ii = curve(500, 7300, 0.5);
    expect(tierTable(5, ii).slice(0, 4)).toEqual([9500, 7300, 6694, 6138]);
    expect(tierTable(10, ii).slice(0, 4)).toEqual([9500, 7300, 7024, 6758]);
    expect(tierTable(10, ii)[99]).toBe(167);

    const i = curve(500, 9000, 0.3);
    expect(tierTable(5, i).slice(0, 4)).toEqual([9500, 9000, 7742, 6660]);
    expect(tierTable(10, i).slice(0, 4)).toEqual([9500, 9000, 8417, 7873]);
    expect(tierTable(10, i)[99]).toBe(12);

    expect(tierTable(5, curve(2000, 7340, 0.5)).slice(0, 2)).toEqual([8000, 7340]);
  });

  it('keeps exact powers exact: a * phi^m lands on the integer, not one below', () => {
    const ii = curve(500, 7300, 0.5);
    for (const n of SIZES) {
      const L = 2 * (n - 1);
      const built = tierTable(n, ii);
      expect(built[1 + L]).toBe(3650);
      expect(built[1 + 2 * L]).toBe(1825);
    }
    const eights = tierTable(5, curve(500, 8000, 0.5));
    expect([eights[9], eights[17]]).toEqual([4000, 2000]);
  });

  it('the fixture tables are the true floors (exact integer check, no floating point)', () => {
    // phi = 1/2: t = floor(a * 2^(-(k-1)/L))  <=>  t^L * 2^(k-1) <= a^L < (t+1)^L * 2^(k-1)
    for (const tier of table.tiers) {
      expect(tier.curve.phi).toBe(0.5);
      const L = BigInt(2 * (tier.n - 1));
      const aPower = BigInt(tier.curve.aBps) ** L;
      for (let k = 1; k < tier.refundBps.length; k++) {
        const t = BigInt(tier.refundBps[k]);
        const scale = 2n ** BigInt(k - 1);
        expect(t ** L * scale <= aPower && aPower < (t + 1n) ** L * scale).toBe(true);
      }
    }
  });

  it.each(SIZES)('AC-R9 n = %i: every point of the tuning grid is strictly decreasing', (n) => {
    let clamped = 0;
    for (const aBps of GRID_A) {
      for (const phi of GRID_PHI) {
        const c = curve(500, aBps, phi);
        const built = tierTable(n, c);
        expect(built).toHaveLength(n * n);
        expect(built[0]).toBe(9500);
        expect(built[1]).toBe(aBps);
        for (let k = 0; k < built.length; k++) {
          expect(Number.isInteger(built[k]) && built[k] >= 0 && built[k] <= 0xffff).toBe(true);
          if (k > 0) expect(built[k]).toBeLessThan(built[k - 1]);
          if (k > 1) {
            const raw = Math.floor(aBps * Math.pow(phi, (k - 1) / (2 * (n - 1))));
            expect(built[k]).toBe(Math.min(raw, built[k - 1] - 1));
            if (raw >= built[k - 1]) clamped += 1;
          }
        }
      }
    }
    // On the largest board the raw curve repeats values in its tail; the table still steps down.
    if (n === 10) expect(clamped).toBeGreaterThan(0);
  });

  it('AC-R9 where the raw curve stalls, the table goes down by exactly one', () => {
    // floor(100 * 0.7^((k-1)/50)) repeats: 100, 99, 98, 97, 97, 96, ...
    const built = buildRefundTable({ cells: 12, shortestPath: 50, curve: curve(500, 100, 0.7) });
    const raw = Array.from({ length: 12 }, (_, k) =>
      k === 0 ? 9500 : Math.floor(100 * Math.pow(0.7, (k - 1) / 50)),
    );
    expect(raw.some((value, k) => k > 1 && value === raw[k - 1])).toBe(true);
    for (let k = 1; k < 12; k++) expect(built[k]).toBe(Math.min(raw[k], built[k - 1] - 1));
    expect(() => assertStrictlyDecreasing(built)).not.toThrow();
  });

  it('AC-R9 build fails when aBps >= 10000 - e0Bps', () => {
    expect(() => tierTable(5, curve(500, 9500, 0.5))).toThrow(/aBps/);
    expect(() => tierTable(5, curve(500, 9600, 0.5))).toThrow(/aBps/);
    expect(() => tierTable(5, curve(2000, 8000, 0.5))).toThrow(/aBps/);
    expect(() => tierTable(5, curve(500, 9499, 0.5))).not.toThrow();
  });

  it('AC-R9 build fails when phi > 0.70', () => {
    for (const phi of [0.71, 0.7000001, 0.9, 1]) {
      expect(() => tierTable(5, curve(500, 7300, phi))).toThrow(/phi/);
    }
    expect(PHI_MAX).toBe(0.7);
    expect(() => tierTable(10, curve(500, 7300, 0.7))).not.toThrow();
  });

  it('build fails when phi < 0.30', () => {
    for (const phi of [0.29, 0.2999999, 0.25, 0]) {
      expect(() => tierTable(5, curve(500, 7300, phi))).toThrow(/phi/);
    }
    expect(PHI_MIN).toBe(0.3);
    expect(() => tierTable(10, curve(500, 6500, 0.3))).not.toThrow();
  });

  it('build fails when an entry would be negative', () => {
    // 5, 4, 3, 2, 1, 0 and then nothing is left below zero.
    expect(() => buildRefundTable({ cells: 100, shortestPath: 18, curve: curve(500, 5, 0.3) })).toThrow(
      /negative/,
    );
    expect(buildRefundTable({ cells: 7, shortestPath: 1000, curve: curve(500, 5, 0.7) })).toEqual([
      9500, 5, 4, 3, 2, 1, 0,
    ]);
    expect(() => tierTable(5, curve(500, -1, 0.5))).toThrow(RangeError);
  });

  it('build fails on malformed parameters', () => {
    const ok = curve(500, 7300, 0.5);
    for (const cells of [0, 1, 2.5, Number.NaN]) {
      expect(() => buildRefundTable({ cells, shortestPath: 8, curve: ok })).toThrow(RangeError);
    }
    for (const shortestPath of [0, -1, 1.5, Number.NaN]) {
      expect(() => buildRefundTable({ cells: 25, shortestPath, curve: ok })).toThrow(RangeError);
    }
    for (const e0Bps of [0, -5, 10001, 1.5]) {
      expect(() => tierTable(5, curve(e0Bps, 100, 0.5))).toThrow(/e0Bps/);
    }
    expect(() => tierTable(5, curve(500, 7300.5, 0.5))).toThrow(/aBps/);
    for (const phi of [Number.NaN, Number.POSITIVE_INFINITY, '0.5' as unknown as number]) {
      expect(() => tierTable(5, curve(500, 7300, phi))).toThrow(/phi/);
    }
    const unknownFamily = { ...ok, family: 'linear' } as unknown as CurveParams;
    expect(() => tierTable(5, unknownFamily)).toThrow(/family/);
    expect(() => assertCurveParams(unknownFamily)).toThrow(RangeError);
    expect(() => assertCurveParams(ok)).not.toThrow();
  });

  it('builds for a rectangle from its cell count and shortest path (5×4: 20 cells, L = 7)', () => {
    const built = buildRefundTable({ cells: 20, shortestPath: 7, curve: curve(500, 7300, 0.5) });
    expect(built).toHaveLength(20);
    expect(built[8]).toBe(3650);
    expect(() => assertStrictlyDecreasing(built)).not.toThrow();
  });
});

describe('assertStrictlyDecreasing', () => {
  it('AC-R9 accepts only tables that go down at every step', () => {
    expect(() => assertStrictlyDecreasing([9500, 7300, 6694])).not.toThrow();
    expect(() => assertStrictlyDecreasing([5])).not.toThrow();
    expect(() => assertStrictlyDecreasing([9500, 7300, 7300])).toThrow(/k = 2/);
    expect(() => assertStrictlyDecreasing([9500, 7300, 7301])).toThrow(RangeError);
    expect(() => assertStrictlyDecreasing([7300, 9500])).toThrow(/k = 1/);
    expect(() => assertStrictlyDecreasing([9500, Number.NaN, 100])).toThrow(RangeError);
  });
});

describe('payouts', () => {
  const bets = [1n, 3n, 9_999n, 10_001n, 123_456_789n, BigInt(table.limits.minBetWei), BigInt(table.limits.minBetWei) + 1n, BigInt(table.limits.maxBetWei)];

  it('refundBps reads the table of the tier', () => {
    table.tiers.forEach((tier, index) => {
      tier.refundBps.forEach((value, k) => expect(refundBps(table, index, k)).toBe(value));
    });
    expect(refundBps(table, 0, 0)).toBe(9500);
  });

  it('AC-R1 each tier has one multiplier and the exit pays bet × multiplierBps / 10000, rounded down', () => {
    expect(table.tiers.map((tier) => tier.multiplierBps)).toEqual([20000, 50000, 200000]);
    table.tiers.forEach((tier, index) => {
      for (const bet of bets) {
        expect(exitPayoutWei(table, bet, index)).toBe((bet * BigInt(tier.multiplierBps)) / 10000n);
      }
    });
    expect(exitPayoutWei(table, 10n ** 16n, 0)).toBe(2n * 10n ** 16n);
    expect(exitPayoutWei(table, 3n, 1)).toBe(15n);
    expect(exitPayoutWei(table, 1n, 0)).toBe(2n);
  });

  it('AC-R3 a cash-out after k moves pays bet × refundBps[k] / 10000, and k = 0 pays refundBps[0]', () => {
    table.tiers.forEach((tier, index) => {
      for (const bet of bets) {
        tier.refundBps.forEach((bps, k) => {
          expect(refundWei(table, bet, index, k)).toBe((bet * BigInt(bps)) / 10000n);
        });
      }
    });
    expect(refundWei(table, 10n ** 18n, 0, 0)).toBe(95n * 10n ** 16n);
    expect(refundWei(table, 10n ** 18n, 0, 1)).toBe(73n * 10n ** 16n);
  });

  it('X7 the refundable amount is a function of (table, tier, step, bet) alone: no maze goes in', () => {
    expect(refundWei).toHaveLength(4);
    expect(refundBps).toHaveLength(3);
    expect(exitPayoutWei).toHaveLength(3);
    expect(refundWei(table, 777n, 2, 40)).toBe(refundWei(structuredClone(table), 777n, 2, 40));
  });

  it('X23 rounding is always down: no bet size and no bet split gains from it', () => {
    table.tiers.forEach((tier, index) => {
      for (const bet of bets) {
        for (const k of [0, 1, 2, tier.refundBps.length - 1]) {
          const paid = refundWei(table, bet, index, k);
          const exact = bet * BigInt(tier.refundBps[k]);
          expect(paid * 10000n <= exact && exact - paid * 10000n < 10000n).toBe(true);
          expect(paid <= bet).toBe(true);
          const part = bet / 3n;
          expect(refundWei(table, part, index, k) + refundWei(table, bet - part, index, k) <= paid).toBe(true);
        }
        const part = bet / 3n;
        expect(
          exitPayoutWei(table, part, index) + exitPayoutWei(table, bet - part, index) <=
            exitPayoutWei(table, bet, index),
        ).toBe(true);
      }
    });
    // A one-wei bet cannot be refunded a fraction of a wei up.
    expect(refundWei(table, 1n, 0, 0)).toBe(0n);
    // At the minimum bet nothing is lost to rounding at all.
    const minBet = BigInt(table.limits.minBetWei);
    expect((minBet * 9500n) % 10000n).toBe(0n);
  });

  it('rejects a tier, step or bet outside the table', () => {
    for (const tier of [-1, 3, 1.5, Number.NaN]) {
      expect(() => refundBps(table, tier, 0)).toThrow(RangeError);
      expect(() => refundWei(table, 1n, tier, 0)).toThrow(RangeError);
      expect(() => exitPayoutWei(table, 1n, tier)).toThrow(RangeError);
    }
    for (const k of [-1, 25, 0.5, Number.NaN]) {
      expect(() => refundBps(table, 0, k)).toThrow(RangeError);
      expect(() => refundWei(table, 1n, 0, k)).toThrow(RangeError);
    }
    expect(refundBps(table, 2, 99)).toBe(167);
    expect(() => refundWei(table, -1n, 0, 0)).toThrow(RangeError);
    expect(() => exitPayoutWei(table, -1n, 0)).toThrow(RangeError);
  });
});
