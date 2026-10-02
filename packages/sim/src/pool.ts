// Executors: where simulation jobs run. The result of a job does not depend on the executor.

import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { runJob, WORKER_TAG, type Job, type ResultOf } from './worker';

export interface Executor {
  /** How many jobs run at the same time. */
  readonly size: number;
  run<J extends Job>(job: J): Promise<ResultOf<J>>;
  close(): Promise<void>;
}

/** Runs every job on the calling thread. Used by tests and by `--workers 0`. */
export class InlineExecutor implements Executor {
  readonly size = 1;

  run<J extends Job>(job: J): Promise<ResultOf<J>> {
    try {
      return Promise.resolve(runJob(job));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Worker cap of plan §8.2: `max(1, min(8, cores - 4))`. `SIM_WORKERS` may lower it (other
 * streams share the machine) but never raise it.
 */
export function simWorkers(env: NodeJS.ProcessEnv = process.env, cores: number = availableParallelism()): number {
  const cap = Math.max(1, Math.min(8, cores - 4));
  const requested = Number(env.SIM_WORKERS);
  if (Number.isInteger(requested) && requested >= 1) return Math.min(cap, requested);
  return cap;
}

interface Pending {
  job: Job;
  resolve: (value: never) => void;
  reject: (error: Error) => void;
}

/** A fixed set of worker threads fed from one queue. */
export class WorkerPool implements Executor {
  readonly size: number;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Pending[] = [];
  private readonly running = new Map<Worker, Pending>();
  private nextId = 0;
  private failure: Error | null = null;
  private closed = false;

  /** `script` is the built worker (`./worker.js` next to the CLI); `execArgv` lets tests load the TypeScript source. */
  constructor(size: number, script: URL, execArgv?: string[]) {
    this.size = size;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(script, { workerData: WORKER_TAG, ...(execArgv ? { execArgv } : {}) });
      worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
        const pending = this.running.get(worker);
        this.running.delete(worker);
        this.idle.push(worker);
        if (pending !== undefined) {
          if (message.error !== undefined) pending.reject(new Error(`worker job failed: ${message.error}`));
          else pending.resolve(message.result as never);
        }
        this.dispatch();
      });
      worker.on('error', (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
      worker.on('exit', (code) => {
        if (!this.closed) this.fail(new Error(`a simulation worker exited unexpectedly with code ${code}`));
      });
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.running.values()) pending.reject(error);
    this.running.clear();
    for (const pending of this.queue.splice(0)) pending.reject(error);
  }

  private dispatch(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const pending = this.queue.shift()!;
      this.running.set(worker, pending);
      worker.postMessage({ id: this.nextId++, job: pending.job });
    }
  }

  run<J extends Job>(job: J): Promise<ResultOf<J>> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('the worker pool is closed'));
    return new Promise<ResultOf<J>>((resolve, reject) => {
      this.queue.push({ job, resolve: resolve as (value: never) => void, reject });
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}
