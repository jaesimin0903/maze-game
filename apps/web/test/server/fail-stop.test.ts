// Audit X33, the server part: a server that can no longer do its job must not keep running.
//
// Before the fix a failed append left the process alive with a store that refused every later
// write, the worker pass stopped at its first failing step, and `/api/health` answered 200
// throughout. No automatic cash-out was signed any more, so every live game ran into its settle
// deadline and was reclaimed in full: a player in a bad position got the whole bet back.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveFinalSeed, generateMaze, MAZE_VERSION, type GameView, type Hex } from '@maze/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORE_FAILURE_EXIT_CODE, WORKER_STALE_MS } from '../../src/server/container';
import { createMemoryStore, type EventStore, type StoreEvent } from '../../src/server/store';
import {
  api,
  BET,
  exitRoute,
  makeEnv,
  ONCHAIN,
  openGame,
  PLAYERS,
  requestTicket,
  type TestEnv,
} from './helpers';

const APP_DIR = fileURLToPath(new URL('../../', import.meta.url));
const CHILD = fileURLToPath(new URL('./fail-stop-child.ts', import.meta.url));

let env: TestEnv | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await env?.close();
  env = null;
});

/** A store that refuses the appends `refuse` picks, the way a full disk would. */
function faultyStore(refuse: (event: StoreEvent) => boolean): EventStore {
  const inner = createMemoryStore();
  return {
    load: () => inner.load(),
    close: () => inner.close(),
    append(events) {
      const list: readonly StoreEvent[] = Array.isArray(events) ? events : [events as StoreEvent];
      return list.some(refuse) ? Promise.reject(new Error('disk full')) : inner.append(events);
    },
  };
}

describe('X33: a failed append stops the server', () => {
  it('the failure is reported at once and once; the request is neither applied nor answered', async () => {
    let failing = false;
    const booted = (env = await makeEnv({
      store: faultyStore((event) => failing && event.type === 'move'),
    }));
    const game = await openGame(booted);
    const route = exitRoute(game.maze);
    expect(booted.storeFailures).toEqual([]);
    expect((await api.health()).status).toBe(200);

    failing = true;
    const refused = await api.move(game.gameId, game.token, { step: 0, dir: route[0] });
    expect(refused.status).toBe(500);
    expect(refused.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal error.' } });
    // This is the call that ends a real server process (see the next test).
    expect(booted.storeFailures).toHaveLength(1);
    expect(booted.storeFailures[0].message).toBe('disk full');
    expect(booted.logs.filter((line) => line.event === 'store-failed')).toEqual([
      expect.objectContaining({ level: 'alert', detail: expect.objectContaining({ error: 'disk full' }) }),
    ]);
    expect((await api.game<GameView>(game.gameId, game.token)).body.step).toBe(0);

    // A second failure is not reported again: the first one already stopped the server.
    expect((await api.move(game.gameId, game.token, { step: 0, dir: route[0] })).status).toBe(500);
    expect(booted.storeFailures).toHaveLength(1);
    expect(booted.logs.filter((line) => line.event === 'store-failed')).toHaveLength(1);
  });

  it('a server process ends with a non-zero exit code right after the failed append, without answering', () => {
    // `node --import tsx`: the server must be the spawned process itself.
    const run = spawnSync(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: APP_DIR,
      encoding: 'utf8',
      timeout: 90_000,
    });
    const lines = run.stdout.split('\n').filter((line) => line !== '');
    expect(run.signal).toBeNull();
    expect(STORE_FAILURE_EXIT_CODE).toBe(70);
    expect(run.status, run.stdout + run.stderr).toBe(STORE_FAILURE_EXIT_CODE);
    expect(lines.slice(0, 2)).toEqual(['READY', 'APPEND-FAILED']);
    expect(lines).toHaveLength(3);
    const exit = /^EXIT (\d+) (\d+) (alert|quiet)$/.exec(lines[2]);
    expect(exit, lines[2]).not.toBeNull();
    expect(Number(exit![1])).toBe(STORE_FAILURE_EXIT_CODE);
    // Promptly: within 100 ms of the append that failed, and after the alert was logged.
    expect(Number(exit![2])).toBeLessThan(100);
    expect(exit![3]).toBe('alert');
    expect(lines.some((line) => line.startsWith('RESPONDED'))).toBe(false);
  });
});

