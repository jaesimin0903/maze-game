// Worker-thread entry point of `sim:chest` (see pool.ts).

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { CHEST_WORKER_TAG, runChestJob, transferables, type ChestJob } from './jobs';

if (!isMainThread && parentPort !== null && workerData === CHEST_WORKER_TAG) {
  const port = parentPort;
  port.on('message', (job: ChestJob) => {
    try {
      const result = runChestJob(job);
      port.postMessage({ result }, transferables(result));
    } catch (error) {
      port.postMessage({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    }
  });
}
