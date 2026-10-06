// Jobs of the attack lane and its worker-thread entry point.
//
// The attack pool runs the simulator's own jobs (table training, through `runJob`) and the
// attack jobs below on the same threads. Its threads carry their own tag, so importing the
// simulator's worker module here does not install that module's message handler.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Game, type TierEconomics } from '../engine';
import { runJob, type Job } from '../worker';
import { runBookJob, type BookJob, type BookResult } from './book';
import { runFitness, type FitnessJob, type FitnessResult } from './cma';
import { solveInfoStates, type InfoStateOptions, type InfoStateResult } from './infostate';
import { runPaired, type PairedJob, type PairedStats } from './paired';
import { createAttackBot, type AttackBotSpec } from './players';

export const ATTACK_WORKER_TAG = 'maze-attack-worker';

/** Exact value by the information-state DP: the optimum (`bot` null) or a deterministic player. */
export interface DpJob {
  kind: 'attack-dp';
  econ: TierEconomics;
  bot: AttackBotSpec | null;
  options: Pick<InfoStateOptions, 'maxStates' | 'mirror' | 'fullKey'>;
}

export type AttackJob = DpJob | PairedJob | BookJob | FitnessJob;

export interface AttackResults {
  'attack-dp': InfoStateResult;
  'attack-pairs': PairedStats;
  'attack-book': BookResult;
  'attack-fitness': FitnessResult;
}

export type AttackResultOf<J extends AttackJob> = AttackResults[J['kind']];

const ATTACK_KINDS = new Set(['attack-dp', 'attack-pairs', 'attack-book', 'attack-fitness']);

export function isAttackJob(job: Job | AttackJob): job is AttackJob {
  return ATTACK_KINDS.has(job.kind);
}

export function runAttackJob<J extends AttackJob>(job: J): AttackResultOf<J>;
export function runAttackJob(job: AttackJob): AttackResults[keyof AttackResults] {
  switch (job.kind) {
    case 'attack-dp': {
      const bot = job.bot === null ? null : createAttackBot(job.bot, new Game(job.econ));
      return solveInfoStates(job.econ, bot, job.options);
    }
    case 'attack-pairs':
      return runPaired(job);
    case 'attack-book':
      return runBookJob(job);
    case 'attack-fitness':
      return runFitness(job);
  }
}

/** Runs either kind of job on the calling thread. */
export function runAnyJob(job: Job | AttackJob): unknown {
  return isAttackJob(job) ? runAttackJob(job) : runJob(job);
}

if (!isMainThread && parentPort !== null && workerData === ATTACK_WORKER_TAG) {
  const port = parentPort;
  port.on('message', (message: { id: number; job: Job | AttackJob }) => {
    try {
      port.postMessage({ id: message.id, result: runAnyJob(message.job) });
    } catch (error) {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      port.postMessage({ id: message.id, error: text });
    }
  });
}