describe('X33: one failing piece of work does not stop the rest of a worker pass', () => {
  it('a chain scan that fails does not keep overdue games from being cashed out and settled in that pass', async () => {
    const booted = (env = await makeEnv());
    const a = await openGame(booted, { player: PLAYERS[0] });
    const b = await openGame(booted, { player: PLAYERS[1] });
    booted.advance(booted.table.timing.idleTimeoutSec);

    booted.chain.failEvents = true;
    await expect(booted.tick()).rejects.toThrow(/^chain-scan: /);
    await booted.container.relayer.drain();
    for (const game of [a, b]) {
      expect(booted.container.service.get(game.gameId)!.ended).toMatchObject({
        outcome: 1,
        steps: 0,
        auto: true,
        cause: 'idle',
      });
    }
    expect(booted.chain.sent.map((tx) => tx.args.gameId).sort()).toEqual([a.gameId, b.gameId].sort());

    // Both settle in the next block, long before the settle deadline: there is nothing to reclaim.
    booted.advance(1);
    await expect(booted.tick()).rejects.toThrow(/^chain-scan: /);
    for (const game of [a, b]) {
      expect(booted.chain.games.get(game.gameId)!.status).toBe(ONCHAIN.Settled);
      expect(() => booted.chain.reclaim(game.gameId)).toThrow('GameNotActive');
    }
  });

  it("a game whose chain event cannot be handled does not hide another game's creation or delay its cash-out", async () => {
    let poisoned: Hex | null = null;
    const booted = (env = await makeEnv({
      mazeFactory: (finalSeed, n) => {
        if (finalSeed === poisoned) throw new Error('maze generation failed');
        return generateMaze(finalSeed, n);
      },
    }));
    const { service } = booted.container;
    const a = await requestTicket({ player: PLAYERS[0] });
    const b = await requestTicket({ player: PLAYERS[1] });
    const clientSeed: Hex = `0x${'51'.repeat(32)}`;
    poisoned = deriveFinalSeed({
      serverSeed: service.get(a.ticket.gameId)!.serverSeed,
      clientSeed,
      gameId: a.ticket.gameId,
    });
    booted.chain.createGame({ ...a.ticket, betWei: BET, clientSeed });
    booted.chain.createGame({ ...b.ticket, betWei: BET, clientSeed: `0x${'52'.repeat(32)}` });

    await expect(booted.tick()).rejects.toThrow('chain-scan: maze generation failed');
    expect(service.get(a.ticket.gameId)!.chain).toBeNull();
    expect(service.get(b.ticket.gameId)!.chain).not.toBeNull();
    expect((await api.start(b.ticket.gameId, b.token)).status).toBe(200);

    // The other game is cashed out and settled when it is due, while the first still fails.
    booted.advance(booted.table.timing.idleTimeoutSec);
    await expect(booted.tick()).rejects.toThrow('chain-scan: maze generation failed');
    await booted.container.relayer.drain();
    expect(service.get(b.ticket.gameId)!.ended).toMatchObject({ outcome: 1, auto: true });
    expect(booted.chain.sent.map((tx) => tx.args.gameId)).toEqual([b.ticket.gameId]);

    // Nothing was skipped: once the fault is gone the event is read again, and that game, long
    // overdue by then, is cashed out in the same pass.
    poisoned = null;
    await booted.tick();
    expect(service.get(a.ticket.gameId)!.chain).not.toBeNull();
    expect(service.get(a.ticket.gameId)!.ended).toMatchObject({ outcome: 1, auto: true });
    const created = (await booted.store.load()).filter((event) => event.type === 'chain-created');
    expect(created.map((event) => event.gameId)).toEqual([b.ticket.gameId, a.ticket.gameId]);
  });

  it('a game whose ending cannot be signed does not keep the others from theirs', async () => {
    const booted = (env = await makeEnv());
    const a = await openGame(booted, { player: PLAYERS[0] });
    const b = await openGame(booted, { player: PLAYERS[1] });
    booted.unsignable.add(a.gameId);
    booted.advance(booted.table.timing.idleTimeoutSec);
    await booted.tick();
    await booted.container.relayer.drain();

    expect(booted.container.service.get(a.gameId)!.ended).toBeNull();
    expect(booted.container.service.get(b.gameId)!.ended).toMatchObject({ outcome: 1, auto: true });
    expect(booted.chain.sent.map((tx) => tx.args.gameId)).toEqual([b.gameId]);
    expect(booted.logs.filter((line) => line.event === 'auto-cashout-failed')).toEqual([
      expect.objectContaining({ level: 'error', gameId: a.gameId }),
    ]);

    booted.unsignable.clear();
    booted.advance(1);
    await booted.tick();
    expect(booted.container.service.get(a.gameId)!.ended).toMatchObject({ outcome: 1, auto: true });
  });
});

