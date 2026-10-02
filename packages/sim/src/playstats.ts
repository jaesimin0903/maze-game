// Play statistics (`sim:stats`): what a run of individual games looks like.
//
// The certification answers one question per (bot, tier): the mean return and its bound. It
// stores sums only. This module replays games one by one with the same engine, mazes and bots
// and derives what sums cannot show: where games end, how payouts are distributed, how the
// house's profit and the measured return wander with the number of games, how long players go
// without a win, and how a bankroll lasts.
//
// Everything is a function of the request: the same request gives the same result on any
// machine and with any number of worker threads. Timing is reported through a callback and is
// not part of the result.
//
// Games come from the certification stream (B), far behind the games the certification itself
// played, so a result here is an independent sample of the same maze distribution.

import { fastRng, tableHash, type TuningTable } from '@maze/shared';
import { ASSUMPTIONS, POPULATION_MEMBERS, type PopulationMember } from './assumptions';
import { memberLabel, SLOPPY_EPSILON, type BotSpec, type ValueHyper } from './bots/index';
import { sha256Hex, tierHash } from './cache';
import type { CellReport, TableCertification } from './certify';
import { houseRevenue, type PopulationRtp } from './engagement';
import {
  closeStats,
  emptyStats,
  OUTCOME_CASH,
  OUTCOME_EXIT,
  type ChunkStats,
  type MazeSource,
  type TierEconomics,
} from './engine';
import type { ValueTable } from './lsm';
import { CODE_OUTCOMES, recordGames, type RecordJob } from './playstats-record';
import { rtpOf } from './runner';
import type { PayoutDistribution } from './session';
import { halfWidth95, median, requiredSamples, Z_975 } from './stats';
import { GAME_INDEX_LIMIT, type RngMode, type StreamName } from './streams';
import { tierEconomicsOf } from './tables';
import { splitRange } from './worker';

const BPS = 10_000;

export const STATS_STREAM: StreamName = 'B';
/** Seed `s` plays games `STATS_FIRST_GAME + s × STATS_SEED_SPAN ..` of the stream; the certification uses games below 2^24. */
export const STATS_FIRST_GAME = 2 ** 32;
export const STATS_SEED_SPAN = 2 ** 24;
/** Inclusive limits of a request's numbers. A seed's games must fit its span and the stream. */
export const STATS_LIMITS = {
  games: [100, STATS_SEED_SPAN],
  seed: [0, (GAME_INDEX_LIMIT - STATS_FIRST_GAME) / STATS_SEED_SPAN - 1],
  sessions: [1, 1_000_000],
  bankroll: [1, 100_000],
} as const;

/** Games per recording job. Results are placed by game index, so the size does not change them. */
const RECORD_BLOCK = 5_000;
/** Points kept of the house's cumulative profit. */
const PROFIT_POINTS = 300;
/** Losing streaks are also measured inside consecutive windows of this many games. */
export const STREAK_WINDOW = 100;
const STREAK_LENGTHS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150, 200, 300, 500, 700, 1000];
const NOISE_GAMES = [100, 1_000, 10_000, 100_000, 1_000_000];
/** Bankroll paths kept for plotting, and points per path. */
const SESSION_SAMPLE = 24;
const SESSION_POINTS = 200;

export const PLAYER_IDS = ['random-walk', 'naive-greedy', 'sloppy-greedy', 'nervous', 'harmonic', 'value-lsm'] as const;
export type PlayerId = (typeof PLAYER_IDS)[number];
export const MIX_ID = 'mix';
export type RowId = PlayerId | typeof MIX_ID;

/** Which simulated player stands for each member of the assumed population. */
const MIX_MEMBERS: Record<PopulationMember, PlayerId> = {
  'naive-greedy': 'naive-greedy',
  'sloppy-greedy': 'sloppy-greedy',
  nervous: 'nervous',
  'random-walk': 'random-walk',
  best: 'value-lsm',
};

export interface PlayerInfo {
  id: RowId;
  /** Short Korean name and one-sentence description, for the report. */
  name: string;
  description: string;
  /** Label of the same bot in `certify.json`, or null when the certification has no such cell. */
  certifiedAs: string | null;
  /** True when the row rests on `assumptions.ts`. */
  assumption: boolean;
}

const percent = (x: number): string => `${Math.round(100 * x)}%`;

