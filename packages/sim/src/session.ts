// Session metric E11 (plan §9.3): starting with a bankroll of 50 bets and betting 1 per game,
// how many games does a player last? Games of one bot on one tier are independent draws from
// the payout distribution measured by its certification cell, so sessions are simulated from
// that distribution; no further mazes are needed.

import { fastRng } from '@maze/shared';
import type { ChunkStats, TierEconomics } from './engine';
import { median } from './stats';

export interface PayoutDistribution {
  /** Payouts as multiples of the bet, with their probabilities (which sum to 1). */
  payout: number[];
  probability: number[];
}

/** The payout distribution of a sampled cell: the multiplier, each refund level and zero. */
export function payoutDistribution(stats: ChunkStats, econ: TierEconomics): PayoutDistribution {
  if (stats.expected) throw new RangeError('payoutDistribution: the cell holds expectations, not sampled games');
  const payout: number[] = [econ.multiplierBps / 10_000];
  const probability: number[] = [stats.wins / stats.n];
  for (let k = 0; k < stats.cash.length; k++) {
    if (stats.cash[k] === 0) continue;
    payout.push(econ.refundBps[k] / 10_000);
    probability.push(stats.cash[k] / stats.n);
  }
  payout.push(0);
  probability.push(stats.losses / stats.n);
  return { payout, probability };
}

/** Median number of games played before the bankroll cannot cover a bet, capped at `gameCap`. */
export function sessionMedian(
  distribution: PayoutDistribution,
  options: { bankroll: number; gameCap: number; sessions: number; seed: bigint },
): number {
  const cumulative: number[] = [];
  let running = 0;
  for (const p of distribution.probability) {
    running += p;
    cumulative.push(running);
  }
  const rng = fastRng(options.seed);
  const lengths: number[] = [];
  for (let s = 0; s < options.sessions; s++) {
    let bankroll = options.bankroll;
    let games = 0;
    while (games < options.gameCap && bankroll >= 1) {
      const u = rng.nextU32() / 0x1_0000_0000;
      let outcome = 0;
      while (outcome < cumulative.length - 1 && u >= cumulative[outcome]) outcome += 1;
      bankroll += distribution.payout[outcome] - 1;
      games += 1;
    }
    lengths.push(games);
  }
  return median(lengths);
}
