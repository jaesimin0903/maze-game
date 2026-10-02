// AC-S8: the server does not serve games with an uncalibrated or mismatched table, a fixture
// table is accepted with test hooks only, and a refused boot turns every game route into 503.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTuning, type TuningTable } from '@maze/shared';
import fixtureJson from '@maze/shared/fixtures/tuning.fixture.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as healthGet } from '../../app/api/health/route';
import {
  assertTablePolicy,
  effectiveTiming,
  loadConfig,
  loadTable,
  type Env,
} from '../../src/server/config';
import { bootFromEnv, uninstallContainer } from '../../src/server/container';
import { BootError } from '../../src/server/errors';
import { api, CONTRACT, FakeChain, fixtureTable, makeEnv, SIGNER_KEY, type EnvOptions } from './helpers';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FIXTURE_PATH = path.join(ROOT, 'packages/shared/test/fixtures/tuning.fixture.json');

function table(p: { fixture: boolean; calibrated: boolean }): TuningTable {
  const { fixture: _fixture, ...rest } = fixtureJson;
  return parseTuning({
    ...rest,
    ...(p.fixture ? { fixture: true } : {}),
    calibration: { ...rest.calibration, calibrated: p.calibrated },
  });
}

/** Boots a container that is not installed, and reports the refusal code if it is refused. */
async function bootCode(options: EnvOptions): Promise<string> {
  try {
    const env = await makeEnv({ ...options, install: false });
    await env.close();
    return 'ok';
  } catch (error) {
    if (error instanceof BootError) return error.code;
    throw error;
  }
}

const ENV: Env = {
  RPC_URL: 'http://127.0.0.1:8546',
  CHAIN_ID: '31337',
  MAZEBET_ADDRESS: CONTRACT,
  SERVER_SIGNER_PRIVATE_KEY: SIGNER_KEY,
  RELAYER_PRIVATE_KEY: SIGNER_KEY,
};

afterEach(async () => {
  vi.restoreAllMocks();
  await uninstallContainer();
});

describe('AC-S8: table policy', () => {
  it('an uncalibrated table is refused, with test hooks on or off', async () => {
    const uncalibrated = table({ fixture: false, calibrated: false });
    for (const testHooks of [false, true]) {
      expect(
        await bootCode({ table: uncalibrated, chain: new FakeChain(uncalibrated), config: { testHooks } }),
      ).toBe('NOT_CALIBRATED');
    }
  });

  it('a calibrated table boots without test hooks', async () => {
    const calibrated = table({ fixture: false, calibrated: true });
    expect(
      await bootCode({ table: calibrated, chain: new FakeChain(calibrated), config: { testHooks: false } }),
    ).toBe('ok');
  });

  it('a fixture table boots with test hooks only, whatever its calibrated flag says', async () => {
    for (const calibrated of [false, true]) {
      const fixture = table({ fixture: true, calibrated });
      const chain = (): FakeChain => new FakeChain(fixture);
      expect(await bootCode({ table: fixture, chain: chain(), config: { testHooks: true } })).toBe('ok');
      expect(await bootCode({ table: fixture, chain: chain(), config: { testHooks: false } })).toBe(
        'NOT_CALIBRATED',
      );
    }
    expect(() => assertTablePolicy(fixtureTable, false)).toThrow(BootError);
    expect(() => assertTablePolicy(fixtureTable, true)).not.toThrow();
  });

  it('test hooks are refused on a chain other than 31337', async () => {
    const chain = new FakeChain(fixtureTable);
    chain.chainIdValue = 1;
    expect(await bootCode({ chain, config: { testHooks: true, chainId: 1 } })).toBe('NOT_CALIBRATED');
  });
});

