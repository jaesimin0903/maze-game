// The single server container (plan §10, "module instance separation").
//
// Next.js may load `instrumentation.ts` and each route handler as separate bundles, each with
// its own copy of this module. All server state therefore hangs off ONE object stored on
// `globalThis` under a registered symbol: whichever copy boots first creates it and every other
// copy finds it there. No module in `src/server` keeps mutable state at module level.

import {
  mazeBetDomain,
  tableHash as hashOfTable,
  type Hex,
  type Maze,
  type TuningTable,
} from '@maze/shared';
import { createViemChain, Watcher, type ChainPort, type ScanMarker } from './chain';
import { createChainClock, type Clock } from './clock';
import {
  assertTablePolicy,
  effectiveTiming,
  loadConfig,
  loadTable,
  TEST_CHAIN_ID,
  type Env,
  type ServerConfig,
} from './config';
import { ApiError, BootError, type BootFailureCode } from './errors';
import { GameService } from './game-service';
import { createLogger, describeError, type LogSink, type Logger } from './log';
import { Relayer } from './relayer';
import { Worker } from './settler';
import { createSigner, type Signer } from './signer';
import { openFileStore, type EventStore, type StoreEvent } from './store';
import { UiSnapshots } from './test-hooks';

export interface ContainerDeps {
  config: ServerConfig;
  table: TuningTable;
  chain: ChainPort;
  store: EventStore;
  /** Defaults to the chain clock with a 500 ms cache. */
  clock?: Clock;
  /** Defaults to one built from `config.signerKey`. */
  signer?: Signer;
  /** Where log lines go. Defaults to stdout. */
  logSink?: LogSink;
  mazeFactory?: (finalSeed: Hex, n: number) => Maze;
  random32?: () => Hex;
  mazePadMs?: number;
  /** False: the server never reads the contract's game events. Default true. */
  watcher?: boolean;
  /** False: no polling loop; passes run only when `worker.tick()` is called. Default true. */
  background?: boolean;
  /** Poll period of the worker in milliseconds. Default 500. */
  pollMs?: number;
}

export interface Container {
  readonly config: ServerConfig;
  readonly table: TuningTable;
  readonly tableHash: Hex;
  readonly testHooks: boolean;
  readonly idleTimeoutSec: number;
  readonly maxGameSec: number;
  readonly chain: ChainPort;
  readonly clock: Clock;
  readonly log: Logger;
  readonly service: GameService;
  readonly watcher: Watcher;
  readonly relayer: Relayer;
  readonly worker: Worker;
  readonly snapshots: UiSnapshots;
  /** Stops the worker, waits for sends in flight and closes the event log. */
  close(): Promise<void>;
}

function lastMarker(events: readonly StoreEvent[]): ScanMarker | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'block-scanned') {
      return { blockNumber: BigInt(event.blockNumber), blockHash: event.blockHash };
    }
  }
  return null;
}

/**
 * Builds a running server: checks the boot guards, replays the event log, catches up with the
 * chain and starts the worker. Throws `BootError` when the server must not serve games:
 *
 * - `NOT_CALIBRATED`: the table is not calibrated (a `fixture: true` table is exempt only
 *   while test hooks are on), or test hooks are on off chain 31337;
 * - `TABLE_MISMATCH`: the contract's `tableHash()` is not the hash of the table;
 * - `CHAIN_UNAVAILABLE`: the chain cannot be read, is not the configured chain, does not trust
 *   this server's signing key, or the event log belongs to another deployment or chain.
 */