const SOLO_PLAYERS: PlayerInfo[] = [
  {
    id: 'random-walk',
    name: '무작위 보행자',
    description: '갈림길마다 아무 길이나 고르고 끝까지 걷습니다. 캐시아웃하지 않습니다.',
    certifiedAs: memberLabel({ bot: 'random-walk' }),
    assumption: false,
  },
  {
    id: 'naive-greedy',
    name: '출구 방향 플레이어',
    description: '항상 출구에 가까워지는 쪽 길을 고릅니다. 캐시아웃하지 않습니다. 평범한 플레이어의 기준입니다.',
    certifiedAs: memberLabel({ bot: 'naive-greedy' }),
    assumption: false,
  },
  {
    id: 'sloppy-greedy',
    name: '실수하는 플레이어',
    description: `출구 방향으로 가지만 갈림길에서 ${percent(SLOPPY_EPSILON)} 확률로 아무 길이나 고릅니다. 캐시아웃하지 않습니다.`,
    certifiedAs: memberLabel({ bot: 'sloppy-greedy', epsilon: SLOPPY_EPSILON }),
    assumption: false,
  },
  {
    id: 'nervous',
    name: '불안한 플레이어',
    description: '실수하는 플레이어처럼 걷다가, 한 걸음 걸을 때마다 1/(최단 경로 길이) 확률로 캐시아웃합니다.',
    certifiedAs: memberLabel({ bot: 'nervous', epsilon: SLOPPY_EPSILON }),
    assumption: false,
  },
  {
    id: 'harmonic',
    name: '확률 계산 플레이어',
    description: '지금까지 본 벽과 맞는 미로를 모두 따져, 출구로 이어질 확률이 가장 높은 길을 고릅니다. 캐시아웃하지 않습니다.',
    certifiedAs: memberLabel({ bot: 'harmonic' }),
    assumption: false,
  },
  {
    id: 'value-lsm',
    name: '최강 전략',
    description: '확률 계산에 학습한 가치표를 더해, 계속 가는 것보다 캐시아웃이 이득일 때 그만둡니다. 인증 묶음에서 환수율이 가장 높았던 전략입니다.',
    certifiedAs: memberLabel({ bot: 'value-lsm' }),
    assumption: false,
  },
];

/** Every row a report can have: the player types and, last, the assumed population. */
export const PLAYERS: readonly PlayerInfo[] = [
  ...SOLO_PLAYERS,
  {
    id: MIX_ID,
    name: '가정한 플레이어 집단',
    description:
      '판마다 플레이어 유형을 가정한 비율로 뽑아 섞은 것입니다: ' +
      POPULATION_MEMBERS.map((member) => `${SOLO_PLAYERS.find((info) => info.id === MIX_MEMBERS[member])!.name} ${percent(ASSUMPTIONS.population[member])}`).join(', ') +
      '. 이 비율은 실제 데이터가 아니라 가정입니다.',
    certifiedAs: null,
    assumption: true,
  },
];

/** The trained table of value-lsm for one tier, as the certification plays it. */
export interface ValueLsmTable {
  table: ValueTable;
  hyper: ValueHyper;
}

/** The bot of a player type, or null when it needs a trained table that is not available. */
export function playerBot(player: PlayerId, valueLsm: ValueLsmTable | null): BotSpec | null {
  switch (player) {
    case 'random-walk':
      // The certification scores random-walk by its exact expectation per maze; here it plays.
      return { bot: 'random-walk-sampled' };
    case 'naive-greedy':
      return { bot: 'naive-greedy' };
    case 'sloppy-greedy':
      return { bot: 'sloppy-greedy', epsilon: SLOPPY_EPSILON };
    case 'nervous':
      return { bot: 'nervous', epsilon: SLOPPY_EPSILON };
    case 'harmonic':
      return { bot: 'harmonic' };
    case 'value-lsm':
      return valueLsm === null ? null : { bot: 'value-lsm', table: valueLsm.table, hyper: valueLsm.hyper };
  }
}

export interface Interval {
  value: number;
  ci95: [number, number];
}

export interface PayoutLevel {
  kind: 'dead-end' | 'cash-out' | 'exit';
  /** Payout as a multiple of the bet. */
  multiple: number;
  /** Moves made before the cash-out; null for the other kinds. */
  step: number | null;
  games: number;
  share: number;
}

