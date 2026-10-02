// Audit X33 on a real chain: the dev stack runs the app under a supervisor
// (`scripts/dev-up.sh --supervise`), so that a server that died, or ended itself because it could
// no longer write its event log, is started again and its boot catch-up signs the overdue
// automatic cash-outs. Without it the games that were live would reach their settle deadline
// unsettled and be reclaimed for the whole bet.
//
// The supervised command here is a real game server process (server-child.ts) instead of
// `next start`: the same container, worker and event log, without the web pages.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refundWei } from '@maze/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { STORE_FAILURE_EXIT_CODE } from '../../src/server/container';
import { exitRoute } from '../server/helpers';
import type { ServerChildArgs } from './server-child';
import {
  BET,
  jump,
  onchainGame,
  openGame,
  playerOf,
  reclaimRevert,
  serverConfig,
  settlements,
  startHarness,
  startServer,
  until,
  waitSettled,
  walk,
  type Harness,
  type Server,
} from './setup';

const APP_DIR = fileURLToPath(new URL('../../', import.meta.url));
const CHILD = fileURLToPath(new URL('./server-child.ts', import.meta.url));
const DEV_UP = fileURLToPath(new URL('../../../../scripts/dev-up.sh', import.meta.url));

interface Supervised {
  /** Everything the supervisor and the app have written so far. */
  output(): string;
  /** How many times the app has reported that it serves. */
  ready(): number;
  /** PID of the app that is running now. */
  appPid(): Promise<number>;
  /** How many times the app has exited. */
  restarts(): Promise<number>;
  log(): Promise<string>;
  stop(): Promise<void>;
}

