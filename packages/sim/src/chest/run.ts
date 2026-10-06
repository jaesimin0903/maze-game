// `sim:chest`: how many treasure chests games find, what the points come to, how a person who
// counts points plays, and what the chests would cost if they were paid in money.
//
// For every table, tier and player type it plays evaluation games and bankroll sessions with the
// production chest rule (model.ts; rule 2 by default) and reports, per row: path chests per game,
// the share of games that end in a dead-end chest, points per game (path and dead-end) and per
// unit of bet, the distribution of points per session, the return to player in money (unchanged
// by points) and what it would be if chest rewards were paid in money, and the value per point at
// which the row's play would break even for a player who counted points as money. It plays the
// thoughtful person a second time as a person who also counts points, on the same mazes with the
// same noise, and reports how much longer it walks. For the strongest certified strategy it
// computes the exit multiplier per tier that would bring its return back to today's if chests
// paid money (computed, never applied), and checks it with a paired run. Everything is a function
// of the request.

import {
  CHEST_RATE_BPS,
  CHEST_REWARD_MAX_BPS,
  CHEST_REWARD_MIN_BPS,
  CHEST_TAG,
  isKnownChestRule,
  PATH_CHEST_RATE_BPS,
  PATH_CHEST_REWARD_MAX_BPS,
  PATH_CHEST_REWARD_MIN_BPS,
  PATH_CHEST_TAG,
  POINT_UNIT_WEI,
  tableHash,
  type TuningTable,
} from '@maze/shared';
import { ASSUMPTIONS } from '../assumptions';
import { SLOPPY_EPSILON, VALUE_LSM_HYPER, type BotSpec } from '../bots/index';
import type { TierEconomics } from '../engine';
import { firstIndex } from '../human/feed';
import { AVERAGE_DEFAULTS, LEARNING_DEFAULTS, NOVICE_DEFAULTS, THOUGHTFUL_DEFAULTS } from '../human/models';
import type { ValueTable } from '../lsm';
import { Z_975 } from '../stats';
import { tierEconomicsOf } from '../tables';
import {
  emptyGames,
  emptyPaired,
  mergeGames,
  mergePaired,
  type Calibration,
  type GamesStats,
  type PairedStats,
  type PlayerSpec,
  type SessionColumns,
} from './jobs';
import { CHEST_STREAM_LABEL, chestFirstIndex, chestStreamBaseHex, chestStreamDisjoint } from './model';
import type { ChestExecutor } from './pool';

export const PLAYER_IDS = [
  'novice',
  'average',
  'thoughtful',
  'thoughtful-points',
  'learning',
  'naive-greedy',
  'sloppy-greedy',
  'nervous',
  'random-walk',
  'value-lsm',
  'value-lookahead-all',
  'dead-end-seeker',
] as const;
export type PlayerId = (typeof PLAYER_IDS)[number];

export interface PlayerInfo {
  id: PlayerId;
  name: string;
  group: 'human' | 'bot' | 'ai' | 'farmer';
  description: string;
}

