// Executors of the attack lane. One pool runs both the simulator's jobs (so a `Runner` can train
// value tables with it) and the attack jobs; results do not depend on the executor.

import { Worker } from 'node:worker_threads';
import type { Executor } from '../pool';
import type { Job, ResultOf } from '../worker';
import { ATTACK_WORKER_TAG, runAnyJob, type AttackJob, type AttackResultOf } from './worker';

export interface AttackExecutor extends Executor {
  runAttack<J extends AttackJob>(job: J): Promise<AttackResultOf<J>>;
}

/** Every job on the calling thread (tests, `--workers 0`). */
export class InlineAttackExecutor implements AttackExecutor {
  readonly size = 1;

  private execute<T>(job: Job | AttackJob): Promise<T> {
    try {
      return Promise.resolve(runAnyJob(job) as T);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  run<J extends Job>(job: J): Promise<ResultOf<J>> {
    return this.execute(job);
  }

  runAttack<J extends AttackJob>(job: J): Promise<AttackResultOf<J>> {
    return this.execute(job);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

interface Pending {
  job: Job | AttackJob;
  resolve: (value: never) => void;
  reject: (error: Error) => void;
}

/** A fixed set of attack worker threads fed from one queue. */
export class AttackPool implements AttackExecutor {
  readonly size: number;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Pending[] = [];
  private readonly running = new Map<Worker, Pending>();
  private nextId = 0;
  private failure: Error | null = null;
  private closed = false;

  /** `script` is the built `attack/worker.js`; `execArgv` lets tests load the TypeScript source. */
  constructor(size: number, script: URL, execArgv?: string[]) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('AttackPool: size must be a positive integer');
    this.size = size;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(script, { workerData: ATTACK_WORKER_TAG, ...(execArgv ? { execArgv } : {}) });
      worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
        const pending = this.running.get(worker);
        this.running.delete(worker);
        this.idle.push(worker);
        if (pending !== undefined) {
          if (message.error !== undefined) pending.reject(new Error(`attack worker job failed: ${message.error}`));
          else pending.resolve(message.result as never);
        }
        this.dispatch();
      });
      worker.on('error', (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
      worker.on('exit', (code) => {
        if (!this.closed) this.fail(new Error(`an attack worker exited unexpectedly with code ${code}`));
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

  private submit<T>(job: Job | AttackJob): Promise<T> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('the attack pool is closed'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ job, resolve: resolve as (value: never) => void, reject });
      this.dispatch();
    });
  }

  run<J extends Job>(job: J): Promise<ResultOf<J>> {
    return this.submit(job);
  }

  runAttack<J extends AttackJob>(job: J): Promise<AttackResultOf<J>> {
    return this.submit(job);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}
