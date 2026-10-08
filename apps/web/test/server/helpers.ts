// Shared test equipment for the server unit tests: an in-memory chain, a container built on
// it, callers for the real route handlers, and maze route planning.

import { createHash, randomBytes } from 'node:crypto';
import {
  chestAt,
  deriveFinalSeed,
  generateMaze,
  mazeBetDomain,
  neighbor,
  openDirs,
  parseTuning,
  tableHash,
  ticketRequestMessage,
  type Dir,
  type Hex,
  type Maze,
  type TicketResponse,
  type TuningTable,
} from '@maze/shared';
import fixtureJson from '@maze/shared/fixtures/tuning.fixture.json';
import { privateKeyToAccount } from 'viem/accounts';
import { GET as configGet } from '../../app/api/config/route';
import { POST as ticketPost } from '../../app/api/games/route';
import { GET as gameGet } from '../../app/api/games/[id]/route';
import { POST as cashoutPost } from '../../app/api/games/[id]/cashout/route';
import { POST as movePost } from '../../app/api/games/[id]/move/route';
import { GET as revealGet } from '../../app/api/games/[id]/reveal/route';
import { GET as healthGet } from '../../app/api/health/route';
import { POST as startPost } from '../../app/api/games/[id]/start/route';
import { GET as pointsGet } from '../../app/api/points/[address]/route';
import { GET as snapshotGet, POST as snapshotPost } from '../../app/api/test/ui-snapshot/route';
import type {
  ChainEvent,
  ChainHead,
  ChainPort,
  OnchainGame,
  ScanTag,
  SettleArgs,
} from '../../src/server/chain';
import type { Clock } from '../../src/server/clock';
import type { ServerConfig } from '../../src/server/config';
import {
  createContainer,
  installContainer,
  uninstallContainer,
  type Container,
  type ContainerDeps,
} from '../../src/server/container';
import { ApiError } from '../../src/server/errors';
import type { RouteHandler } from '../../src/server/http';
import { createSigner, type Signer } from '../../src/server/signer';
import { createMemoryStore, type EventStore } from '../../src/server/store';

export const fixtureTable: TuningTable = parseTuning(fixtureJson);

/** Anvil account #1: the server signer and relayer of every test. */
export const SIGNER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const SIGNER_ADDRESS: Hex = privateKeyToAccount(SIGNER_KEY).address;
export const CONTRACT: Hex = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

/** Private keys of Anvil accounts #2 .. #9. Public, well-known test keys. */
export const PLAYER_KEYS: readonly Hex[] = [
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
];

/** Anvil accounts #2 .. #9. */
export const PLAYERS: readonly Hex[] = PLAYER_KEYS.map((key) => privateKeyToAccount(key).address);

export const T0 = 1_700_000_000;
export const BET = 10_000_000_000_000_000n;

export const ONCHAIN = { None: 0, Active: 1, Settled: 2, Reclaimed: 3 } as const;

function hex32(): Hex {
  return `0x${randomBytes(32).toString('hex')}`;
}

/**
 * An in-memory chain with the parts of `MazeBet` the server depends on: game status, the three
 * game events, and a relayer transaction pool that is mined by `mine()`.
 */
export class FakeChain implements ChainPort {
  readonly relayerAddress: Hex = SIGNER_ADDRESS;
  chainIdValue = 31337;
  tableHashValue: Hex;
  signerValue: Hex = SIGNER_ADDRESS;
  /** Chain time. `mine()` stamps the next block with it. */
  time = T0;
  /** True: every read fails as `CHAIN_UNAVAILABLE`. */
  offline = false;
  /** True: reading the contract's events fails, every other read works. */
  failEvents = false;
  /** `accept`: sends enter the pool. `drop`: sends return a hash and vanish. `fail`: sends throw. */
  sendMode: 'accept' | 'drop' | 'fail' = 'accept';
  /** Sends for these games throw, whatever `sendMode` says. */
  readonly failGames = new Set<Hex>();
  readonly games = new Map<Hex, OnchainGame>();
  /** Every `settle` the relayer has broadcast, in order. */
  readonly sent: { hash: Hex; nonce: number; args: SettleArgs }[] = [];
  /** Every block range the server read the contract's events for, in order. */
  readonly eventReads: [from: bigint, to: bigint][] = [];
  /** How many blocks `safe` and `finalized` trail `latest`. */
  readonly tagLag: Record<Exclude<ScanTag, 'latest'>, number> = { safe: 0, finalized: 0 };
  /** How many times the head was read, per tag. */
  readonly headReads: Record<ScanTag, number> = { latest: 0, safe: 0, finalized: 0 };

