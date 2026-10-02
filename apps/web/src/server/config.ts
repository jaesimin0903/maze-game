// Server configuration from environment variables, and the boot guards that depend only on
// configuration and the tuning table (plan §7.9, AC-S8).
//
// The test-hook flags (`MAZE_ALLOW_TEST_HOOKS`, `MAZE_TEST_SEED_SECRET`, `MAZE_TUNING_FIXTURE`)
// are read from the process environment only. No code here reads or writes a `.env*` file.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadTuning, parseTuning, type Hex, type TuningTable } from '@maze/shared';
import { isAddress, getAddress } from 'viem';
import { BootError } from './errors';

/** The only chain on which test hooks and the dev wallet may be enabled (Anvil). */
export const TEST_CHAIN_ID = 31337;

export interface ServerConfig {
  rpcUrl: string;
  chainId: number;
  contract: Hex;
  signerKey: Hex;
  relayerKey: Hex;
  /** Absolute path of the event-log directory. */
  dataDir: string;
  /** Overrides of the table's timeouts, in chain seconds. They may only shorten them. */
  idleTimeoutSec: number | null;
  maxGameSec: number | null;
  /** True only when `MAZE_ALLOW_TEST_HOOKS=1` and the chain id is 31337. */
  testHooks: boolean;
  /** Honoured only while `testHooks` is true. */
  testSeedSecret: string | null;
  /** Path of a table to use instead of the production table. Only while `testHooks` is true. */
  fixturePath: string | null;
  devWallet: boolean;
}

export type Env = Record<string, string | undefined>;

function set(env: Env, name: string): string | null {
  const value = env[name];
  return value === undefined || value === '' ? null : value;
}

function required(env: Env, name: string): string {
  const value = set(env, name);
  if (value === null) throw new BootError('CHAIN_UNAVAILABLE', `${name} is not set`);
  return value;
}

function positiveInt(env: Env, name: string): number | null {
  const value = set(env, name);
  if (value === null) return null;
  if (!/^[1-9]\d{0,8}$/.test(value)) {
    throw new BootError('CHAIN_UNAVAILABLE', `${name} must be a positive integer`);
  }
  return Number(value);
}

function privateKey(env: Env, name: string): Hex {
  const value = required(env, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new BootError('CHAIN_UNAVAILABLE', `${name} must be 32 bytes of 0x-prefixed hex`);
  }
  return value as Hex;
}

/**
 * Reads the configuration from `env`. Throws `BootError` when a value is missing or malformed
 * (`MAZE_DATA_DIR` included: it has no default and must be absolute), when test hooks are
 * requested on a chain other than 31337, or when a hook-only variable is set while test hooks
 * are off.
 *
 * Variables are looked up through the `env` argument, never written as `process.env.NAME`:
 * Next.js replaces `process.env.NEXT_PUBLIC_*` expressions at build time, and these values
 * must come from the running process.
 */
