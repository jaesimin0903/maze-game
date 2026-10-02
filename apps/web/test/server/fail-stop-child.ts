// A server process whose event log fails when a move is written.
// Spawned by fail-stop.test.ts with `tsx`; not a test file itself.
//
// The process boots a server over the in-memory chain with the default failure handling (the
// one a real server runs with), opens a game and sends itself one move. It reports on stdout
// with synchronous writes:
//
//   READY            the game is open, the move is about to be sent
//   APPEND-FAILED    the store has just refused the move
//   EXIT <code> <ms since APPEND-FAILED> <alert|quiet>
//                    written from the process's exit handler; `alert` when the server logged
//                    `store-failed` before it ended
//   RESPONDED <status>
//                    the move was answered (it must not be)

import { writeSync } from 'node:fs';
import { createMemoryStore, type EventStore, type StoreEvent } from '../../src/server/store';
import { api, exitRoute, makeEnv, openGame, type TestEnv } from './helpers';

function report(line: string): void {
  writeSync(1, `${line}\n`);
}

async function main(): Promise<void> {
  const inner = createMemoryStore();
  let failedAtMs: number | null = null;
  let env: TestEnv | null = null;
  const store: EventStore = {
    load: () => inner.load(),
    close: () => inner.close(),
    append(events) {
      const list: readonly StoreEvent[] = Array.isArray(events) ? events : [events as StoreEvent];
      if (list.some((event) => event.type === 'move')) {
        failedAtMs = performance.now();
        report('APPEND-FAILED');
        return Promise.reject(new Error('disk full'));
      }
      return inner.append(events);
    },
  };
  process.on('exit', (code) => {
    const elapsed = failedAtMs === null ? 'never' : String(Math.round(performance.now() - failedAtMs));
    const alerted = env?.logs.some((line) => line.event === 'store-failed' && line.level === 'alert');
    report(`EXIT ${code} ${elapsed} ${alerted === true ? 'alert' : 'quiet'}`);
  });

  env = await makeEnv({ store, exitOnStoreFailure: true });
  const game = await openGame(env);
  report('READY');
  const reply = await api.move(game.gameId, game.token, { step: 0, dir: exitRoute(game.maze)[0] });
  report(`RESPONDED ${reply.status}`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    report(`FAILED ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  },
);