export const PLAYER_INFO: Record<PlayerId, PlayerInfo> = {
  novice: { id: 'novice', name: '초보', group: 'human', description: 'sim:human의 초보 모델. 출구 쪽으로 대충 가고 거의 그만두지 않는다.' },
  average: { id: 'average', name: '보통', group: 'human', description: 'sim:human의 보통 모델. 본 벽을 기억하고 환급 하한 아래로 떨어지면 그만둔다.' },
  thoughtful: {
    id: 'thoughtful',
    name: '생각하는 사람',
    group: 'human',
    description: 'sim:human의 생각하는 모델(전망이론 왜곡 포함). 크기마다 sim:human과 같은 보정을 쓴다.',
  },
  'thoughtful-points': {
    id: 'thoughtful-points',
    name: '포인트를 세는 생각하는 사람',
    group: 'human',
    description:
      '생각하는 사람과 같은 사람(같은 미로, 같은 잡음)이 포인트도 센다. 1포인트를 그 포인트 단위만큼의 베팅 금액(10^12 wei)과 같은 가치로 치고, 그만둘지 정할 때마다 계속 걸으면 얻을 상자 가치(생각하는 사람이 한 걸음에 얻는 평균 상자 보상 × 자기 모델이 내다보는 걸음 수 2)만큼 지금 그만두는 값을 낮춰 본다.',
  },
  learning: { id: 'learning', name: '배우는 사람', group: 'human', description: 'sim:human의 배우는 모델. 처음 시작한 사람이 300판을 하는 동안의 평균.' },
  'naive-greedy': {
    id: 'naive-greedy',
    name: 'naive-greedy',
    group: 'bot',
    description: '인증 묶음의 봇. 출구 방향으로만 가고 그만두지 않는다(가정한 플레이어 구성 35%).',
  },
  'sloppy-greedy': { id: 'sloppy-greedy', name: 'sloppy-greedy(0.10)', group: 'bot', description: '인증 묶음의 봇. 10% 확률로 아무 갈래나 고른다(구성 25%).' },
  nervous: { id: 'nervous', name: 'nervous(0.10)', group: 'bot', description: '인증 묶음의 봇. 걸음마다 일정 확률로 그만둔다(구성 20%).' },
  'random-walk': { id: 'random-walk', name: 'random-walk', group: 'bot', description: '인증 묶음의 봇. 아무 갈래나 고른다(구성 5%).' },
  'value-lsm': { id: 'value-lsm', name: 'value-lsm (최고 인증 봇)', group: 'ai', description: '인증의 최고 봇. 인증에 쓴 가치표 그대로(구성 15%).' },
  'value-lookahead-all': {
    id: 'value-lookahead-all',
    name: 'value-lookahead-all',
    group: 'ai',
    description: '모든 결정에서 한 수 앞을 정확히 계산하는 적대 전략(expectimax(1)). 같은 가치표.',
  },
  'dead-end-seeker': {
    id: 'dead-end-seeker',
    name: '막다른 길 사냥꾼',
    group: 'farmer',
    description:
      '돈이 아니라 포인트를 노리는 플레이어. 그만두지 않고, 갈림길에서 출구에서 가장 먼 쪽으로 가서 거의 모든 판을 막다른 칸에서 끝낸다.',
  },
};

/** Careers of the learning model: a person who starts and plays this many games. */
export const LEARNING_CAREER = 300;

/**
 * What the points-counting person (`thoughtful-points`) takes one point to be worth, in point
 * units (10^12 wei of bet): 1 = a point is worth the bet share it stands for, as if chest rewards
 * were money. The most a person could reasonably count a point at, so its effect is an upper bound.
 */
export const POINT_VALUE_UNITS = 1;

export interface ChestTableInput {
  /** Short Korean name, e.g. "기본 표". */
  label: string;
  path: string;
  table: TuningTable;
  /** The value-lsm table the certification played each tier with, or `null` (then the AI rows are skipped). */
  valueTables: ValueTable[] | null;
}

export interface ChestRequest {
  tables: ChestTableInput[];
  players: readonly PlayerId[];
  /** Evaluation games per (table, tier, player). */
  games: number;
  /** Bankroll sessions per (table, tier, player). */
  sessions: number;
  bankrollBets: number;
  gameCap: number;
  /** Paired games of the multiplier check per tier. */
  checkGames: number;
  /** The thoughtful player's calibration (sim:human's defaults reproduce its calibration). */
  fitGames: number;
  reachGames: number;
  /** Decimal wei: the bet the points are counted for. */
  betWei: string;
  seed: number;
  /** The chest rule the games are played under (1 or 2). */
  rule: number;
}

export interface Interval {
  mean: number;
  ci95: [number, number];
}

