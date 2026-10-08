// The single server container (plan §10, "module instance separation").
//
// Next.js may load `instrumentation.ts` and each route handler as separate bundles, each with
// its own copy of this module. All server state therefore hangs off ONE object stored on
// `globalThis` under a registered symbol: whichever copy boots first creates it and every other
// copy finds it there. No module in `src/server` keeps mutable state at module level.

import {
  mazeBetDomain,
  tableHash as hashOfTable,
  type ChestDraw,
  type ChestKind,
  type Hex,
  type Maze,
  type TuningTable,
} from '@maze/shared';
import { createViemChain, findResumeMarker, Watcher, type ChainPort, type ScanMarker } from './chain';
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
import { GameService, TICKET_RETENTION_SEC } from './game-service';
import { createLogger, describeError, type LogSink, type Logger } from './log';
import { singleFlight } from './mutex';
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
  /**
   * The chest draws of a cell, for the kind of chest it can hold and the game's rule. Defaults to
   * `chestDraw` (tests place chests at will).
   */
  chestDraw?: (finalSeed: Hex, cell: number, kind: ChestKind, rule: number) => ChestDraw;
  /** False: the server never reads the contract's game events. Default true. */
  watcher?: boolean;
  /** False: no polling loop; passes run only when `worker.tick()` is called. Default true. */
  background?: boolean;
  /** Poll period of the worker in milliseconds. Default 500. */
  pollMs?: number;
  /**
   * Waits, in milliseconds, before each new attempt of the boot catch-up after a failed one; the
   * boot is refused once they are used up. Default `CATCH_UP_RETRY_MS`.
   */
  catchUpRetryMs?: readonly number[];
  /**
   * Called once, when an append to the event log fails. The server must stop then: it can no
   * longer record a move or an ending, and one that keeps running in that state signs no
   * automatic cash-out, so every live game would run into its settle deadline and be reclaimed
   * in full. Defaults to ending the process with `STORE_FAILURE_EXIT_CODE`; a supervisor starts
   * it again, and the boot catch-up signs what is overdue.
   */
  onStoreFailure?: (error: Error) => void;
}

/** Exit code of a server that stopped because its event log could not be written. */
export const STORE_FAILURE_EXIT_CODE = 70;

/** The worker counts as stalled when no pass has completed for this long. */
export const WORKER_STALE_MS = 10_000;

/**
 * Waits between attempts of the boot catch-up, about a minute in all. Every completed range is
 * kept, in memory and through the markers of long scans, so an attempt continues where the
 * failed one stopped.
 */
export const CATCH_UP_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/** Why the server cannot be relied on to settle games right now. */
export type HealthProblem = 'store-failed' | 'worker-stalled';

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
  /** `null` while the event log is writable and the worker completes its passes. */
  health(): HealthProblem | null;
  /** Stops the worker, waits for sends in flight and closes the event log. */
  close(): Promise<void>;
}

