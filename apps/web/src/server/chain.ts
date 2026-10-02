// Chain access and the GameCreated / GameSettled / GameReclaimed watcher (plan §3.7, §7.8).
//
// `ChainPort` is everything the server asks of the chain. `createViemChain` implements it over
// JSON-RPC; unit tests substitute an in-memory chain.

import { mazeBetAbi, type Hex } from '@maze/shared';
import {
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
  head(): Promise<ChainHead>;
  /** Hash of the block with that number, or `null` when the chain has no such block. */
  blockHash(blockNumber: bigint): Promise<Hex | null>;
  /** The contract's game events in the inclusive block range, in chain order. */
  events(fromBlock: bigint, toBlock: bigint): Promise<ChainEvent[]>;
  /** `getGame` as of the end of `blockNumber` (the latest block when omitted). */
  game(gameId: Hex, blockNumber?: bigint): Promise<OnchainGame>;
  tableHash(): Promise<Hex>;
  serverSigner(): Promise<Hex>;
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
    head: () =>
      read(async () => {
        const block = await publicClient.getBlock({ blockTag: 'latest' });
        return { number: block.number, timestamp: Number(block.timestamp), hash: block.hash };
      }),
    blockHash: (blockNumber) =>
      read(async () => {
        const latest = await publicClient.getBlock({ blockTag: 'latest' });
        if (blockNumber > latest.number) return null;
        return (await publicClient.getBlock({ blockNumber })).hash;
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
/** A marker is stored at least this often even when no game event occurs. */
const MARK_EVERY_BLOCKS = 20n;
const LOG_CHUNK_BLOCKS = 2000n;

/**
 * Reads the contract's game events block range by block range and hands them to `onEvent` in
 * chain order. The server's clock for a game starts from what this reads, never from an HTTP
 * call. Events may be delivered more than once (after a reboot, or when a scan fails half
 * way), so `onEvent` must be idempotent.
 */
export class Watcher {
  private readonly mutex = new Mutex();
  /** Highest block whose events have been delivered. */
  private scannedTo: bigint;
  private markedAt: bigint;

  constructor(
    private readonly deps: {
      chain: ChainPort;
      store: EventStore;
      clock: Clock;
      onEvent: (event: ChainEvent) => Promise<void>;
      /** When false, `sync` does nothing: the server never learns about the chain's games. */
      enabled: boolean;
    },
    private readonly marker: ScanMarker | null,
  ) {
    const resumeFrom = marker === null ? 0n : marker.blockNumber - REWIND_BLOCKS;
    this.scannedTo = (resumeFrom < 0n ? 0n : resumeFrom) - 1n;
    this.markedAt = marker === null ? -1n : marker.blockNumber;
  }

  /**
   * True when the stored marker is a block of the connected chain. A data directory that was
   * written against another chain instance (for example an Anvil that was restarted) would make
   * the scan skip the blocks in which new games are created.
   */
  async markerMatchesChain(): Promise<boolean> {
    if (this.marker === null) return true;
    const hash = await this.deps.chain.blockHash(this.marker.blockNumber);
    return hash !== null && hash.toLowerCase() === this.marker.blockHash.toLowerCase();
  }

  /** Delivers every event up to the latest block. Calls are serialized. */
  sync(): Promise<void> {
    if (!this.deps.enabled) return Promise.resolve();
    return this.mutex.run(async () => {
      const { chain, store, clock } = this.deps;
      const head = await chain.head();
      clock.observe?.(head.timestamp);
      if (head.number <= this.scannedTo) return;

      let delivered = false;
      while (this.scannedTo < head.number) {
        const from = this.scannedTo + 1n;
        const to = from + LOG_CHUNK_BLOCKS - 1n < head.number ? from + LOG_CHUNK_BLOCKS - 1n : head.number;
        for (const event of await chain.events(from, to)) {
          await this.deps.onEvent(event);
          delivered = true;
        }
        this.scannedTo = to;
      }
      if (delivered || head.number - this.markedAt >= MARK_EVERY_BLOCKS) {
        await store.append({
          type: 'block-scanned',
          blockNumber: head.number.toString(),
          blockHash: head.hash,
        });
        this.markedAt = head.number;
      }
    });
  }
}
