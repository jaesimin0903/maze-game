// Jobs of `sim:human`. A job is a pure function of its description: the same job returns the
// same result on any thread, so the split into jobs and the number of workers never change a
// result.

import { Game, play, type TierEconomics } from '../engine';
import { calibrateReach, fitCueWeights, type CueFit, type ReachFit } from './calibrate';
import { createPolicy, type ModelSpec } from './catalog';
import { HumanFeed, NoiseSource } from './feed';
import { RulePlayer, scoreMovePart, type ForkLog, type MovePart, type MoveRecords, type PartScores } from './rules';
import { runSessions, type SessionColumns, type SessionJob } from './sessions';

/** A game's code is `moves × 4 + outcome`, as `sim:stats` codes it, so its summaries apply. */
export const CODE_OUTCOMES = 4;

/** `workerData` of the threads of this command's pool (pool.ts). */
export const HUMAN_WORKER_TAG = 'maze-sim-human-worker';

export type PlayJob = {
  kind: 'play';
  econ: TierEconomics;
  spec: ModelSpec;
  noiseKey: string;
  /** Games `first .. first + games - 1` of the evaluation range. */
  first: number;
  games: number;
  /** Games per person: 0 draws a new person for every game; otherwise a person plays this many games in a row (a career; `first` starts one). */
  career: number;
};

export type SearchJob = { kind: 'search'; econ: TierEconomics; part: MovePart; first: number; games: number };

export type CalibrateJob = { kind: 'calibrate'; w: number; h: number; fitFirst: number; fitGames: number; reachFirst: number; reachGames: number; perception: number };

export type HumanJob = CalibrateJob | SearchJob | PlayJob | { kind: 'sessions'; job: SessionJob };

export interface CalibrateResult {
  fit: CueFit;
  reach: ReachFit;
  /** The same calibration for a player whose estimate has no noise. */
  reachIdeal: ReachFit;
}

export type HumanResult = CalibrateResult | PartScores | Uint16Array | SessionColumns;

export function playGames(job: PlayJob): Uint16Array {
  const g = new Game(job.econ);
  const policy = createPolicy(job.spec, g);
  const feed = new HumanFeed(job.econ.w, job.econ.h);
  const noise = new NoiseSource(job.noiseKey);
  const codes = new Uint16Array(job.games);
  for (let i = 0; i < job.games; i++) {
    const index = job.first + i;
    feed.load(index);
    const rng = noise.at(index);
    if (job.career === 0 || i % job.career === 0) policy.newPlayer(rng);
    policy.startGame(rng);
    play(g, policy, feed.open, feed.rng);
    policy.endGame(g);
    codes[i] = g.k * CODE_OUTCOMES + g.outcome;
  }
  return codes;
}

/** Plays one move part with no stop rule on training games and scores its stop parts. */
export function searchMovePart(job: SearchJob): PartScores {
  const g = new Game(job.econ);
  const rule = new RulePlayer(g, { ...job.part, stops: [] });
  const log: ForkLog = { k: [], d: [], kinds: [] };
  rule.log = log;
  const feed = new HumanFeed(job.econ.w, job.econ.h);
  const natural = new Int32Array(job.games);
  const start = new Int32Array(job.games + 1);
  for (let i = 0; i < job.games; i++) {
    feed.load(job.first + i);
    play(g, rule, feed.open, feed.rng);
    natural[i] = g.payoutBps;
    start[i + 1] = log.k.length;
  }
  const records: MoveRecords = {
    games: job.games,
    natural,
    start,
    k: Uint8Array.from(log.k),
    d: Uint8Array.from(log.d),
    kinds: Uint8Array.from(log.kinds),
  };
  return scoreMovePart(records, job.econ.refundBps, g.shortest);
}

export function runHumanJob(job: HumanJob): HumanResult {
  switch (job.kind) {
    case 'calibrate': {
      const fit = fitCueWeights(job.w, job.h, job.fitFirst, job.fitGames);
      const reach = calibrateReach(job.w, job.h, fit.weights, job.perception, job.reachFirst, job.reachGames);
      const reachIdeal = calibrateReach(job.w, job.h, fit.weights, 0, job.reachFirst, job.reachGames);
      return { fit, reach, reachIdeal };
    }
    case 'search':
      return searchMovePart(job);
    case 'play':
      return playGames(job);
    case 'sessions':
      return runSessions(job.job);
  }
}

/** Buffers of a result that can move to the main thread without a copy. */
export function transferables(result: HumanResult): ArrayBuffer[] {
  if (result instanceof Uint16Array) return [result.buffer as ArrayBuffer];
  if ('tierGames' in result) {
    return [result.games, result.staked, result.returned, result.final, result.peak, result.everAhead, result.end, result.tierGames, result.ruinedAt].map(
      (array) => array.buffer as ArrayBuffer,
    );
  }
  return [];
}
