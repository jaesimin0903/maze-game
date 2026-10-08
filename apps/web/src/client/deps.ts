// Everything the UI reaches outside the page for, in one injectable object: the game server,
// the chain and the wallets. Production uses `defaultDeps`; tests pass fakes.

import type { EIP1193Provider } from 'viem';
import type { ConfigResponse } from '@maze/shared';
import { createApi, type ApiClient } from './api';
import { createChainApi, type ChainApi } from './chain';
import {
  connectDevWallet,
  connectInjectedWallet,
  connectPrivyWallet,
  injectedProvider,
  type WalletApi,
} from './wallet';

export interface ClientDeps {
  api: ApiClient;
  chain(config: ConfigResponse): ChainApi;
  injected(): EIP1193Provider | null;
  connectInjected(config: ConfigResponse, provider: EIP1193Provider): Promise<WalletApi>;
  connectDev(config: ConfigResponse, index: number): Promise<WalletApi>;
  /** The embedded wallet of a Privy login, from its EIP-1193 provider. */
  connectPrivy(config: ConfigResponse, provider: EIP1193Provider): Promise<WalletApi>;
  timing: {
    /** `GET /api/games/:id` period while a game is in progress (plan §7.3: 3 seconds). */
    pollMs: number;
    /** Period of the block-timestamp read. Blocks arrive every second. */
    clockMs: number;
    /** Retry period while the server has not yet seen the bet transaction. */
    startRetryMs: number;
    /**
     * How long a Privy login's wallet may take to appear, and then to connect, before the page
     * says so and offers to try again (default 20 seconds).
     */
    walletWaitMs?: number;
  };
}

export const defaultDeps: ClientDeps = {
  api: createApi(),
  chain: createChainApi,
  injected: injectedProvider,
  connectInjected: connectInjectedWallet,
  connectDev: connectDevWallet,
  connectPrivy: connectPrivyWallet,
  timing: { pollMs: 3000, clockMs: 1000, startRetryMs: 500 },
};
