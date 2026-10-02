// The event log (plan §7.8) and recovery from it (AC-S6, AC-S9 at unit level).

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GameView, Hex } from '@maze/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BootError } from '../../src/server/errors';
import {
  createMemoryStore,
  openFileStore,
  type EventStore,
  type StoreEvent,
} from '../../src/server/store';
import {
  api,
  BET,
  exitRoute,
  FakeChain,
  fixtureTable,
  makeEnv,
  openGame,
  PLAYERS,
  requestTicket,
  type TestEnv,
} from './helpers';

const ID: Hex = `0x${'a7'.repeat(32)}`;
const MOVE_1: StoreEvent = { type: 'move', gameId: ID, step: 1, dir: 1, cell: 1, open: 10, atSec: 5 };
const MOVE_2: StoreEvent = { type: 'move', gameId: ID, step: 2, dir: 2, cell: 6, open: 5, atSec: 6 };
const ENDED: StoreEvent = {
  type: 'ended',
  gameId: ID,
  outcome: 2,
  steps: 2,
  payoutWei: '0',
  signature: '0xabcd',
  auto: false,
  cause: 'dead-end',
  atSec: 6,
};

/** Opens the log in `dir`, reads it and closes it again. */
async function reload(dir: string): Promise<StoreEvent[]> {
  const store = await openFileStore(dir);
  try {
    return await store.load();
  } finally {
    await store.close();
  }
}

describe('file store', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'maze-store-'));
    file = path.join(dir, 'events.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('an event is on disk when append resolves, and survives reopening', async () => {
    const store = await openFileStore(dir);
    await store.append(MOVE_1);
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(MOVE_1)}\n`);
    await store.append([MOVE_2, ENDED]);
    expect(await store.load()).toEqual([MOVE_1, MOVE_2, ENDED]);
    await store.close();

    const reopened = await openFileStore(dir);
    expect(await reopened.load()).toEqual([MOVE_1, MOVE_2, ENDED]);
    await reopened.close();
  });

  it('events appended together are one line: stored together or not at all', async () => {
    const store = await openFileStore(dir);
    await store.append(MOVE_1);
    await store.append([MOVE_2, ENDED]);
    await store.close();
    const lines = (await readFile(file, 'utf8')).split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1])).toEqual({ type: 'group', events: [MOVE_2, ENDED] });

    // The process died while writing the group: neither event is there after reboot.
    await writeFile(file, `${lines[0]}\n${lines[1].slice(0, lines[1].length - 7)}`);
    const reopened = await openFileStore(dir);
    expect(await reopened.load()).toEqual([MOVE_1]);
    // The torn tail was cut off, so the next append starts on a clean line.
    expect(await readFile(file, 'utf8')).toBe(`${lines[0]}\n`);
    await reopened.append(MOVE_2);
    await reopened.close();
    expect(await reload(dir)).toEqual([MOVE_1, MOVE_2]);
  });

  it('keeps concurrent appends in call order', async () => {
    const store = await openFileStore(dir);
    const events: StoreEvent[] = Array.from({ length: 30 }, (_, i) => ({ ...MOVE_1, step: i + 1 }));
    await Promise.all(events.map((event) => store.append(event)));
    expect(await store.load()).toEqual(events);
    await store.close();
    expect(await reload(dir)).toEqual(events);
  });

  it('refuses a log with a damaged or unknown line instead of guessing', async () => {
    await writeFile(file, `${JSON.stringify(MOVE_1)}\n{"type":"mo\n${JSON.stringify(MOVE_2)}\n`);
    await expect(openFileStore(dir)).rejects.toThrow(/line 2/);
    await writeFile(file, `${JSON.stringify({ type: 'surprise' })}\n`);
    await expect(openFileStore(dir)).rejects.toThrow(/line 1/);
  });

  it('one process at a time: a live owner blocks a second open, a dead one does not', async () => {
    const lock = path.join(dir, 'events.lock');
    const store = await openFileStore(dir);
    expect((await readFile(lock, 'utf8')).trim()).toBe(String(process.pid));
    await store.append(MOVE_1);
    await store.close();
    await expect(readFile(lock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // The same process cannot open one log twice (two containers would each sign endings).
    const held = await openFileStore(dir);
    await expect(openFileStore(dir)).rejects.toThrow(/already open in this process/);
    await expect(openFileStore(path.join(dir, '.'))).rejects.toThrow(/already open in this process/);
    await held.close();

    // Another live process (this test's parent) holds the log.
    await writeFile(lock, `${process.ppid}\n`);
    await expect(openFileStore(dir)).rejects.toThrow(`in use by process ${process.ppid}`);
    expect((await readFile(lock, 'utf8')).trim()).toBe(String(process.ppid));

    // The owner was killed: its pid no longer runs, so the lock is taken over.
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    });
    await writeFile(lock, `${dead.stdout}\n`);
    expect(await reload(dir)).toEqual([MOVE_1]);
    await writeFile(lock, 'not a pid');
    expect(await reload(dir)).toEqual([MOVE_1]);
  });

  it('rejects appends after close', async () => {
    const store = await openFileStore(dir);
    await store.close();
    await expect(store.append(MOVE_1)).rejects.toThrow(/closed/);
  });
});