export function loadConfig(env: Env): ServerConfig {
  const rpcUrl = required(env, 'RPC_URL');
  if (!/^https?:\/\//.test(rpcUrl)) {
    throw new BootError('CHAIN_UNAVAILABLE', 'RPC_URL must be an http(s) URL');
  }
  const chainId = positiveInt(env, 'CHAIN_ID');
  if (chainId === null) throw new BootError('CHAIN_UNAVAILABLE', 'CHAIN_ID is not set');
  const address = required(env, 'MAZEBET_ADDRESS');
  if (!isAddress(address, { strict: false })) {
    throw new BootError('CHAIN_UNAVAILABLE', 'MAZEBET_ADDRESS is not an address');
  }

  const allow = set(env, 'MAZE_ALLOW_TEST_HOOKS');
  if (allow !== null && allow !== '1') {
    throw new BootError('NOT_CALIBRATED', 'MAZE_ALLOW_TEST_HOOKS must be 1 or unset');
  }
  if (allow === '1' && chainId !== TEST_CHAIN_ID) {
    throw new BootError(
      'NOT_CALIBRATED',
      `test hooks are allowed on chain ${TEST_CHAIN_ID} only, not on chain ${chainId}`,
    );
  }
  const testHooks = allow === '1';
  const testSeedSecret = set(env, 'MAZE_TEST_SEED_SECRET');
  const fixturePath = set(env, 'MAZE_TUNING_FIXTURE');
  if (!testHooks && (testSeedSecret !== null || fixturePath !== null)) {
    throw new BootError(
      'NOT_CALIBRATED',
      'MAZE_TEST_SEED_SECRET and MAZE_TUNING_FIXTURE require MAZE_ALLOW_TEST_HOOKS=1',
    );
  }

  // No default, and never relative: a path that depends on the directory the server was started
  // from would open a fresh, empty log while the games of the real one are still Active on chain.
  const dataDir = required(env, 'MAZE_DATA_DIR');
  if (!path.isAbsolute(dataDir)) {
    throw new BootError('CHAIN_UNAVAILABLE', `MAZE_DATA_DIR must be an absolute path, got "${dataDir}"`);
  }

  return {
    rpcUrl,
    chainId,
    contract: getAddress(address),
    signerKey: privateKey(env, 'SERVER_SIGNER_PRIVATE_KEY'),
    relayerKey: privateKey(env, 'RELAYER_PRIVATE_KEY'),
    dataDir,
    idleTimeoutSec: positiveInt(env, 'MAZE_IDLE_TIMEOUT_SEC'),
    maxGameSec: positiveInt(env, 'MAZE_MAX_GAME_SEC'),
    testHooks,
    testSeedSecret,
    fixturePath,
    devWallet: set(env, 'NEXT_PUBLIC_ENABLE_DEV_WALLET') === '1' && chainId === TEST_CHAIN_ID,
  };
}

/** The table the server runs with: the production table, or the one a test hook points at. */
export function loadTable(config: ServerConfig): TuningTable {
  if (config.fixturePath === null) return loadTuning();
  if (!config.testHooks) {
    throw new BootError('NOT_CALIBRATED', 'a test table needs test hooks to be on');
  }
  try {
    return parseTuning(JSON.parse(readFileSync(config.fixturePath, 'utf8')));
  } catch (error) {
    throw new BootError(
      'NOT_CALIBRATED',
      `cannot load the table at ${config.fixturePath}: ${(error as Error).message}`,
    );
  }
}

/**
 * A table may serve games only when it is calibrated. The single exception is a table marked
 * `fixture: true`, and only while test hooks are on (which implies chain 31337). A fixture
 * table is never accepted with test hooks off, whatever its `calibrated` flag says.
 */
export function assertTablePolicy(table: TuningTable, testHooks: boolean): void {
  if (table.fixture === true) {
    if (!testHooks) {
      throw new BootError('NOT_CALIBRATED', 'a fixture table can be used with test hooks only');
    }
    return;
  }
  if (!table.calibration.calibrated) {
    throw new BootError('NOT_CALIBRATED', 'the tuning table is not calibrated');
  }
}

/**
 * The idle and game timeouts in force. An override may shorten the table's value, never
 * lengthen it: the forced settlement of a game must stay ahead of the contract's settle
 * deadline, after which the player could reclaim the whole bet.
 */
export function effectiveTiming(
  table: TuningTable,
  config: Pick<ServerConfig, 'idleTimeoutSec' | 'maxGameSec'>,
): { idleTimeoutSec: number; maxGameSec: number } {
  const { timing } = table;
  const idleTimeoutSec = config.idleTimeoutSec ?? timing.idleTimeoutSec;
  const maxGameSec = config.maxGameSec ?? timing.maxGameSec;
  if (idleTimeoutSec > timing.idleTimeoutSec) {
    throw new BootError(
      'CHAIN_UNAVAILABLE',
      `MAZE_IDLE_TIMEOUT_SEC may not exceed the table's ${timing.idleTimeoutSec}`,
    );
  }
  if (maxGameSec > timing.maxGameSec) {
    throw new BootError(
      'CHAIN_UNAVAILABLE',
      `MAZE_MAX_GAME_SEC may not exceed the table's ${timing.maxGameSec}`,
    );
  }
  return { idleTimeoutSec, maxGameSec };
}
