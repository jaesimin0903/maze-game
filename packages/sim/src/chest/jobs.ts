// Jobs of `sim:chest`. A job is a pure function of its description: the same job returns the same
// result on any thread, so the split into jobs and the number of workers never change a result.
//
// Every game is played by the engine exactly as the certification plays it (`play`); a chest is
// asked about only when the game ended in a dead end (outcome loss), for that one cell. Points
// are what the server would award for the job's bet (`chestPoints`, rounded down).

import { chestPoints } from '@maze/shared';
import { createBot, type BotSpec } from '../bots/index';
import type { Bot } from '../bots/types';
import { Game, OUTCOME_CASH, OUTCOME_EXIT, OUTCOME_LOSS, play, type TierEconomics } from '../engine';
import { calibrateReach, fitCueWeights } from '../human/calibrate';
import { createPolicy, type ModelSpec } from '../human/catalog';
import { NoiseSource } from '../human/feed';
import { THOUGHTFUL_DEFAULTS, type CueWeights, type HumanPolicy } from '../human/models';
import { ChestFeed, chestOfGame, DeadEndSeeker } from './model';

/** `workerData` of the threads of this command's pool (pool.ts). */
export const CHEST_WORKER_TAG = 'maze-sim-chest-worker';

/** A player: a certified bot, a model of a person (`career` games per person, 0 = a new person every game), or the points maximiser. */
export type PlayerSpec =
  | { kind: 'bot'; spec: BotSpec }
  | { kind: 'human'; spec: ModelSpec; career: number }
  | { kind: 'seeker' };

/** Sums over games. Payouts and rewards are in basis points of the bet, so the sums are exact. */
export interface GamesStats {
  games: number;
  wins: number;
  losses: number;
  cashouts: number;
  steps: number;
  sumPayout: number;
  sumPayoutSq: number;
  /** Games that ended in a dead end holding a chest. */
  chests: number;
  sumReward: number;
  sumRewardSq: number;
  /** Σ (payout + chest reward)²: the money version's second moment (a chest only comes with a payout of 0). */
  sumTotalSq: number;
  /** Points awarded at the job's bet. */
  points: number;
}

export interface GamesJob {
  kind: 'games';
  econ: TierEconomics;
  player: PlayerSpec;
  noiseKey: string;
  /** Mazes `first .. first + games - 1` of the stream. */
  first: number;
  games: number;
  /** Decimal wei: the bet the points are computed for. */
  betWei: string;
}

export interface SessionsJob {
  kind: 'sessions';
  econ: TierEconomics;
  player: PlayerSpec;
  noiseKey: string;
  /** Session `s` plays mazes `first + s × stride + j`, j = 0, 1, ... */
  first: number;
  stride: number;
  firstSession: number;
  sessions: number;
  /** Starting bankroll in bets; a session stops when it cannot cover a bet or after `gameCap` games. */
  bankrollBets: number;
  gameCap: number;
  betWei: string;
}

export interface SessionColumns {
  games: Uint16Array;
  chests: Uint16Array;
  points: Float64Array;
}

/**
 * The same mazes played twice by a deterministic player: at the table's multiplier with money
 * payouts only (A), and at `multiplierBps` with chest rewards paid in money (B).
 */
export interface PairedJob {
  kind: 'paired';
  econ: TierEconomics;
  multiplierBps: number;
  player: PlayerSpec;
  first: number;
  games: number;
}

export interface PairedStats {
  games: number;
  sumA: number;
  sumB: number;
  sumD: number;
  sumDSq: number;
  winsB: number;
}

/** The thoughtful player's per-size calibration, as `sim:human` makes it. */
export interface CalibrateJob {
  kind: 'calibrate';
  n: number;
  fitFirst: number;
  fitGames: number;
  reachFirst: number;
  reachGames: number;
}

export interface Calibration {
  cue: CueWeights;
  reach: number[];
}

export type ChestJob = GamesJob | SessionsJob | PairedJob | CalibrateJob;
export type ChestResult = GamesStats | SessionColumns | PairedStats | Calibration;

export function emptyGames(): GamesStats {
  return {
    games: 0,
    wins: 0,
    losses: 0,
    cashouts: 0,
    steps: 0,
    sumPayout: 0,
    sumPayoutSq: 0,
    chests: 0,
    sumReward: 0,
    sumRewardSq: 0,
    sumTotalSq: 0,
    points: 0,
  };
}

export function mergeGames(into: GamesStats, from: GamesStats): void {
  for (const key of Object.keys(into) as (keyof GamesStats)[]) into[key] += from[key];
}

export function emptyPaired(): PairedStats {
  return { games: 0, sumA: 0, sumB: 0, sumD: 0, sumDSq: 0, winsB: 0 };
}

export function mergePaired(into: PairedStats, from: PairedStats): void {
  for (const key of Object.keys(into) as (keyof PairedStats)[]) into[key] += from[key];
}

/** A player bound to one `Game`, with the per-game noise of the people models. */
class Seat {
  readonly bot: Bot;
  readonly careerLength: number;
  private readonly human: HumanPolicy | null;
  private readonly noise: NoiseSource;

  constructor(spec: PlayerSpec, g: Game, noiseKey: string) {
    if (spec.kind === 'human') {
      const policy = createPolicy(spec.spec, g);
      this.bot = policy;
      this.human = policy;
      this.careerLength = spec.career;
    } else {
      this.bot = spec.kind === 'seeker' ? new DeadEndSeeker() : createBot(spec.spec, g);
      this.human = null;
      this.careerLength = 0;
    }
    this.noise = new NoiseSource(`chest/${noiseKey}`);
  }

