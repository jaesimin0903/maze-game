'use client';

// Login with Privy: email, Google, a passkey or an external wallet. Loaded only when the server
// names a Privy app. A player without a wallet of their own gets an embedded one, used as a plain
// account (no session keys, no smart account) with Privy's confirmation screens turned off, so the
// ticket signature and the bet transaction go through without a popup: the console's screen names
// the bet and its fee ("A: BET 0.010 MON"), and pressing A is the player's consent. A player who
// logs in with an external wallet plays with that wallet, which asks for both signatures as a
// browser wallet does.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EIP1193Provider } from 'viem';
import {
  PrivyProvider,
  useCreateWallet,
  useExportWallet,
  useLogout,
  usePrivy,
  useWallets,
  type ConnectedWallet,
  type PrivyClientConfig,
} from '@privy-io/react-auth';
import type { ConfigResponse } from '@maze/shared';
import { chainOf, type ChainApi } from '../chain';
import type { ClientDeps } from '../deps';
import { shortHex } from '../format';
import { describeTxError, type WalletApi } from '../wallet';
import { AccountPanel } from './AccountPanel';
import { Boundary } from './Boundary';

export interface PrivyWalletProps {
  appId: string;
  config: ConfigResponse;
  deps: Pick<ClientDeps, 'connectPrivy' | 'connectInjected' | 'timing'>;
  chain: Pick<ChainApi, 'gasPrice' | 'estimateTransferGas' | 'waitForTx'>;
  /** The page's wallet, however it was connected. */
  wallet: WalletApi | null;
  /** Whether `wallet` is the one this login connected. */
  owned: boolean;
  balance: bigint | null;
  onConnect(wallet: WalletApi): void;
  onDisconnect(): void;
  onError(message: string | null): void;
  /** The login failed: its UI threw (`session`), or Privy itself could not start (`provider`). */
  onUnavailable(scope: 'session' | 'provider'): void;
  onRefresh(): void;
}

/** Privy's settings: the login methods, the page's colours, and the one chain the game runs on. */
export function privyConfig(config: Pick<ConfigResponse, 'chainId' | 'rpcUrl' | 'network'>): PrivyClientConfig {
  const chain = chainOf(config);
  return {
    // Every method listed here must also be enabled for the app in the Privy dashboard.
    loginMethods: ['email', 'google', 'passkey', 'wallet'],
    appearance: {
      theme: '#14111f',
      accentColor: '#ffcc33',
      landingHeader: 'Log in to Maze Bet',
      walletChainType: 'ethereum-only',
    },
    embeddedWallets: {
      ethereum: { createOnLogin: 'users-without-wallets' },
      showWalletUIs: false,
    },
    // The embedded wallet sends through the chain's own RPC URL, the one `/api/config` names.
    defaultChain: chain,
    supportedChains: [chain],
  };
}

export function PrivyWallet(props: PrivyWalletProps) {
  const { config, wallet, owned } = props;
  const settings = useMemo(() => privyConfig(config), [config]);
  /** Mounts the session UI again after it failed. */
  const [round, setRound] = useState(0);
  // A fault in the login's own UI stays inside the provider, so Privy and the embedded wallet it
  // signs for keep running: a game in play keeps its wallet, shown as a plain chip until Retry.
  return (
    <PrivyProvider appId={props.appId} config={settings}>
      <Boundary
        key={round}
        name="Privy login"
        onError={() => props.onUnavailable('session')}
        fallback={
          <>
            {wallet !== null && owned && (
              <span className="stat-chip" title={wallet.address}>
                <span className="wallet-dot" aria-hidden="true" />
                <span className="sr-only">Account wallet</span>
                <code className="wallet-address" data-testid="wallet-address" data-kind={wallet.kind}>
                  {shortHex(wallet.address)}
                </code>
              </span>
            )}
            {(wallet === null || owned) && (
              <button
                type="button"
                className="quiet"
                data-testid="privy-retry"
                onClick={() => {
                  props.onError(null);
                  setRound((r) => r + 1);
                }}
              >
                Retry log in
              </button>
            )}
          </>
        }
      >
        <PrivySession {...props} />
      </Boundary>
    </PrivyProvider>
  );
}