  private pool: { hash: Hex; nonce: number; args: SettleArgs }[] = [];
  private nextNonce = 0;
  private readonly blocks: ChainHead[] = [];
  private readonly eventsByBlock = new Map<bigint, ChainEvent[]>();

  constructor(private readonly table: TuningTable) {
    this.tableHashValue = tableHash(table);
    this.blocks.push({ number: 0n, timestamp: this.time, hash: hex32() });
  }

  private guard(): void {
    if (this.offline) throw new ApiError('CHAIN_UNAVAILABLE');
  }

  // ----- test controls -----

  /** Mines one block at `time`, including every pool transaction whose nonce is next. */
  mine(extra: ChainEvent[] = []): ChainHead {
    const number = BigInt(this.blocks.length);
    const events: ChainEvent[] = [...extra];
    for (;;) {
      const index = this.pool.findIndex((tx) => tx.nonce === this.nextNonce);
      if (index === -1) break;
      const [tx] = this.pool.splice(index, 1);
      this.nextNonce += 1;
      const game = this.games.get(tx.args.gameId);
      // A `settle` for a game that is not active, or past its deadline, reverts.
      if (
        game === undefined ||
        game.status !== ONCHAIN.Active ||
        this.time > game.settleDeadlineSec
      ) {
        continue;
      }
      game.status = ONCHAIN.Settled;
      events.push({
        type: 'settled',
        blockNumber: number,
        txHash: tx.hash,
        gameId: tx.args.gameId,
        player: game.player,
        outcome: tx.args.outcome,
        steps: tx.args.steps,
        payoutWei: tx.args.payoutWei,
        serverSeed: tx.args.serverSeed,
      });
    }
    const head = { number, timestamp: this.time, hash: hex32() };
    this.blocks.push(head);
    this.eventsByBlock.set(
      number,
      events.map((event) => ({ ...event, blockNumber: number })),
    );
    return head;
  }

  /** `createGame` by the ticket's player: a block with `GameCreated` at the current time. */
  createGame(p: {
    gameId: Hex;
    player: Hex;
    tier: number;
    commitment: Hex;
    betWei: bigint;
    clientSeed: Hex;
  }): void {
    const maxPayoutWei = (p.betWei * BigInt(this.table.tiers[p.tier].multiplierBps)) / 10_000n;
    const settleDeadlineSec = this.time + this.table.timing.settleWindowSec;
    this.games.set(p.gameId, {
      player: p.player,
      tier: p.tier,
      status: ONCHAIN.Active,
      createdAtSec: this.time,
      settleDeadlineSec,
      betWei: p.betWei,
      maxPayoutWei,
      commitment: p.commitment,
      clientSeed: p.clientSeed,
    });
    this.mine([
      {
        type: 'created',
        blockNumber: 0n,
        txHash: hex32(),
        gameId: p.gameId,
        player: p.player,
        tier: p.tier,
        betWei: p.betWei,
        maxPayoutWei,
        commitment: p.commitment,
        clientSeed: p.clientSeed,
        settleDeadlineSec,
      },
    ]);
  }

