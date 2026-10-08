'use client';

import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import type { ConfigResponse } from '@maze/shared';
import type { ChainApi } from '../chain';
import type { ClientDeps } from '../deps';
import { formatEth } from '../format';
import { DEV_ACCOUNT_INDEXES, describeTxError, walletOptions, type WalletApi, type WalletKind } from '../wallet';
import { Boundary } from './Boundary';

// Privy's SDK is large: it is fetched only when the server names a Privy app.
const PrivyWallet = lazy(() => import('./PrivyWallet').then((m) => ({ default: m.PrivyWallet })));

const WALLET_LABEL: Record<WalletKind, string> = {
  dev: 'Dev wallet',
  injected: 'Browser wallet',
  privy: 'Account wallet',
};

interface Props {
  config: ConfigResponse;
  deps: ClientDeps;
  chain: ChainApi;
  wallet: WalletApi | null;
  onWallet(wallet: WalletApi | null): void;
  /** Changes whenever the balance may have changed (a game started, ended or was settled). */
  refreshKey: string;
}

/**
 * Wallet connection. `wallet-connect` is the browser-wallet path; `wallet-dev-option` is the
 * Anvil dev wallet and is rendered only when the server's config enables it. With a Privy app in
 * the config, `privy-login` comes first: email, Google, a passkey or an external wallet, and the
 * account chip with its panel once the login's wallet is connected.
 */