export interface GameSummary {
  games: number;
  outcomes: { exit: number; deadEnd: number; cashOut: number };
  rates: { exit: number; deadEnd: number; cashOut: number };
  /** Share of games that reached the exit, with its Wilson 95% interval. */
  winRate: Interval;
  /** Return to player as a fraction of the bet; `sd` is the deviation of one game's return. */
  rtp: { mean: number; ci95: [number, number]; halfWidth: number; sd: number; se: number };
  /** `1 − RTP`: what the house keeps of each bet. */
  houseHold: Interval;
  meanSteps: number;
  /** Games that ended after `step` moves, by outcome. The three arrays have the same length. */
  endStep: { exit: number[]; deadEnd: number[]; cashOut: number[] };
  /** Every payout level, in ascending order of the multiple: nothing, each refund that was paid, the exit. */
  payouts: PayoutLevel[];
  houseProfit: {
    /** Cumulative profit of the house in bets after `games[i]` games, in game order. */
    games: number[];
    profit: number[];
    final: number;
    lowest: { game: number; profit: number };
    /** Games after which the cumulative profit was below zero. */
    behind: { games: number; share: number; lastGame: number };
    /** Largest fall from an earlier high. */
    maxDrawdown: { bets: number; peakGame: number; peakProfit: number; troughGame: number; troughProfit: number };
    /** Longest run of consecutive games that ended below an earlier high. */
    longestBelowPeak: number;
  };
  /** The return measured on the first `games` games, with its 95% interval. */
  convergence: { games: number; rtp: number; lo: number; hi: number }[];
  /** Half-width of the 95% interval of the return after `games` games, from the measured deviation. */
  noise: { games: number; halfWidth: number }[];
  /** Games needed for a 95% interval of ±1 percentage point. */
  gamesForOnePoint: number;
  streaks: {
    /** Longest run of consecutive games that did not reach the exit. */
    longest: number;
    window: number;
    windows: number;
    /** `longestInWindow[r]`: windows of `window` games whose longest such run was `r`. */
    longestInWindow: number[];
    /** Share of all runs of `k` consecutive games without a win, and `(1 − win rate)^k`. */
    inARow: { k: number; observed: number; independent: number }[];
  };
}

export interface SessionOptions {
  /** Starting bankroll in bets; one bet is staked per game. */
  bankroll: number;
  sessions: number;
  /** A session stops after this many games when the player is still solvent. */
  gameCap: number;
  seed: bigint;
}

export interface SessionStats {
  bankroll: number;
  sessions: number;
  gameCap: number;
  /** Games between two recorded points of a path and of the survival curve. */
  stride: number;
  /** A sample of sessions: the bankroll after 0, `stride`, 2 × `stride`, … games, then the last game and bankroll. */
  paths: { values: number[]; games: number; final: number }[];
  /** Share of players who can still cover a bet after `games[i]` games. Never increases. */
  survival: { games: number[]; share: number[] };
  /** Games played before the bankroll could no longer cover a bet; `gameCap` for players who never got there. */
  gamesPlayed: { p10: number; median: number; p90: number };
  /** True when at least half of the players were still solvent at `gameCap`. */
  medianCapped: boolean;
  ruinedShare: number;
  /** Share of players whose bankroll was above its start after at least one game. */
  everAheadShare: number;
  aheadAtEndShare: number;
}

export interface CellStats extends GameSummary {
  player: RowId;
  /** Null for the population mix: a session belongs to one player, not to a blend. */
  sessions: SessionStats | null;
}

export interface CrossCheck {
  player: PlayerId;
  certifiedBot: string;
  certifiedGames: number;
  certifiedRtp: number;
  certifiedSe: number;
  rtp: number;
  /** Standard error of this run's mean, from the deviation of one game that the certified cell implies. */
  se: number;
  difference: number;
  /** Half-width of the 95% interval of the difference of two independent estimates. */
  halfWidth: number;
  z: number;
  agrees: boolean;
}

export interface TierStats {
  tier: number;
  n: number;
  multiplier: number;
  shortestPath: number;
  /** Refund as a multiple of the bet after `k` moves. */
  refund: number[];
  cells: CellStats[];
  crossCheck: CrossCheck[];
  /** Requested rows that could not be produced. */
  unavailable: { player: RowId; reason: 'no-value-table' | 'mix-needs-every-member' }[];
}

