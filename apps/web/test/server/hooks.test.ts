// Test hooks are reachable only when the server was booted with them on (AC-A4, AC-A5, AC-S8).

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { parseTuning, type ConfigResponse, type Hex, type TuningTable, type UiSnapshot } from '@maze/shared';
import fixtureJson from '@maze/shared/fixtures/tuning.fixture.json';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config';
import { testServerSeed } from '../../src/server/test-hooks';
import { api, CONTRACT, FakeChain, makeEnv, PLAYERS, requestTicket, SIGNER_KEY, type TestEnv } from './helpers';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** A calibrated table that is not a fixture: what a production boot runs with. */
function productionLikeTable(): TuningTable {
  const { fixture: _fixture, ...rest } = fixtureJson;
  return parseTuning({ ...rest, calibration: { ...rest.calibration, calibrated: true } });
}

const SNAPSHOT = {
  url: 'http://localhost:3000/',
  chainNowSec: 1_700_000_005,
  items: {
    'refundable-amount': { text: '0.0095 ETH', attrs: { 'data-testid': 'refundable-amount' } },
    'cell-0-0': { text: '', attrs: { 'data-state': 'current', 'data-open': '2' } },
  },
};

let env: TestEnv | null = null;

afterEach(async () => {
  await env?.close();
  env = null;
});