export async function createContainer(deps: ContainerDeps): Promise<Container> {
  const { config, table, chain, store } = deps;
  const log = createLogger(deps.logSink);

  assertTablePolicy(table, config.testHooks);
  const { idleTimeoutSec, maxGameSec } = effectiveTiming(table, config);

  const signer =
    deps.signer ?? createSigner(config.signerKey, mazeBetDomain(config.chainId, config.contract));
  const tableHash = hashOfTable(table);
  let onchain: { chainId: number; tableHash: Hex; serverSigner: Hex };
  try {
    const [chainId, onchainHash, serverSigner] = await Promise.all([
      chain.chainId(),
      chain.tableHash(),
      chain.serverSigner(),
    ]);
    onchain = { chainId, tableHash: onchainHash, serverSigner };
  } catch (error) {
    throw new BootError('CHAIN_UNAVAILABLE', `cannot read the contract: ${describeError(error)}`);
  }
  if (onchain.chainId !== config.chainId) {
    throw new BootError(
      'CHAIN_UNAVAILABLE',
      `the node is chain ${onchain.chainId}, CHAIN_ID says ${config.chainId}`,
    );
  }
  if (config.testHooks && onchain.chainId !== TEST_CHAIN_ID) {
    throw new BootError('NOT_CALIBRATED', `test hooks are allowed on chain ${TEST_CHAIN_ID} only`);
  }
  if (onchain.tableHash.toLowerCase() !== tableHash.toLowerCase()) {
    throw new BootError(
      'TABLE_MISMATCH',
      `contract tableHash ${onchain.tableHash} differs from the table's ${tableHash}`,
    );
  }
  if (onchain.serverSigner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new BootError(
      'CHAIN_UNAVAILABLE',
      `the contract trusts signer ${onchain.serverSigner}, this server signs as ${signer.address}`,
    );
  }

  const events = await store.load();
  const meta = events.find((event) => event.type === 'meta');
  if (meta === undefined) {
    if (events.length > 0) {
      throw new BootError('CHAIN_UNAVAILABLE', 'the event log has no header; use a fresh data directory');
    }
    await store.append({ type: 'meta', chainId: config.chainId, contract: config.contract });
  } else if (
    meta.chainId !== config.chainId ||
    meta.contract.toLowerCase() !== config.contract.toLowerCase()
  ) {
    throw new BootError(
      'CHAIN_UNAVAILABLE',
      'the event log belongs to another deployment; use a fresh data directory',
    );
  }

  const clock = deps.clock ?? createChainClock(() => chain.head());
  const service = new GameService({
    table,
    idleTimeoutSec,
    maxGameSec,
    clock,
    store,
    signer,
    log,
    mazeFactory: deps.mazeFactory,
    random32: deps.random32,
    mazePadMs: deps.mazePadMs,
    // The seed hook exists only while test hooks are on.
    testSeedSecret: config.testHooks ? config.testSeedSecret : null,
  });
  try {
    service.restore(events);
  } catch (error) {
    throw new BootError('CHAIN_UNAVAILABLE', describeError(error));
  }

  const watcher = new Watcher(
    {
      chain,
      store,
      clock,
      onEvent: (event) => service.onChainEvent(event),
      enabled: deps.watcher ?? true,
    },
    lastMarker(events),
  );
  const relayer = new Relayer({ chain, service, clock, log });
  const worker = new Worker({ watcher, service, relayer, log, pollMs: deps.pollMs ?? 500 });
  service.setHooks({
    onEnded: (gameId) => relayer.kick(gameId),
    syncChain: () => watcher.sync(),
  });

  let bootedAtSec: number;
  try {
    if (!(await watcher.markerMatchesChain())) {
      throw new BootError(
        'CHAIN_UNAVAILABLE',
        'the event log was written against another chain instance; use a fresh data directory',
      );
    }
    // Catch up before serving: games created or finished while the server was down.
    await worker.tick();
    bootedAtSec = await clock.chainNow();
  } catch (error) {
    if (error instanceof BootError) throw error;
    throw new BootError('CHAIN_UNAVAILABLE', `cannot catch up with the chain: ${describeError(error)}`);
  }
  // Nothing after this point can fail, so a refused boot never leaves a worker running.
  if (deps.background ?? true) worker.start();

  log.event({
    event: 'boot',
    chainSec: bootedAtSec,
    detail: {
      chainId: config.chainId,
      contract: config.contract,
      tableHash,
      fixture: table.fixture === true,
      testHooks: config.testHooks,
      idleTimeoutSec,
      maxGameSec,
      replayedEvents: events.length,
    },
  });

  return {
    config,
    table,
    tableHash,
    testHooks: config.testHooks,
    idleTimeoutSec,
    maxGameSec,
    chain,
    clock,
    log,
    service,
    watcher,
    relayer,
    worker,
    snapshots: new UiSnapshots(),
    async close() {
      await worker.stop();
      await relayer.drain();
      await store.close();
    },
  };
}

// ----- the process-wide instance -----

export type BootResult =
  | { ok: true; container: Container }
  | { ok: false; code: BootFailureCode; message: string };

const SLOT = Symbol.for('maze.server.container');
const globals = globalThis as { [SLOT]?: { boot: Promise<BootResult> } };

async function bootOnce(env: Env): Promise<BootResult> {
  let store: EventStore | null = null;
  try {
    const config = loadConfig(env);
    const table = loadTable(config);
    const chain = createViemChain(config);
    store = await openFileStore(config.dataDir);
    return { ok: true, container: await createContainer({ config, table, chain, store }) };
  } catch (error) {
    await store?.close().catch(() => undefined);
    const code = error instanceof BootError ? error.code : 'CHAIN_UNAVAILABLE';
    const message = describeError(error);
    createLogger().event({ level: 'error', event: 'boot-failed', detail: { code, message } });
    return { ok: false, code, message };
  }
}

/**
 * Boots the server from environment variables, once per process: every caller, from any
 * bundle, gets the same promise. A failed boot is final; the process should exit.
 */
export function bootFromEnv(env: Env = process.env): Promise<BootResult> {
  const existing = globals[SLOT];
  if (existing !== undefined) return existing.boot;
  const boot = bootOnce(env);
  globals[SLOT] = { boot };
  return boot;
}

/**
 * Boots the server and ends the process with a non-zero code when the boot guards refuse it
 * (the reason has been logged). Called once, by the instrumentation hook, at server start.
 */
export async function bootOrExit(env: Env = process.env): Promise<void> {
  const result = await bootFromEnv(env);
  if (!result.ok) process.exit(1);
}

/** Makes `container` the process-wide instance. For launchers that build their own container. */
export function installContainer(container: Container): void {
  globals[SLOT] = { boot: Promise.resolve({ ok: true, container }) };
}

/** Removes the process-wide instance and closes it. */
export async function uninstallContainer(): Promise<void> {
  const existing = globals[SLOT];
  delete globals[SLOT];
  if (existing === undefined) return;
  const result = await existing.boot;
  if (result.ok) await result.container.close();
}

/**
 * The running container, booting it if nothing has yet. When the boot guards failed, every
 * caller gets the failure's error code (HTTP 503).
 */
export async function getContainer(): Promise<Container> {
  const result = await bootFromEnv();
  if (!result.ok) throw new ApiError(result.code);
  return result.container;
}