export interface TableStats {
  role: 'main' | 'compare';
  path: string;
  tableHash: string;
  /** `certify.json` holds a passed, complete certification of this table by the current simulator code. */
  certified: boolean;
  tiers: TierStats[];
  /** House revenue per unit bet over the assumed population and tier usage (`H` of the tuning report); null unless every tier and member was run. */
  population: { houseHold: number; se: number; byTier: number[] } | null;
}

export interface PlayStats {
  schema: 1;
  simCodeHash: string;
  options: {
    games: number;
    seed: number;
    sessions: number;
    bankroll: number;
    sessionGameCap: number;
    streakWindow: number;
    rng: RngMode;
    stream: StreamName;
    /** Every cell plays games `firstGame .. firstGame + games - 1` of the stream. */
    firstGame: number;
  };
  players: PlayerInfo[];
  /** ASSUMPTIONS, not data: the population mix and the share of play per tier. */
  assumptions: { population: Record<string, number>; tierShare: number[] };
  tables: TableStats[];
}

function wilson(successes: number, n: number): Interval {
  const p = successes / n;
  const z2 = Z_975 * Z_975;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z_975 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { value: p, ci95: [Math.max(0, centre - half), Math.min(1, centre + half)] };
}

/** 100, 200, 500, 1,000, … up to `n`, and `n` itself. */
function checkpoints(n: number): number[] {
  const out: number[] = [];
  for (let decade = 100; decade <= n; decade *= 10) {
    for (const step of [1, 2, 5]) if (decade * step <= n) out.push(decade * step);
  }
  if (out[out.length - 1] !== n) out.push(n);
  return out;
}

/**
 * Everything the game sequence alone determines. `codes[i]` is game `i` as `recordGames` codes
 * it; the order of the games is the order they were played in.
 */