  /** `reclaim`, callable only after the deadline, as on the contract. */
  reclaim(gameId: Hex): void {
    const game = this.games.get(gameId);
    if (game === undefined || game.status !== ONCHAIN.Active) throw new Error('GameNotActive');
    if (this.time <= game.settleDeadlineSec) throw new Error('DeadlineNotReached');
    game.status = ONCHAIN.Reclaimed;
    this.mine([
      {
        type: 'reclaimed',
        blockNumber: 0n,
        txHash: hex32(),
        gameId,
        player: game.player,
        amountWei: game.betWei,
      },
    ]);
  }

  /** Transactions waiting in the pool. */
  pending(): number {
    return this.pool.length;
  }

  /** Replaces every block from `blockNumber` on with one of the same number and another hash. */
  replaceBlocksFrom(blockNumber: number): void {
    for (let i = blockNumber; i < this.blocks.length; i++) this.blocks[i] = { ...this.blocks[i], hash: hex32() };
  }

  // ----- ChainPort -----

  async chainId(): Promise<number> {
    this.guard();
    return this.chainIdValue;
  }

  async head(tag: ScanTag = 'latest'): Promise<ChainHead> {
    this.guard();
    this.headReads[tag] += 1;
    const lag = tag === 'latest' ? 0 : this.tagLag[tag];
    return this.blocks[Math.max(0, this.blocks.length - 1 - lag)];
  }

  async block(blockNumber: bigint): Promise<ChainHead | null> {
    this.guard();
    return this.blocks[Number(blockNumber)] ?? null;
  }

  async events(fromBlock: bigint, toBlock: bigint): Promise<ChainEvent[]> {
    this.guard();
    if (this.failEvents) throw new ApiError('CHAIN_UNAVAILABLE');
    this.eventReads.push([fromBlock, toBlock]);
    const events: ChainEvent[] = [];
    for (let number = fromBlock; number <= toBlock; number++) {
      events.push(...(this.eventsByBlock.get(number) ?? []));
    }
    return events;
  }

  async game(gameId: Hex): Promise<OnchainGame> {
    this.guard();
    const game = this.games.get(gameId);
    if (game !== undefined) return { ...game };
    const zero: Hex = `0x${'00'.repeat(32)}`;
    return {
      player: '0x0000000000000000000000000000000000000000',
      tier: 0,
      status: ONCHAIN.None,
      createdAtSec: 0,
      settleDeadlineSec: 0,
      betWei: 0n,
      maxPayoutWei: 0n,
      commitment: zero,
      clientSeed: zero,
    };
  }

  async tableHash(): Promise<Hex> {
    this.guard();
    return this.tableHashValue;
  }

  async serverSigner(): Promise<Hex> {
    this.guard();
    return this.signerValue;
  }

  async totalReserved(): Promise<bigint> {
    this.guard();
    let total = 0n;
    for (const game of this.games.values()) {
      if (game.status !== ONCHAIN.Active) continue;
      total += game.betWei > game.maxPayoutWei ? game.betWei : game.maxPayoutWei;
    }
    return total;
  }

  async pendingNonce(): Promise<number> {
    this.guard();
    let nonce = this.nextNonce;
    while (this.pool.some((tx) => tx.nonce === nonce)) nonce += 1;
    return nonce;
  }

  async sendSettle(args: SettleArgs, nonce: number): Promise<Hex> {
    if (this.offline || this.sendMode === 'fail' || this.failGames.has(args.gameId)) {
      throw new Error('send failed');
    }
    const tx = { hash: hex32(), nonce, args };
    this.sent.push(tx);
    if (this.sendMode === 'accept') this.pool.push(tx);
    return tx.hash;
  }
}

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    rpcUrl: 'http://127.0.0.1:8546',
    publicRpcUrl: 'http://127.0.0.1:8546',
    network: { name: 'Anvil', symbol: 'ETH', explorerUrl: null, faucetUrl: null },
    privyAppId: null,
    chainId: 31337,
    contract: CONTRACT,
    signerKey: SIGNER_KEY,
    relayerKey: SIGNER_KEY,
    dataDir: '/nonexistent/maze-data-test',
    idleTimeoutSec: null,
    maxGameSec: null,
    scanTag: 'latest',
    startBlock: null,
    logChunkBlocks: 2000,
    testHooks: true,
    testSeedSecret: null,
    fixturePath: null,
    devWallet: false,
    ...overrides,
  };
}

