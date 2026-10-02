// A game server process that keeps running: what `next start` is under the dev-up supervisor.
// Spawned by supervisor.test.ts through `scripts/dev-up.sh --supervise`; not a test file itself.
//
// The process boots a real server over the given data directory, with the background worker
// and the default handling of a failed append (the process ends with exit code 70), and then
// stays alive. Its log lines go to stdout, followed by READY once it serves.
//
// With `failEndedOnceFile`: while that file exists, the first append that carries an `ended`
// event is refused the way a full disk would refuse it, and the file is removed. The process
// that is started next therefore writes normally.

import { existsSync, unlinkSync, writeSync } from 'node:fs';
import { parseTuning } from '@maze/shared';
import fixtureJson from '@maze/shared/fixtures/tuning.fixture.json';
import { createViemChain } from '../../src/server/chain';
import type { ServerConfig } from '../../src/server/config';
import { createContainer } from '../../src/server/container';
import { TICKET_RETENTION_SEC } from '../../src/server/game-service';
import { openFileStore, type EventStore, type StoreEvent } from '../../src/server/store';

export interface ServerChildArgs {
  config: ServerConfig;
  failEndedOnceFile?: string;
}

function report(line: string): void {
  writeSync(1, `${line}\n`);
}

async function main(): Promise<void> {
  const args = JSON.parse(process.env.SERVER_CHILD_ARGS ?? 'null') as ServerChildArgs | null;
  if (args === null) throw new Error('SERVER_CHILD_ARGS is not set');
  const trigger = args.failEndedOnceFile;

  const inner = await openFileStore(args.config.dataDir, { ticketRetentionSec: TICKET_RETENTION_SEC });
  const store: EventStore = {
    load: () => inner.load(),
    close: () => inner.close(),
    append(events) {
      const list: readonly StoreEvent[] = Array.isArray(events) ? events : [events as StoreEvent];
      if (trigger !== undefined && existsSync(trigger) && list.some((event) => event.type === 'ended')) {
        unlinkSync(trigger);
        report('APPEND-FAILED');
        return Promise.reject(new Error('disk full'));
      }
      return inner.append(events);
    },
  };

  await createContainer({
    config: args.config,
    table: parseTuning(fixtureJson),
    chain: createViemChain(args.config),
    store,
    logSink: report,
  });
  report('READY');

  // The worker's poll timer does not keep the process alive; a listening server would.
  setInterval(() => undefined, 1000);
  process.on('SIGTERM', () => process.exit(0));
}

main().catch((error: unknown) => {
  report(`FAILED ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
