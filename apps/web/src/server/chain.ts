// Chain access and the GameCreated / GameSettled / GameReclaimed watcher (plan §3.7, §7.8).
//
// `ChainPort` is everything the server asks of the chain. `createViemChain` implements it over
// JSON-RPC; unit tests substitute an in-memory chain.

import { mazeBetAbi, type Hex } from '@maze/shared';
import {
  BlockNotFoundError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseEventLogs,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Clock } from './clock';
import { ApiError } from './errors';
import { Mutex } from './mutex';
import type { EventStore } from './store';

export interface ChainHead {
  number: bigint;
  /** Block timestamp, unix seconds. */
  timestamp: number;
  hash: Hex;
}

/**
 * The block tag the watcher reads the chain at (`MAZE_SCAN_TAG`). On Monad `latest` is a
 * proposed block that may still be replaced; `finalized` cannot be.
 */
export type ScanTag = 'latest' | 'safe' | 'finalized';

interface ChainEventBase {
  blockNumber: bigint;
  txHash: Hex;
  gameId: Hex;
  player: Hex;
}

export type ChainEvent =
  | (ChainEventBase & {
      type: 'created';
      tier: number;
      betWei: bigint;
      maxPayoutWei: bigint;
      commitment: Hex;
      clientSeed: Hex;
      settleDeadlineSec: number;
    })
  | (ChainEventBase & {
      type: 'settled';
      outcome: number;
      steps: number;
      payoutWei: bigint;
      serverSeed: Hex;
    })
  | (ChainEventBase & { type: 'reclaimed'; amountWei: bigint });

/** `getGame(gameId)`. `status` follows `ONCHAIN_STATUS` (0 None, 1 Active, 2 Settled, 3 Reclaimed). */
export interface OnchainGame {
  player: Hex;
  tier: number;
  status: number;
  createdAtSec: number;
  settleDeadlineSec: number;
  betWei: bigint;
  maxPayoutWei: bigint;
  commitment: Hex;
  clientSeed: Hex;
}

export interface SettleArgs {
  gameId: Hex;
  outcome: number;
  steps: number;
  payoutWei: bigint;
  serverSeed: Hex;
  signature: Hex;
}

export interface ChainPort {
  /** Address `settle` transactions are sent from. */
  readonly relayerAddress: Hex;
  chainId(): Promise<number>;
  /** The newest block at `tag`, `latest` when omitted. */
  head(tag?: ScanTag): Promise<ChainHead>;
  /** The block with that number, or `null` when the chain has no such block. */
  block(blockNumber: bigint): Promise<ChainHead | null>;
  /** The contract's game events in the inclusive block range, in chain order. */
  events(fromBlock: bigint, toBlock: bigint): Promise<ChainEvent[]>;
  /** `getGame` as of the end of `blockNumber` (the latest block when omitted). */
  game(gameId: Hex, blockNumber?: bigint): Promise<OnchainGame>;
  tableHash(): Promise<Hex>;
  serverSigner(): Promise<Hex>;
  /** `totalReserved()`: wei held for the games that are `Active`. Zero when there is none. */
  totalReserved(): Promise<bigint>;
  /** The relayer's next nonce, counting transactions still in the node's pool. */
  pendingNonce(): Promise<number>;
  /** Signs and broadcasts `settle` with the fixed gas limit. Resolves to the transaction hash. */
  sendSettle(args: SettleArgs, nonce: number): Promise<Hex>;
}

/** Fixed gas limit of the relayer's `settle` (plan §3.6). `eth_estimateGas` is never used. */
export const SETTLE_GAS_LIMIT = 300_000n;

/** Reads fail as `CHAIN_UNAVAILABLE`, keeping the RPC error as `cause` for the logs. */
async function read<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw new ApiError('CHAIN_UNAVAILABLE', { cause });
  }
}