export function WalletButton({ config, deps, chain, wallet, onWallet, refreshKey }: Props) {
  const options = walletOptions(config, deps.injected() !== null);
  const symbol = config.network?.symbol ?? 'ETH';
  const privyAppId = typeof config.privyAppId === 'string' && config.privyAppId !== '' ? config.privyAppId : null;
  const [devIndex, setDevIndex] = useState<number>(DEV_ACCOUNT_INDEXES[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [pending, setPending] = useState(0n);
  /** The wallet the Privy login connected, to tell it from one connected another way. */
  const [viaPrivy, setViaPrivy] = useState<WalletApi | null>(null);
  /** Privy itself cannot run (its code did not load, or the SDK did not start); `privyRound` mounts it again. */
  const [privyFailed, setPrivyFailed] = useState(false);
  const [privyRound, setPrivyRound] = useState(0);
  // While Privy is down an external wallet it connected shows as any other, so the game keeps it.
  const owned = wallet !== null && wallet === viaPrivy && !privyFailed;

  const connect = useCallback(
    async (open: () => Promise<WalletApi>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        onWallet(await open());
      } catch (cause) {
        setError(describeTxError(cause));
      } finally {
        setBusy(false);
      }
    },
    [onWallet],
  );

  const connectInjected = (): void => {
    const provider = deps.injected();
    if (!provider) {
      setError('This browser has no wallet extension');
      return;
    }
    void connect(() => deps.connectInjected(config, provider));
  };

  const address = wallet?.address ?? null;
  const refresh = useCallback(async (): Promise<void> => {
    if (address === null) return;
    try {
      const [nextBalance, nextPending] = await Promise.all([
        chain.balanceOf(address),
        chain.pendingOf(address),
      ]);
      setBalance(nextBalance);
      setPending(nextPending);
    } catch {
      // The chain clock already reports an unreachable RPC.
    }
  }, [address, chain]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const disconnect = useCallback((): void => {
    setBalance(null);
    setPending(0n);
    setViaPrivy(null);
    onWallet(null);
  }, [onWallet]);
  const privyConnected = useCallback(
    (next: WalletApi): void => {
      setViaPrivy(next);
      onWallet(next);
    },
    [onWallet],
  );

  const withdraw = async (): Promise<void> => {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      const hash = await wallet.withdrawPending();
      if ((await chain.waitForTx(hash)) !== 'success') throw new Error('The withdrawal transaction was reverted');
    } catch (cause) {
      setError(describeTxError(cause));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  /**
   * The Privy login failed. `session`: its UI threw, while Privy itself still runs (see
   * `PrivyWallet`), so its wallet keeps working. `provider`: Privy itself is down; its code did
   * not load, or the SDK refused to start (an app id it does not accept, a page served over plain
   * http from a host other than localhost) or could not load the app. The embedded wallet signs
   * through Privy and is dropped; an external wallet the login connected does not need Privy and
   * stays. Either way the header offers Retry log in.
   */
  const privyDown = useCallback(
    (scope: 'session' | 'provider'): void => {
      setError('Log in failed to load.');
      if (scope === 'session') return;
      setPrivyFailed(true);
      if (wallet !== null && wallet === viaPrivy && wallet.kind === 'privy') disconnect();
    },
    [wallet, viaPrivy, disconnect],
  );

  const retryPrivy = (): void => {
    setPrivyFailed(false);
    setError(null);
    setPrivyRound((r) => r + 1);
  };

  const privyRetry = (wallet === null || wallet === viaPrivy) && (
    <button type="button" className="quiet" data-testid="privy-retry" onClick={retryPrivy}>
      Retry log in
    </button>
  );

  // The Privy part keeps its place (and its login session) whichever way a wallet is connected:
  // the log-in button, the account chip of its own wallet, or nothing while another wallet plays.
  // A fault in its own UI stays inside it, with Privy still running (see `PrivyWallet`).
  const privy = privyAppId !== null && (
    <Boundary key={`privy-${privyRound}`} name="Privy" onError={() => privyDown('provider')} fallback={privyRetry}>
      {privyFailed ? (
        privyRetry
      ) : (
        <Suspense
          fallback={
            wallet === null && (
              <button type="button" className="primary" data-testid="privy-login" disabled>
                Log in
              </button>
            )
          }
        >
          <PrivyWallet
            appId={privyAppId}
            config={config}
            deps={deps}
            chain={chain}
            wallet={wallet}
            owned={owned}
            balance={balance}
            onConnect={privyConnected}
            onDisconnect={disconnect}
            onError={setError}
            onUnavailable={privyDown}
            onRefresh={() => void refresh()}
          />
        </Suspense>
      )}
    </Boundary>
  );

  const withdrawPending = pending > 0n && (
    <button
      type="button"
      className="quiet"
      data-testid="withdraw-pending"
      data-wei={pending.toString()}
      disabled={busy}
      onClick={() => void withdraw()}
    >
      Withdraw {formatEth(pending)} {symbol} held for you
    </button>
  );

  if (wallet && owned) {
    return (
      <div className="wallet" data-connected="true">
        {withdrawPending}
        {privy}
        {error && (
          <p className="wallet-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (wallet) {
    return (
      <div className="wallet" data-connected="true">
        {privy}
        <span className="stat-chip" title={WALLET_LABEL[wallet.kind]}>
          <span className="wallet-dot" aria-hidden="true" />
          <span className="sr-only">{WALLET_LABEL[wallet.kind]}</span>
          <code className="wallet-address" data-testid="wallet-address" data-kind={wallet.kind}>
            {wallet.address}
          </code>
          <span
            className="wallet-balance"
            data-testid="wallet-balance"
            data-wei={balance?.toString() ?? ''}
          >
            {balance === null ? '...' : `${formatEth(balance, 4)} ${symbol}`}
          </span>
        </span>
        {withdrawPending}
        <button type="button" className="quiet" data-testid="wallet-disconnect" onClick={disconnect}>
          Disconnect
        </button>
        {error && (
          <p className="wallet-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="wallet" data-connected="false">
      {privy}
      <button
        type="button"
        className={privy && !privyFailed ? 'quiet' : 'primary'}
        data-testid="wallet-connect"
        disabled={busy}
        onClick={connectInjected}
      >
        Connect wallet
      </button>
      {options.dev && (
        <span className="wallet">
          <button
            type="button"
            data-testid="wallet-dev-option"
            data-account-index={devIndex}
            disabled={busy}
            onClick={() => void connect(() => deps.connectDev(config, devIndex))}
          >
            Use dev wallet
          </button>
          <label className="wallet-dev-account">
            <span className="sr-only">Anvil account</span>
            <select
              data-testid="wallet-dev-account"
              value={devIndex}
              disabled={busy}
              onChange={(event) => setDevIndex(Number(event.target.value))}
            >
              {DEV_ACCOUNT_INDEXES.map((index) => (
                <option key={index} value={index}>
                  Anvil #{index}
                </option>
              ))}
            </select>
          </label>
        </span>
      )}
      {error && (
        <p className="wallet-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
