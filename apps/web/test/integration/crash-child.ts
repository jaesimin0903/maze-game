// A separate server process that kills itself at a chosen point of one request.
// Spawned by crash.test.ts with `tsx`; not a test file itself.
//
// The process boots a real server over the given data directory, sends itself one request
// through the route handler (a move, a cash-out or a ticket request) and, depending on `crash`,
// dies around the write of the first event of type `killOn` (`move`, `ended` or `ticket-issued`):
//
//   after-persist   SIGKILLs itself once the event is durable, before the handler can answer
//   before-persist  SIGKILLs itself when the event is about to be written
//   never           answers normally (control run)
//
// It reports on stdout with synchronous writes: READY, BEFORE-PERSIST, PERSISTED,
// RESPONDED <status> <body>.

import { writeSync } from 'node:fs';
import { parseTuning } from '@maze/shared';
import fixtureJson from '@maze/shared/fixtures/tuning.fixture.json';
import { POST as ticketPost } from '../../app/api/games/route';
import { POST as cashoutPost } from '../../app/api/games/[id]/cashout/route';
import { POST as movePost } from '../../app/api/games/[id]/move/route';
import { createViemChain } from '../../src/server/chain';
import type { ServerConfig } from '../../src/server/config';
import { createContainer, installContainer } from '../../src/server/container';
import { openFileStore, type EventStore, type StoreEvent } from '../../src/server/store';

export type CrashChildRequest =
  | { kind: 'move' | 'cashout'; gameId: string; token: string; body: unknown }
  | { kind: 'ticket'; body: unknown };

export interface CrashChildArgs {
  config: ServerConfig;
  request: CrashChildRequest;
  /** The process dies around the write of the first event of this type. */
  killOn: 'move' | 'ended' | 'ticket-issued';
  crash: 'after-persist' | 'before-persist' | 'never';
}

function report(line: string): void {
  writeSync(1, `${line}\n`);
}

/** Dies the way a crashed or killed process does: no handlers, no flushing, no answer. */
function die(marker: string): never {
  report(marker);
  process.kill(process.pid, 'SIGKILL');
  // The signal is delivered asynchronously; nothing else may run in the meantime.
  for (;;) {
    // wait to be killed
  }
}

async function main(): Promise<void> {
  const args = JSON.parse(process.env.CRASH_CHILD_ARGS ?? 'null') as CrashChildArgs | null;
  if (args === null) throw new Error('CRASH_CHILD_ARGS is not set');

  const inner = await openFileStore(args.config.dataDir);
  const store: EventStore = {
    load: () => inner.load(),
    close: () => inner.close(),
    async append(events) {
      const list: readonly StoreEvent[] = Array.isArray(events) ? events : [events as StoreEvent];
      const hit = list.some((event) => event.type === args.killOn);
      if (hit && args.crash === 'before-persist') die('BEFORE-PERSIST');
      await inner.append(events);
      if (hit && args.crash === 'after-persist') die('PERSISTED');
    },
  };

  const container = await createContainer({
    config: args.config,
    table: parseTuning(fixtureJson),
    chain: createViemChain(args.config),
    store,
    logSink: () => undefined,
    background: false,
  });
  installContainer(container);
  report('READY');

  const { request } = args;
  const response =
    request.kind === 'ticket'
      ? await ticketPost(
          new Request('http://localhost/api/games', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request.body),
          }),
          { params: Promise.resolve({}) },
        )
      : await (request.kind === 'move' ? movePost : cashoutPost)(
          new Request(`http://localhost/api/games/${request.gameId}/${request.kind}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${request.token}`, 'content-type': 'application/json' },
            body: JSON.stringify(request.body),
          }),
          { params: Promise.resolve({ id: request.gameId }) },
        );
  report(`RESPONDED ${response.status} ${await response.text()}`);
  await container.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    report(`FAILED ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  },
);