describe('X33: /api/health reports the state of the server', () => {
  /** Moves the process's monotonic clock forward without waiting. */
  function skewClock(): { forward(ms: number): void } {
    const real = performance.now.bind(performance);
    let offset = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => real() + offset);
    return {
      forward(ms) {
        offset += ms;
      },
    };
  }

  function expectError(reply: { status: number; body: unknown }, status: number, code: string): void {
    expect(reply.status).toBe(status);
    expect(reply.body).toEqual({ error: { code, message: expect.any(String) } });
  }

  it('200 while the worker completes its passes, 503 when it has not completed one for 10 s', async () => {
    const booted = (env = await makeEnv());
    const clock = skewClock();
    const healthy = await api.health();
    expect(healthy.status).toBe(200);
    expect(healthy.body).toEqual({ ok: true, mazeVersion: MAZE_VERSION });

    expect(WORKER_STALE_MS).toBe(10_000);
    clock.forward(WORKER_STALE_MS - 500);
    expect((await api.health()).status).toBe(200);
    clock.forward(1000);
    expectError(await api.health(), 503, 'CHAIN_UNAVAILABLE');
    expect(booted.container.health()).toBe('worker-stalled');

    await booted.tick();
    expect((await api.health()).status).toBe(200);
    expect(booted.container.health()).toBeNull();
  });

  it('a pass that fails is not a completed pass', async () => {
    const booted = (env = await makeEnv());
    const clock = skewClock();
    booted.chain.offline = true;
    await expect(booted.tick()).rejects.toThrow();
    // Still inside the 10 s since the pass at boot.
    expect((await api.health()).status).toBe(200);
    clock.forward(WORKER_STALE_MS + 1);
    await expect(booted.tick()).rejects.toThrow();
    expectError(await api.health(), 503, 'CHAIN_UNAVAILABLE');

    booted.chain.offline = false;
    await booted.tick();
    expect((await api.health()).status).toBe(200);
  });

  it('500 once the event log has failed, however recently the worker ran', async () => {
    let failing = false;
    const booted = (env = await makeEnv({
      store: faultyStore((event) => failing && event.type === 'ended'),
    }));
    const game = await openGame(booted);
    expect((await api.health()).status).toBe(200);

    failing = true;
    expect((await api.cashout(game.gameId, game.token, { step: 0 })).status).toBe(500);
    await booted.tick();
    expectError(await api.health(), 500, 'INTERNAL');
    expect(booted.container.health()).toBe('store-failed');
    expect(booted.container.service.get(game.gameId)!.ended).toBeNull();
    expect(booted.chain.sent).toHaveLength(0);
  });
});
