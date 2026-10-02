// Engagement metrics and the house-revenue objective (plan §9.3). All ranges and weights come
// from `assumptions.ts` and are assumptions.

import { POPULATION_MEMBERS, type Assumptions, type PopulationMember } from './assumptions';
import type { ChunkStats, TierEconomics } from './engine';
import { byTier } from './profile';
import { payoutDistribution, sessionMedian } from './session';

/** What the metrics need from the cells of one tier. */
export interface TierCells {
  naive: ChunkStats;
  sloppy: ChunkStats;
  /** The strongest certified bot of the tier (largest upper confidence bound). */
  best: ChunkStats;
  /** value-lsm, which reports its continuation margin at a junction on the second cell. */
  reference: ChunkStats;
}

export interface TierEngagement {
  /** N1: point estimate of the best bot minus refund(0). Must be positive (fixed constraint). */
  n1PlayPremium: number;
  /** E1: win frequency of naive-greedy and its assumed range. */
  e1WinRate: number;
  e1Range: [number, number];
  e1InRange: boolean;
  /** E2: RTP of naive-greedy (assumed floor). */
  e2NaiveRtp: number;
  e2Pass: boolean;
  /** E3: share of the best bot's games cashed out after at most one move. Reported only. */
  e3EarlyQuitRate: number;
  /** E4: share of the best bot's games that end in a cash-out. Reported only. */
  e4CashOutRate: number;
  /** E6: mean number of moves of naive-greedy. Reported only. */
  e6MeanSteps: number;
  /** E7: share of sloppy-greedy games lost within distance 2 of the exit. Reported only. */
  e7NearMissRate: number;
  /** E8: displayed multiplier and its assumed minimum. */
  e8Multiplier: number;
  e8Min: number;
  e8Pass: boolean;
  /** E9: refundBps[1] and refundBps[L]. */
  e9Refund1Bps: number;
  e9RefundAtShortestBps: number;
  e9Pass: boolean;
  /** E10: RTP of sloppy-greedy (assumed floor). */
  e10SloppyRtp: number;
  e10Pass: boolean;
  /** E11: median games of a naive-greedy session, and the assumed minimum. */
  e11SessionMedian: number;
  e11Min: number;
  e11Pass: boolean;
  /** M1: mean of value-lsm's own estimate of (continuation value − refund(1)) at a junction on the second cell; null when there was none. */
  m1ContinuationMargin: number | null;
  /** Share of games in which the second cell is a junction and value-lsm reached it. */
  m1JunctionRate: number;
}

function rtp(stats: ChunkStats): number {
  return stats.sum / stats.n / 10_000;
}

export function tierEngagement(
  tierIndex: number,
  econ: TierEconomics,
  cells: TierCells,
  assumptions: Assumptions,
  sessions: number,
): TierEngagement {
  const shortest = econ.w + econ.h - 2;
  const { naive, sloppy, best, reference } = cells;
  const cashOuts = best.cash.reduce((total, count) => total + count, 0);
  const e1Range = byTier(assumptions.e1WinRate, tierIndex);
  const e1WinRate = naive.wins / naive.n;
  const e8Min = byTier(assumptions.e8MultiplierMin, tierIndex);
  const e11Min = byTier(assumptions.e11MedianMin, tierIndex);
  const e11SessionMedian = sessionMedian(payoutDistribution(naive, econ), {
    bankroll: assumptions.e11Bankroll,
    gameCap: assumptions.e11GameCap,
    sessions,
    seed: BigInt(econ.w * 1000 + econ.h) * 1_000_003n + BigInt(econ.multiplierBps),
  });
  const naiveRtp = rtp(naive);
  const sloppyRtp = rtp(sloppy);
  return {
    n1PlayPremium: rtp(best) - econ.refundBps[0] / 10_000,
    e1WinRate,
    e1Range,
    e1InRange: e1WinRate >= e1Range[0] && e1WinRate <= e1Range[1],
    e2NaiveRtp: naiveRtp,
    e2Pass: naiveRtp >= assumptions.e2NaiveRtpMin,
    e3EarlyQuitRate: (best.cash[0] + best.cash[1]) / best.n,
    e4CashOutRate: cashOuts / best.n,
    e6MeanSteps: naive.steps / naive.n,
    e7NearMissRate: sloppy.nearMiss / sloppy.n,
    e8Multiplier: econ.multiplierBps / 10_000,
    e8Min,
    e8Pass: econ.multiplierBps / 10_000 >= e8Min,
    e9Refund1Bps: econ.refundBps[1],
    e9RefundAtShortestBps: econ.refundBps[shortest],
    e9Pass: econ.refundBps[1] >= assumptions.e9Refund1MinBps && econ.refundBps[shortest] >= assumptions.e9RefundAtShortestMinBps,
    e10SloppyRtp: sloppyRtp,
    e10Pass: sloppyRtp >= assumptions.e10SloppyRtpMin,
    e11SessionMedian,
    e11Min,
    e11Pass: e11SessionMedian >= e11Min,
    m1ContinuationMargin: reference.m1N > 0 ? reference.m1Sum / reference.m1N / 10_000 : null,
    m1JunctionRate: reference.m1N / reference.n,
  };
}

/** RTP of each population member on one tier, with the standard error of each estimate. */
export type PopulationRtp = Record<PopulationMember, { rtp: number; se: number }>;

/**
 * `H = Σ_tier u_t · Σ_bot w_b · (1 − RTP_{b,t})`: the population-weighted house revenue per unit
 * bet, and its standard error under independent cells.
 */
export function houseRevenue(tiers: readonly PopulationRtp[], assumptions: Assumptions): { h: number; se: number; byTier: number[] } {
  let h = 0;
  let variance = 0;
  const perTier: number[] = [];
  for (let t = 0; t < tiers.length; t++) {
    const share = byTier(assumptions.tierShare, t);
    let tierRevenue = 0;
    for (const member of POPULATION_MEMBERS) {
      const weight = assumptions.population[member];
      tierRevenue += weight * (1 - tiers[t][member].rtp);
      variance += (share * weight * tiers[t][member].se) ** 2;
    }
    perTier.push(tierRevenue);
    h += share * tierRevenue;
  }
  return { h, se: Math.sqrt(variance), byTier: perTier };
}
