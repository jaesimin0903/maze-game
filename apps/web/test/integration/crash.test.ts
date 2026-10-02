// AC-S9: process-kill injection. A real server process is SIGKILLed between storing an event and
// answering the request that caused it (and, as the opposite case, just before storing it): a
// move, a ticket, and the ending of a cash-out. After a restart the state never contradicts what
// was, or was not, answered.

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EIP712_TYPES,
  mazeBetDomain,
  refundWei,
  type GameView,
  type Hex,
  type TicketResponse,
} from '@maze/shared';
import { verifyTypedData } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoreEvent } from '../../src/server/store';
import { api, cellsOf, deadEndRoute, exitRoute, newToken, signTicketBody } from '../server/helpers';
import type { CrashChildArgs, CrashChildRequest } from './crash-child';
import {
  BET,
  createOnChain,
  linesOf,
  openGame,
  playerOf,
  serverConfig,
  settlements,
  startHarness,
  startServer,
  waitSettled,
  walk,
  type Harness,
  type LiveGame,
  type Server,
} from './setup';

const APP_DIR = fileURLToPath(new URL('../../', import.meta.url));
const CHILD = fileURLToPath(new URL('./crash-child.ts', import.meta.url));

let h: Harness;
let server: Server | null = null;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await server?.stop();
  await h?.stop();
});

interface ChildRun {
  signal: NodeJS.Signals | null;
  status: number | null;
  lines: string[];
}

/** Runs one move request in a separate server process over `dataDir`. */
function runChild(
  dataDir: string,
  game: LiveGame,
  body: unknown,
  crash: CrashChildArgs['crash'],
): ChildRun {
  return runRequest(dataDir, { kind: 'move', gameId: game.gameId, token: game.token, body }, 'move', crash);
}

/** Runs one request in a separate server process that dies around the write of a `killOn` event. */
function runRequest(
  dataDir: string,
  request: CrashChildRequest,
  killOn: CrashChildArgs['killOn'],
  crash: CrashChildArgs['crash'],
): ChildRun {
  const args: CrashChildArgs = { config: serverConfig(h, dataDir), request, killOn, crash };
  // `node --import tsx` rather than the `tsx` launcher: the server must be the spawned process
  // itself, so that its SIGKILL is what this test observes.
  const run = spawnSync(process.execPath, ['--import', 'tsx', CHILD], {
    cwd: APP_DIR,
    env: { ...process.env, CRASH_CHILD_ARGS: JSON.stringify(args) },
    encoding: 'utf8',
    timeout: 90_000,
  });
  const lines = run.stdout.split('\n').filter((line) => line !== '');
  if (lines.some((line) => line.startsWith('FAILED'))) {
    throw new Error(`crash child failed:\n${run.stdout}\n${run.stderr}`);
  }
  return { signal: run.signal, status: run.status, lines };
}

/** The events in the log of `dataDir`, read from the file. */
async function logOf(dataDir: string): Promise<StoreEvent[]> {
  const text = await readFile(path.join(dataDir, 'events.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .flatMap((line) => {
      const value = JSON.parse(line) as StoreEvent | { type: 'group'; events: StoreEvent[] };
      return value.type === 'group' ? value.events : [value];
    });
}

function ticketsOf(events: readonly StoreEvent[], player: Hex): Hex[] {
  return events.flatMap((event) =>
    event.type === 'ticket-issued' && event.player.toLowerCase() === player.toLowerCase()
      ? [event.gameId]
      : [],
  );
}

/** Stops the test's own server so that a child process can own the data directory. */
async function handOver(): Promise<string> {
  const { dataDir } = server!;
  await server!.stop();
  server = null;
  return dataDir;
}

