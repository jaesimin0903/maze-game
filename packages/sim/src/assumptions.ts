// Population mix and engagement ranges (plan §9.3).
//
// EVERYTHING IN THIS FILE IS AN ASSUMPTION. There is no real player data. The house-revenue
// figure `H`, the engagement checks and the choice between candidate tables depend on these
// numbers; every table of a report that uses them says so, and `sim:sensitivity` shows how the
// choice moves when they change.

/** A member of the assumed player population. `best` is the strongest certified bot of the tier. */
export type PopulationMember = 'naive-greedy' | 'sloppy-greedy' | 'nervous' | 'random-walk' | 'best';

export interface Assumptions {
  /** Share of play by each kind of player. Sums to 1. */
  population: Record<PopulationMember, number>;
  /** Share of play by tier index (S, M, L). Sums to 1. */
  tierShare: number[];
  /** E1: win frequency of naive-greedy, by tier index. Basis for a size change only. */
  e1WinRate: [min: number, max: number][];
  /** E2: RTP of naive-greedy must be at least this. Not relaxable; bounds the house revenue from above. */
  e2NaiveRtpMin: number;
  /** E8: displayed multiplier, by tier index. Relaxed second. */
  e8MultiplierMin: number[];
  /** E9: `refundBps[1]` and `refundBps[L]`. Relaxed first. */
  e9Refund1MinBps: number;
  e9RefundAtShortestMinBps: number;
  /** E10: RTP of sloppy-greedy must be at least this. Not relaxable. */
  e10SloppyRtpMin: number;
  /** E11: a naive-greedy session with a bankroll of 50 bets, one bet per game, capped at 2,000 games. */
  e11Bankroll: number;
  e11GameCap: number;
  e11MedianMin: number[];
}

export const ASSUMPTIONS: Assumptions = {
  population: { 'naive-greedy': 0.35, 'sloppy-greedy': 0.25, nervous: 0.2, 'random-walk': 0.05, best: 0.15 },
  tierShare: [0.5, 0.35, 0.15],
  e1WinRate: [
    [0.25, 0.45],
    [0.08, 0.2],
    [0.02, 0.06],
  ],
  e2NaiveRtpMin: 0.85,
  e8MultiplierMin: [2.0, 5.0, 20],
  e9Refund1MinBps: 6000,
  e9RefundAtShortestMinBps: 2000,
  e10SloppyRtpMin: 0.5,
  e11Bankroll: 50,
  e11GameCap: 2000,
  e11MedianMin: [200, 150, 50],
};

export const POPULATION_MEMBERS: readonly PopulationMember[] = ['naive-greedy', 'sloppy-greedy', 'nervous', 'random-walk', 'best'];

/** A tuned table must improve `H` by at least this to replace the baseline (0.2 percentage points). */
export const ADOPTION_THRESHOLD = 0.002;
