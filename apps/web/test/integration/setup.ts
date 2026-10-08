// Equipment for the integration tests: a private Anvil (`--block-time 1`) on the WS-C port, a
// real deployment made by `scripts/deploy-local.ts`, and a game server whose route handlers
// are called directly. No Next.js process is involved.
//
// The vitest config does not load this file; every integration test imports it.

import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  deriveFinalSeed,
  generateMaze,
  mazeBetAbi,
  type Dir,
  type GameView,
  type Hex,
  type Maze,
  type TicketResponse,
  type TuningTable,
} from '@maze/shared';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ANVIL_SIGNER_KEY, deployMazeBet } from '../../../../scripts/deploy-local';
import { createViemChain } from '../../src/server/chain';
import type { ServerConfig } from '../../src/server/config';
import {
  createContainer,
  installContainer,
  uninstallContainer,
  type Container,
} from '../../src/server/container';
import { openFileStore } from '../../src/server/store';
import { testServerSeed } from '../../src/server/test-hooks';
import {
  api,
  fixtureTable,
  newToken,
  pickClientSeed,
  PLAYER_KEYS,
  signTicketBody,
} from '../server/helpers';

/** The Anvil port reserved for these tests (`MAZE_INT_ANVIL_PORT` in scripts/ports.sh). */
export const ANVIL_PORT = 8546;
export const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
export const SEED_SECRET = 'integration-secret';
export const BET = 10_000_000_000_000_000n;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `probe` until it returns something truthy. */
export async function until<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 40_000,
  intervalMs = 150,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

async function rpcAlive(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Starts this test file's own Anvil. It is stopped by PID, never by name. */
async function startAnvil(): Promise<{ stop(): Promise<void> }> {
  if (await rpcAlive(RPC_URL)) {
    throw new Error(`port ${ANVIL_PORT} already answers JSON-RPC; the integration tests need it free`);
  }
  const child = spawn('anvil', ['--port', String(ANVIL_PORT), '--block-time', '1', '--silent'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  const killWithParent = (): void => {
    child.kill('SIGKILL');
  };
  process.once('exit', killWithParent);

  await until('anvil to answer', async () => {
    if (child.exitCode !== null) throw new Error(`anvil exited early: ${stderr}`);
    return rpcAlive(RPC_URL);
  }, 20_000, 100);

  return {
    async stop() {
      process.off('exit', killWithParent);
      child.kill('SIGTERM');
      await exited;
    },
  };
}

/** A running chain with the contract deployed from the fixture table and funded. */
export async function startHarness() {
  const anvil = await startAnvil();
  try {
    const table: TuningTable = fixtureTable;
    const deployment = await deployMazeBet({ rpcUrl: RPC_URL, table });
    const chain = defineChain({
      id: deployment.chainId,
      name: 'anvil',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
    });
    const publicClient = createPublicClient({
      chain,
      transport: http(RPC_URL),
      pollingInterval: 100,
      cacheTime: 0,
    });
    const testClient = createTestClient({ chain, mode: 'anvil', transport: http(RPC_URL) });
    return {
      rpcUrl: RPC_URL,
      chain,
      table,
      deployment,
      contract: deployment.mazeBetAddress,
      relayer: privateKeyToAccount(ANVIL_SIGNER_KEY).address,
      publicClient,
      testClient,
      stop: () => anvil.stop(),
    };
  } catch (error) {
    await anvil.stop();
    throw error;
  }
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;

// ----- server -----

export interface ServerOptions {
  /** Reuse a data directory to boot from an existing event log. */
  dataDir?: string;
  idleTimeoutSec?: number;
  maxGameSec?: number;
  watcher?: boolean;
  background?: boolean;
  /** RPC endpoint of the server only (for example a recording proxy in front of Anvil). */
  rpcUrl?: string;
}

export type LogLine = {
  level: string;
  event: string;
  chainSec: number | null;
  gameId: Hex | null;
  step: number | null;
  outcome: number | null;
  txHash: Hex | null;
  detail?: Record<string, unknown>;
};

export interface Server {
  container: Container;
  config: ServerConfig;
  dataDir: string;
  logs: LogLine[];
  /** Every failure of the event log the server reported instead of ending the process. */
  storeFailures: Error[];
  /** Stops the worker and closes the event log. */
  stop(): Promise<void>;
}

export function serverConfig(h: Harness, dataDir: string, options: ServerOptions = {}): ServerConfig {
  return {
    rpcUrl: options.rpcUrl ?? h.rpcUrl,
    publicRpcUrl: options.rpcUrl ?? h.rpcUrl,
    network: { name: 'Anvil', symbol: 'ETH', explorerUrl: null, faucetUrl: null },
    privyAppId: null,
    chainId: h.deployment.chainId,
    contract: h.contract,
    signerKey: ANVIL_SIGNER_KEY,
    relayerKey: ANVIL_SIGNER_KEY,
    dataDir,
    idleTimeoutSec: options.idleTimeoutSec ?? null,
    maxGameSec: options.maxGameSec ?? null,
    scanTag: 'latest',
    startBlock: null,
    logChunkBlocks: 2000,
    testHooks: true,
    testSeedSecret: SEED_SECRET,
    fixturePath: null,
    devWallet: false,
  };
}

/** Boots a server over the harness chain with the fixture table and makes it the process's server. */
export async function startServer(h: Harness, options: ServerOptions = {}): Promise<Server> {
  const dataDir = options.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), 'maze-int-')));
  const config = serverConfig(h, dataDir, options);
  const logs: LogLine[] = [];
  const storeFailures: Error[] = [];
  const store = await openFileStore(dataDir);
  let container: Container;
  try {
    container = await createContainer({
      config,
      table: h.table,
      chain: createViemChain(config),
      store,
      logSink: (line) => logs.push(JSON.parse(line) as LogLine),
      watcher: options.watcher,
      background: options.background,
      onStoreFailure: (error) => storeFailures.push(error),
    });
  } catch (error) {
    await store.close();
    throw error;
  }
  installContainer(container);
  return { container, config, dataDir, logs, storeFailures, stop: () => uninstallContainer() };
}

