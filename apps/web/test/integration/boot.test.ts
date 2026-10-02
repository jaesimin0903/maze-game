// AC-S8 on a real chain: the server boots from environment variables the way the instrumentation
// hook boots it, and refuses to when the table is not the calibrated table of the deployed
// contract. A refused boot turns the game routes into 503.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTuning, type ConfigResponse, type GameView, type TuningTable } from '@maze/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ANVIL_SIGNER_KEY } from '../../../../scripts/deploy-local';
import type { Env } from '../../src/server/config';
import { bootFromEnv, uninstallContainer } from '../../src/server/container';
import { testServerSeed } from '../../src/server/test-hooks';
import { api } from '../server/helpers';
import {
  BET,
  createOnChain,
  playerOf,
  requestTicket,
  startHarness,
  waitSettled,
  type Harness,
} from './setup';

const FIXTURE = fileURLToPath(
  new URL('../../../../packages/shared/test/fixtures/tuning.fixture.json', import.meta.url),
);

let h: Harness;
let logged: { event: string; detail?: { code?: string } }[] = [];

beforeAll(async () => {
  h = await startHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await uninstallContainer();
});

afterAll(async () => {
  await h?.stop();
});

async function baseEnv(): Promise<Env> {
  return {
    RPC_URL: h.rpcUrl,
    CHAIN_ID: '31337',
    MAZEBET_ADDRESS: h.contract,
    SERVER_SIGNER_PRIVATE_KEY: ANVIL_SIGNER_KEY,
    RELAYER_PRIVATE_KEY: ANVIL_SIGNER_KEY,
    MAZE_DATA_DIR: await mkdtemp(path.join(os.tmpdir(), 'maze-boot-')),
  };
}

/** Captures the server's stdout log lines for the duration of a test. */
function captureLogs(): void {
  logged = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.startsWith('{')) logged.push(JSON.parse(line) as (typeof logged)[number]);
    }
    return true;
  });
}

async function expectRefused(env: Env, code: string): Promise<void> {
  captureLogs();
  const result = await bootFromEnv(env);
  expect(result).toMatchObject({ ok: false, code });
  expect(logged.filter((line) => line.event === 'boot-failed')).toHaveLength(1);
  expect(logged[0].detail?.code).toBe(code);
  for (const reply of [await api.config(), await api.ticket({}), await api.reveal(`0x${'aa'.repeat(32)}`)]) {
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: { code, message: expect.any(String) } });
  }
}

describe('AC-S8: booting from the environment', () => {
  it('boots with the fixture table when test hooks are on, and plays a game', async () => {
    captureLogs();
    const result = await bootFromEnv({
      ...(await baseEnv()),
      MAZE_ALLOW_TEST_HOOKS: '1',
      MAZE_TUNING_FIXTURE: FIXTURE,
      MAZE_TEST_SEED_SECRET: 'boot-secret',
      MAZE_IDLE_TIMEOUT_SEC: '6',
      NEXT_PUBLIC_ENABLE_DEV_WALLET: '1',
    });
    expect(result.ok).toBe(true);
    expect(logged.some((line) => line.event === 'boot')).toBe(true);

    const config = (await api.config<ConfigResponse>()).body;
    expect(config).toMatchObject({
      chainId: 31337,
      rpcUrl: h.rpcUrl,
      fixture: true,
      calibrated: false,
      testHooks: true,
      devWallet: true,
      idleTimeoutSec: 6,
      maxGameSec: 900,
    });
    expect(config.contract.toLowerCase()).toBe(h.contract.toLowerCase());

    const player = playerOf(h, 0);
    const { ticket, token } = await requestTicket(player.address);
    await createOnChain(h, player, ticket, BET, `0x${'71'.repeat(32)}`);
    expect((await api.start(ticket.gameId, token)).status).toBe(200);
    const ended = await api.cashout<GameView>(ticket.gameId, token, { step: 0 });
    // The seed hook is in force for a server booted this way.
    expect(ended.body.terminal!.serverSeed).toBe(testServerSeed('boot-secret', ticket.gameId));
    expect((await waitSettled(h, ticket.gameId)).payoutWei).toBe((BET * 9500n) / 10_000n);
  });

  it('refuses the production table: not calibrated, or not the table of this contract', async () => {
    // Today the production table is uncalibrated. Once it is calibrated it still is not the
    // table this contract was deployed with, so the boot is refused either way.
    const code = loadTuning().calibration.calibrated ? 'TABLE_MISMATCH' : 'NOT_CALIBRATED';
    await expectRefused(await baseEnv(), code);
  });

  it('refuses the fixture table without test hooks, and hook variables without the hook flag', async () => {
    await expectRefused({ ...(await baseEnv()), MAZE_TUNING_FIXTURE: FIXTURE }, 'NOT_CALIBRATED');
    await uninstallContainer();
    vi.restoreAllMocks();
    await expectRefused({ ...(await baseEnv()), MAZE_TEST_SEED_SECRET: 'x' }, 'NOT_CALIBRATED');
  });

  it('refuses a table whose hash differs from the contract: TABLE_MISMATCH', async () => {
    const table = JSON.parse(await readFile(FIXTURE, 'utf8')) as TuningTable;
    table.tiers[1].multiplierBps += 1;
    const env = await baseEnv();
    const altered = path.join(env.MAZE_DATA_DIR!, 'altered-table.json');
    await writeFile(altered, JSON.stringify(table));
    await expectRefused(
      { ...env, MAZE_ALLOW_TEST_HOOKS: '1', MAZE_TUNING_FIXTURE: altered },
      'TABLE_MISMATCH',
    );
  });

  it('refuses when the chain cannot be reached, and test hooks on any other chain id', async () => {
    await expectRefused(
      { ...(await baseEnv()), MAZE_ALLOW_TEST_HOOKS: '1', MAZE_TUNING_FIXTURE: FIXTURE, RPC_URL: 'http://127.0.0.1:1' },
      'CHAIN_UNAVAILABLE',
    );
    await uninstallContainer();
    vi.restoreAllMocks();
    await expectRefused(
      { ...(await baseEnv()), MAZE_ALLOW_TEST_HOOKS: '1', MAZE_TUNING_FIXTURE: FIXTURE, CHAIN_ID: '1' },
      'NOT_CALIBRATED',
    );
  });
});