export function createViemChain(p: {
  rpcUrl: string;
  chainId: number;
  contract: Hex;
  relayerKey: Hex;
}): ChainPort {
  const chain = defineChain({
    id: p.chainId,
    name: `chain-${p.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [p.rpcUrl] } },
  });
  const account = privateKeyToAccount(p.relayerKey);
  // `cacheTime: 0`: the latest block must never be answered from a client-side cache.
  const publicClient = createPublicClient({ chain, transport: http(p.rpcUrl), cacheTime: 0 });
  const walletClient = createWalletClient({ chain, transport: http(p.rpcUrl), account });
  const contract = { address: p.contract, abi: mazeBetAbi } as const;

  return {
    relayerAddress: account.address,
    chainId: () => read(() => publicClient.getChainId()),
    head: (tag = 'latest') =>
      read(async () => {
        const block = await publicClient.getBlock({ blockTag: tag });
        return { number: block.number, timestamp: Number(block.timestamp), hash: block.hash };
      }),
    block: (blockNumber) =>
      read(async () => {
        try {
          const block = await publicClient.getBlock({ blockNumber });
          return { number: block.number, timestamp: Number(block.timestamp), hash: block.hash };
        } catch (error) {
          if (error instanceof BlockNotFoundError) return null;
          throw error;
        }
      }),
    events: (fromBlock, toBlock) =>
      read(async () => {
        const logs = await publicClient.getLogs({ address: p.contract, fromBlock, toBlock });
        const parsed = parseEventLogs({
          abi: mazeBetAbi,
          logs,
          eventName: ['GameCreated', 'GameSettled', 'GameReclaimed'],
          strict: true,
        });
        return parsed.map((log): ChainEvent => {
          const base = {
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            gameId: log.args.gameId,
            player: log.args.player,
          };
          if (log.eventName === 'GameCreated') {
            return {
              ...base,
              type: 'created',
              tier: log.args.tier,
              betWei: log.args.bet,
              maxPayoutWei: log.args.maxPayout,
              commitment: log.args.commitment,
              clientSeed: log.args.clientSeed,
              settleDeadlineSec: Number(log.args.settleDeadline),
            };
          }
          if (log.eventName === 'GameSettled') {
            return {
              ...base,
              type: 'settled',
              outcome: log.args.outcome,
              steps: log.args.steps,
              payoutWei: log.args.payout,
              serverSeed: log.args.serverSeed,
            };
          }
          return { ...base, type: 'reclaimed', amountWei: log.args.amount };
        });
      }),
    game: (gameId, blockNumber) =>
      read(async () => {
        const game = await publicClient.readContract({
          ...contract,
          functionName: 'getGame',
          args: [gameId],
          ...(blockNumber === undefined ? {} : { blockNumber }),
        });
        return {
          player: game.player,
          tier: game.tier,
          status: game.status,
          createdAtSec: Number(game.createdAt),
          settleDeadlineSec: Number(game.settleDeadline),
          betWei: game.bet,
          maxPayoutWei: game.maxPayout,
          commitment: game.commitment,
          clientSeed: game.clientSeed,
        };
      }),
    tableHash: () => read(() => publicClient.readContract({ ...contract, functionName: 'tableHash' })),
    serverSigner: () =>
      read(() => publicClient.readContract({ ...contract, functionName: 'serverSigner' })),
    totalReserved: () =>
      read(() => publicClient.readContract({ ...contract, functionName: 'totalReserved' })),
    pendingNonce: () =>
      read(() =>
        publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      ),
    sendSettle: (args, nonce) =>
      walletClient.sendTransaction({
        to: p.contract,
        data: encodeFunctionData({
          abi: mazeBetAbi,
          functionName: 'settle',
          args: [
            args.gameId,
            args.outcome,
            args.steps,
            args.payoutWei,
            args.serverSeed,
            args.signature,
          ],
        }),
        gas: SETTLE_GAS_LIMIT,
        nonce,
      }),
  };
}

/** The last block the server recorded as scanned, with its hash. */
export interface ScanMarker {
  blockNumber: bigint;
  blockHash: Hex;
}

/** Booting rescans this many blocks before the stored marker (plan §7.8). */
const REWIND_BLOCKS = 5n;
/** A marker is stored at least this often, in chain seconds, even when no game event occurs. */
export const MARK_EVERY_SEC = 60;
/** A long scan stores a marker after this many ranges, so that a restart resumes close by. */
export const MARK_EVERY_RANGES = 10;

/**
 * The newest of `markers` (in log order) whose block the connected chain still has with the same
 * hash, or `null` when the chain has the log's first marked block with another hash: the log was
 * written against another chain instance (for example an Anvil that was restarted). A marker on a
 * block that was replaced would make the scan skip the blocks in which new games are created; the
 * scan resumes from an older marker instead.
 *
 * Fails, as a read failure, when the node does not have the first marked block at all: a node
 * that is behind, out of sync or pruned says nothing about the log, which must not be given up.
 */
export async function findResumeMarker(
  chain: Pick<ChainPort, 'block' | 'head'>,
  markers: readonly ScanMarker[],
): Promise<ScanMarker | null> {
  if (markers.length === 0) return null;
  const onChain = async (marker: ScanMarker): Promise<boolean> => {
    const block = await chain.block(marker.blockNumber);
    return block !== null && block.hash.toLowerCase() === marker.blockHash.toLowerCase();
  };
  // Every marker is at or after the log's first one. A chain that has that block with another
  // hash has none of the later ones either, so one read settles the case of another chain.
  const first = await chain.block(markers[0].blockNumber);
  if (first === null) {
    const head = await chain.head();
    throw new Error(
      head.number >= markers[0].blockNumber
        ? `the node's latest block is ${head.number}, but it has no block ${markers[0].blockNumber}: it is out of sync or pruned`
        : `the node is at block ${head.number}, behind block ${markers[0].blockNumber} of the event log: it may still be syncing`,
    );
  }
  if (first.hash.toLowerCase() !== markers[0].blockHash.toLowerCase()) return null;
  const checked = new Set<string>();
  for (let i = markers.length - 1; i > 0; i--) {
    const key = `${markers[i].blockNumber}:${markers[i].blockHash.toLowerCase()}`;
    if (checked.has(key)) continue;
    checked.add(key);
    if (await onChain(markers[i])) return markers[i];
  }
  return markers[0];
}