describe('AC-S9: a server killed around the write of a move', () => {
  it('control: the child process answers a move when nothing kills it', async () => {
    server = await startServer(h);
    const game = await openGame(h, playerOf(h, 0));
    const route = exitRoute(game.maze);
    const dataDir = await handOver();

    const run = runChild(dataDir, game, { step: 0, dir: route[0] }, 'never');
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.lines[0]).toBe('READY');
    expect(run.lines[1]).toMatch(/^RESPONDED 200 \{/);
    const answered = JSON.parse(run.lines[1].slice('RESPONDED 200 '.length)) as GameView;

    server = await startServer(h, { dataDir });
    const read = await api.game<GameView>(game.gameId, game.token);
    expect(read.body.step).toBe(1);
    expect(read.body.cell).toEqual(answered.cell);
    expect(read.body.open).toBe(answered.open);
  });

  it('killed after the move was stored, before it was answered: the move stands', async () => {
    server = server ?? (await startServer(h));
    const game = await openGame(h, playerOf(h, 1));
    const route = exitRoute(game.maze);
    const cells = cellsOf(game.maze, route);
    const dataDir = await handOver();

    const run = runChild(dataDir, game, { step: 0, dir: route[0] }, 'after-persist');
    expect(run.signal).toBe('SIGKILL');
    expect(run.lines).toEqual(['READY', 'PERSISTED']);

    server = await startServer(h, { dataDir });
    const read = await api.game<GameView>(game.gameId, game.token);
    expect(read.status).toBe(200);
    expect(read.body.step).toBe(1);
    expect(read.body.cell).toEqual({ x: cells[1] % game.n, y: Math.floor(cells[1] / game.n) });
    expect(read.body.open).toBe(game.maze.open[cells[1]]);
    expect(read.body.path).toHaveLength(2);

    // The client never got an answer and repeats the request: it is told its step is stale,
    // reads the game, and goes on from the state the server stored.
    const repeated = await api.move(game.gameId, game.token, { step: 0, dir: route[0] });
    expect(repeated.status).toBe(409);
    expect((repeated.body as { error: { code: string } }).error.code).toBe('STALE_STEP');
    const next = await api.move<GameView>(game.gameId, game.token, { step: 1, dir: route[1] });
    expect(next.status).toBe(200);
    expect(next.body.step).toBe(2);
  });

  it('killed before the move was stored: nothing happened', async () => {
    server = server ?? (await startServer(h));
    const game = await openGame(h, playerOf(h, 2));
    const route = exitRoute(game.maze);
    await walk(game, route.slice(0, 1));
    const before = await api.game<GameView>(game.gameId, game.token);
    const dataDir = await handOver();

    const run = runChild(dataDir, game, { step: 1, dir: route[1] }, 'before-persist');
    expect(run.signal).toBe('SIGKILL');
    expect(run.lines).toEqual(['READY', 'BEFORE-PERSIST']);

    server = await startServer(h, { dataDir });
    const read = await api.game<GameView>(game.gameId, game.token);
    expect(read.body.step).toBe(1);
    expect(read.body.path).toEqual(before.body.path);
    // The same request is simply accepted now.
    const again = await api.move<GameView>(game.gameId, game.token, { step: 1, dir: route[1] });
    expect(again.status).toBe(200);
    expect(again.body.step).toBe(2);
  });

  it('killed after a losing move and its signature were stored: the loss stands and is settled', async () => {
    server = server ?? (await startServer(h));
    const game = await openGame(h, playerOf(h, 3), { deadEnd: true });
    const route = deadEndRoute(game.maze);
    const k = route.length - 1;
    await walk(game, route.slice(0, k));
    const dataDir = await handOver();

    const run = runChild(dataDir, game, { step: k, dir: route[k] }, 'after-persist');
    expect(run.signal).toBe('SIGKILL');
    expect(run.lines).toEqual(['READY', 'PERSISTED']);
    // The process died before it could send the settlement.
    expect(await settlements(h, game.gameId)).toHaveLength(0);

    const restarted = (server = await startServer(h, { dataDir }));
    const read = await api.game<GameView>(game.gameId, game.token);
    expect(read.body).toMatchObject({ status: 'lost', step: k + 1, auto: false });
    expect(read.body.terminal).toMatchObject({ outcome: 2, steps: k + 1, payoutWei: '0' });

    // The stored signature is the one that settles the game; no second one is made.
    expect(linesOf(restarted, game.gameId).some((line) => line.event === 'ended')).toBe(false);
    expect(
      await verifyTypedData({
        address: h.relayer,
        domain: mazeBetDomain(h.deployment.chainId, h.contract),
        types: EIP712_TYPES,
        primaryType: 'Settlement',
        message: {
          gameId: game.gameId,
          player: game.player.address,
          outcome: 2,
          steps: k + 1,
          payout: 0n,
          serverSeed: read.body.terminal!.serverSeed,
        },
        signature: read.body.terminal!.signature,
      }),
    ).toBe(true);
    const settled = await waitSettled(h, game.gameId);
    expect(settled).toMatchObject({ outcome: 2, steps: k + 1, payoutWei: 0n });
    expect(await settlements(h, game.gameId)).toHaveLength(1);

    // A cash-out attempt after the restart cannot undo the loss.
    const cashout = await api.cashout(game.gameId, game.token, { step: k });
    expect(cashout.status).toBe(409);
  });
});