/** Starts the game server under the dev-up supervisor, the way dev-up.sh starts `next start`. */
async function supervise(args: ServerChildArgs): Promise<Supervised> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'maze-sup-'));
  const supervisor = spawn(
    'bash',
    [DEV_UP, '--supervise', stateDir, '--', process.execPath, '--import', 'tsx', CHILD],
    {
      cwd: APP_DIR,
      env: { ...process.env, SERVER_CHILD_ARGS: JSON.stringify(args) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  supervisor.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  supervisor.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => {
    supervisor.once('exit', () => resolve());
  });
  const number = async (name: string): Promise<number> => {
    const text = await readFile(path.join(stateDir, name), 'utf8').catch(() => '');
    return text.trim() === '' ? 0 : Number(text);
  };
  return {
    output: () => output,
    ready: () => output.split('\n').filter((line) => line === 'READY').length,
    appPid: () => number('next.pid'),
    restarts: () => number('restarts'),
    log: () => readFile(path.join(stateDir, 'supervisor.log'), 'utf8'),
    async stop() {
      const appPid = await number('next.pid');
      supervisor.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      // Whatever is left of what this test started is stopped by its PID.
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
      if (appPid > 0) {
        try {
          process.kill(appPid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let h: Harness;
let server: Server | null = null;
let supervised: Supervised | null = null;

beforeAll(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await supervised?.stop();
  supervised = null;
  await server?.stop();
  server = null;
});

afterAll(async () => {
  await h?.stop();
});

describe('X33: the app runs under a restarting supervisor', () => {
  it('killed while a game is live: the restarted app cashes the game out and settles it before the settle deadline', async () => {
    const IDLE_SEC = 30;
    const first = (server = await startServer(h, { idleTimeoutSec: IDLE_SEC }));
    const player = playerOf(h, 0);
    const game = await openGame(h, player);
    await walk(game, exitRoute(game.maze).slice(0, 1));
    await first.stop();
    server = null;

    const sup = (supervised = await supervise({
      config: serverConfig(h, first.dataDir, { idleTimeoutSec: IDLE_SEC }),
    }));
    await until('the supervised app to serve', async () => sup.ready() >= 1, 60_000);
    const firstPid = await sup.appPid();
    expect(alive(firstPid)).toBe(true);

    // The app dies while the game is live: nothing has ended or settled it yet.
    expect(await settlements(h, game.gameId)).toHaveLength(0);
    expect((await onchainGame(h, game.gameId)).status).toBe(1);
    process.kill(firstPid, 'SIGKILL');

    await until(
      'the supervisor to start the app again',
      async () => (await sup.restarts()) === 1 && sup.ready() >= 2,
      60_000,
    );
    const secondPid = await sup.appPid();
    expect(secondPid).not.toBe(firstPid);
    expect(alive(firstPid)).toBe(false);
    expect(alive(secondPid)).toBe(true);
    expect(await sup.log()).toMatch(
      new RegExp(`pid ${firstPid} exited with status 137 after \\d+s; starting it again in 1s`),
    );

    // The restarted app ends the game at its idle deadline and settles it: 73% of the bet for
    // one step, not the whole bet.
    const settled = await waitSettled(h, game.gameId, 120_000);
    expect(settled).toMatchObject({ outcome: 1, steps: 1, payoutWei: refundWei(h.table, BET, 0, 1) });
    expect(settled.from.toLowerCase()).toBe(h.relayer.toLowerCase());
    const onchain = await onchainGame(h, game.gameId);
    expect(onchain.status).toBe(2);
    expect(settled.timestamp).toBeLessThanOrEqual(Number(onchain.settleDeadline));
    const sinceRestart = sup.output().slice(sup.output().lastIndexOf('READY'));
    expect(sup.output().slice(0, sup.output().lastIndexOf('READY'))).not.toContain('"event":"ended"');
    expect(sinceRestart).toContain('"event":"ended"');
    expect(sinceRestart).toContain(game.gameId);

    // `reclaim` is refused, now and after the deadline has passed.
    expect(await reclaimRevert(h, game.gameId, player.address)).toBe('GameNotActive');
    await jump(h, h.table.timing.settleWindowSec + 1);
    expect(await reclaimRevert(h, game.gameId, player.address)).toBe('GameNotActive');
    expect(await settlements(h, game.gameId)).toHaveLength(1);

    await sup.stop();
    supervised = null;
    expect(alive(secondPid)).toBe(false);
    expect(await sup.restarts()).toBe(1);
  });

  it('an append fails: the app ends itself, and the restarted app signs the cash-out that could not be written', async () => {
    const IDLE_SEC = 8;
    const first = (server = await startServer(h, { idleTimeoutSec: IDLE_SEC }));
    const player = playerOf(h, 1);
    const game = await openGame(h, player);
    await first.stop();
    server = null;

    // The first write of an ending fails, as on a full disk: that is the automatic cash-out.
    const trigger = path.join(first.dataDir, 'fail-ended');
    await writeFile(trigger, '');
    const sup = (supervised = await supervise({
      config: serverConfig(h, first.dataDir, { idleTimeoutSec: IDLE_SEC }),
      failEndedOnceFile: trigger,
    }));

    await until('the app to end itself and be started again', async () => (await sup.restarts()) >= 1, 120_000);
    expect(existsSync(trigger)).toBe(false);
    expect(sup.output()).toContain('APPEND-FAILED');
    expect(sup.output()).toContain('"event":"store-failed"');
    expect(await sup.log()).toMatch(
      new RegExp(`exited with status ${STORE_FAILURE_EXIT_CODE} after \\d+s; starting it again in 1s`),
    );
    // The process that failed signed nothing that reached the chain.
    expect(sup.output().slice(0, sup.output().indexOf('APPEND-FAILED'))).not.toContain('"event":"settle-sent"');

    const settled = await waitSettled(h, game.gameId, 120_000);
    expect(settled).toMatchObject({ outcome: 1, steps: 0, payoutWei: refundWei(h.table, BET, 0, 0) });
    const onchain = await onchainGame(h, game.gameId);
    expect(settled.timestamp).toBeLessThanOrEqual(Number(onchain.settleDeadline));
    expect(await reclaimRevert(h, game.gameId, player.address)).toBe('GameNotActive');
    expect(await settlements(h, game.gameId)).toHaveLength(1);
    expect(await sup.restarts()).toBe(1);
  });
});
