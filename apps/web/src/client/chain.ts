// Read access to the chain (plan §7.4, §7.7). The browser uses its own RPC connection for the
// chain clock and for the state of its game, so both keep working while the game server is down.

import {
  createPublicClient,
  defineChain,
  http,
  isAddressEqual,
  parseEventLogs,
  TransactionReceiptNotFoundError,
  type Chain,
} from 'viem';
import { mazeBetAbi, type ConfigResponse, type Hex } from '@maze/shared';

/** `getGame(gameId)`. `status` follows `ONCHAIN_STATUS`; times are chain seconds. */
export interface OnchainGame {
  player: Hex;
  tier: number;
  status: number;
  createdAt: number;
  settleDeadline: number;
  bet: bigint;
  maxPayout: bigint;
  commitment: Hex;
  clientSeed: Hex;
}

export interface ChainApi {
  /** Timestamp of the latest block, in seconds. */
  now(): Promise<number>;
  game(gameId: Hex): Promise<OnchainGame>;
  /** Payouts the contract could not deliver and holds for `address`. */
  pendingOf(address: Hex): Promise<bigint>;
  balanceOf(address: Hex): Promise<bigint>;
  /** The chain's current gas price in wei, for the fee a transaction needs. */
  gasPrice(): Promise<bigint>;
  /**
   * The most per gas a wallet bids for a transaction now, which the chain wants covered up front:
   * viem's `maxFeePerGas` (base fee × 1.2 plus the priority fee, the rule Privy's embedded wallet
   * uses), or the gas price × 6/5 on a chain without EIP-1559 fees.
   */
  maxFeePerGas(): Promise<bigint>;
  /** Gas a transfer of `valueWei` from `from` to `to` uses (`eth_estimateGas`; more for a contract). */
  estimateTransferGas(p: { from: Hex; to: Hex; valueWei: bigint }): Promise<bigint>;
  /** Resolves once the transaction is mined. */
  waitForTx(hash: Hex): Promise<'success' | 'reverted'>;
  /**
   * What transaction `hash` cost its sender in fees: gas used × effective gas price from its
   * receipt (on Monad gas used is the whole limit, which is what it charges). `null` while the
   * transaction has no receipt.
   */
  txFee(hash: Hex): Promise<bigint | null>;
  /**
   * Whether `hash` is the transaction that settled `gameId`: it is mined, it succeeded and the
   * contract's `GameSettled` event of that game is in its receipt. `false` for a transaction
   * that is pending, dropped, reverted, or about something else.
   */
  settledBy(hash: Hex, gameId: Hex): Promise<boolean>;
}

export type ChainConfig = Pick<ConfigResponse, 'chainId' | 'rpcUrl' | 'contract' | 'network'>;

export function chainOf(config: Pick<ConfigResponse, 'chainId' | 'rpcUrl' | 'network'>): Chain {
  const network = config.network;
  const symbol = network?.symbol ?? 'ETH';
  return defineChain({
    id: config.chainId,
    name: network?.name ?? (config.chainId === 31337 ? 'Anvil' : `Chain ${config.chainId}`),
    nativeCurrency: { name: symbol === 'ETH' ? 'Ether' : symbol, symbol, decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    ...(network?.explorerUrl
      ? { blockExplorers: { default: { name: network.name, url: network.explorerUrl } } }
      : {}),
  });
}

export function createChainApi(config: ChainConfig): ChainApi {
  const client = createPublicClient({
    chain: chainOf(config),
    transport: http(config.rpcUrl),
    pollingInterval: 500,
  });
  const contract = { address: config.contract, abi: mazeBetAbi } as const;

  return {
    async now() {
      const block = await client.getBlock({ blockTag: 'latest' });
      return Number(block.timestamp);
    },
    async game(gameId) {
      const g = await client.readContract({ ...contract, functionName: 'getGame', args: [gameId] });
      return {
        player: g.player,
        tier: g.tier,
        status: g.status,
        createdAt: Number(g.createdAt),
        settleDeadline: Number(g.settleDeadline),
        bet: g.bet,
        maxPayout: g.maxPayout,
        commitment: g.commitment,
        clientSeed: g.clientSeed,
      };
    },
    pendingOf: (address) =>
      client.readContract({ ...contract, functionName: 'pendingWithdrawals', args: [address] }),
    balanceOf: (address) => client.getBalance({ address }),
    gasPrice: () => client.getGasPrice(),
    async maxFeePerGas() {
      try {
        return (await client.estimateFeesPerGas()).maxFeePerGas;
      } catch {
        return ((await client.getGasPrice()) * 6n) / 5n;
      }
    },
    estimateTransferGas: ({ from, to, valueWei }) => client.estimateGas({ account: from, to, value: valueWei }),
    async waitForTx(hash) {
      const receipt = await client.waitForTransactionReceipt({ hash });
      return receipt.status;
    },
    async txFee(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return receipt.gasUsed * receipt.effectiveGasPrice;
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
    async settledBy(hash, gameId) {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return false;
        throw error;
      }
      if (receipt.status !== 'success') return false;
      return parseEventLogs({ abi: mazeBetAbi, eventName: 'GameSettled', logs: receipt.logs }).some(
        (log) =>
          isAddressEqual(log.address, config.contract) &&
          log.args.gameId.toLowerCase() === gameId.toLowerCase(),
      );
    },
  };
}
