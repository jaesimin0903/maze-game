// Worker-thread entry point of `sim:stats`: records games for the pool in `pool.ts`.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { recordGames, type RecordJob } from './playstats-record';

/**
 * The value of `WORKER_TAG` in `worker.ts`, which the pool passes as `workerData`. It is
 * repeated here because importing that module would install its message handler on this thread.
 */
const POOL_TAG = 'maze-sim-worker';

if (!isMainThread && parentPort !== null && workerData === POOL_TAG) {
  const port = parentPort;
  port.on('message', (message: { id: number; job: RecordJob }) => {
    try {
      const result = recordGames(message.job);
      port.postMessage({ id: message.id, result }, [result.buffer as ArrayBuffer]);
    } catch (error) {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      port.postMessage({ id: message.id, error: text });
    }
  });
}