export interface SessionSummary {
  sessions: number;
  medianGames: number;
  /** Share of sessions that found at least one chest. */
  withChest: number;
  meanChests: number;
  points: { mean: number; p10: number; p50: number; p90: number; max: number };
}

export interface ChestRow {
  player: PlayerId;
  games: number;
  winRate: number;
  lossRate: number;
  cashRate: number;
  meanSteps: number;
  /** Mean steps of the games that ended in a cash-out; `null` without any. */
  meanCashSteps: number | null;
  /** Share of games that end in a dead end holding a chest. */
  chestRate: Interval;
  /** Share of losses that found a chest (about 0.3 for every player: nobody sees a chest before entering it). */
  chestShareOfLosses: number;
  /** Mean reward of a dead-end chest, bps. */
  meanRewardBps: number;
  /** Path chests found per game (rule 2). */
  pathChestsPerGame: number;
  /** Path chests per path cell entered: about 0.1 for every player. */
  pathChestShareOfCells: number;
  /** Mean reward of a path chest, bps. */
  meanPathRewardBps: number;
  /** Points per game at the request's bet (rounded down per award, as the server does), both kinds. */
  pointsPerGame: number;
  pathPointsPerGame: number;
  deadEndPointsPerGame: number;
  /** Points per 1 ETH of bets (no rounding): 10^6 × chest money per unit of bet. */
  pointsPerEth: number;
  /** Return in money, as the contract pays it (points do not change it). */
  rtp: Interval;
  /** Return if chest rewards were paid in money. */
  moneyRtp: Interval;
  /** moneyRtp − rtp: what chests paid in money would add to the return, per unit of bet. */
  chestEv: Interval;
  /**
   * The value of one point, in wei, at which this play would break even at the request's bet if
   * points were worth that much: (1 − rtp) × bet / pointsPerGame. `null` without points.
   */
  breakEvenWeiPerPoint: number | null;
  sessions: SessionSummary | null;
}

export interface MoneyCost {
  player: PlayerId;
  /** Today's return of the player, and what chests paid in money would add (fractions of the bet). */
  rtp: number;
  chestEv: number;
  winRate: number;
  multiplierBps: number;
  /**
   * The exit multiplier that would bring the player's return with money chests back to today's,
   * holding its play fixed: floor(M − chestEv / winRate), in bps. Computed, not applied.
   */
  requiredMultiplierBps: number;
  /** Paired check at the required multiplier: return with money chests minus today's return. */
  check: { games: number; rtpToday: number; rtpWithChests: number; diff: Interval } | null;
}

/** The thoughtful person against the same person counting points, on the same mazes and noise. */
export interface PointsMindedEffect {
  /** What one point is worth to it, in point units. */
  pointValue: number;
  /** The thoughtful person's chest reward per step taken, bps of the bet. */
  perStepBps: number;
  /** How much less cashing out now is worth to it at every decision, bps of the bet. */
  bonusBps: number;
  ignoring: PointsMindedSide;
  counting: PointsMindedSide;
}

export interface PointsMindedSide {
  meanSteps: number;
  meanCashSteps: number | null;
  cashRate: number;
  winRate: number;
  lossRate: number;
  rtp: number;
  pointsPerGame: number;
}

export interface TierChest {
  tier: number;
  n: number;
  multiplierBps: number;
  rows: ChestRow[];
  moneyCost: MoneyCost[];
  pointsMinded: PointsMindedEffect | null;
}

export interface PopulationChest {
  /** ASSUMPTIONS: the assumed population (assumptions.ts), with value-lsm as `best`, and the tier shares. */
  houseTake: number;
  houseTakeIfMoney: number;
  pointsPerEth: number;
  /** The same for the assumed mix of people (sim:human's HUMAN_MIX). */
  humanHouseTake: number | null;
  humanHouseTakeIfMoney: number | null;
}

export interface TableChest {
  label: string;
  path: string;
  tableHash: string;
  tiers: TierChest[];
  population: PopulationChest | null;
}