export function summarizeGames(codes: Uint16Array, econ: TierEconomics): GameSummary {
  const n = codes.length;
  if (n < STATS_LIMITS.games[0]) throw new RangeError(`summarizeGames: at least ${STATS_LIMITS.games[0]} games are needed, got ${n}`);
  const cells = econ.w * econ.h;
  // The counts the engine keeps for a cell, so the return is computed by the certification's own formula.
  const counts: ChunkStats = emptyStats(cells);
  const exitAt = new Array<number>(cells).fill(0);
  const deadEndAt = new Array<number>(cells).fill(0);

  // House profit, in bps of a bet so that the running total is an exact integer.
  const points = Math.min(n, PROFIT_POINTS);
  const profitGames: number[] = [];
  const profit: number[] = [];
  let cumulative = 0;
  let peak = 0;
  let peakGame = 0;
  let lowest = 0;
  let lowestGame = 0;
  let behind = 0;
  let lastBehind = 0;
  let longestBelowPeak = 0;
  const drawdown = { bps: 0, peakGame: 0, peakBps: 0, troughGame: 0 };

  const marks = checkpoints(n);
  let mark = 0;
  const convergence: GameSummary['convergence'] = [];

  // Runs of consecutive games without a win: over the whole sequence and inside each window.
  let run = 0;
  let longest = 0;
  const runs = new Map<number, number>();
  let windowRun = 0;
  let windowLongest = 0;
  const longestInWindow = new Array<number>(STREAK_WINDOW + 1).fill(0);
  const closeRun = (): void => {
    if (run === 0) return;
    runs.set(run, (runs.get(run) ?? 0) + 1);
    if (run > longest) longest = run;
    run = 0;
  };

  for (let i = 0; i < n; i++) {
    const game = i + 1;
    const code = codes[i];
    const outcome = code % CODE_OUTCOMES;
    const k = (code - outcome) / CODE_OUTCOMES;
    let payout = 0;
    counts.n += 1;
    counts.steps += k;
    if (outcome === OUTCOME_EXIT) {
      counts.wins += 1;
      exitAt[k] += 1;
      payout = econ.multiplierBps;
      closeRun();
      if (windowRun > windowLongest) windowLongest = windowRun;
      windowRun = 0;
    } else {
      if (outcome === OUTCOME_CASH) {
        counts.cash[k] += 1;
        payout = econ.refundBps[k];
      } else {
        counts.losses += 1;
        deadEndAt[k] += 1;
      }
      run += 1;
      windowRun += 1;
    }
    if (game % STREAK_WINDOW === 0) {
      longestInWindow[Math.max(windowLongest, windowRun)] += 1;
      windowRun = 0;
      windowLongest = 0;
    }

    cumulative += BPS - payout;
    if (cumulative >= peak) {
      longestBelowPeak = Math.max(longestBelowPeak, game - peakGame - 1);
      peak = cumulative;
      peakGame = game;
    } else if (peak - cumulative > drawdown.bps) {
      drawdown.bps = peak - cumulative;
      drawdown.peakGame = peakGame;
      drawdown.peakBps = peak;
      drawdown.troughGame = game;
    }
    if (cumulative < 0) {
      behind += 1;
      lastBehind = game;
    }
    if (cumulative < lowest) {
      lowest = cumulative;
      lowestGame = game;
    }
    if (game === Math.ceil(((profit.length + 1) * n) / points)) {
      profitGames.push(game);
      profit.push(cumulative / BPS);
    }
    if (game === marks[mark]) {
      closeStats(counts, econ);
      const running = rtpOf(counts);
      convergence.push({ games: game, rtp: running.mean, lo: running.ci[0], hi: running.ci[1] });
      mark += 1;
    }
  }
  closeRun();
  longestBelowPeak = Math.max(longestBelowPeak, n - peakGame);

  closeStats(counts, econ);
  const rtp = rtpOf(counts);
  const cashOuts = counts.cash.reduce((total, count) => total + count, 0);
  let lastStep = 0;
  for (let k = 0; k < cells; k++) if (exitAt[k] + deadEndAt[k] + counts.cash[k] > 0) lastStep = k;

  const payouts: PayoutLevel[] = [{ kind: 'dead-end', multiple: 0, step: null, games: counts.losses, share: counts.losses / n }];
  // Refunds fall with every move, so descending steps are ascending multiples.
  for (let k = cells - 1; k >= 0; k--) {
    if (counts.cash[k] === 0) continue;
    payouts.push({ kind: 'cash-out', multiple: econ.refundBps[k] / BPS, step: k, games: counts.cash[k], share: counts.cash[k] / n });
  }
  payouts.push({ kind: 'exit', multiple: econ.multiplierBps / BPS, step: null, games: counts.wins, share: counts.wins / n });

  const winRate = wilson(counts.wins, n);
  const inARow: GameSummary['streaks']['inARow'] = [];
  for (const k of STREAK_LENGTHS) {
    if (k > n) break;
    let all = 0;
    for (const [length, count] of runs) if (length >= k) all += count * (length - k + 1);
    inARow.push({ k, observed: all / (n - k + 1), independent: (1 - winRate.value) ** k });
    if (all === 0) break;
  }
  let longestWindowRun = STREAK_WINDOW;
  while (longestWindowRun > 0 && longestInWindow[longestWindowRun] === 0) longestWindowRun -= 1;

  return {
    games: n,
    outcomes: { exit: counts.wins, deadEnd: counts.losses, cashOut: cashOuts },
    rates: { exit: counts.wins / n, deadEnd: counts.losses / n, cashOut: cashOuts / n },
    winRate,
    rtp: { mean: rtp.mean, ci95: rtp.ci, halfWidth: rtp.halfWidth, sd: rtp.sd, se: rtp.se },
    houseHold: { value: 1 - rtp.mean, ci95: [1 - rtp.ci[1], 1 - rtp.ci[0]] },
    meanSteps: counts.steps / n,
    endStep: {
      exit: exitAt.slice(0, lastStep + 1),
      deadEnd: deadEndAt.slice(0, lastStep + 1),
      cashOut: counts.cash.slice(0, lastStep + 1),
    },
    payouts,
    houseProfit: {
      games: profitGames,
      profit,
      final: cumulative / BPS,
      lowest: { game: lowestGame, profit: lowest / BPS },
      behind: { games: behind, share: behind / n, lastGame: lastBehind },
      maxDrawdown: {
        bets: drawdown.bps / BPS,
        peakGame: drawdown.peakGame,
        peakProfit: drawdown.peakBps / BPS,
        troughGame: drawdown.troughGame,
        troughProfit: (drawdown.peakBps - drawdown.bps) / BPS,
      },
      longestBelowPeak,
    },
    convergence,
    noise: NOISE_GAMES.map((games) => ({ games, halfWidth: halfWidth95(rtp.sd, games) })),
    gamesForOnePoint: requiredSamples(rtp.sd, 0.01),
    streaks: {
      longest,
      window: STREAK_WINDOW,
      windows: Math.floor(n / STREAK_WINDOW),
      longestInWindow: longestInWindow.slice(0, longestWindowRun + 1),
      inARow,
    },
  };
}