describe('AC-S9: a server killed around the issue of a ticket', () => {
  it('killed before the ticket was stored: no ticket exists, and the same request issues one', async () => {
    server = server ?? (await startServer(h));
    const player = playerOf(h, 4);
    const { token, sessionTokenHash } = newToken();
    const body = await signTicketBody(player.key, { sessionTokenHash }, player.domain);
    const dataDir = await handOver();

    const run = runRequest(dataDir, { kind: 'ticket', body }, 'ticket-issued', 'before-persist');
    expect(run.signal).toBe('SIGKILL');
    expect(run.lines).toEqual(['READY', 'BEFORE-PERSIST']);
    expect(ticketsOf(await logOf(dataDir), player.address)).toEqual([]);

    server = await startServer(h, { dataDir });
    // Nothing was answered and nothing was stored: the request is simply accepted now.
    const reply = await api.ticket<TicketResponse>(body);
    expect(reply.status).toBe(201);
    expect(ticketsOf(await logOf(dataDir), player.address)).toEqual([reply.body.gameId]);
    await createOnChain(h, player, reply.body, BET, `0x${'c4'.repeat(32)}`);
    expect((await api.start<GameView>(reply.body.gameId, token)).status).toBe(200);
  });

  it('killed after the ticket was stored, before it was answered: the repeated request gets that ticket', async () => {
    server = server ?? (await startServer(h));
    const player = playerOf(h, 5);
    const { token, sessionTokenHash } = newToken();
    const body = await signTicketBody(player.key, { sessionTokenHash }, player.domain);
    const dataDir = await handOver();

    const run = runRequest(dataDir, { kind: 'ticket', body }, 'ticket-issued', 'after-persist');
    expect(run.signal).toBe('SIGKILL');
    expect(run.lines).toEqual(['READY', 'PERSISTED']);
    const stored = ticketsOf(await logOf(dataDir), player.address);
    expect(stored).toHaveLength(1);

    const restarted = (server = await startServer(h, { dataDir }));
    expect(restarted.container.service.get(stored[0])).toMatchObject({ chain: null, sessionTokenHash });
    // The client never got an answer and repeats the request: it gets the ticket that was
    // stored, not a second one, and the ticket creates and plays its game.
    const reply = await api.ticket<TicketResponse>(body);
    expect(reply.status).toBe(201);
    expect(reply.body.gameId).toBe(stored[0]);
    expect(linesOf(restarted, stored[0]).some((line) => line.event === 'ticket-issued')).toBe(false);
    expect(ticketsOf(await logOf(dataDir), player.address)).toEqual(stored);

    await createOnChain(h, player, reply.body, BET, `0x${'c5'.repeat(32)}`);
    expect((await api.start<GameView>(reply.body.gameId, token)).status).toBe(200);
    const ended = await api.cashout<GameView>(reply.body.gameId, token, { step: 0 });
    expect(ended.body.status).toBe('cashed_out');
    expect((await waitSettled(h, reply.body.gameId)).payoutWei).toBe(refundWei(h.table, BET, 0, 0));
  });
});