  /** Plays the maze in `feed` (game `index`); `newPerson` starts a new person first (people models only). */
  play(g: Game, feed: ChestFeed, index: number, newPerson: boolean): void {
    if (this.human !== null) {
      const rng = this.noise.at(index);
      if (newPerson) this.human.newPlayer(rng);
      this.human.startGame(rng);
    }
    play(g, this.bot, feed.open, feed.rng);
    this.human?.endGame(g);
  }
}

/** The chest a game ended with: its reward in bps, or 0 when it did not end in a chest. */
function rewardOf(g: Game, index: number): number {
  if (g.outcome !== OUTCOME_LOSS) return 0;
  const draw = chestOfGame(g.w, g.h, index, g.cell);
  return draw.placed ? draw.rewardBps : 0;
}

export function playGames(job: GamesJob): GamesStats {
  const g = new Game(job.econ);
  const seat = new Seat(job.player, g, job.noiseKey);
  const feed = new ChestFeed(job.econ.w, job.econ.h);
  const bet = BigInt(job.betWei);
  const stats = emptyGames();
  for (let i = 0; i < job.games; i++) {
    const index = job.first + i;
    feed.load(index);
    // Per-game rows: a new person every game, or every `career` games for the learning model.
    seat.play(g, feed, index, seat.careerLength === 0 || i % seat.careerLength === 0);
    const payout = g.payoutBps;
    const reward = rewardOf(g, index);
    stats.games += 1;
    stats.steps += g.k;
    if (g.outcome === OUTCOME_EXIT) stats.wins += 1;
    else if (g.outcome === OUTCOME_CASH) stats.cashouts += 1;
    else stats.losses += 1;
    stats.sumPayout += payout;
    stats.sumPayoutSq += payout * payout;
    if (reward > 0) {
      stats.chests += 1;
      stats.sumReward += reward;
      stats.sumRewardSq += reward * reward;
      stats.points += Number(chestPoints(bet, reward));
    }
    stats.sumTotalSq += (payout + reward) * (payout + reward);
  }
  return stats;
}

export function playSessions(job: SessionsJob): SessionColumns {
  if (job.gameCap > job.stride) throw new RangeError('sessions: gameCap must not exceed the stride');
  const g = new Game(job.econ);
  const seat = new Seat(job.player, g, job.noiseKey);
  const feed = new ChestFeed(job.econ.w, job.econ.h);
  const bet = BigInt(job.betWei);
  const out: SessionColumns = {
    games: new Uint16Array(job.sessions),
    chests: new Uint16Array(job.sessions),
    points: new Float64Array(job.sessions),
  };
  for (let s = 0; s < job.sessions; s++) {
    const start = job.first + (job.firstSession + s) * job.stride;
    // Bankroll in bps of one bet. Points have no cash value, so they never extend a session.
    let bankroll = job.bankrollBets * 10_000;
    let games = 0;
    let chests = 0;
    let points = 0;
    while (games < job.gameCap && bankroll >= 10_000) {
      const index = start + games;
      feed.load(index);
      // One person plays the whole session (a learning person keeps what it learnt).
      seat.play(g, feed, index, games === 0);
      bankroll += g.payoutBps - 10_000;
      const reward = rewardOf(g, index);
      if (reward > 0) {
        chests += 1;
        points += Number(chestPoints(bet, reward));
      }
      games += 1;
    }
    out.games[s] = games;
    out.chests[s] = chests;
    out.points[s] = points;
  }
  return out;
}

export function playPaired(job: PairedJob): PairedStats {
  if (job.player.kind === 'human') throw new RangeError('paired: only deterministic players are paired');
  const gA = new Game(job.econ);
  const gB = new Game({ ...job.econ, multiplierBps: job.multiplierBps });
  const seatA = new Seat(job.player, gA, 'paired-a');
  const seatB = new Seat(job.player, gB, 'paired-b');
  const feed = new ChestFeed(job.econ.w, job.econ.h);
  const stats = emptyPaired();
  for (let i = 0; i < job.games; i++) {
    const index = job.first + i;
    feed.load(index);
    seatA.play(gA, feed, index, false);
    const a = gA.payoutBps;
    seatB.play(gB, feed, index, false);
    const b = gB.payoutBps + rewardOf(gB, index);
    if (gB.outcome === OUTCOME_EXIT) stats.winsB += 1;
    stats.games += 1;
    stats.sumA += a;
    stats.sumB += b;
    stats.sumD += b - a;
    stats.sumDSq += (b - a) * (b - a);
  }
  return stats;
}

export function calibrate(job: CalibrateJob): Calibration {
  const fit = fitCueWeights(job.n, job.n, job.fitFirst, job.fitGames);
  const reach = calibrateReach(job.n, job.n, fit.weights, THOUGHTFUL_DEFAULTS.perception, job.reachFirst, job.reachGames);
  return { cue: fit.weights, reach: reach.reach };
}

export function runChestJob(job: ChestJob): ChestResult {
  switch (job.kind) {
    case 'games':
      return playGames(job);
    case 'sessions':
      return playSessions(job);
    case 'paired':
      return playPaired(job);
    case 'calibrate':
      return calibrate(job);
  }
}

/** Buffers of a result that can move to the main thread without a copy. */
export function transferables(result: ChestResult): ArrayBuffer[] {
  if ('chests' in result && result.chests instanceof Uint16Array) {
    const columns = result as SessionColumns;
    return [columns.games.buffer as ArrayBuffer, columns.chests.buffer as ArrayBuffer, columns.points.buffer as ArrayBuffer];
  }
  return [];
}