export interface TestEnv {
  container: Container;
  chain: FakeChain;
  store: EventStore;
  table: TuningTable;
  /** Every log line the server wrote, parsed. */
  logs: Record<string, unknown>[];
  /** How many times the server signed each kind of message. */
  signs: { ticket: number; settlement: number };
  /** Every failure of the event log the server reported instead of ending the process. */
  storeFailures: Error[];
  /** Games whose settlement the signer refuses to sign, for as long as they are listed. */
  unsignable: Set<Hex>;
  /** Moves chain time forward and mines a block at the new time. */
  advance(sec: number): void;
  /** One worker pass. */
  tick(): Promise<void>;
  close(): Promise<void>;
}

export interface EnvOptions {
  config?: Partial<ServerConfig>;
  table?: TuningTable;
  chain?: FakeChain;
  store?: EventStore;
  mazeFactory?: ContainerDeps['mazeFactory'];
  /** Where the chests are; the current chest rule by default. */
  chestDraw?: ContainerDeps['chestDraw'];
  watcher?: boolean;
  /** False: the container is not made the process-wide instance. Default true. */
  install?: boolean;
  /** Waits between attempts of the boot catch-up. Default none: the first failure refuses the boot. */
  catchUpRetryMs?: readonly number[];
  /**
   * True: a failed append ends the process, as it does in a real server. By default the test
   * process records the failure in `storeFailures` instead.
   */
  exitOnStoreFailure?: boolean;
}

/**
 * A container over a `FakeChain`, with the chain's time as the injected clock and no background
 * polling: time moves only through `advance` and the worker runs only through `tick`.
 */
export async function makeEnv(options: EnvOptions = {}): Promise<TestEnv> {
  const table = options.table ?? fixtureTable;
  const chain = options.chain ?? new FakeChain(table);
  const store = options.store ?? createMemoryStore();
  const config = testConfig(options.config);
  const logs: Record<string, unknown>[] = [];
  const signs = { ticket: 0, settlement: 0 };
  const storeFailures: Error[] = [];
  const unsignable = new Set<Hex>();

  const inner = createSigner(config.signerKey, mazeBetDomain(config.chainId, config.contract));
  const signer: Signer = {
    address: inner.address,
    signTicket(message) {
      signs.ticket += 1;
      return inner.signTicket(message);
    },
    signSettlement(message) {
      if (unsignable.has(message.gameId)) return Promise.reject(new Error('the signer is unavailable'));
      signs.settlement += 1;
      return inner.signSettlement(message);
    },
  };
  const clock: Clock = {
    chainNow: () =>
      chain.offline
        ? Promise.reject(new ApiError('CHAIN_UNAVAILABLE'))
        : Promise.resolve(chain.time),
  };

  const container = await createContainer({
    config,
    table,
    chain,
    store,
    clock,
    signer,
    logSink: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
    mazeFactory: options.mazeFactory,
    chestDraw: options.chestDraw,
    mazePadMs: 0,
    watcher: options.watcher,
    background: false,
    catchUpRetryMs: options.catchUpRetryMs ?? [],
    // A server process ends itself here; a test process records the call instead.
    onStoreFailure:
      options.exitOnStoreFailure === true ? undefined : (error) => storeFailures.push(error),
  });
  if (options.install ?? true) installContainer(container);

  return {
    container,
    chain,
    store,
    table,
    logs,
    signs,
    storeFailures,
    unsignable,
    advance(sec) {
      chain.time += sec;
      chain.mine();
    },
    tick: () => container.worker.tick(),
    async close() {
      if (options.install ?? true) await uninstallContainer();
      else await container.close();
    },
  };
}