describe('AC-S9: a server killed around the ending of a cash-out', () => {
  it('killed before the ending was stored: the game is still in play, and the same cash-out goes through', async () => {
    server = server ?? (await startServer(h));
    const game = await openGame(h, playerOf(h, 6));
    const route = exitRoute(game.maze);
    await walk(game, route.slice(0, 1));
    const before = await api.game<GameView>(game.gameId, game.token);
    const dataDir = await handOver();

    const request: CrashChildRequest = { kind: 'cashout', gameId: game.gameId, token: game.token, body: { step: 1 } };
    const run = runRequest(dataDir, request, 'ended', 'before-persist');
    expect(run.signal).toBe('SIGKILL');
    expect(run.lines).toEqual(['READY', 'BEFORE-PERSIST']);
    // No ending is in the log, and no settlement left the process.
    expect((await logOf(dataDir)).some((event) => event.type === 'ended' && event.gameId === game.gameId)).toBe(false);
    expect(await settlements(h, game.gameId)).toHaveLength(0);

    server = await startServer(h, { dataDir });
    const read = await api.game<GameView>(game.gameId, game.token);
    expect(read.body).toMatchObject({ status: 'active', step: 1 });
    expect(read.body.terminal).toBeUndefined();
    expect(read.body.path).toEqual(before.body.path);

    // The same request is simply accepted now, and it is the one ending of the game.
    const again = await api.cashout<GameView>(game.gameId, game.token, { step: 1 });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'cashed_out', auto: false, step: 1 });
    const settled = await waitSettled(h, game.gameId);
    expect(settled).toMatchObject({ outcome: 1, steps: 1, payoutWei: refundWei(h.table, BET, 0, 1) });
    expect(await settlements(h, game.gameId)).toHaveLength(1);
  });

  it('killed after the ending and its signature were stored: the cash-out stands and is settled once', async () => {
    server = server ?? (await startServer(h));
    const game = await openGame(h, playerOf(h, 7));
    const route = exitRoute(game.maze);
    await walk(game, route.slice(0, 2));
    const dataDir = await handOver();

    const request: CrashChildRequest = { kind: 'cashout', gameId: game.gameId, token: game.token, body: { step: 2 } };
    const run = runRequest(dataDir, request, 'ended', 'after-persist');
    expect(run.signal).toBe('SIGKILL');
    expect(run.lines).toEqual(['READY', 'PERSISTED']);
    // The process died before it could send the settlement.
    expect(await settlements(h, game.gameId)).toHaveLength(0);

    const restarted = (server = await startServer(h, { dataDir }));
    const read = await api.game<GameView>(game.gameId, game.token);
    const refund = refundWei(h.table, BET, 0, 2);
    expect(read.body).toMatchObject({ status: 'cashed_out', step: 2, auto: false });
    expect(read.body.terminal).toMatchObject({ outcome: 1, steps: 2, payoutWei: refund.toString() });

    // The stored signature is the one that settles the game; no second one is made.
    expect(linesOf(restarted, game.gameId).some((line) => line.event === 'ended')).toBe(false);
    expect(
      await verifyTypedData({
        address: h.relayer,
        domain: mazeBetDomain(h.deployment.chainId, h.contract),
        types: EIP712_TYPES,
        primaryType: 'Settlement',
        message: {
          gameId: game.gameId,
          player: game.player.address,
          outcome: 1,
          steps: 2,
          payout: refund,
          serverSeed: read.body.terminal!.serverSeed,
        },
        signature: read.body.terminal!.signature,
      }),
    ).toBe(true);
    const settled = await waitSettled(h, game.gameId);
    expect(settled).toMatchObject({ outcome: 1, steps: 2, payoutWei: refund });
    expect(await settlements(h, game.gameId)).toHaveLength(1);
    expect((await logOf(restarted.dataDir)).filter((event) => event.type === 'ended' && event.gameId === game.gameId)).toHaveLength(1);

    // The client repeats the request it never got an answer to: the game has ended.
    const repeated = await api.cashout(game.gameId, game.token, { step: 2 });
    expect(repeated.status).toBe(409);
    expect((repeated.body as { error: { code: string } }).error.code).toBe('GAME_NOT_ACTIVE');
    expect((await api.move(game.gameId, game.token, { step: 2, dir: route[2] })).status).toBe(409);
  });
});
