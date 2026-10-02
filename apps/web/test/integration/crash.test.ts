// AC-S9: process-kill injection. A real server process is SIGKILLed between storing a move and
// answering it (and, as the opposite case, just before storing it). After a restart the state
// never contradicts what was, or was not, answered.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EIP712_TYPES, mazeBetDomain, type GameView } from '@maze/shared';
import { verifyTypedData } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, cellsOf, deadEndRoute, exitRoute } from '../server/helpers';
import type { CrashChildArgs } from './crash-child';
import {
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

/** Runs one move request in a separate server process over `dataDir`. */
function runChild(
  dataDir: string,
  game: LiveGame,
  body: unknown,
  crash: CrashChildArgs['crash'],
): { signal: NodeJS.Signals | null; status: number | null; lines: string[] } {
  const args: CrashChildArgs = {
    config: serverConfig(h, dataDir),
    gameId: game.gameId,
    token: game.token,
    body,
    crash,
  };
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