/** The scan markers of the log, in log order. */
function markersOf(events: readonly StoreEvent[]): ScanMarker[] {
  const markers: ScanMarker[] = [];
  for (const event of events) {
    if (event.type === 'block-scanned') {
      markers.push({ blockNumber: BigInt(event.blockNumber), blockHash: event.blockHash });
    }
  }
  return markers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a running server: checks the boot guards, replays the event log, catches up with the
 * chain and starts the worker. Throws `BootError` when the server must not serve games:
 *
 * - `NOT_CALIBRATED`: the table is not calibrated (a `fixture: true` table is exempt only
 *   while test hooks are on), or test hooks are on off chain 31337;
 * - `TABLE_MISMATCH`: the contract's `tableHash()` is not the hash of the table;
 * - `CHAIN_UNAVAILABLE`: the chain cannot be read (the catch-up is tried again for about a
 *   minute first), is not the configured chain, does not trust this server's signing key, the
 *   event log belongs to another deployment or chain (none of its scan markers is a block of this
 *   chain), or a fresh log's MAZE_START_BLOCK lies beyond the head.
 */
export async function createContainer(deps: ContainerDeps): Promise<Container> {
  const { config, table, chain } = deps;
  const log = createLogger(deps.logSink);

  // Fail-stop: every append of the server goes through this wrapper.
  let storeFailure: Error | null = null;
  let closing = false;
  const store: EventStore = {
    load: () => deps.store.load(),
    close: () => deps.store.close(),
    append: (events) =>
      deps.store.append(events).catch((error: unknown) => {
        if (storeFailure === null && !closing) {
          storeFailure = error instanceof Error ? error : new Error(String(error));
          log.event({
            level: 'alert',
            event: 'store-failed',
            detail: { dataDir: config.dataDir, error: describeError(error) },
          });
          (deps.onStoreFailure ?? exitOnStoreFailure)(storeFailure);
        }
        throw error;
      }),
  };

  assertTablePolicy(table, config.testHooks);
  const { idleTimeoutSec, maxGameSec } = effectiveTiming(table, config);

  const signer =
    deps.signer ?? createSigner(config.signerKey, mazeBetDomain(config.chainId, config.contract));
  const tableHash = hashOfTable(table);
  let onchain: { chainId: number; tableHash: Hex; serverSigner: Hex; reservedWei: bigint };
  try {
    const [chainId, onchainHash, serverSigner, reservedWei] = await Promise.all([
      chain.chainId(),
      chain.tableHash(),
      chain.serverSigner(),
      chain.totalReserved(),
    ]);
    onchain = { chainId, tableHash: onchainHash, serverSigner, reservedWei };
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
    // A game is created with a ticket, and the ticket is in the log before it is handed out. An
    // empty log next to a contract that holds money for Active games is therefore the wrong
    // directory: this server could play and settle none of them.
    if (onchain.reservedWei > 0n) {
      throw new BootError(
        'CHAIN_UNAVAILABLE',
        `the event log in ${config.dataDir} is empty, but the contract holds ${onchain.reservedWei} wei ` +
          'for games that are Active; start the server on the data directory their tickets were issued from',
      );
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
    chainId: config.chainId,
    contract: config.contract,
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
    chestDraw: deps.chestDraw,
    // The seed hook exists only while test hooks are on.
    testSeedSecret: config.testHooks ? config.testSeedSecret : null,
  });
  try {
    service.restore(events);
  } catch (error) {
    throw new BootError('CHAIN_UNAVAILABLE', describeError(error));
  }

  // Where the scan resumes: the newest marker whose block the chain still has. A marker on a
  // block that was replaced is passed over; a log none of whose markers is on this chain was
  // written against another chain instance.
  const markers = markersOf(events);
  let marker: ScanMarker | null;
  let startBlock = config.startBlock === null ? null : BigInt(config.startBlock);
  try {
    marker = await findResumeMarker(chain, markers);
    if (markers.length > 0 && marker === null) {
      throw new BootError(
        'CHAIN_UNAVAILABLE',
        'the chain has the first block the event log marked with another hash: the log was written ' +
          'against another chain instance; use a fresh data directory',
      );
    }
    if (marker !== null && marker !== markers[markers.length - 1]) {
      log.event({
        level: 'alert',
        event: 'scan-marker-rewound',
        detail: {
          warning: 'The newest scan markers name blocks the chain no longer has; the scan resumes from an older one.',
          newestBlock: markers[markers.length - 1].blockNumber,
          resumeBlock: marker.blockNumber,
        },
      });
    }
    if (marker === null && startBlock === null && service.counts().games > 0) {
      // A log with tickets but no marker was written by an older server, which stored its first
      // marker late. The games of those tickets may lie anywhere after the deployment.
      if (config.chainId !== TEST_CHAIN_ID) {
        throw new BootError(
          'CHAIN_UNAVAILABLE',
          'the event log holds tickets but no scan marker; set MAZE_START_BLOCK to the deploy block',
        );
      }
      startBlock = 0n;
    } else if (marker === null && startBlock !== null) {
      // A start block beyond the head would leave the blocks up to it unread, and the games
      // created in them unknown to this server.
      const head = await chain.head(config.scanTag);
      if (startBlock > head.number) {
        throw new BootError(
          'CHAIN_UNAVAILABLE',
          `MAZE_START_BLOCK ${startBlock} is beyond the ${config.scanTag} block ${head.number}`,
        );
      }
    }
  } catch (error) {
    if (error instanceof BootError) throw error;
    throw new BootError(
      'CHAIN_UNAVAILABLE',
      `cannot read the chain: ${describeError(error)}. The event log is fine; start again later or with another RPC`,
    );
  }

  const watcher = new Watcher(
    {
      chain,
      store,
      clock,
      onEvent: (event) => service.onChainEvent(event),
      enabled: deps.watcher ?? true,
      scanTag: config.scanTag,
      startBlock,
      logChunkBlocks: BigInt(config.logChunkBlocks),
    },
    marker,
  );
  const relayer = new Relayer({ chain, service, clock, log });
  const worker = new Worker({ watcher, service, relayer, log, pollMs: deps.pollMs ?? 500 });
  // Requests that need the chain read now (a ticket request, a game the server has not seen yet)
  // each sync it on chain 31337. Where the scan trails the clock they may wait and sync again, so
  // their syncs are shared: one in flight, one queued for everyone who arrives meanwhile.
  service.setHooks(
    config.scanTag === 'latest'
      ? { onEnded: (gameId) => relayer.kick(gameId), syncChain: () => watcher.sync() }
      : {
          onEnded: (gameId) => relayer.kick(gameId),
          syncChain: singleFlight(() => watcher.sync()),
          scannedTimeSec: () => watcher.scannedTimeSec,
        },
  );

  let bootedAtSec: number;
  let unknownReservedWei = 0n;
  try {
    // Catch up before serving: games created or finished while the server was down. A failed
    // attempt (a rate-limited RPC, say) is tried again after a wait rather than refusing the boot.
    const retryMs = deps.catchUpRetryMs ?? CATCH_UP_RETRY_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        await worker.tick();
        break;
      } catch (error) {
        // A log that cannot be written stays that way: there is nothing to wait for.
        if (attempt >= retryMs.length || storeFailure !== null) throw error;
        log.event({
          level: 'warn',
          event: 'catch-up-retry',
          detail: { attempt: attempt + 1, waitMs: retryMs[attempt], error: describeError(error) },
        });
        await sleep(retryMs[attempt]);
      }
    }
    // After the catch-up the log knows every game its tickets created. Whatever the contract
    // reserves beyond those belongs to games this server cannot settle. A game created in the
    // moment between the scan and the read would look like one, so a difference is checked
    // again after one more pass.
    for (let pass = 0; pass < 2; pass++) {
      const reservedWei = await chain.totalReserved();
      const knownWei = service.reservedWei();
      unknownReservedWei = reservedWei > knownWei ? reservedWei - knownWei : 0n;
      if (unknownReservedWei === 0n || pass === 1) break;
      await worker.tick();
    }
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
  if (unknownReservedWei > 0n) {
    // Not a reason to refuse the boot: the games this log does know still have to be settled.
    log.event({
      level: 'alert',
      event: 'unknown-active-games',
      chainSec: bootedAtSec,
      detail: {
        warning:
          'The contract holds money for Active games that are not in this event log. This server ' +
          'cannot settle them; they will be reclaimed in full after their settle deadline.',
        unknownReservedWei,
        dataDir: config.dataDir,
      },
    });
  }
  if (config.testHooks) {
    log.event({
      level: 'alert',
      event: 'test-hooks-enabled',
      chainSec: bootedAtSec,
      detail: {
        warning:
          'TEST HOOKS ARE ON. This server is for automated tests only and must not hold real bets: ' +
          'with the seed hook, every maze can be computed from the public game id.',
        seedHook: config.testSeedSecret !== null,
        fixtureTable: table.fixture === true,
        uiSnapshotRoutes: true,
      },
    });
  }

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
    health() {
      if (storeFailure !== null) return 'store-failed';
      const sincePassMs = worker.sinceCompletedMs();
      return sincePassMs === null || sincePassMs > WORKER_STALE_MS ? 'worker-stalled' : null;
    },
    async close() {
      closing = true;
      await worker.stop();
      await relayer.drain();
      await store.close();
    },
  };
}

function exitOnStoreFailure(): void {
  process.exit(STORE_FAILURE_EXIT_CODE);
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
    store = await openFileStore(config.dataDir, { ticketRetentionSec: TICKET_RETENTION_SEC });
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
