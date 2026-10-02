'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ConfigResponse } from '@maze/shared';
import type { ChainApi } from '../chain';
import type { ClientDeps } from '../deps';
import { formatEth } from '../format';
import { DEV_ACCOUNT_INDEXES, describeTxError, walletOptions, type WalletApi } from '../wallet';

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
 * Anvil dev wallet and is rendered only when the server's config enables it.
 */
export function WalletButton({ config, deps, chain, wallet, onWallet, refreshKey }: Props) {
  const options = walletOptions(config, deps.injected() !== null);
  const [devIndex, setDevIndex] = useState<number>(DEV_ACCOUNT_INDEXES[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [pending, setPending] = useState(0n);

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
      setError('이 브라우저에는 지갑 확장이 없습니다');
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

  const withdraw = async (): Promise<void> => {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      const hash = await wallet.withdrawPending();
      if ((await chain.waitForTx(hash)) !== 'success') throw new Error('인출 트랜잭션이 되돌려졌습니다');
    } catch (cause) {
      setError(describeTxError(cause));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  if (wallet) {
    return (
      <div className="wallet" data-connected="true">
        <span className="wallet-kind">{wallet.kind === 'dev' ? '개발용 지갑' : '브라우저 지갑'}</span>
        <code className="wallet-address" data-testid="wallet-address" data-kind={wallet.kind}>
          {wallet.address}
        </code>
        <span
          className="wallet-balance"
          data-testid="wallet-balance"
          data-wei={balance?.toString() ?? ''}
        >
          {balance === null ? '잔액 확인 중' : `${formatEth(balance, 4)} ETH`}
        </span>
        {pending > 0n && (
          <button
            type="button"
            className="quiet"
            data-testid="withdraw-pending"
            data-wei={pending.toString()}
            disabled={busy}
            onClick={() => void withdraw()}
          >
            보류된 지급액 {formatEth(pending)} ETH 받기
          </button>
        )}
        <button
          type="button"
          className="quiet"
          data-testid="wallet-disconnect"
          onClick={() => {
            setBalance(null);
            setPending(0n);
            onWallet(null);
          }}
        >
          연결 해제
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
      <button type="button" data-testid="wallet-connect" disabled={busy} onClick={connectInjected}>
        브라우저 지갑 연결
      </button>
      {options.dev && (
        <span className="wallet-dev">
          <button
            type="button"
            data-testid="wallet-dev-option"
            data-account-index={devIndex}
            disabled={busy}
            onClick={() => void connect(() => deps.connectDev(config, devIndex))}
          >
            개발용 지갑으로 연결
          </button>
          <label className="wallet-dev-account">
            <span className="sr-only">Anvil 계정</span>
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