/**
 * Bankroll sessions: each player starts with `bankroll` bets and stakes one bet per game until
 * the bankroll cannot cover a bet or `gameCap` games are played. As in `session.ts`, the games
 * of a session are independent draws from the measured payout distribution.
 */
export function simulateSessions(distribution: PayoutDistribution, options: SessionOptions): SessionStats {
  const { bankroll, sessions, gameCap } = options;
  // Likeliest outcome first, so that most draws stop at the first comparison.
  const order = distribution.probability
    .map((_, i) => i)
    .sort((a, b) => distribution.probability[b] - distribution.probability[a] || distribution.payout[a] - distribution.payout[b]);
  const net = order.map((i) => Math.round(distribution.payout[i] * BPS) - BPS);
  const cumulative: number[] = [];
  let running = 0;
  for (const i of order) {
    running += distribution.probability[i];
    cumulative.push(running);
  }
  const last = order.length - 1;
  const start = bankroll * BPS;
  const stride = Math.max(1, Math.ceil(gameCap / SESSION_POINTS));
  const rng = fastRng(options.seed);

  const lengths: number[] = [];
  const ruinedAfter = new Array<number>(gameCap + 1).fill(0);
  const paths: SessionStats['paths'] = [];
  let ruined = 0;
  let everAhead = 0;
  let aheadAtEnd = 0;
  for (let s = 0; s < sessions; s++) {
    const values: number[] | null = s < SESSION_SAMPLE ? [bankroll] : null;
    let money = start;
    let games = 0;
    let ahead = false;
    while (games < gameCap && money >= BPS) {
      const u = rng.nextU32() / 0x1_0000_0000;
      let outcome = 0;
      while (outcome < last && u >= cumulative[outcome]) outcome += 1;
      money += net[outcome];
      games += 1;
      if (money > start) ahead = true;
      if (values !== null && games % stride === 0) values.push(money / BPS);
    }
    if (money < BPS) {
      ruined += 1;
      ruinedAfter[games] += 1;
    }
    if (ahead) everAhead += 1;
    if (money > start) aheadAtEnd += 1;
    lengths.push(games);
    if (values !== null) paths.push({ values, games, final: money / BPS });
  }

  const survivalGames: number[] = [];
  const share: number[] = [];
  let gone = 0;
  for (let k = 0; k <= gameCap; k++) {
    gone += ruinedAfter[k];
    if (k % stride === 0 || k === gameCap) {
      survivalGames.push(k);
      share.push(1 - gone / sessions);
    }
  }
  const sorted = [...lengths].sort((a, b) => a - b);
  const quantile = (q: number): number => sorted[Math.min(sessions - 1, Math.floor(q * sessions))];
  const medianGames = median(lengths);
  return {
    bankroll,
    sessions,
    gameCap,
    stride,
    paths,
    survival: { games: survivalGames, share },
    gamesPlayed: { p10: quantile(0.1), median: medianGames, p90: quantile(0.9) },
    medianCapped: medianGames >= gameCap,
    ruinedShare: ruined / sessions,
    everAheadShare: everAhead / sessions,
    aheadAtEndShare: aheadAtEnd / sessions,
  };
}

/** A 64-bit seed that depends on the purpose and on nothing else. */
function derivedSeed(...parts: (string | number)[]): bigint {
  return BigInt(`0x${sha256Hex(`maze-sim/playstats/v1/${parts.join('/')}`).slice(0, 16)}`);
}

/**
 * The assumed population as one sequence: game `i` is the game the member drawn for it played
 * on maze `i`. `records` holds every member's games on the same mazes.
 */
export function mixGames(records: Record<PopulationMember, Uint16Array>, population: Record<PopulationMember, number>, seed: bigint): Uint16Array {
  const n = records[POPULATION_MEMBERS[0]].length;
  const cumulative: number[] = [];
  let running = 0;
  for (const member of POPULATION_MEMBERS) {
    if (records[member].length !== n) throw new RangeError('mixGames: the members played different numbers of games');
    running += population[member];
    cumulative.push(running);
  }
  const rng = fastRng(seed);
  const last = POPULATION_MEMBERS.length - 1;
  const mixed = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const u = rng.nextU32() / 0x1_0000_0000;
    let member = 0;
    while (member < last && u >= cumulative[member]) member += 1;
    mixed[i] = records[POPULATION_MEMBERS[member]][i];
  }
  return mixed;
}