// ----- players and games -----

export function playerOf(h: Harness, index: number) {
  const account = privateKeyToAccount(PLAYER_KEYS[index]);
  return {
    address: account.address,
    key: PLAYER_KEYS[index],
    /** The chain and contract this player's ticket requests are signed for. */
    domain: { chainId: h.deployment.chainId, contract: h.contract },
    wallet: createWalletClient({ chain: h.chain, transport: http(h.rpcUrl), account }),
  };
}

export type Player = ReturnType<typeof playerOf>;

/** The maze of a game, rebuilt offline from the seed hook exactly as a scenario would. */
export function mazeOf(ticket: TicketResponse, clientSeed: Hex, n: number): Maze {
  const serverSeed = testServerSeed(SEED_SECRET, ticket.gameId);
  return generateMaze(deriveFinalSeed({ serverSeed, clientSeed, gameId: ticket.gameId }), n);
}

/** A ticket request signed by the player, as the page signs it with the wallet. */
export async function requestTicket(
  player: Pick<Player, 'key' | 'domain'>,
  tier = 0,
): Promise<{ ticket: TicketResponse; token: string }> {
  const { token, sessionTokenHash } = newToken();
  const reply = await api.ticket<TicketResponse>(
    await signTicketBody(player.key, { tier, sessionTokenHash }, player.domain),
  );
  if (reply.status !== 201) throw new Error(`ticket refused: ${reply.text}`);
  return { ticket: reply.body, token };
}

/** Sends `createGame` from the player's wallet and waits for it to be mined. */
export async function createOnChain(
  h: Harness,
  player: Player,
  ticket: TicketResponse,
  betWei: bigint,
  clientSeed: Hex,
) {
  const hash = await player.wallet.writeContract({
    address: h.contract,
    abi: mazeBetAbi,
    functionName: 'createGame',
    args: [
      ticket.gameId,
      ticket.tier,
      ticket.commitment,
      BigInt(ticket.expirySec),
      clientSeed,
      ticket.signature,
    ],
    value: betWei,
  });
  const receipt = await h.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`createGame ${hash} reverted`);
  const block = await h.publicClient.getBlock({ blockNumber: receipt.blockNumber });
  return { hash, blockNumber: receipt.blockNumber, createdAtSec: Number(block.timestamp) };
}

export interface LiveGame {
  gameId: Hex;
  token: string;
  player: Player;
  tier: number;
  n: number;
  betWei: bigint;
  clientSeed: Hex;
  ticket: TicketResponse;
  maze: Maze;
  createdAtSec: number;
  createTxHash: Hex;
}

/**
 * Ticket, `createGame` on chain and, unless `start: false`, the first `/start`.
 * `deadEnd: true` picks a client seed whose maze has a dead end before the exit; `chest` also
 * fixes whether the dead end `deadEndRoute` leads into holds a chest, and `pathChest` whether the
 * route there passes a path chest.
 */
export async function openGame(
  h: Harness,
  player: Player,
  p: {
    tier?: number;
    betWei?: bigint;
    start?: boolean;
    deadEnd?: boolean;
    chest?: boolean;
    pathChest?: boolean;
  } = {},
): Promise<LiveGame> {
  const { ticket, token } = await requestTicket(player, p.tier ?? 0);
  const betWei = p.betWei ?? BET;
  const n = h.table.tiers[ticket.tier].n;
  const { clientSeed } = pickClientSeed(
    ticket,
    testServerSeed(SEED_SECRET, ticket.gameId),
    n,
    p.deadEnd ?? false,
    p.chest,
    p.pathChest,
  );
  const created = await createOnChain(h, player, ticket, betWei, clientSeed);
  const game: LiveGame = {
    gameId: ticket.gameId,
    token,
    player,
    tier: ticket.tier,
    n,
    betWei,
    clientSeed,
    ticket,
    maze: mazeOf(ticket, clientSeed, n),
    createdAtSec: created.createdAtSec,
    createTxHash: created.hash,
  };
  if (p.start ?? true) {
    const started = await api.start<GameView>(ticket.gameId, token);
    if (started.status !== 200) throw new Error(`start refused: ${started.text}`);
  }
  return game;
}

