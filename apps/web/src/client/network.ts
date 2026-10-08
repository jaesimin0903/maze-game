// How the page names the chain's money and links to the chain, from `ConfigResponse.network`.
// A server without that block is a local Anvil: bets in ETH, no block explorer.

import { createContext, useContext } from 'react';
import type { ConfigResponse } from '@maze/shared';

export interface NetworkView {
  /** Symbol of the native currency bets are placed in: "ETH", "MON". */
  symbol: string;
  /** Block explorer base URL without a trailing slash, or `null`. */
  explorerUrl: string | null;
}

export function networkView(config: Pick<ConfigResponse, 'network'>): NetworkView {
  return {
    symbol: config.network?.symbol ?? 'ETH',
    explorerUrl: config.network?.explorerUrl?.replace(/\/+$/, '') || null,
  };
}

/** The explorer page of a transaction or an address, or `null` on a chain without an explorer. */
export function explorerLink(explorerUrl: string | null, kind: 'tx' | 'address', value: string): string | null {
  return explorerUrl === null ? null : `${explorerUrl}/${kind}/${value}`;
}

/** The network of the game page. Components outside it (and tests) see a local Anvil. */
export const NetworkContext = createContext<NetworkView>({ symbol: 'ETH', explorerUrl: null });

export function useNetwork(): NetworkView {
  return useContext(NetworkContext);
}