/**
 * Compares a cell with the certification's cell of the same bot: two independent samples of
 * one mean. The deviation of a single game is computed from the certified cell's outcome
 * counts, where millions of games pin it down; a small sample's own deviation can be far off
 * (it is zero when the sample saw no win), and the certified `sd` of a bot scored by exact
 * expectation (random-walk) is not the deviation of a played game.
 */
export function crossCheck(player: PlayerId, cell: GameSummary, certified: CellReport, econ: TierEconomics): CrossCheck {
  let secondMoment = certified.winRate * (econ.multiplierBps / BPS) ** 2;
  certified.cash.forEach((count, k) => {
    secondMoment += (count / certified.games) * (econ.refundBps[k] / BPS) ** 2;
  });
  const se = Math.sqrt(Math.max(0, secondMoment - certified.rtp ** 2) / cell.games);
  const difference = cell.rtp.mean - certified.rtp;
  const combined = Math.hypot(se, certified.se);
  const halfWidth = Z_975 * combined;
  return {
    player,
    certifiedBot: certified.bot,
    certifiedGames: certified.games,
    certifiedRtp: certified.rtp,
    certifiedSe: certified.se,
    rtp: cell.rtp.mean,
    se,
    difference,
    halfWidth,
    z: difference / combined,
    agrees: Math.abs(difference) <= halfWidth,
  };
}

export interface StatsTableInput {
  role: 'main' | 'compare';
  path: string;
  table: TuningTable;
  /** The trained value-lsm table per tier index; null where none is available. */
  valueLsm: (ValueLsmTable | null)[];
  certification: TableCertification | null;
}

export interface StatsRequest {
  tables: StatsTableInput[];
  /** Tier indexes; null runs every tier of each table. */
  tiers: number[] | null;
  players: PlayerId[];
  /** Games per (player, tier) cell. */
  games: number;
  seed: number;
  sessions: number;
  bankroll: number;
  rngMode: RngMode;
  codeHash: string;
}

/** Plays the games of a job; the worker pool or the calling thread. */
export type Recorder = (job: RecordJob) => Promise<Uint16Array>;

export const recordInline: Recorder = (job) => Promise.resolve(recordGames(job));

export interface CellTiming {
  role: 'main' | 'compare';
  tier: number;
  n: number;
  player: PlayerId;
  games: number;
  /** Wall-clock seconds spent playing the cell's games. */
  seconds: number;
}