export interface ChestStats {
  schema: 2;
  kind: 'sim-chest';
  rule: {
    version: number;
    tag: string;
    rateBps: number;
    rewardMinBps: number;
    rewardMaxBps: number;
    pointUnitWei: string;
    /** Rule 2: path chests. `null` under rule 1. */
    path: { tag: string; rateBps: number; rewardMinBps: number; rewardMaxBps: number } | null;
  };
  options: Omit<ChestRequest, 'tables'>;
  stream: { label: string; base: string; disjoint: boolean };
  players: PlayerInfo[];
  tables: TableChest[];
  /** The lowest break-even value per point over every row, and where it is. */
  cheapestPoints: { table: string; n: number; player: PlayerId; weiPerPoint: number } | null;
}

/** The assumed share of play of each kind of person (sim:human run.ts HUMAN_MIX). */
const HUMAN_MIX: Partial<Record<PlayerId, number>> = { novice: 0.3, average: 0.4, thoughtful: 0.2, learning: 0.1 };

const GAMES_BLOCK = 25_000;
const SESSIONS_BLOCK = 25;
const SESSION_STRIDE = 4096;

function interval(sum: number, sumSq: number, n: number, scale: number): Interval {
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean) * (n / Math.max(1, n - 1));
  const half = Z_975 * Math.sqrt(variance / n);
  return { mean: mean / scale, ci95: [(mean - half) / scale, (mean + half) / scale] };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function split(total: number, block: number): [number, number][] {
  const out: [number, number][] = [];
  for (let from = 0; from < total; from += block) out.push([from, Math.min(total, from + block)]);
  return out;
}

/** The player spec of a row on a tier, or `null` when it cannot be built (no value table). */
function playerSpec(
  id: PlayerId,
  econ: TierEconomics,
  calibration: Calibration | undefined,
  valueTable: ValueTable | null,
): PlayerSpec | null {
  const bot = (spec: BotSpec): PlayerSpec => ({ kind: 'bot', spec });
  switch (id) {
    case 'novice':
      return { kind: 'human', spec: { model: 'novice', params: NOVICE_DEFAULTS }, career: 0 };
    case 'average':
      return { kind: 'human', spec: { model: 'average', params: AVERAGE_DEFAULTS }, career: 0 };
    case 'thoughtful':
    case 'thoughtful-points':
      if (calibration === undefined) throw new Error(`no calibration of the thoughtful player for ${econ.w}x${econ.h}`);
      return {
        kind: 'human',
        spec: { model: 'thoughtful', params: { ...THOUGHTFUL_DEFAULTS, cue: calibration.cue, reach: calibration.reach } },
        career: 0,
      };
    case 'learning':
      return { kind: 'human', spec: { model: 'learning', params: LEARNING_DEFAULTS }, career: LEARNING_CAREER };
    case 'naive-greedy':
      return bot({ bot: 'naive-greedy' });
    case 'sloppy-greedy':
      return bot({ bot: 'sloppy-greedy', epsilon: SLOPPY_EPSILON });
    case 'nervous':
      return bot({ bot: 'nervous', epsilon: SLOPPY_EPSILON });
    case 'random-walk':
      return bot({ bot: 'random-walk-sampled' });
    case 'value-lsm':
      return valueTable === null ? null : bot({ bot: 'value-lsm', table: valueTable, hyper: VALUE_LSM_HYPER });
    case 'value-lookahead-all':
      return valueTable === null ? null : bot({ bot: 'value-lookahead-all', table: valueTable });
    case 'dead-end-seeker':
      return { kind: 'seeker' };
  }
}