// ----- route callers -----

export interface Reply<T = unknown> {
  status: number;
  /** The raw body text, for byte-for-byte comparisons. */
  text: string;
  body: T;
}

async function call<T>(
  handler: RouteHandler,
  p: {
    method: 'GET' | 'POST';
    path: string;
    id?: string;
    /** Route parameters other than `id`. */
    params?: Record<string, string>;
    token?: string | null;
    body?: unknown;
    rawBody?: string;
  },
): Promise<Reply<T>> {
  const headers: Record<string, string> = {};
  if (p.token !== undefined && p.token !== null) headers.authorization = `Bearer ${p.token}`;
  let body: string | undefined;
  if (p.rawBody !== undefined) body = p.rawBody;
  else if (p.body !== undefined) body = JSON.stringify(p.body);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`http://localhost${p.path}`, { method: p.method, headers, body });
  const params: Record<string, string> = p.params ?? (p.id === undefined ? {} : { id: p.id });
  const response = await handler(request, { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, text, body: (text === '' ? null : JSON.parse(text)) as T };
}

export const api = {
  health: <T = unknown>() => call<T>(healthGet, { method: 'GET', path: '/api/health' }),
  config: <T = unknown>() => call<T>(configGet, { method: 'GET', path: '/api/config' }),
  ticket: <T = unknown>(body: unknown) =>
    call<T>(ticketPost, { method: 'POST', path: '/api/games', body }),
  ticketRaw: <T = unknown>(rawBody: string) =>
    call<T>(ticketPost, { method: 'POST', path: '/api/games', rawBody }),
  start: <T = unknown>(id: string, token: string | null, body: unknown = {}) =>
    call<T>(startPost, { method: 'POST', path: `/api/games/${id}/start`, id, token, body }),
  move: <T = unknown>(id: string, token: string | null, body: unknown) =>
    call<T>(movePost, { method: 'POST', path: `/api/games/${id}/move`, id, token, body }),
  cashout: <T = unknown>(id: string, token: string | null, body: unknown) =>
    call<T>(cashoutPost, { method: 'POST', path: `/api/games/${id}/cashout`, id, token, body }),
  game: <T = unknown>(id: string, token: string | null) =>
    call<T>(gameGet, { method: 'GET', path: `/api/games/${id}`, id, token }),
  reveal: <T = unknown>(id: string) =>
    call<T>(revealGet, { method: 'GET', path: `/api/games/${id}/reveal`, id }),
  points: <T = unknown>(address: string) =>
    call<T>(pointsGet, { method: 'GET', path: `/api/points/${address}`, params: { address } }),
  snapshotPost: <T = unknown>(body: unknown) =>
    call<T>(snapshotPost, { method: 'POST', path: '/api/test/ui-snapshot', body }),
  snapshotGet: <T = unknown>() =>
    call<T>(snapshotGet, { method: 'GET', path: '/api/test/ui-snapshot' }),
};

// ----- game setup -----

export function newToken(): { token: string; sessionTokenHash: Hex } {
  const token = `tok-${randomBytes(16).toString('hex')}`;
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  return { token, sessionTokenHash: `0x${digest}` };
}

export interface OpenedGame {
  gameId: Hex;
  token: string;
  player: Hex;
  tier: number;
  n: number;
  betWei: bigint;
  clientSeed: Hex;
  ticket: TicketResponse;
  /** The maze `generateMaze` gives for this game's seeds. */
  maze: Maze;
}

export interface TicketBody {
  player: Hex;
  tier: number;
  sessionTokenHash: Hex;
  signature: Hex;
}

/**
 * The body of `POST /api/games`, signed with `key` the way a wallet's `personal_sign` signs it.
 * The message names the chain and contract of `testConfig()` unless `domain` says otherwise.
 */