describe('AC-A5: with test hooks off', () => {
  async function bootWithoutHooks(): Promise<TestEnv> {
    const table = productionLikeTable();
    return makeEnv({
      table,
      chain: new FakeChain(table),
      // A secret left in the configuration must not matter while hooks are off.
      config: { testHooks: false, testSeedSecret: 'scenario-secret' },
    });
  }

  it('/api/test/ui-snapshot answers 404 to both methods and stores nothing', async () => {
    env = await bootWithoutHooks();
    const post = await api.snapshotPost(SNAPSHOT);
    expect(post.status).toBe(404);
    expect(post.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
    const get = await api.snapshotGet();
    expect(get.status).toBe(404);
    expect(env.container.snapshots.get()).toBeNull();
  });

  it('the seed hook is not applied and /api/config says testHooks: false', async () => {
    const booted = (env = await bootWithoutHooks());
    const { ticket } = await requestTicket();
    const seed = booted.container.service.get(ticket.gameId)!.serverSeed;
    expect(seed).not.toBe(testServerSeed('scenario-secret', ticket.gameId));
    expect((await api.config<ConfigResponse>()).body).toMatchObject({
      testHooks: false,
      fixture: false,
      calibrated: true,
    });
  });
});

describe('with test hooks on', () => {
  it('the snapshot route stores the latest snapshot and numbers it', async () => {
    env = await makeEnv();
    expect((await api.snapshotGet()).status).toBe(404);

    const first = await api.snapshotPost(SNAPSHOT);
    expect(first.status).toBe(204);
    expect(first.text).toBe('');
    expect((await api.snapshotGet<UiSnapshot>()).body).toEqual({ seq: 1, ...SNAPSHOT });

    await api.snapshotPost({ ...SNAPSHOT, chainNowSec: SNAPSHOT.chainNowSec + 1, items: {} });
    const latest = await api.snapshotGet<UiSnapshot>();
    expect(latest.body.seq).toBe(2);
    expect(latest.body.items).toEqual({});
  });

  it('accepts a full-board snapshot and refuses malformed ones', async () => {
    env = await makeEnv();
    const items: UiSnapshot['items'] = {};
    for (let i = 0; i < 400; i++) {
      items[`cell-${i % 10}-${Math.floor(i / 10)}`] = {
        text: '',
        attrs: { 'data-state': 'fog', 'data-open': '', 'data-start': 'false', 'data-exit': 'false' },
      };
    }
    expect((await api.snapshotPost({ ...SNAPSHOT, items })).status).toBe(204);

    for (const body of [
      { url: 1, chainNowSec: 1, items: {} },
      { url: 'x', chainNowSec: '1', items: {} },
      { url: 'x', chainNowSec: 1, items: [] },
      { url: 'x', chainNowSec: 1, items: { a: { text: 1, attrs: {} } } },
      { url: 'x', chainNowSec: 1, items: { a: { text: '', attrs: { b: 2 } } } },
    ]) {
      expect((await api.snapshotPost(body)).status).toBe(400);
    }
    expect((await api.snapshotGet<UiSnapshot>()).body.seq).toBe(1);

    // An item may be called anything; it is stored as plain data.
    const odd = { ['__proto__']: { text: 'x', attrs: { ['constructor']: 'y' } } };
    expect((await api.snapshotPost({ ...SNAPSHOT, items: odd })).status).toBe(204);
    const stored = (await api.snapshotGet<UiSnapshot>()).body;
    expect(Object.keys(stored.items)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(stored.items, '__proto__')?.value).toEqual({
      text: 'x',
      attrs: { constructor: 'y' },
    });
  });

  it('the seed hook derives the server seed from the game id', async () => {
    const booted = (env = await makeEnv({ config: { testSeedSecret: 'scenario-secret' } }));
    // Distinct addresses: one address may hold only one live ticket at a time (plan §7.3).
    const a = await requestTicket({ player: PLAYERS[0] });
    const b = await requestTicket({ player: PLAYERS[1] });
    for (const { ticket } of [a, b]) {
      const seed = booted.container.service.get(ticket.gameId)!.serverSeed;
      expect(seed).toBe(testServerSeed('scenario-secret', ticket.gameId));
    }
    // Game ids stay random, so seeds are still never reused.
    expect(a.ticket.gameId).not.toBe(b.ticket.gameId);
    expect(a.ticket.commitment).not.toBe(b.ticket.commitment);
  });

  it('without a secret the seeds are random even with hooks on', async () => {
    const booted = (env = await makeEnv());
    const { ticket } = await requestTicket();
    const seed = booted.container.service.get(ticket.gameId)!.serverSeed;
    expect(seed).not.toBe(testServerSeed('', ticket.gameId));
  });
});

describe('testServerSeed byte layout', () => {
  it('is sha256("maze-test-seed" ‖ utf8(secret) ‖ gameId bytes)', () => {
    const cases: [string, Hex][] = [
      ['scenario-secret', `0x${'01'.repeat(32)}`],
      ['비밀 ✓', `0x${'ab'.repeat(32)}`],
      ['', `0x${'00'.repeat(32)}`],
    ];
    for (const [secret, gameId] of cases) {
      const expected = sha256(
        concatBytes(utf8ToBytes('maze-test-seed'), utf8ToBytes(secret), hexToBytes(gameId.slice(2))),
      );
      expect(testServerSeed(secret, gameId)).toBe(`0x${bytesToHex(expected)}`);
    }
    // Fixed vectors, so that another implementation can check itself against this one.
    expect(testServerSeed('scenario-secret', `0x${'01'.repeat(32)}`)).toBe(
      '0x1cba827c588e96163cc5b45a9722233f048019fd9a458dd293d96197aa8edaf9',
    );
    expect(testServerSeed('비밀 ✓', `0x${'ab'.repeat(32)}`)).toBe(
      '0x07f1abef261c4610f9145a71882857d5af517860df49124639d30a118d46ebdd',
    );
    // Upper-case hex of the same id is the same bytes.
    expect(testServerSeed('scenario-secret', `0x${'AB'.repeat(32)}`)).toBe(
      testServerSeed('scenario-secret', `0x${'ab'.repeat(32)}`),
    );
    expect(() => testServerSeed('s', '0x1234')).toThrow(TypeError);
  });
});

describe('AC-A4: dev wallet', () => {
  const base = {
    RPC_URL: 'http://127.0.0.1:8545',
    MAZEBET_ADDRESS: CONTRACT,
    SERVER_SIGNER_PRIVATE_KEY: SIGNER_KEY,
    RELAYER_PRIVATE_KEY: SIGNER_KEY,
  };

  it('is offered only on chain 31337 with NEXT_PUBLIC_ENABLE_DEV_WALLET=1', () => {
    const on = { ...base, NEXT_PUBLIC_ENABLE_DEV_WALLET: '1' };
    expect(loadConfig({ ...on, CHAIN_ID: '31337' }).devWallet).toBe(true);
    expect(loadConfig({ ...on, CHAIN_ID: '1' }).devWallet).toBe(false);
    expect(loadConfig({ ...base, CHAIN_ID: '31337' }).devWallet).toBe(false);
    expect(loadConfig({ ...on, NEXT_PUBLIC_ENABLE_DEV_WALLET: 'true', CHAIN_ID: '31337' }).devWallet).toBe(false);
  });

  it('reaches the browser through /api/config only', async () => {
    env = await makeEnv({ config: { devWallet: true } });
    expect((await api.config<ConfigResponse>()).body.devWallet).toBe(true);
  });
});

describe('AC-S8: hook flags stay out of files', () => {
  const FLAG = /^\s*(export\s+)?(MAZE_ALLOW_TEST_HOOKS|MAZE_TEST_SEED_SECRET|MAZE_TUNING_FIXTURE)\s*=/m;

  it('no .env* file assigns a hook flag', () => {
    for (const dir of [ROOT, path.join(ROOT, 'apps/web')]) {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith('.env')) continue;
        expect(readFileSync(path.join(dir, name), 'utf8'), `${dir}/${name}`).not.toMatch(FLAG);
      }
    }
  });

  it('the server and the deploy script never open a .env file', () => {
    const serverDir = path.join(ROOT, 'apps/web/src/server');
    const sources = [
      ...readdirSync(serverDir).map((name) => path.join(serverDir, name)),
      path.join(ROOT, 'apps/web/instrumentation.ts'),
      path.join(ROOT, 'scripts/deploy-local.ts'),
    ];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/dotenv/);
      // A string literal that names a .env file, with or without a directory in front.
      expect(text, file).not.toMatch(/['"`](?:[^'"`\n]*\/)?\.env[.\w-]*['"`]/);
    }
  });
});