function summarizeSessions(columns: SessionColumns[]): SessionSummary {
  const games: number[] = [];
  const points: number[] = [];
  let chests = 0;
  let withChest = 0;
  for (const column of columns) {
    for (let i = 0; i < column.games.length; i++) {
      games.push(column.games[i]);
      points.push(column.points[i]);
      chests += column.chests[i];
      if (column.chests[i] > 0) withChest += 1;
    }
  }
  games.sort((a, b) => a - b);
  const sorted = [...points].sort((a, b) => a - b);
  const n = points.length;
  return {
    sessions: n,
    medianGames: quantile(games, 0.5),
    withChest: withChest / n,
    meanChests: chests / n,
    points: {
      mean: points.reduce((sum, value) => sum + value, 0) / n,
      p10: quantile(sorted, 0.1),
      p50: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      max: sorted[n - 1] ?? 0,
    },
  };
}

export function rowOf(player: PlayerId, s: GamesStats, sessions: SessionSummary | null, betWei: bigint): ChestRow {
  const n = s.games;
  const rtp = interval(s.sumPayout, s.sumPayoutSq, n, 10_000);
  const moneyRtp = interval(s.sumPayout + s.sumReward, s.sumTotalSq, n, 10_000);
  const chestEv = interval(s.sumReward, s.sumRewardSq, n, 10_000);
  const pointsPerGame = (s.points + s.pathPoints) / n;
  // Every entered cell but the exit and the dead end a loss ends in is a path cell.
  const pathCells = s.steps - s.wins - s.losses;
  return {
    player,
    games: n,
    winRate: s.wins / n,
    lossRate: s.losses / n,
    cashRate: s.cashouts / n,
    meanSteps: s.steps / n,
    meanCashSteps: s.cashouts === 0 ? null : s.cashSteps / s.cashouts,
    chestRate: interval(s.chests, s.chests, n, 1),
    chestShareOfLosses: s.losses === 0 ? 0 : s.chests / s.losses,
    meanRewardBps: s.chests === 0 ? 0 : s.sumDeadReward / s.chests,
    pathChestsPerGame: s.pathChests / n,
    pathChestShareOfCells: pathCells === 0 ? 0 : s.pathChests / pathCells,
    meanPathRewardBps: s.pathChests === 0 ? 0 : s.sumPathReward / s.pathChests,
    pointsPerGame,
    pathPointsPerGame: s.pathPoints / n,
    deadEndPointsPerGame: s.points / n,
    pointsPerEth: (s.sumReward / 10_000 / n) * 1e6,
    rtp,
    moneyRtp,
    chestEv,
    breakEvenWeiPerPoint: pointsPerGame > 0 ? ((1 - rtp.mean) * Number(betWei)) / pointsPerGame : null,
    sessions,
  };
}

function assertRequest(request: ChestRequest): void {
  for (const key of ['games', 'sessions', 'bankrollBets', 'gameCap', 'fitGames', 'reachGames'] as const) {
    if (!Number.isInteger(request[key]) || request[key] < 1) throw new RangeError(`${key} must be a positive integer`);
  }
  if (!Number.isInteger(request.checkGames) || request.checkGames < 0) throw new RangeError('checkGames must be a non-negative integer');
  if (request.gameCap > SESSION_STRIDE) throw new RangeError(`gameCap must not exceed ${SESSION_STRIDE}`);
  if (request.games > 2 ** 30 || request.sessions * SESSION_STRIDE > 2 ** 30 || request.checkGames > 2 ** 30) {
    throw new RangeError('too many games for one seed');
  }
  if (!/^\d+$/.test(request.betWei) || BigInt(request.betWei) <= 0n) throw new RangeError('betWei must be a positive decimal');
  for (const id of request.players) if (!PLAYER_IDS.includes(id)) throw new RangeError(`unknown player ${id}`);
  if (request.players.includes('thoughtful-points') && !request.players.includes('thoughtful')) {
    throw new RangeError('thoughtful-points is measured against thoughtful: request both');
  }
  if (!isKnownChestRule(request.rule)) throw new RangeError(`unknown chest rule ${request.rule}`);
}

