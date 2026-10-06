// Worker-thread entry point of `sim:human` (see pool.ts).

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { HUMAN_WORKER_TAG, runHumanJob, transferables, type HumanJob } from './jobs';

if (!isMainThread && parentPort !== null && workerData === HUMAN_WORKER_TAG) {
  const port = parentPort;
  port.on('message', (job: HumanJob) => {
    try {
      const result = runHumanJob(job);
      port.postMessage({ result }, transferables(result));
    } catch (error) {
      port.postMessage({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    }
  });
}
