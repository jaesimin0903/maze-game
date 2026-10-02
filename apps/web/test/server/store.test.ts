// The event log (plan §7.8) and recovery from it (AC-S6, AC-S9 at unit level).

import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

  it('reads the log as a stream: lines that span read boundaries, and a torn tail, are handled', async () => {
    // 6 MB of lines, so that the 1 MiB reads cut through lines, with a multi-byte character in
    // each line and an unterminated tail.
    const events: StoreEvent[] = Array.from({ length: 30_000 }, (_, i) => ({
      type: 'settle-sent',
      gameId: ID,
      txHash: `0x${i.toString(16).padStart(64, '0')}`,
      nonce: i,
      atSec: i,
    }));
    const lines = events.map((event, i) => JSON.stringify({ ...event, note: `블록 ${i} ✓ ${'x'.repeat(60)}` }));
    await writeFile(file, `${lines.join('\n')}\n{"type":"settle-sent","gameId":"0xto`);
    const before = (await stat(file)).size;
    expect(before).toBeGreaterThan(5 * 1024 * 1024);

    const store = await openFileStore(dir);
    const loaded = await store.load();
    expect(loaded).toHaveLength(events.length);
    expect(loaded[0]).toMatchObject({ type: 'settle-sent', nonce: 0, note: `블록 0 ✓ ${'x'.repeat(60)}` });
    expect(loaded[29_999]).toMatchObject({ nonce: 29_999, note: `블록 29999 ✓ ${'x'.repeat(60)}` });
    expect(loaded.map((event) => (event as { nonce: number }).nonce)).toEqual(events.map((_, i) => i));
    // The torn tail is gone and the next append starts on a clean line.
    expect((await stat(file)).size).toBe(before - '{"type":"settle-sent","gameId":"0xto'.length);
    await store.append(MOVE_1);
    expect((await store.load()).at(-1)).toEqual(MOVE_1);
    await store.close();
  });

  it('load() reads the file back: what was appended is not kept in memory by the store', async () => {
    const store = await openFileStore(dir);
    await store.append(MOVE_1);
    // Whatever is in the file is what load() returns, so there is no second copy to grow.
    await appendFile(file, `${JSON.stringify(MOVE_2)}\n`);
    expect(await store.load()).toEqual([MOVE_1, MOVE_2]);
    await store.close();
  });
});

describe('file store: tickets that never became a game are compacted out at open', () => {
  const RETENTION = 3600;
  const T = 1_700_000_000;
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'maze-compact-'));
    file = path.join(dir, 'events.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const id = (byte: string): Hex => `0x${byte.repeat(32)}`;
  function ticket(gameId: Hex, expirySec: number): StoreEvent {
    return {
      type: 'ticket-issued',
      gameId,
      player: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      tier: 0,
      n: 5,
      serverSeed: id('5e'),
      commitment: id('c0'),
      sessionTokenHash: id('70'),
      expirySec,
      signature: `0x${'ab'.repeat(65)}`,
      atSec: expirySec - 120,
    };
  }
  const rebound = (gameId: Hex, expirySec: number): StoreEvent => ({
    type: 'ticket-rebound',
    gameId,
    sessionTokenHash: id('71'),
    expirySec,
    atSec: expirySec - 60,
  });
  const created = (gameId: Hex, atSec: number): StoreEvent => ({
    type: 'chain-created',
    gameId,
    clientSeed: id('c1'),
    betWei: '10',
    maxPayoutWei: '20',
    createdAtSec: atSec,
    settleDeadlineSec: atSec + 1800,
    blockNumber: '7',
    startOpen: 2,
    atSec,
  });
  const marker = (blockNumber: number, timestampSec?: number): StoreEvent => ({
    type: 'block-scanned',
    blockNumber: String(blockNumber),
    blockHash: id('b1'),
    ...(timestampSec === undefined ? {} : { timestampSec }),
  });
  const META: StoreEvent = { type: 'meta', chainId: 31337, contract: '0x5FbDB2315678afecb367f032d93F642f64180aa3' };

  const DEAD = id('d1'); // expired at T, never created
  const PLAYED = id('d2'); // as old, but its game was created
  const YOUNG = id('d3'); // expired at T + 600: inside the retention window of the last marker
  const BORDER = id('d4'); // expiry + retention is exactly the marker's timestamp

  /** The last marker is at T + 3601: only tickets with expiry < T + 1 are past the window. */
  const LOG: StoreEvent[] = [
    META,
    ticket(DEAD, T),
    rebound(DEAD, T),
    ticket(PLAYED, T),
    created(PLAYED, T - 30),
    { ...MOVE_1, gameId: PLAYED },
    marker(10, T + 5),
    ticket(BORDER, T + 1),
    ticket(YOUNG, T + 600),
    rebound(YOUNG, T + 600),
    marker(900, T + RETENTION + 1),
  ];
  const KEPT = LOG.filter((event) => !('gameId' in event) || event.gameId !== DEAD);

  async function write(events: readonly StoreEvent[]): Promise<void> {
    await writeFile(file, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
  }

  async function open(retention?: number): Promise<StoreEvent[]> {
    const store = await openFileStore(dir, retention === undefined ? {} : { ticketRetentionSec: retention });
    try {
      return await store.load();
    } finally {
      await store.close();
    }
  }

  it('drops a ticket and its re-bindings once a scan marker is past expiry + retention, and nothing else', async () => {
    await write(LOG);
    expect(await open(RETENTION)).toEqual(KEPT);
    // The file itself was rewritten, in the same order, and opening it again changes nothing.
    expect(await readFile(file, 'utf8')).toBe(KEPT.map((event) => `${JSON.stringify(event)}\n`).join(''));
    expect(await open(RETENTION)).toEqual(KEPT);
    expect(await readdir(dir)).toEqual(['events.jsonl']);
  });

  it('keeps everything without the option, without a timestamped marker, or before the window has passed', async () => {
    await write(LOG);
    expect(await open()).toEqual(LOG);

    // A log written before markers carried a timestamp proves nothing about the chain's time.
    const untimed = LOG.map((event) => (event.type === 'block-scanned' ? marker(Number(event.blockNumber)) : event));
    await write(untimed);
    expect(await open(RETENTION)).toEqual(untimed);

    // One second earlier the dead ticket is still inside its retention window.
    const early = [...LOG.slice(0, -1), marker(900, T + RETENTION)];
    await write(early);
    expect(await open(RETENTION)).toEqual(early);
  });

  it('a ticket whose game exists is kept however old, also when the creation is the last line', async () => {
    const log = [META, ticket(PLAYED, T), marker(900, T + 10 * RETENTION), created(PLAYED, T - 5)];
    await write(log);
    expect(await open(RETENTION)).toEqual(log);
  });

  it('a compaction that was interrupted leaves the log whole', async () => {
    await write(LOG);
    // What a process that died while compacting leaves behind: a partial copy next to the log.
    await writeFile(`${file}.compact`, `${JSON.stringify(META)}\n{"type":"ticket-is`);
    expect(await open()).toEqual(LOG);
    expect(await readdir(dir)).toEqual(['events.jsonl']);
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
    // A real server process has ended here (fail-stop.test.ts); this one only recorded the call.
    expect(booted.storeFailures).toHaveLength(1);

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