function sideOf(row: ChestRow): PointsMindedSide {
  return {
    meanSteps: row.meanSteps,
    meanCashSteps: row.meanCashSteps,
    cashRate: row.cashRate,
    winRate: row.winRate,
    lossRate: row.lossRate,
    rtp: row.rtp.mean,
    pointsPerGame: row.pointsPerGame,
  };
}

/** House take under the assumed population (assumptions.ts) with and without money chests. */
function population(tiers: TierChest[]): PopulationChest | null {
  const shares = ASSUMPTIONS.tierShare.slice(0, tiers.length);
  const norm = shares.reduce((sum, share) => sum + share, 0);
  const members: [PlayerId, number][] = [
    ['naive-greedy', ASSUMPTIONS.population['naive-greedy']],
    ['sloppy-greedy', ASSUMPTIONS.population['sloppy-greedy']],
    ['nervous', ASSUMPTIONS.population.nervous],
    ['random-walk', ASSUMPTIONS.population['random-walk']],
    ['value-lsm', ASSUMPTIONS.population.best],
  ];
  const take = (mix: [PlayerId, number][], money: boolean): number | null => {
    const mixTotal = mix.reduce((sum, [, share]) => sum + share, 0);
    let total = 0;
    for (let i = 0; i < tiers.length; i++) {
      for (const [player, share] of mix) {
        const row = tiers[i].rows.find((candidate) => candidate.player === player);
        if (row === undefined) return null;
        total += (shares[i] / norm) * (share / mixTotal) * (1 - (money ? row.moneyRtp.mean : row.rtp.mean));
      }
    }
    return total;
  };
  const houseTake = take(members, false);
  const houseTakeIfMoney = take(members, true);
  if (houseTake === null || houseTakeIfMoney === null) return null;
  let pointsPerEth = 0;
  for (let i = 0; i < tiers.length; i++) {
    for (const [player, share] of members) {
      pointsPerEth += (shares[i] / norm) * share * tiers[i].rows.find((row) => row.player === player)!.pointsPerEth;
    }
  }
  const people = Object.entries(HUMAN_MIX) as [PlayerId, number][];
  return {
    houseTake,
    houseTakeIfMoney,
    pointsPerEth,
    humanHouseTake: take(people, false),
    humanHouseTakeIfMoney: take(people, true),
  };
}