/** The wallet a login plays with: its embedded wallet, else the external wallet it logged in with. */
function playWallet(wallets: ConnectedWallet[]): ConnectedWallet | null {
  return wallets.find((w) => w.walletClientType === 'privy') ?? wallets.find((w) => w.linked) ?? null;
}

/** How long a login's wallet may take to appear, and then to connect, before the page says so. */
const WALLET_WAIT_MS = 20_000;

class TimedOut extends Error {}

/** `promise`, or a `TimedOut` rejection once `ms` have passed without it settling. */
function timeLimit<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut()), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function PrivySession(p: PrivyWalletProps) {
  const { config, deps, wallet, owned, onConnect, onDisconnect, onError, onUnavailable } = p;
  const { ready, authenticated, user, login, connectWallet, error: failure } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { logout } = useLogout();
  const { exportWallet } = useExportWallet();
  const { createWallet } = useCreateWallet();
  const waitMs = deps.timing.walletWaitMs ?? WALLET_WAIT_MS;
  const [connecting, setConnecting] = useState(false);
  /** The address whose connection failed. It is tried again only when the player asks. */
  const [failed, setFailed] = useState<string | null>(null);
  /** Counts connection attempts; a log-out or a newer attempt makes an older one's answer moot. */
  const attempt = useRef(0);
  const inFlight = useRef(false);
  /** Set from the log-out click until Privy reports the session gone, so nothing reconnects. */
  const leaving = useRef(false);
  /** The login's wallet did not appear in time; `round` starts the wait again. */
  const [late, setLate] = useState(false);
  const [round, setRound] = useState(0);
  /** Mounts the account panel again after it failed. */
  const [panelRound, setPanelRound] = useState(0);
  const target = authenticated && walletsReady ? playWallet(wallets) : null;
  // An external wallet the user logged in with that this browser has not connected yet.
  const external =
    target === null && walletsReady && user?.wallet !== undefined && user.wallet.walletClientType !== 'privy';
  const waiting = authenticated && wallet === null && target === null && !external;

  const connect = useCallback(
    async (w: ConnectedWallet): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      const mine = ++attempt.current;
      setConnecting(true);
      onError(null);
      try {
        // The embedded wallet answers from Privy's iframe, which may never answer (blocked iframe
        // or storage), so its whole connection is timed. An external wallet may be showing the
        // player its own prompt (switch or add the chain): only its provider lookup is timed.
        let next: WalletApi;
        if (w.walletClientType === 'privy') {
          next = await timeLimit(
            (async () => deps.connectPrivy(config, (await w.getEthereumProvider()) as EIP1193Provider))(),
            waitMs,
          );
        } else {
          const provider = (await timeLimit(w.getEthereumProvider(), waitMs)) as EIP1193Provider;
          next = await deps.connectInjected(config, provider);
        }
        if (mine !== attempt.current) return;
        setFailed(null);
        onConnect(next);
      } catch (cause) {
        if (mine !== attempt.current) return;
        setFailed(w.address);
        onError(
          cause instanceof TimedOut
            ? `The account wallet did not answer within ${Math.round(waitMs / 1000)} seconds. Press Connect to try again`
            : describeTxError(cause),
        );
      } finally {
        if (mine === attempt.current) {
          inFlight.current = false;
          setConnecting(false);
        }
      }
    },
    [config, deps, onConnect, onError, waitMs],
  );

  // Connect as soon as the login has its wallet, and again after a reload once Privy has restored
  // the session, so the last game's result comes back with it.
  useEffect(() => {
    if (target === null || wallet !== null || leaving.current || failed === target.address) return;
    void connect(target);
  }, [target, wallet, failed, connect]);

  // A login whose wallet never shows up: its creation failed, or Privy's iframe or storage is blocked.
  const hasWallet = user?.wallet !== undefined;
  useEffect(() => {
    setLate(false);
    if (!waiting) return;
    const timer = setTimeout(() => {
      setLate(true);
      onError(
        hasWallet
          ? 'Your account wallet did not load. Reload the page to try again, or log out'
          : 'No account wallet was created for this login. Press Create wallet to try again, or log out',
      );
    }, waitMs);
    return () => clearTimeout(timer);
  }, [waiting, hasWallet, round, waitMs, onError]);

  const retryWallet = (): void => {
    if (hasWallet) {
      window.location.reload();
      return;
    }
    onError(null);
    setRound((r) => r + 1);
    createWallet().catch((cause: unknown) => onError(describeTxError(cause)));
  };

  // A session that ends elsewhere (a log-out in another tab, an expired login) takes its wallet.
  useEffect(() => {
    if (!ready || authenticated) return;
    leaving.current = false;
    if (owned) onDisconnect();
  }, [ready, authenticated, owned, onDisconnect]);

  const logOut = async (): Promise<void> => {
    leaving.current = true;
    // A connection still on its way is dropped, whatever it answers later.
    attempt.current += 1;
    inFlight.current = false;
    setConnecting(false);
    try {
      await logout();
    } catch (cause) {
      leaving.current = false;
      throw cause;
    }
    onDisconnect();
  };

  // An SDK that could not start (Privy does not know the app id, or this site is not one of the
  // app's allowed origins) never becomes ready: Privy itself is down.
  const down = !ready && failure !== null && failure !== undefined;
  useEffect(() => {
    if (down) onUnavailable('provider');
  }, [down, onUnavailable]);
  if (down) return null;

  if (wallet !== null) {
    if (!owned) return null;
    // A fault in the panel leaves the wallet connected (a game may be running): only the panel
    // gives way, to the address and a button that mounts it again.
    return (
      <Boundary
        key={panelRound}
        name="Account panel"
        fallback={
          <span className="stat-chip" title={wallet.address}>
            <span className="wallet-dot" aria-hidden="true" />
            <code className="wallet-address" data-testid="wallet-address" data-kind={wallet.kind}>
              {shortHex(wallet.address)}
            </code>
            <button
              type="button"
              className="quiet"
              data-testid="account-retry"
              onClick={() => setPanelRound((r) => r + 1)}
            >
              Reload panel
            </button>
          </span>
        }
      >
        <AccountPanel
          config={config}
          chain={p.chain}
          wallet={wallet}
          balance={p.balance}
          onExport={wallet.kind === 'privy' ? () => exportWallet({ address: wallet.address }) : null}
          onLogout={logOut}
          onRefresh={p.onRefresh}
        />
      </Boundary>
    );
  }

  if (!ready || !authenticated) {
    return (
      <button type="button" className="primary" data-testid="privy-login" disabled={!ready} onClick={() => login()}>
        Log in
      </button>
    );
  }

  // Logged in, and the wallet to play with has not connected: it is on its way, its connection
  // failed or timed out, it never appeared, or it is an external wallet this browser has not
  // connected yet. Log out stays at hand throughout.
  const retry = target !== null && failed === target.address && !connecting;
  return (
    <>
      {retry || external ? (
        <button
          type="button"
          className="primary"
          data-testid="privy-connect"
          onClick={() => (target !== null ? void connect(target) : connectWallet())}
        >
          Connect
        </button>
      ) : waiting && late ? (
        <button type="button" className="primary" data-testid="privy-connect" onClick={retryWallet}>
          {hasWallet ? 'Reload' : 'Create wallet'}
        </button>
      ) : (
        <button type="button" className="primary" data-testid="privy-connect" disabled>
          Connecting...
        </button>
      )}
      <button
        type="button"
        className="quiet"
        data-testid="privy-logout"
        onClick={() => void logOut().catch((cause: unknown) => onError(describeTxError(cause)))}
      >
        Log out
      </button>
    </>
  );
}