describe('AC-S8: contract checks', () => {
  it('a different tableHash on the contract is TABLE_MISMATCH', async () => {
    const chain = new FakeChain(fixtureTable);
    chain.tableHashValue = `0x${'12'.repeat(32)}`;
    expect(await bootCode({ chain })).toBe('TABLE_MISMATCH');

    // A table that differs in one refund entry has a different hash.
    const raw = structuredClone(fixtureJson);
    raw.tiers[0].multiplierBps += 1;
    const other = parseTuning(raw);
    expect(await bootCode({ table: other, chain: new FakeChain(fixtureTable) })).toBe('TABLE_MISMATCH');
  });

  it('a wrong chain, a foreign signer and an unreachable node are CHAIN_UNAVAILABLE', async () => {
    const wrongChain = new FakeChain(fixtureTable);
    wrongChain.chainIdValue = 5;
    expect(await bootCode({ chain: wrongChain })).toBe('CHAIN_UNAVAILABLE');

    const foreignSigner = new FakeChain(fixtureTable);
    foreignSigner.signerValue = '0x000000000000000000000000000000000000dEaD';
    expect(await bootCode({ chain: foreignSigner })).toBe('CHAIN_UNAVAILABLE');

    const offline = new FakeChain(fixtureTable);
    offline.offline = true;
    expect(await bootCode({ chain: offline })).toBe('CHAIN_UNAVAILABLE');
  });

  it('timeout overrides may shorten the table values but never lengthen them', async () => {
    expect(effectiveTiming(fixtureTable, { idleTimeoutSec: 6, maxGameSec: 30 })).toEqual({
      idleTimeoutSec: 6,
      maxGameSec: 30,
    });
    expect(effectiveTiming(fixtureTable, { idleTimeoutSec: null, maxGameSec: null })).toEqual({
      idleTimeoutSec: 120,
      maxGameSec: 900,
    });
    expect(await bootCode({ config: { idleTimeoutSec: 121 } })).toBe('CHAIN_UNAVAILABLE');
    expect(await bootCode({ config: { maxGameSec: 1800 } })).toBe('CHAIN_UNAVAILABLE');
    expect(await bootCode({ config: { idleTimeoutSec: 6, maxGameSec: 60 } })).toBe('ok');
  });
});

describe('AC-S8: environment', () => {
  it('reads a complete environment', () => {
    expect(loadConfig({ ...ENV, MAZE_DATA_DIR: '/tmp/x', MAZE_IDLE_TIMEOUT_SEC: '6' })).toEqual({
      rpcUrl: 'http://127.0.0.1:8546',
      chainId: 31337,
      contract: CONTRACT,
      signerKey: SIGNER_KEY,
      relayerKey: SIGNER_KEY,
      dataDir: '/tmp/x',
      idleTimeoutSec: 6,
      maxGameSec: null,
      testHooks: false,
      testSeedSecret: null,
      fixturePath: null,
      devWallet: false,
    });
  });

  it('test hooks need MAZE_ALLOW_TEST_HOOKS=1 and chain 31337', () => {
    expect(loadConfig({ ...ENV, MAZE_ALLOW_TEST_HOOKS: '1' }).testHooks).toBe(true);
    expect(() => loadConfig({ ...ENV, MAZE_ALLOW_TEST_HOOKS: '1', CHAIN_ID: '1' })).toThrow(BootError);
    expect(() => loadConfig({ ...ENV, MAZE_ALLOW_TEST_HOOKS: 'yes' })).toThrow(BootError);
    // The hook-only variables are refused, not ignored, when hooks are off.
    expect(() => loadConfig({ ...ENV, MAZE_TEST_SEED_SECRET: 's' })).toThrow(BootError);
    expect(() => loadConfig({ ...ENV, MAZE_TUNING_FIXTURE: FIXTURE_PATH })).toThrow(BootError);
    const hooked = loadConfig({
      ...ENV,
      MAZE_ALLOW_TEST_HOOKS: '1',
      MAZE_TEST_SEED_SECRET: 's',
      MAZE_TUNING_FIXTURE: FIXTURE_PATH,
    });
    expect(hooked).toMatchObject({ testHooks: true, testSeedSecret: 's', fixturePath: FIXTURE_PATH });
    expect(loadTable(hooked)).toEqual(fixtureTable);
    expect(() => loadTable({ ...hooked, testHooks: false })).toThrow(BootError);
    expect(() => loadTable({ ...hooked, fixturePath: '/nonexistent/table.json' })).toThrow(BootError);
  });

  it('missing or malformed settings are refused', () => {
    for (const name of Object.keys(ENV)) {
      expect(() => loadConfig({ ...ENV, [name]: undefined }), name).toThrow(BootError);
    }
    expect(() => loadConfig({ ...ENV, RPC_URL: 'ftp://x' })).toThrow(BootError);
    expect(() => loadConfig({ ...ENV, CHAIN_ID: 'abc' })).toThrow(BootError);
    expect(() => loadConfig({ ...ENV, MAZEBET_ADDRESS: '0x12' })).toThrow(BootError);
    expect(() => loadConfig({ ...ENV, RELAYER_PRIVATE_KEY: '0x12' })).toThrow(BootError);
    expect(() => loadConfig({ ...ENV, MAZE_MAX_GAME_SEC: '0' })).toThrow(BootError);
  });
});