/** Runs the request. `log` hears about progress; it is not part of the result. */
export async function collectChestStats(
  request: ChestRequest,
  executor: ChestExecutor,
  log: (line: string) => void = () => {},
): Promise<ChestStats> {
  assertRequest(request);
  const betWei = BigInt(request.betWei);
  const evalFirst = chestFirstIndex('eval', request.seed);
  const sessionsFirst = chestFirstIndex('sessions', request.seed);
  const checkFirst = chestFirstIndex('check', request.seed);

  // Phase 1: the thoughtful player's calibration per grid size, on sim:human's training range
  // (the games sim:human calibrates with by default, so the model is the same person).
  const calibrations = new Map<number, Calibration>();
  if (request.players.includes('thoughtful')) {
    const fitFirst = firstIndex('train', 0) + 100_000;
    const reachFirst = fitFirst + request.fitGames;
    const sizes = [...new Set(request.tables.flatMap((input) => input.table.tiers.map((tier) => tier.n)))];
    await Promise.all(
      sizes.map(async (n) => {
        const result = await executor.run({
          kind: 'calibrate',
          n,
          fitFirst,
          fitGames: request.fitGames,
          reachFirst,
          reachGames: request.reachGames,
        });
        calibrations.set(n, result as Calibration);
        log(`calibrated the thoughtful player for ${n}x${n}`);
      }),
    );
  }

  // Phase 2: evaluation games and sessions of every row. The points-counting person comes after
  // the thoughtful one, whose chest reward per step sets what it counts walking on as worth.
  const gamesOf = new Map<string, GamesStats>();
  const sessionsOf = new Map<string, SessionColumns[]>();
  const bonusOf = new Map<string, { perStepBps: number; bonusBps: number }>();
  const keyOf = (t: number, i: number, player: PlayerId): string => `${t}/${i}/${player}`;
  const playRows = async (players: readonly PlayerId[]): Promise<void> => {
    const work: Promise<void>[] = [];
    request.tables.forEach((input, t) => {
      input.table.tiers.forEach((tier, i) => {
        const econ = tierEconomicsOf(tier);
        for (const player of players) {
          const built = playerSpec(player, econ, calibrations.get(tier.n), input.valueTables?.[i] ?? null);
          if (built === null) continue;
          const key = keyOf(t, i, player);
          const bonus = bonusOf.get(key);
          const spec: PlayerSpec =
            bonus !== undefined && built.kind === 'human' ? { ...built, pointsBonusBps: bonus.bonusBps } : built;
          // The points-counting person is the thoughtful person: same people, same noise.
          const noise = player === 'thoughtful-points' ? 'thoughtful' : player;
          gamesOf.set(key, emptyGames());
          sessionsOf.set(key, []);
          for (const [from, to] of split(request.games, GAMES_BLOCK)) {
            work.push(
              executor
                .run({
                  kind: 'games',
                  econ,
                  player: spec,
                  noiseKey: `games/${noise}/${tier.n}`,
                  first: evalFirst + from,
                  games: to - from,
                  betWei: request.betWei,
                  rule: request.rule,
                })
                .then((result) => mergeGames(gamesOf.get(key)!, result as GamesStats)),
            );
          }
          for (const [from, to] of split(request.sessions, SESSIONS_BLOCK)) {
            work.push(
              executor
                .run({
                  kind: 'sessions',
                  econ,
                  player: spec,
                  noiseKey: `sessions/${noise}/${tier.n}`,
                  first: sessionsFirst,
                  stride: SESSION_STRIDE,
                  firstSession: from,
                  sessions: to - from,
                  bankrollBets: request.bankrollBets,
                  gameCap: request.gameCap,
                  betWei: request.betWei,
                  rule: request.rule,
                })
                .then((result) => {
                  sessionsOf.get(key)!.push(result as SessionColumns);
                }),
            );
          }
        }
      });
    });
    await Promise.all(work);
  };
  await playRows(request.players.filter((player) => player !== 'thoughtful-points'));
  if (request.players.includes('thoughtful-points')) {
    request.tables.forEach((input, t) => {
      input.table.tiers.forEach((_tier, i) => {
        const base = gamesOf.get(keyOf(t, i, 'thoughtful'))!;
        const perStepBps = base.steps === 0 ? 0 : base.sumReward / base.steps;
        bonusOf.set(keyOf(t, i, 'thoughtful-points'), {
          perStepBps,
          bonusBps: POINT_VALUE_UNITS * perStepBps * THOUGHTFUL_DEFAULTS.bailLag,
        });
      });
    });
    await playRows(['thoughtful-points']);
  }
  log(`played ${[...gamesOf.values()].reduce((sum, stats) => sum + stats.games, 0)} evaluation games and the sessions`);

  // Phase 3: the money version's multiplier for the strongest strategies, and its paired check.
  const tables: TableChest[] = [];
  const checks: Promise<void>[] = [];
  request.tables.forEach((input, t) => {
    const tiers: TierChest[] = input.table.tiers.map((tier, i) => {
      const rows: ChestRow[] = [];
      for (const player of request.players) {
        const games = gamesOf.get(keyOf(t, i, player));
        if (games === undefined) continue;
        const columns = sessionsOf.get(keyOf(t, i, player))!;
        rows.push(rowOf(player, games, columns.length === 0 ? null : summarizeSessions(columns), betWei));
      }
      const moneyCost: MoneyCost[] = [];
      for (const row of rows) {
        if (row.player !== 'value-lsm' && row.player !== 'value-lookahead-all') continue;
        moneyCost.push({
          player: row.player,
          rtp: row.rtp.mean,
          chestEv: row.chestEv.mean,
          winRate: row.winRate,
          multiplierBps: tier.multiplierBps,
          requiredMultiplierBps: Math.floor(tier.multiplierBps - (row.chestEv.mean * 10_000) / row.winRate),
          check: null,
        });
      }
      const ignoring = rows.find((row) => row.player === 'thoughtful');
      const counting = rows.find((row) => row.player === 'thoughtful-points');
      const bonus = bonusOf.get(keyOf(t, i, 'thoughtful-points'));
      const pointsMinded: PointsMindedEffect | null =
        ignoring === undefined || counting === undefined || bonus === undefined
          ? null
          : { pointValue: POINT_VALUE_UNITS, ...bonus, ignoring: sideOf(ignoring), counting: sideOf(counting) };
      return { tier: i, n: tier.n, multiplierBps: tier.multiplierBps, rows, moneyCost, pointsMinded };
    });
    tiers.forEach((tierChest, i) => {
      const cost = tierChest.moneyCost.find((entry) => entry.player === 'value-lsm');
      const valueTable = input.valueTables?.[i] ?? null;
      if (cost === undefined || valueTable === null || request.checkGames === 0) return;
      const econ = tierEconomicsOf(input.table.tiers[i]);
      const spec = playerSpec('value-lsm', econ, undefined, valueTable)!;
      const paired = emptyPaired();
      const runs = split(request.checkGames, GAMES_BLOCK).map(([from, to]) =>
        executor
          .run({
            kind: 'paired',
            econ,
            multiplierBps: cost.requiredMultiplierBps,
            player: spec,
            first: checkFirst + from,
            games: to - from,
            rule: request.rule,
          })
          .then((result) => mergePaired(paired, result as PairedStats)),
      );
      checks.push(
        Promise.all(runs).then(() => {
          cost.check = {
            games: paired.games,
            rtpToday: paired.sumA / paired.games / 10_000,
            rtpWithChests: paired.sumB / paired.games / 10_000,
            diff: interval(paired.sumD, paired.sumDSq, paired.games, 10_000),
          };
        }),
      );
    });
    tables.push({ label: input.label, path: input.path, tableHash: tableHash(input.table), tiers, population: population(tiers) });
  });
  await Promise.all(checks);
  if (checks.length > 0) log('checked the money version against the strongest certified strategy');

  let cheapest: ChestStats['cheapestPoints'] = null;
  for (const table of tables) {
    for (const tier of table.tiers) {
      for (const row of tier.rows) {
        if (row.breakEvenWeiPerPoint === null) continue;
        if (cheapest === null || row.breakEvenWeiPerPoint < cheapest.weiPerPoint) {
          cheapest = { table: table.label, n: tier.n, player: row.player, weiPerPoint: row.breakEvenWeiPerPoint };
        }
      }
    }
  }

  const { tables: _inputs, ...options } = request;
  return {
    schema: 2,
    kind: 'sim-chest',
    rule: {
      version: request.rule,
      tag: CHEST_TAG,
      rateBps: CHEST_RATE_BPS,
      rewardMinBps: CHEST_REWARD_MIN_BPS,
      rewardMaxBps: CHEST_REWARD_MAX_BPS,
      pointUnitWei: POINT_UNIT_WEI.toString(),
      path:
        request.rule >= 2
          ? {
              tag: PATH_CHEST_TAG,
              rateBps: PATH_CHEST_RATE_BPS,
              rewardMinBps: PATH_CHEST_REWARD_MIN_BPS,
              rewardMaxBps: PATH_CHEST_REWARD_MAX_BPS,
            }
          : null,
    },
    options,
    stream: { label: CHEST_STREAM_LABEL, base: chestStreamBaseHex(), disjoint: chestStreamDisjoint() },
    players: request.players.map((id) => PLAYER_INFO[id]),
    tables,
    cheapestPoints: cheapest,
  };
}