/** Plays `dirs` in order, starting at `fromStep`, and returns every view. */
export async function walk(game: LiveGame, dirs: readonly Dir[], fromStep = 0): Promise<GameView[]> {
  const views: GameView[] = [];
  for (let i = 0; i < dirs.length; i++) {
    const reply = await api.move<GameView>(game.gameId, game.token, {
      step: fromStep + i,
      dir: dirs[i],
    });
    if (reply.status !== 200) throw new Error(`move ${fromStep + i} refused: ${reply.text}`);
    views.push(reply.body);
  }
  return views;
}

// ----- chain reads and time -----

export async function chainTime(h: Harness): Promise<number> {
  return Number((await h.publicClient.getBlock({ blockTag: 'latest' })).timestamp);
}

/** Waits until a block with a timestamp of at least `sec` exists. */
export async function waitChainTime(h: Harness, sec: number): Promise<number> {
  return until(`chain time ${sec}`, async () => {
    const now = await chainTime(h);
    return now >= sec ? now : null;
  });
}

/** Moves chain time forward by `seconds` and waits for a block that carries the new time. */
export async function jump(h: Harness, seconds: number): Promise<number> {
  const before = await chainTime(h);
  await h.testClient.increaseTime({ seconds });
  return waitChainTime(h, before + seconds);
}

export function onchainGame(h: Harness, gameId: Hex) {
  return h.publicClient.readContract({
    address: h.contract,
    abi: mazeBetAbi,
    functionName: 'getGame',
    args: [gameId],
  });
}

export interface Settlement {
  outcome: number;
  steps: number;
  payoutWei: bigint;
  serverSeed: Hex;
  txHash: Hex;
  blockNumber: bigint;
  /** Timestamp of the block that settled the game. */
  timestamp: number;
  /** Sender of the settle transaction. */
  from: Hex;
  gasUsed: bigint;
}

/** Every `GameSettled` log of a game. There must never be more than one. */
export async function settlements(h: Harness, gameId: Hex): Promise<Settlement[]> {
  const logs = await h.publicClient.getContractEvents({
    address: h.contract,
    abi: mazeBetAbi,
    eventName: 'GameSettled',
    args: { gameId },
    fromBlock: 0n,
    strict: true,
  });
  return Promise.all(
    logs.map(async (log) => {
      const [block, receipt] = await Promise.all([
        h.publicClient.getBlock({ blockNumber: log.blockNumber }),
        h.publicClient.getTransactionReceipt({ hash: log.transactionHash }),
      ]);
      return {
        outcome: log.args.outcome,
        steps: log.args.steps,
        payoutWei: log.args.payout,
        serverSeed: log.args.serverSeed,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        timestamp: Number(block.timestamp),
        from: receipt.from,
        gasUsed: receipt.gasUsed,
      };
    }),
  );
}

/** Waits for the game to be `Settled` on chain and returns its one settlement. */
export async function waitSettled(h: Harness, gameId: Hex, timeoutMs = 40_000): Promise<Settlement> {
  return until(
    `settlement of ${gameId}`,
    async () => {
      const logs = await settlements(h, gameId);
      if (logs.length > 1) throw new Error(`game ${gameId} was settled ${logs.length} times`);
      return logs[0] ?? null;
    },
    timeoutMs,
  );
}

/**
 * Runs a contract simulation and returns the name of the custom error it reverts with, or
 * `null` when it would succeed.
 */
export async function revertName(simulate: () => Promise<unknown>): Promise<string | null> {
  try {
    await simulate();
    return null;
  } catch (error) {
    if (error instanceof BaseError) {
      const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
      if (reverted instanceof ContractFunctionRevertedError) {
        return reverted.data?.errorName ?? 'revert';
      }
    }
    throw error;
  }
}

/** What `reclaim(gameId)` sent by `from` would revert with right now, or `null`. */
export function reclaimRevert(h: Harness, gameId: Hex, from: Hex): Promise<string | null> {
  return revertName(() =>
    h.publicClient.simulateContract({
      address: h.contract,
      abi: mazeBetAbi,
      functionName: 'reclaim',
      args: [gameId],
      account: from,
    }),
  );
}

/** What `settle(...)` sent by `from` would revert with right now, or `null`. */
export function settleRevert(
  h: Harness,
  args: readonly [gameId: Hex, outcome: number, steps: number, payout: bigint, serverSeed: Hex, signature: Hex],
  from: Hex,
): Promise<string | null> {
  return revertName(() =>
    h.publicClient.simulateContract({
      address: h.contract,
      abi: mazeBetAbi,
      functionName: 'settle',
      args,
      account: from,
    }),
  );
}

/** Log lines of one game, in the order they were written. */
export function linesOf(server: Server, gameId: Hex): LogLine[] {
  return server.logs.filter((line) => line.gameId === gameId);
}