describe('AC-S8: a refused boot', () => {
  async function refusedBoot(env: Env, code: string): Promise<void> {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const result = await bootFromEnv(env);
    expect(result).toMatchObject({ ok: false, code });
    // The reason is logged as one JSON line.
    const logged = lines.map((line) => JSON.parse(line) as { event: string; detail: { code: string } });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 'error', event: 'boot-failed', detail: { code } });

    const id = `0x${'aa'.repeat(32)}`;
    const replies = [
      await api.config(),
      await api.ticket({}),
      await api.start(id, 't'),
      await api.move(id, 't', { step: 0, dir: 1 }),
      await api.cashout(id, 't', { step: 0 }),
      await api.game(id, 't'),
      await api.reveal(id),
      await api.snapshotGet(),
      await api.snapshotPost({}),
    ];
    for (const reply of replies) {
      expect(reply.status).toBe(503);
      expect(reply.body).toEqual({ error: { code, message: expect.any(String) } });
    }
    // Health is not a game route.
    expect(healthGet().status).toBe(200);
  }

  it('turns every game route into 503 NOT_CALIBRATED', async () => {
    await refusedBoot({ ...ENV, MAZE_TEST_SEED_SECRET: 'leftover' }, 'NOT_CALIBRATED');
  });

  it('turns every game route into 503 CHAIN_UNAVAILABLE', async () => {
    await refusedBoot({ ...ENV, RPC_URL: undefined }, 'CHAIN_UNAVAILABLE');
  });
});

describe('AC-S8: the instrumentation hook', () => {
  const saved = { runtime: process.env.NEXT_RUNTIME, phase: process.env.NEXT_PHASE };

  afterEach(() => {
    for (const [name, value] of [
      ['NEXT_RUNTIME', saved.runtime],
      ['NEXT_PHASE', saved.phase],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** Runs `register()` with `process.exit` and stdout intercepted. */
  async function register(): Promise<{ exits: (number | undefined)[]; lines: string[] }> {
    const exits: (number | undefined)[] = [];
    const lines: string[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code);
    }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const { register: run } = await import('../../instrumentation');
    await run();
    return { exits, lines };
  }

  it('does nothing outside the Node.js server runtime and during next build', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    expect(await register()).toEqual({ exits: [], lines: [] });
    vi.restoreAllMocks();
    process.env.NEXT_RUNTIME = 'nodejs';
    process.env.NEXT_PHASE = 'phase-production-build';
    expect(await register()).toEqual({ exits: [], lines: [] });
  });

  it('exits with a non-zero code, after logging why, when the boot is refused', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    delete process.env.NEXT_PHASE;
    // This test process has no server environment (no RPC_URL), so the boot is refused.
    expect(process.env.RPC_URL ?? '').toBe('');
    const { exits, lines } = await register();
    expect(exits).toEqual([1]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'error', event: 'boot-failed' });
  });
});

describe('AC-S8: pnpm start:web', () => {
  it('refuses to start while any hook flag is set', () => {
    for (const flag of ['MAZE_ALLOW_TEST_HOOKS', 'MAZE_TEST_SEED_SECRET', 'MAZE_TUNING_FIXTURE']) {
      const clean = { ...process.env };
      delete clean.MAZE_ALLOW_TEST_HOOKS;
      delete clean.MAZE_TEST_SEED_SECRET;
      delete clean.MAZE_TUNING_FIXTURE;
      const run = spawnSync('pnpm', ['run', '--silent', 'start:web'], {
        cwd: ROOT,
        env: { ...clean, [flag]: '1' },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(run.status, flag).toBe(1);
      expect(run.stderr, flag).toContain('refusing to start');
    }
  });
});
