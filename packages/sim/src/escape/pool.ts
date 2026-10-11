// Where the jobs of `sim:escape` run: the calling thread, or a few worker threads. The worker
// threads run `worker.ts` (TypeScript, through the tsx loader the command runs under) and are
// tagged with their own `workerData`, so other worker modules stay inactive in them.

import { Worker } from 'node:worker_threads';
import { ESCAPE_WORKER_TAG, runEscapeJob, type EscapeJob, type EscapeResult } from './jobs';

export interface EscapeExecutor {
  readonly size: number;
  run(job: EscapeJob): Promise<EscapeResult>;
  close(): Promise<void>;
}

export class InlineEscapeExecutor implements EscapeExecutor {
  /** Only sets how many jobs a cell keeps in flight; the jobs run one at a time on this thread. */
  constructor(readonly size = 1) {}

  run(job: EscapeJob): Promise<EscapeResult> {
    try {
      return Promise.resolve(runEscapeJob(job));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

interface Pending {
  job: EscapeJob;
  resolve: (result: EscapeResult) => void;
  reject: (error: Error) => void;
}

/** A fixed set of worker threads fed from one queue, in submission order. */
export class EscapeWorkerPool implements EscapeExecutor {
  readonly size: number;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Pending[] = [];
  private readonly running = new Map<Worker, Pending>();
  private failure: Error | null = null;
  private closed = false;

  constructor(size: number) {
    this.size = size;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: ESCAPE_WORKER_TAG });
      worker.on('message', (message: { result?: EscapeResult; error?: string }) => {
        const pending = this.running.get(worker);
        this.running.delete(worker);
        this.idle.push(worker);
        if (pending !== undefined) {
          if (message.error !== undefined) pending.reject(new Error(`sim:escape worker job failed: ${message.error}`));
          else pending.resolve(message.result as EscapeResult);
        }
        this.dispatch();
      });
      worker.on('error', (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
      worker.on('exit', (code) => {
        if (!this.closed) this.fail(new Error(`a sim:escape worker exited unexpectedly with code ${code}`));
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
      worker.postMessage(pending.job);
    }
  }

  run(job: EscapeJob): Promise<EscapeResult> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('the sim:escape worker pool is closed'));
    return new Promise<EscapeResult>((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}
