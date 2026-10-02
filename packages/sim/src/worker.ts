// Simulation jobs and the worker-thread entry point.
//
// A job is a pure function of its description: the same job always returns the same result,
// on any thread. The pool only decides which thread runs which job.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createBot, type BotSpec, type ValueHyper } from './bots/index';
import { ParamSearch } from './bots/param-search';
import { Region } from './bots/region';
import { HarmonicPolicy, ValuePolicy } from './bots/value-core';
import {
  Game,
  MazeFeed,
  play,
  runGames,
  runPairs,
  SolutionScratch,
  type ChunkStats,
  type MazeSource,
  type PairStats,
  type TierEconomics,
} from './engine';
import {
  newAccumulator,
  newRegionAccumulator,
  recordTrajectories,
  shapeOf,
  trainGames,
  trainRegionGames,
  type RegionAccumulator,
  type TableAccumulator,
  type Trajectories,
  type ValueTable,
} from './lsm';

/**
 * Games per job, by how expensive a game of the bot is. A cell's games are split into jobs of
 * this size in game order, so the split is the same on every machine and with any worker count.
 */
export function jobGames(bot: BotSpec['bot'], lookaheadAll = false): number {
  switch (bot) {
    case 'rollout':
      return 200;
    case 'value-lookahead-all':
      return 4_000;
    case 'value-lsm':
      return lookaheadAll ? 4_000 : 20_000;
    case 'value-table':
    case 'harmonic-lsm':
    case 'harmonic':
    case 'oracle-stop':
      return 50_000;
    case 'region-heuristic':
    case 'param-search':
      return 100_000;
    default:
      return 250_000;
  }
}

/** `[from, to)` cut into consecutive ranges of at most `size` games. */
export function splitRange(from: number, to: number, size: number): [number, number][] {
  const out: [number, number][] = [];
  for (let at = from; at < to; at += size) out.push([at, Math.min(to, at + size)]);
  return out;
}

/** Marks a thread started by the simulator's pool (and not, say, by a test runner). */
export const WORKER_TAG = 'maze-sim-worker';

interface Range {
  econ: TierEconomics;
  source: MazeSource;
  /** Games `from .. to - 1`. */
  from: number;
  to: number;
}

export interface EvalJob extends Range {
  kind: 'eval';
  bot: BotSpec;
}

/** Bot A and bot B on identical mazes; `D = A - B`. */
export interface PairJob extends Range {
  kind: 'pair';
  botA: BotSpec;
  botB: BotSpec;
}

export type TrainPolicy =
  | { kind: 'harmonic' }
  | { kind: 'value'; table: ValueTable; hyper: ValueHyper };

export interface TrainJob extends Range {
  kind: 'train';
  policy: TrainPolicy;
  /** Bins of the region feature (1 = off). */
  rBins: number;
}

export interface RegionJob extends Range {
  kind: 'train-region';
}

export interface TrajectoryJob extends Range {
  kind: 'trajectories';
}

/** Sum of payouts (bps) of param-search(θ) for every θ over the same games. */
export interface FitnessJob extends Range {
  kind: 'fitness';
  thetas: number[][];
}

export interface FitnessResult {
  games: number;
  sums: number[];
}

export type Job = EvalJob | PairJob | TrainJob | RegionJob | TrajectoryJob | FitnessJob;

export interface JobResults {
  eval: ChunkStats;
  pair: PairStats;
  train: TableAccumulator;
  'train-region': RegionAccumulator;
  trajectories: Trajectories;
  fitness: FitnessResult;
}

export type ResultOf<J extends Job> = JobResults[J['kind']];

function runTrain(job: TrainJob): TableAccumulator {
  const g = new Game(job.econ);
  const shape = shapeOf(g.w, g.h, job.rBins);
  const acc = newAccumulator(shape);
  if (job.policy.kind === 'harmonic') {
    // The harmonic pass records wins, which do not depend on the multiplier, and counts S[d].
    trainGames(g, new HarmonicPolicy(g, job.rBins), shape, job.source, job.from, job.to, acc, 1, new SolutionScratch(g.cells));
  } else {
    const policy = new ValuePolicy(g, job.policy.table, job.policy.hyper);
    trainGames(g, policy, shape, job.source, job.from, job.to, acc, g.multiplierBps, null);
  }
  return acc;
}

function runFitness(job: FitnessJob): FitnessResult {
  const g = new Game(job.econ);
  const bots = job.thetas.map((theta) => new ParamSearch(g, theta));
  const sums = new Array<number>(bots.length).fill(0);
  const feed = new MazeFeed(job.source, g.w, g.h);
  for (let index = job.from; index < job.to; index++) {
    feed.load(index);
    for (let b = 0; b < bots.length; b++) {
      play(g, bots[b], feed.open, feed.rng);
      sums[b] += g.payoutBps;
    }
  }
  return { games: job.to - job.from, sums };
}

/** Executes a job. */
export function runJob<J extends Job>(job: J): ResultOf<J>;
export function runJob(job: Job): JobResults[keyof JobResults] {
  switch (job.kind) {
    case 'eval': {
      const g = new Game(job.econ);
      return runGames(g, createBot(job.bot, g), job.source, job.from, job.to);
    }
    case 'pair': {
      const g = new Game(job.econ);
      return runPairs(g, createBot(job.botA, g), createBot(job.botB, g), job.source, job.from, job.to);
    }
    case 'train':
      return runTrain(job);
    case 'train-region': {
      const g = new Game(job.econ);
      const acc = newRegionAccumulator(g.cells, g.shortest);
      trainRegionGames(g, new Region(g.cells), job.source, job.from, job.to, acc);
      return acc;
    }
    case 'trajectories':
      return recordTrajectories(new Game(job.econ), job.source, job.from, job.to);
    case 'fitness':
      return runFitness(job);
  }
}

if (!isMainThread && parentPort !== null && workerData === WORKER_TAG) {
  const port = parentPort;
  port.on('message', (message: { id: number; job: Job }) => {
    try {
      port.postMessage({ id: message.id, result: runJob(message.job) });
    } catch (error) {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      port.postMessage({ id: message.id, error: text });
    }
  });
}