describe('recovery from the log', () => {
  let env: TestEnv | null = null;

  afterEach(async () => {
    await env?.close();
    env = null;
  });

  /** Boots a second server over the same chain from a copy of the first server's log. */
  async function reboot(from: TestEnv, events?: StoreEvent[]): Promise<TestEnv> {
    const log = events ?? (await from.store.load());
    await from.close();
    return makeEnv({ chain: from.chain, store: createMemoryStore(log) });
  }

  it('AC-S9: a rebooted server answers exactly what was answered before', async () => {
    const first = (env = await makeEnv());
    const active = await openGame(first, { player: PLAYERS[0] });
    const ended = await openGame(first, { player: PLAYERS[1] });
    const unstarted = await openGame(first, { player: PLAYERS[2] });
    const ticketOnly = await requestTicket({ player: PLAYERS[3] });

    const route = exitRoute(active.maze);
    await api.move(active.gameId, active.token, { step: 0, dir: route[0] });
    await api.move(active.gameId, active.token, { step: 1, dir: route[1] });
    await api.move(ended.gameId, ended.token, { step: 0, dir: exitRoute(ended.maze)[0] });
    await api.cashout(ended.gameId, ended.token, { step: 1 });
    await first.container.relayer.drain();

    const before = {
      active: await api.game(active.gameId, active.token),
      ended: await api.game(ended.gameId, ended.token),
      unstarted: await api.game(unstarted.gameId, unstarted.token),
    };

    const second = (env = await reboot(first));
    expect((await api.game(active.gameId, active.token)).text).toBe(before.active.text);
    expect((await api.game(ended.gameId, ended.token)).text).toBe(before.ended.text);
    expect((await api.game(unstarted.gameId, unstarted.token)).text).toBe(before.unstarted.text);
    // Nothing was signed again: the ending and its signature came from the log.
    expect(second.signs.settlement).toBe(0);

    // Play continues where it stopped, on the same maze.
    const next = await api.move<GameView>(active.gameId, active.token, { step: 2, dir: route[2] });
    expect(next.status).toBe(200);
    expect(next.body.step).toBe(3);
    expect((await api.move(active.gameId, active.token, { step: 0, dir: route[0] })).status).toBe(409);

    // A ticket issued before the reboot can still create its game.
    second.chain.createGame({ ...ticketOnly.ticket, betWei: BET, clientSeed: `0x${'21'.repeat(32)}` });
    expect((await api.start(ticketOnly.ticket.gameId, ticketOnly.token)).status).toBe(200);
  });

  it('AC-S6: a game created while the server was down is picked up from the chain at boot', async () => {
    const first = (env = await makeEnv());
    const { ticket, token } = await requestTicket();
    const log = await first.store.load();
    await first.close();

    // The server is down. The player creates the game; time passes.
    first.chain.time += 3;
    first.chain.createGame({ ...ticket, betWei: BET, clientSeed: `0x${'22'.repeat(32)}` });
    first.chain.time += 40;
    first.chain.mine();

    const second = (env = await makeEnv({ chain: first.chain, store: createMemoryStore(log) }));
    const view = await api.game<GameView>(ticket.gameId, token);
    expect(view.status).toBe(200);
    // The clock runs from the creation block, not from the boot.
    expect(view.body.idleDeadlineSec).toBe(second.chain.time - 40 + fixtureTable.timing.idleTimeoutSec);

    second.advance(fixtureTable.timing.idleTimeoutSec - 40);
    await second.tick();
    expect((await api.game<GameView>(ticket.gameId, token)).body).toMatchObject({
      status: 'cashed_out',
      auto: true,
    });
  });

  it('AC-S9: a move that could not be stored is neither applied nor answered', async () => {
    let failing = true;
    const inner = createMemoryStore();
    const store: EventStore = {
      load: () => inner.load(),
      close: () => inner.close(),
      append(events) {
        const list = Array.isArray(events) ? events : [events];
        if (failing && list.some((event: StoreEvent) => event.type === 'move')) {
          return Promise.reject(new Error('disk full'));
        }
        return inner.append(events);
      },
    };
    const booted = (env = await makeEnv({ store }));
    const game = await openGame(booted);
    const route = exitRoute(game.maze);

    const refused = await api.move(game.gameId, game.token, { step: 0, dir: route[0] });
    expect(refused.status).toBe(500);
    expect(refused.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal error.' } });
    expect((await api.game<GameView>(game.gameId, game.token)).body.step).toBe(0);

    // The same for a move that would have ended the game: its signature never leaves.
    failing = false;
    for (let k = 0; k < route.length - 1; k++) {
      await api.move(game.gameId, game.token, { step: k, dir: route[k] });
    }
    failing = true;
    const last = route.length - 1;
    const lost = await api.move(game.gameId, game.token, { step: last, dir: route[last] });
    expect(lost.status).toBe(500);
    expect(lost.text).not.toContain('signature');
    expect(lost.text).not.toContain('terminal');
    expect(booted.container.service.get(game.gameId)!.ended).toBeNull();
    expect(booted.chain.sent).toHaveLength(0);
    expect((await inner.load()).some((event) => event.type === 'ended')).toBe(false);

    failing = false;
    const won = await api.move<GameView>(game.gameId, game.token, { step: last, dir: route[last] });
    expect(won.body.status).toBe('won');
    expect((await inner.load()).filter((event) => event.type === 'ended')).toHaveLength(1);
  });

  it('refuses to boot from a log that disagrees with the regenerated maze', async () => {
    const first = (env = await makeEnv());
    const game = await openGame(first);
    await api.move(game.gameId, game.token, { step: 0, dir: exitRoute(game.maze)[0] });
    const tampered = (await first.store.load()).map((event) =>
      event.type === 'move' ? { ...event, open: event.open ^ 15 } : event,
    );
    await first.close();
    env = null;
    await expect(
      makeEnv({ chain: first.chain, store: createMemoryStore(tampered), install: false }),
    ).rejects.toBeInstanceOf(BootError);
  });

  it('refuses a log that belongs to another deployment or another chain instance', async () => {
    const first = (env = await makeEnv());
    await openGame(first);
    const log = await first.store.load();
    expect(log[0]).toMatchObject({ type: 'meta', chainId: 31337 });
    expect(log.some((event) => event.type === 'block-scanned')).toBe(true);
    await first.close();
    env = null;

    // Same contract address on a chain that was restarted: the scan marker is not its block.
    await expect(
      makeEnv({ chain: new FakeChain(fixtureTable), store: createMemoryStore(log), install: false }),
    ).rejects.toMatchObject({ code: 'CHAIN_UNAVAILABLE' });
    // Another contract.
    await expect(
      makeEnv({
        chain: first.chain,
        store: createMemoryStore(log),
        config: { contract: '0x000000000000000000000000000000000000bEEF' },
        install: false,
      }),
    ).rejects.toMatchObject({ code: 'CHAIN_UNAVAILABLE' });
    // Events without the header line.
    await expect(
      makeEnv({ chain: first.chain, store: createMemoryStore(log.slice(1)), install: false }),
    ).rejects.toMatchObject({ code: 'CHAIN_UNAVAILABLE' });
  });
});
