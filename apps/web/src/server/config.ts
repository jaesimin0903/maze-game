// Server configuration from environment variables, and the boot guards that depend only on
// configuration and the tuning table (plan §7.9, AC-S8).
//
// The test-hook flags (`MAZE_ALLOW_TEST_HOOKS`, `MAZE_TEST_SEED_SECRET`, `MAZE_TUNING_FIXTURE`)
// are read from the process environment only. No code here reads or writes a `.env*` file.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadTuning, parseTuning, type Hex, type NetworkInfo, type TuningTable } from '@maze/shared';
import { isAddress, getAddress } from 'viem';
import type { ScanTag } from './chain';
import { BootError } from './errors';

/** The only chain on which test hooks and the dev wallet may be enabled (Anvil). */
export const TEST_CHAIN_ID = 31337;

export interface ServerConfig {
  rpcUrl: string;
  /** The RPC the browser is told to use. `rpcUrl` unless `PUBLIC_RPC_URL` is set, for when `rpcUrl` carries a key. */
  publicRpcUrl: string;
  chainId: number;
  contract: Hex;
  signerKey: Hex;
  relayerKey: Hex;
  /** Absolute path of the event-log directory. */
  dataDir: string;
  /** Overrides of the table's timeouts, in chain seconds. They may only shorten them. */
  idleTimeoutSec: number | null;
  maxGameSec: number | null;
  /**
   * The block tag the chain scan reads at (`MAZE_SCAN_TAG`): `latest` on chain 31337 and
   * `finalized` on any other unless set.
   */
  scanTag: ScanTag;
  /**
   * The block the chain scan starts from while the event log holds no scan marker
   * (`MAZE_START_BLOCK`). `null`: the head at the scan tag, which is right for a log that holds
   * no ticket yet.
   */
  startBlock: number | null;
  /**
   * Blocks per `eth_getLogs` request (`MAZE_LOG_CHUNK_BLOCKS`): 2000 on chain 31337 and 100 on
   * any other unless set (Monad's public RPC refuses longer ranges).
   */
  logChunkBlocks: number;
  /** True only when `MAZE_ALLOW_TEST_HOOKS=1` and the chain id is 31337. */
  testHooks: boolean;
  /** Honoured only while `testHooks` is true. */
  testSeedSecret: string | null;
  /** Path of a table to use instead of the production table. Only while `testHooks` is true. */
  fixturePath: string | null;
  devWallet: boolean;
  /** How the browser names the chain (`CHAIN_NAME`, `NATIVE_SYMBOL`, `EXPLORER_URL`, `FAUCET_URL`). */
  network: NetworkInfo;
  /** `PRIVY_APP_ID`, or `null`: the browser offers no Privy login. */
  privyAppId: string | null;
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

function nonNegativeInt(env: Env, name: string): number | null {
  const value = set(env, name);
  if (value === null) return null;
  if (!/^(0|[1-9]\d{0,14})$/.test(value)) {
    throw new BootError('CHAIN_UNAVAILABLE', `${name} must be a non-negative integer`);
  }
  return Number(value);
}

/** True when `url` has user info, a path other than `/`, a query or a fragment. */
function mayHoldKey(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.username !== '' ||
      parsed.password !== '' ||
      (parsed.pathname !== '/' && parsed.pathname !== '') ||
      parsed.search !== '' ||
      parsed.hash !== ''
    );
  } catch {
    return true;
  }
}

function httpUrl(env: Env, name: string): string | null {
  const value = set(env, name);
  if (value !== null && !/^https?:\/\//.test(value)) {
    throw new BootError('CHAIN_UNAVAILABLE', `${name} must be an http(s) URL`);
  }
  return value === null ? null : value.replace(/\/+$/, '');
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
 * requested on a chain other than 31337, when a hook-only variable is set while test hooks are
 * off, or when, off chain 31337, the browser would be given an RPC URL that may hold a key.
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
  const symbol = set(env, 'NATIVE_SYMBOL') ?? 'ETH';
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(symbol)) {
    throw new BootError('CHAIN_UNAVAILABLE', 'NATIVE_SYMBOL must be 2 to 10 capital letters or digits');
  }
  const privyAppId = set(env, 'PRIVY_APP_ID');
  if (privyAppId !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(privyAppId)) {
    throw new BootError('CHAIN_UNAVAILABLE', 'PRIVY_APP_ID is malformed');
  }
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

  const scanTag = set(env, 'MAZE_SCAN_TAG') ?? (chainId === TEST_CHAIN_ID ? 'latest' : 'finalized');
  if (scanTag !== 'latest' && scanTag !== 'safe' && scanTag !== 'finalized') {
    throw new BootError('CHAIN_UNAVAILABLE', 'MAZE_SCAN_TAG must be latest, safe or finalized');
  }

  // The browser is told PUBLIC_RPC_URL, or RPC_URL when that is unset. An RPC URL with a path, a
  // query or user info usually carries an API key, which must not reach every visitor.
  const publicRpcUrl = httpUrl(env, 'PUBLIC_RPC_URL');
  if (publicRpcUrl === null && chainId !== TEST_CHAIN_ID && mayHoldKey(rpcUrl)) {
    throw new BootError(
      'CHAIN_UNAVAILABLE',
      'RPC_URL has a path, a query or user info, which may hold an API key, and PUBLIC_RPC_URL is ' +
        'not set: the browser would be given RPC_URL. Set PUBLIC_RPC_URL to an RPC without a key',
    );
  }

  return {
    rpcUrl,
    publicRpcUrl: publicRpcUrl ?? rpcUrl,
    chainId,
    contract: getAddress(address),
    signerKey: privateKey(env, 'SERVER_SIGNER_PRIVATE_KEY'),
    relayerKey: privateKey(env, 'RELAYER_PRIVATE_KEY'),
    dataDir,
    idleTimeoutSec: positiveInt(env, 'MAZE_IDLE_TIMEOUT_SEC'),
    maxGameSec: positiveInt(env, 'MAZE_MAX_GAME_SEC'),
    scanTag,
    startBlock: nonNegativeInt(env, 'MAZE_START_BLOCK'),
    logChunkBlocks: positiveInt(env, 'MAZE_LOG_CHUNK_BLOCKS') ?? (chainId === TEST_CHAIN_ID ? 2000 : 100),
    testHooks,
    testSeedSecret,
    fixturePath,
    devWallet: set(env, 'NEXT_PUBLIC_ENABLE_DEV_WALLET') === '1' && chainId === TEST_CHAIN_ID,
    network: {
      name: set(env, 'CHAIN_NAME') ?? (chainId === TEST_CHAIN_ID ? 'Anvil' : `Chain ${chainId}`),
      symbol,
      explorerUrl: httpUrl(env, 'EXPLORER_URL'),
      faucetUrl: httpUrl(env, 'FAUCET_URL'),
    },
    privyAppId,
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