export async function signTicketBody(
  key: Hex,
  p: { player?: Hex; tier?: number; sessionTokenHash?: Hex } = {},
  domain: { chainId: number; contract: Hex } = { chainId: 31337, contract: CONTRACT },
): Promise<TicketBody> {
  const account = privateKeyToAccount(key);
  const player = p.player ?? account.address;
  const tier = p.tier ?? 0;
  const sessionTokenHash = p.sessionTokenHash ?? newToken().sessionTokenHash;
  const signature = await account.signMessage({
    message: ticketRequestMessage({
      chainId: domain.chainId,
      mazeBetAddress: domain.contract,
      player,
      tier,
      sessionTokenHash,
    }),
  });
  return { player, tier, sessionTokenHash, signature };
}

/** The key of one of `PLAYERS`, whatever the letter case of the address. */
export function keyOf(player: Hex): Hex {
  const index = PLAYERS.findIndex((address) => address.toLowerCase() === player.toLowerCase());
  if (index === -1) throw new Error(`${player} is not one of PLAYERS`);
  return PLAYER_KEYS[index];
}

/** A signed ticket request of one of `PLAYERS` (the first by default) with a fresh session token. */
export function ticketBody(player: Hex = PLAYERS[0], tier = 0): Promise<TicketBody> {
  return signTicketBody(keyOf(player), { player, tier });
}

/** Requests a ticket through the route, without creating the game on chain. */
export async function requestTicket(
  p: { player?: Hex; tier?: number } = {},
): Promise<{ ticket: TicketResponse; token: string }> {
  const { token, sessionTokenHash } = newToken();
  const player = p.player ?? PLAYERS[0];
  const reply = await api.ticket<TicketResponse>(
    await signTicketBody(keyOf(player), { player, tier: p.tier ?? 0, sessionTokenHash }),
  );
  if (reply.status !== 201) throw new Error(`ticket refused: ${reply.text}`);
  return { ticket: reply.body, token };
}

/**
 * A client seed for a ticket whose server seed the test knows. With `deadEnd`, one whose maze
 * has a dead end that can be walked into before the exit (about one 5×5 maze in a thousand
 * has none). With `chest` as well, one where the dead end `deadEndRoute` leads into holds a
 * chest under the current chest rule (`true`) or holds none (`false`); with `pathChest`, one where
 * that route passes at least one path chest (`true`) or none (`false`). A real player cannot do
 * this: the server seed is secret until the game ends.
 */
export function pickClientSeed(
  ticket: TicketResponse,
  serverSeed: Hex,
  n: number,
  deadEnd: boolean,
  chest?: boolean,
  pathChest?: boolean,
): { clientSeed: Hex; maze: Maze } {
  for (;;) {
    const clientSeed = hex32();
    const finalSeed = deriveFinalSeed({ serverSeed, clientSeed, gameId: ticket.gameId });
    const maze = generateMaze(finalSeed, n);
    if (!deadEnd && chest === undefined && pathChest === undefined) return { clientSeed, maze };
    const route = findDeadEndRoute(maze);
    if (route === null) continue;
    const cells = cellsOf(maze, route);
    if (chest !== undefined && (chestAt(finalSeed, maze, cells[route.length]) !== null) !== chest) continue;
    if (pathChest !== undefined && cells.slice(1, -1).some((cell) => chestAt(finalSeed, maze, cell) !== null) !== pathChest) {
      continue;
    }
    return { clientSeed, maze };
  }
}

/**
 * Ticket, `createGame` on the fake chain, and one worker pass so the server has seen it.
 * `deadEnd: true` guarantees that `deadEndRoute(game.maze)` exists; `chest` also fixes whether
 * the dead end it leads into holds a chest under the current chest rule, and `pathChest` whether
 * the route there passes a path chest.
 */