/**
 * Reads the contract's game events block range by block range and hands them to `onEvent` in
 * chain order. The server's clock for a game starts from what this reads, never from an HTTP
 * call. Events may be delivered more than once (after a reboot, or when a scan fails half
 * way), so `onEvent` must be idempotent.
 *
 * The chain is read at `scanTag`: an event is delivered, and a marker stored, only once its block
 * has reached that state.
 */
export class Watcher {
  private readonly mutex = new Mutex();
  /** Highest block whose events have been delivered; `null` until the first scan picks one. */
  private scannedTo: bigint | null;
  /** Timestamp of the block of the last marker this process stored. */
  private markedAtSec: number | null = null;
  private scannedSec: number | null = null;

  constructor(
    private readonly deps: {
      chain: ChainPort;
      store: EventStore;
      clock: Clock;
      onEvent: (event: ChainEvent) => Promise<void>;
      /** When false, `sync` does nothing: the server never learns about the chain's games. */
      enabled: boolean;
      scanTag: ScanTag;
      /**
       * Where the scan starts when there is no marker. `null`: at the head the first scan sees,
       * which is right for a log that holds no ticket yet.
       */
      startBlock: bigint | null;
      /** Most blocks per `events` call: RPC providers cap the block range of `eth_getLogs`. */
      logChunkBlocks: bigint;
    },
    marker: ScanMarker | null,
  ) {
    const resumeFrom = marker === null ? deps.startBlock : marker.blockNumber - REWIND_BLOCKS;
    this.scannedTo = resumeFrom === null ? null : (resumeFrom < 0n ? 0n : resumeFrom) - 1n;
  }

  /**
   * Timestamp of the latest block up to which every event has been delivered, or `null` before
   * the first complete scan. A ticket that expired before this time and whose `GameCreated` was
   * not among those events can never create a game.
   */
  get scannedTimeSec(): number | null {
    return this.scannedSec;
  }

  /**
   * Delivers every event up to the head at the scan tag. Calls are serialized. When the handling
   * of an event fails, the other events of the range are still delivered, so that one game
   * cannot keep the server from learning about the others; the call then fails and the range is
   * read again by the next one.
   *
   * The first successful call of a process always stores a marker, so a log never holds a ticket
   * without one.
   */
  sync(): Promise<void> {
    if (!this.deps.enabled) return Promise.resolve();
    return this.mutex.run(async () => {
      const { chain, clock, scanTag } = this.deps;
      const head = await chain.head(scanTag);
      // The clock tells the time of the latest block; an older block's must not hold it back.
      if (scanTag === 'latest') clock.observe?.(head.timestamp);
      let scannedTo = this.scannedTo ?? head.number - 1n;
      this.scannedTo = scannedTo;

      const chunk = this.deps.logChunkBlocks;
      let delivered = false;
      let ranges = 0;
      while (scannedTo < head.number) {
        const from = scannedTo + 1n;
        const to = from + chunk - 1n < head.number ? from + chunk - 1n : head.number;
        let failure: { error: unknown } | null = null;
        for (const event of await chain.events(from, to)) {
          try {
            await this.deps.onEvent(event);
            delivered = true;
          } catch (error) {
            failure ??= { error };
          }
        }
        if (failure !== null) throw failure.error;
        this.scannedTo = scannedTo = to;
        ranges += 1;
        if (to < head.number && ranges % MARK_EVERY_RANGES === 0) {
          const block = await chain.block(to);
          if (block !== null) await this.mark(block);
        }
      }
      if (delivered || this.markedAtSec === null || head.timestamp - this.markedAtSec >= MARK_EVERY_SEC) {
        await this.mark(head);
      }
      this.scannedSec = head.timestamp;
    });
  }

  private async mark(block: ChainHead): Promise<void> {
    await this.deps.store.append({
      type: 'block-scanned',
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      timestampSec: block.timestamp,
    });
    this.markedAtSec = block.timestamp;
  }
}
