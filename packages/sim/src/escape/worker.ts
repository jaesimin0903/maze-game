// Worker-thread entry point of `sim:escape` (see pool.ts).

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { ESCAPE_WORKER_TAG, runEscapeJob, transferables, type EscapeJob } from './jobs';

if (!isMainThread && parentPort !== null && workerData === ESCAPE_WORKER_TAG) {
  const port = parentPort;
  port.on('message', (job: EscapeJob) => {
    try {
      const result = runEscapeJob(job);
      port.postMessage({ result }, transferables(result));
    } catch (error) {
      port.postMessage({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    }
  });
}
