// Read access to the chain (plan §7.4, §7.7). The browser uses its own RPC connection for the
// chain clock and for the state of its game, so both keep working while the game server is down.

import { createPublicClient, defineChain, http, type Chain } from 'viem';
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
  /** Resolves once the transaction is mined. */
  waitForTx(hash: Hex): Promise<'success' | 'reverted'>;
}

export type ChainConfig = Pick<ConfigResponse, 'chainId' | 'rpcUrl' | 'contract'>;

export function chainOf(config: Pick<ConfigResponse, 'chainId' | 'rpcUrl'>): Chain {
  return defineChain({
    id: config.chainId,
    name: config.chainId === 31337 ? 'Anvil' : `Chain ${config.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
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
    async waitForTx(hash) {
      const receipt = await client.waitForTransactionReceipt({ hash });
      return receipt.status;
    },
  };
}