function assertRequest(request: StatsRequest): void {
  for (const name of ['games', 'seed', 'sessions', 'bankroll'] as const) {
    const [min, max] = STATS_LIMITS[name];
    const value = request[name];
    if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer in ${min} .. ${max}, got ${value}`);
  }
  if (request.players.length === 0) throw new RangeError('at least one player type is needed');
  for (const input of request.tables) {
    for (const tier of request.tiers ?? []) {
      if (!Number.isInteger(tier) || tier < 0 || tier >= input.table.tiers.length) throw new RangeError(`table ${input.path} has no tier ${tier}`);
    }
  }
}

async function recordCell(record: Recorder, job: Omit<RecordJob, 'from' | 'to'>, first: number, games: number): Promise<Uint16Array> {
  const parts = await Promise.all(splitRange(first, first + games, RECORD_BLOCK).map(([from, to]) => record({ ...job, from, to })));
  const codes = new Uint16Array(games);
  let at = 0;
  for (const part of parts) {
    codes.set(part, at);
    at += part.length;
  }
  return codes;
}

/** Runs the request. `onCell` is told how long each cell's games took; that is not part of the result. */
export async function collectPlayStats(request: StatsRequest, record: Recorder, onCell?: (timing: CellTiming) => void): Promise<PlayStats> {
  assertRequest(request);
  const { games, seed, sessions, bankroll } = request;
  const first = STATS_FIRST_GAME + seed * STATS_SEED_SPAN;
  const source: MazeSource = { kind: 'rng', mode: request.rngMode, stream: STATS_STREAM };
  const gameCap = ASSUMPTIONS.e11GameCap;
  const mixWanted = POPULATION_MEMBERS.every((member) => request.players.includes(MIX_MEMBERS[member]));

  const tables: TableStats[] = [];
  for (const input of request.tables) {
    const certification = input.certification !== null && input.certification.simCodeHash === request.codeHash ? input.certification : null;
    const tierIndexes = request.tiers ?? input.table.tiers.map((_, i) => i);
    const tiers: TierStats[] = [];
    const populations: PopulationRtp[] = [];
    for (const tierIndex of tierIndexes) {
      const config = input.table.tiers[tierIndex];
      const econ = tierEconomicsOf(config);
      const tierKey = tierHash(econ);
      const certified = certification?.tiers.find((entry) => entry.tier === tierIndex && entry.multiplierBps === config.multiplierBps) ?? null;
      const cells: CellStats[] = [];
      const checks: CrossCheck[] = [];
      const unavailable: TierStats['unavailable'] = [];
      const records = new Map<PlayerId, Uint16Array>();
      for (const player of request.players) {
        const bot = playerBot(player, input.valueLsm[tierIndex] ?? null);
        if (bot === null) {
          unavailable.push({ player, reason: 'no-value-table' });
          continue;
        }
        const started = performance.now();
        const codes = await recordCell(record, { econ, bot, source }, first, games);
        onCell?.({ role: input.role, tier: tierIndex, n: config.n, player, games, seconds: (performance.now() - started) / 1000 });
        records.set(player, codes);
        const summary = summarizeGames(codes, econ);
        const distribution: PayoutDistribution = {
          payout: summary.payouts.map((level) => level.multiple),
          probability: summary.payouts.map((level) => level.share),
        };
        cells.push({
          player,
          ...summary,
          sessions: simulateSessions(distribution, { bankroll, sessions, gameCap, seed: derivedSeed('sessions', seed, tierKey, player) }),
        });
        const label = PLAYERS.find((info) => info.id === player)!.certifiedAs;
        const cell = certified?.cells.find((entry) => entry.bot === label && entry.stream === STATS_STREAM);
        if (cell !== undefined) checks.push(crossCheck(player, summary, cell, econ));
      }

      if (mixWanted) {
        if (POPULATION_MEMBERS.every((member) => records.has(MIX_MEMBERS[member]))) {
          const members = Object.fromEntries(POPULATION_MEMBERS.map((member) => [member, records.get(MIX_MEMBERS[member])!])) as Record<PopulationMember, Uint16Array>;
          const mixed = mixGames(members, ASSUMPTIONS.population, derivedSeed('mix', seed, tierKey));
          cells.push({ player: MIX_ID, ...summarizeGames(mixed, econ), sessions: null });
          const rtpOfMember = (member: PopulationMember): { rtp: number; se: number } => {
            const cell = cells.find((entry) => entry.player === MIX_MEMBERS[member])!;
            return { rtp: cell.rtp.mean, se: cell.rtp.se };
          };
          populations.push(Object.fromEntries(POPULATION_MEMBERS.map((member) => [member, rtpOfMember(member)])) as PopulationRtp);
        } else {
          unavailable.push({ player: MIX_ID, reason: 'mix-needs-every-member' });
        }
      }

      tiers.push({
        tier: tierIndex,
        n: config.n,
        multiplier: config.multiplierBps / BPS,
        shortestPath: econ.w + econ.h - 2,
        refund: config.refundBps.map((bps) => bps / BPS),
        cells,
        crossCheck: checks,
        unavailable,
      });
    }

    // `H` weights tiers by position, so it is defined only for the whole table.
    const wholeTable = tierIndexes.length === input.table.tiers.length && populations.length === input.table.tiers.length;
    const revenue = wholeTable ? houseRevenue(populations, ASSUMPTIONS) : null;
    tables.push({
      role: input.role,
      path: input.path,
      tableHash: tableHash(input.table),
      certified: certification !== null && certification.complete && certification.pass,
      tiers,
      population: revenue === null ? null : { houseHold: revenue.h, se: revenue.se, byTier: revenue.byTier },
    });
  }

  return {
    schema: 1,
    simCodeHash: request.codeHash,
    options: {
      games,
      seed,
      sessions,
      bankroll,
      sessionGameCap: gameCap,
      streakWindow: STREAK_WINDOW,
      rng: request.rngMode,
      stream: STATS_STREAM,
      firstGame: first,
    },
    players: PLAYERS.filter((info) => (info.id === MIX_ID ? mixWanted : request.players.includes(info.id))),
    assumptions: { population: { ...ASSUMPTIONS.population }, tierShare: [...ASSUMPTIONS.tierShare] },
    tables,
  };
}