export async function openGame(
  env: TestEnv,
  p: {
    player?: Hex;
    tier?: number;
    betWei?: bigint;
    clientSeed?: Hex;
    tick?: boolean;
    deadEnd?: boolean;
    chest?: boolean;
    pathChest?: boolean;
  } = {},
): Promise<OpenedGame> {
  const { ticket, token } = await requestTicket(p);
  const betWei = p.betWei ?? BET;
  const n = env.table.tiers[ticket.tier].n;
  const serverSeed = env.container.service.get(ticket.gameId)!.serverSeed;
  const clientSeed =
    p.clientSeed ?? pickClientSeed(ticket, serverSeed, n, p.deadEnd ?? false, p.chest, p.pathChest).clientSeed;
  env.chain.createGame({
    gameId: ticket.gameId,
    player: ticket.player,
    tier: ticket.tier,
    commitment: ticket.commitment,
    betWei,
    clientSeed,
  });
  if (p.tick ?? true) await env.tick();
  const maze = generateMaze(deriveFinalSeed({ serverSeed, clientSeed, gameId: ticket.gameId }), n);
  return {
    gameId: ticket.gameId,
    token,
    player: ticket.player,
    tier: ticket.tier,
    n,
    betWei,
    clientSeed,
    ticket,
    maze,
  };
}

// ----- maze route planning -----

/** Moves from the start cell to `target` (breadth-first over open sides). */
export function routeTo(maze: Maze, target: number): Dir[] {
  const cells = maze.w * maze.h;
  const from = new Int32Array(cells).fill(-1);
  const via = new Int8Array(cells).fill(-1);
  from[0] = 0;
  const queue = [0];
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    for (const dir of openDirs(maze, cell)) {
      const next = neighbor(maze, cell, dir);
      if (next !== null && from[next] === -1) {
        from[next] = cell;
        via[next] = dir;
        queue.push(next);
      }
    }
  }
  if (from[target] === -1) throw new Error(`cell ${target} is unreachable`);
  const dirs: Dir[] = [];
  for (let cell = target; cell !== 0; cell = from[cell]) dirs.push(via[cell] as Dir);
  return dirs.reverse();
}

/** Cells visited by `dirs` from the start, the start included. */
export function cellsOf(maze: Maze, dirs: readonly Dir[]): number[] {
  const cells = [0];
  for (const dir of dirs) {
    const next = neighbor(maze, cells[cells.length - 1], dir);
    if (next === null) throw new Error('route leaves the grid');
    cells.push(next);
  }
  return cells;
}

/** The moves that reach the exit. */
export function exitRoute(maze: Maze): Dir[] {
  return routeTo(maze, maze.w * maze.h - 1);
}

/**
 * The shortest sequence of moves that ends in a dead end without passing the exit, or `null`
 * when every dead end of the maze lies beyond the exit.
 */
export function findDeadEndRoute(maze: Maze): Dir[] | null {
  const exit = maze.w * maze.h - 1;
  let best: Dir[] | null = null;
  for (let cell = 1; cell < exit; cell++) {
    if (openDirs(maze, cell).length !== 1) continue;
    const route = routeTo(maze, cell);
    if (cellsOf(maze, route).includes(exit)) continue;
    if (best === null || route.length < best.length) best = route;
  }
  return best;
}

/** `findDeadEndRoute` for a maze that is known to have one (a game opened with `deadEnd: true`). */
export function deadEndRoute(maze: Maze): Dir[] {
  const route = findDeadEndRoute(maze);
  if (route === null) throw new Error('the maze has no dead end before the exit');
  return route;
}

/** A direction that is a wall at `cell` and stays inside the grid, or `null` when there is none. */
export function wallDir(maze: Maze, cell: number): Dir | null {
  const open = openDirs(maze, cell);
  for (const dir of [0, 1, 2, 3] as const) {
    if (!open.includes(dir) && neighbor(maze, cell, dir) !== null) return dir;
  }
  return null;
}

/** A direction that leaves the grid at `cell`, or `null` when there is none. */
export function outDir(maze: Maze, cell: number): Dir | null {
  for (const dir of [0, 1, 2, 3] as const) if (neighbor(maze, cell, dir) === null) return dir;
  return null;
}
