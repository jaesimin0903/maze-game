'use client';

// The account of a Privy login: a chip in the header that opens a small panel with the wallet's
// address, its balance, links to the faucet and the block explorer, a withdrawal of the chain's
// coin to another address, the key export of an embedded wallet, and the log-out.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { isAddress, isAddressEqual, zeroAddress } from 'viem';
import type { ConfigResponse, Hex } from '@maze/shared';
import type { ChainApi } from '../chain';
import { formatEth, parseEthInput, shortHex } from '../format';
import { explorerLink, networkView } from '../network';
import { describeTxError, type WalletApi } from '../wallet';

/** Gas of a plain transfer of the native coin to an address without code. */
const PLAIN_TRANSFER_GAS = 21_000n;

/** Chain ids of Monad (mainnet, testnet), whose reserve rule can refuse a withdrawal right after a bet. */
const MONAD_CHAIN_IDS = [143, 10143];

/**
 * The gas limit a withdrawal is sent with: the estimate itself for a plain transfer, whose gas is
 * fixed, and 15% above it for a contract, whose gas may move a little before the transfer lands.
 * Monad charges the whole limit, so the limit stays close to the estimate.
 */
export function transferGasLimit(estimate: bigint): bigint {
  return estimate <= PLAIN_TRANSFER_GAS ? estimate : (estimate * 115n + 99n) / 100n;
}

/**
 * What a withdrawal keeps back for its own fee: its gas limit at twice the current gas price, as
 * the wallet may bid above that price for the next blocks.
 */
export function feeReserve(gas: bigint, gasPriceWei: bigint): bigint {
  return gas * gasPriceWei * 2n;
}

/** The withdrawal the form describes, or the reason it cannot be sent. */
export function readTransfer(p: {
  to: string;
  amount: string;
  balanceWei: bigint | null;
  reserveWei: bigint;
  self: Hex;
  contract: Hex;
  symbol: string;
}): { to: Hex; valueWei: bigint } | { reason: string } {
  const to = p.to.trim();
  if (!isAddress(to, { strict: false })) return { reason: 'Enter the address to send to: 0x followed by 40 hex digits' };
  if (!isAddress(to)) return { reason: 'The capital letters of that address do not match its checksum. Check it for a typo' };
  if (isAddressEqual(to, zeroAddress)) return { reason: 'That is the zero address: coins sent there are lost' };
  if (isAddressEqual(to, p.self)) return { reason: 'That is this wallet’s own address' };
  if (isAddressEqual(to, p.contract)) return { reason: 'That is the game contract. Send to a wallet of your own instead' };
  const valueWei = parseEthInput(p.amount);
  if (valueWei === null) return { reason: `Enter the amount in ${p.symbol}, for example 0.5` };
  if (valueWei === 0n) return { reason: 'Enter an amount above 0' };
  if (p.balanceWei === null) return { reason: 'The balance has not been read yet' };
  const most = p.balanceWei - p.reserveWei;
  if (valueWei > most) {
    return {
      reason:
        most > 0n
          ? `That is more than the balance leaves after the network fee: at most ${formatEth(most, 18)} ${p.symbol}`
          : 'The balance does not cover the network fee',
    };
  }
  return { to, valueWei };
}

/** Appended to a failed withdrawal on Monad, where a fresh bet can block a withdrawal for a moment. */
const MONAD_RESERVE_HINT =
  'If you just placed a bet, wait a few seconds and try again: Monad lets a wallet go below its 10 MON reserve only with a transaction sent on its own';

interface Props {
  config: ConfigResponse;
  chain: Pick<ChainApi, 'gasPrice' | 'estimateTransferGas' | 'waitForTx'>;
  wallet: WalletApi;
  balance: bigint | null;
  /** Opens Privy's key export; `null` for an external wallet, whose key Privy does not hold. */
  onExport: (() => Promise<void>) | null;
  onLogout(): Promise<void>;
  /** Reads the balance again, after a withdrawal. */
  onRefresh(): void;
}

type Send =
  | { step: 'form' }
  | { step: 'review' | 'sending'; to: Hex; valueWei: bigint; gas: bigint; feeWei: bigint }
  | { step: 'sent'; hash: Hex; valueWei: bigint };

export function AccountPanel(p: Props) {
  const { wallet, config, onExport } = p;
  const { symbol, explorerUrl } = networkView(config);
  const faucetUrl = config.network?.faucetUrl ?? null;
  const addressUrl = explorerLink(explorerUrl, 'address', wallet.address);
  const panelId = useId();
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [send, setSend] = useState<Send | null>(null);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  /** The gas price a withdrawal is priced at, once read; `priceFailed` when the read failed. */
  const [price, setPrice] = useState<bigint | null>(null);
  const [priceFailed, setPriceFailed] = useState(false);
  /** A gas estimate is on its way. */
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);

  // A press outside the chip and its panel closes the panel, as Escape does.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const step = send?.step ?? 'menu';
  const sending = step === 'sending';

  // A step change takes away the button that had the focus: it goes to the new step's main control
  // (to the panel itself while sending), so Enter and Escape stay with the panel.
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    if (!open) return;
    const main = panel.current?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)');
    (main ?? panel.current)?.focus();
  }, [step, open]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };

  const readPrice = (): void => {
    setPrice(null);
    setPriceFailed(false);
    p.chain.gasPrice().then(setPrice, () => setPriceFailed(true));
  };

  const startSend = (): void => {
    setSend({ step: 'form' });
    setProblem(null);
    readPrice();
  };

  /** The gas limit of a transfer of `valueWei` to `dest`, from the chain's estimate for it. */
  const gasFor = async (dest: Hex, valueWei: bigint): Promise<bigint> =>
    transferGasLimit(await p.chain.estimateTransferGas({ from: wallet.address, to: dest, valueWei }));

  const max = async (): Promise<void> => {
    if (p.balance === null || price === null) return;
    const dest = to.trim();
    if (!isAddress(dest, { strict: false })) {
      setProblem('Enter the address first: the network fee depends on it');
      return;
    }
    // The estimate needs a value; the balance less the fee of a plain transfer is close enough.
    const rough = p.balance - feeReserve(PLAIN_TRANSFER_GAS, price);
    if (rough <= 0n) {
      setProblem('The balance does not cover the network fee');
      return;
    }
    setChecking(true);
    setProblem(null);
    try {
      const most = p.balance - feeReserve(await gasFor(dest, rough), price);
      if (most > 0n) setAmount(formatEth(most, 18));
      else setProblem('The balance does not cover the network fee');
    } catch (cause) {
      setProblem(`The network could not estimate a transfer to that address: ${describeTxError(cause)}`);
    } finally {
      setChecking(false);
    }
  };

  const review = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (price === null) {
      setProblem(priceFailed ? 'The network fee could not be read. Press Retry' : 'Reading the network fee...');
      return;
    }
    const fields = { to, amount, balanceWei: p.balance, self: wallet.address, contract: config.contract, symbol };
    const first = readTransfer({ ...fields, reserveWei: 0n });
    if ('reason' in first) {
      setProblem(first.reason);
      return;
    }
    setChecking(true);
    setProblem(null);
    try {
      const gas = await gasFor(first.to, first.valueWei);
      const feeWei = feeReserve(gas, price);
      const read = readTransfer({ ...fields, reserveWei: feeWei });
      if ('reason' in read) setProblem(read.reason);
      else setSend({ step: 'review', ...read, gas, feeWei });
    } catch (cause) {
      setProblem(`The network could not estimate this transfer: ${describeTxError(cause)}`);
    } finally {
      setChecking(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (send?.step !== 'review') return;
    setSend({ ...send, step: 'sending' });
    setProblem(null);
    try {
      const hash = await wallet.transfer({ to: send.to, valueWei: send.valueWei, gas: send.gas });
      if ((await p.chain.waitForTx(hash)) !== 'success') throw new Error('The withdrawal transaction was reverted');
      setSend({ step: 'sent', hash, valueWei: send.valueWei });
      setTo('');
      setAmount('');
    } catch (cause) {
      const monad = MONAD_CHAIN_IDS.includes(config.chainId);
      setProblem(monad ? `${describeTxError(cause)}. ${MONAD_RESERVE_HINT}` : describeTxError(cause));
      setSend({ ...send, step: 'review' });
    } finally {
      p.onRefresh();
    }
  };

  const act = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await run();
    } catch (cause) {
      setProblem(describeTxError(cause));
    } finally {
      setBusy(false);
    }
  };

  const balanceText = p.balance === null ? '...' : `${formatEth(p.balance, 4)} ${symbol}`;

  return (
    <div
      className="wallet-account"
      ref={box}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          setOpen(false);
          toggle.current?.focus();
          return;
        }
        // Keys pressed in the open panel are the panel's: none of them drives the game behind it.
        if (open && panel.current?.contains(event.target as Node)) event.stopPropagation();
      }}
    >
      <button
        ref={toggle}
        type="button"
        className="stat-chip wallet-chip"
        data-testid="wallet-menu"
        aria-expanded={open}
        aria-controls={panelId}
        title={wallet.address}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="wallet-dot" aria-hidden="true" />
        <span className="sr-only">Account wallet</span>
        <code className="wallet-address" data-testid="wallet-address" data-kind={wallet.kind} data-address={wallet.address}>
          {shortHex(wallet.address)}
        </code>
        <span className="wallet-balance" data-testid="wallet-balance" data-wei={p.balance?.toString() ?? ''}>
          {balanceText}
        </span>
        <svg className="wallet-caret" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M0 0h10L5 6z" />
        </svg>
      </button>

      <div className="wallet-panel" id={panelId} data-testid="wallet-panel" hidden={!open} ref={panel} tabIndex={-1}>
        <p className="wp-head">
          ACCOUNT<span className="wp-net"> · {config.network?.name ?? `Chain ${config.chainId}`}</span>
        </p>
        <div className="wp-row">
          <code className="wp-address" data-testid="account-address">
            {wallet.address}
          </code>
          <button type="button" className="quiet" data-testid="wallet-copy" onClick={() => void copy()}>
            {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
          </button>
        </div>
        <p className="wp-balance">
          Balance <strong data-testid="account-balance">{balanceText}</strong>
        </p>
        {(faucetUrl !== null || addressUrl !== null) && (
          <p className="wp-links">
            {faucetUrl !== null && (
              <a data-testid="wallet-faucet" href={faucetUrl} target="_blank" rel="noreferrer">
                Get test {symbol}
              </a>
            )}
            {addressUrl !== null && (
              <a data-testid="wallet-explorer" href={addressUrl} target="_blank" rel="noreferrer">
                View on explorer
              </a>
            )}
          </p>
        )}

        {send === null ? (
          <div className="wp-actions">
            <button type="button" data-testid="wallet-send-open" data-autofocus disabled={busy} onClick={startSend}>
              Withdraw
            </button>
            {onExport !== null && (
              <button type="button" data-testid="wallet-export" disabled={busy} onClick={() => void act(onExport)}>
                Export key
              </button>
            )}
            <button
              type="button"
              className="quiet"
              data-testid="privy-logout"
              disabled={busy}
              onClick={() => void act(p.onLogout)}
            >
              Log out
            </button>
          </div>
        ) : send.step === 'form' ? (
          <form className="wp-send" data-testid="send-form" noValidate onSubmit={(event) => void review(event)}>
            <p className="wp-head">WITHDRAW {symbol}</p>
            <label className="wp-field">
              <span>To address</span>
              <input
                data-testid="send-to"
                data-autofocus
                value={to}
                autoComplete="off"
                spellCheck={false}
                placeholder="0x..."
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
            <label className="wp-field">
              <span>Amount in {symbol}</span>
              <span className="wp-amount">
                <input
                  data-testid="send-amount"
                  value={amount}
                  inputMode="decimal"
                  autoComplete="off"
                  onChange={(event) => setAmount(event.target.value)}
                />
                <button
                  type="button"
                  className="quiet"
                  data-testid="send-max"
                  disabled={price === null || p.balance === null || checking}
                  title="The whole balance less the network fee"
                  onClick={() => void max()}
                >
                  MAX
                </button>
              </span>
            </label>
            {priceFailed && (
              <p className="wp-note" role="alert" data-testid="fee-error">
                The network fee could not be read from the chain.{' '}
                <button type="button" className="quiet" data-testid="fee-retry" onClick={readPrice}>
                  Retry
                </button>
              </p>
            )}
            <div className="wp-actions">
              <button
                type="button"
                className="quiet"
                data-testid="send-cancel"
                onClick={() => {
                  setSend(null);
                  setProblem(null);
                }}
              >
                Cancel
              </button>
              <button type="submit" className="primary" data-testid="send-review" disabled={checking}>
                {checking ? 'Checking...' : 'Review'}
              </button>
            </div>
          </form>
        ) : send.step === 'sent' ? (
          <div className="wp-send" data-testid="send-done" data-tx={send.hash}>
            <p>
              Sent {formatEth(send.valueWei, 18)} {symbol}.{' '}
              {explorerUrl !== null ? (
                <a href={explorerLink(explorerUrl, 'tx', send.hash) ?? undefined} target="_blank" rel="noreferrer">
                  tx {shortHex(send.hash)}
                </a>
              ) : (
                <span className="wp-address">tx {shortHex(send.hash)}</span>
              )}
            </p>
            <div className="wp-actions">
              <button type="button" data-autofocus onClick={() => setSend(null)}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="wp-send" data-testid="send-review-step">
            <p className="wp-head">CONFIRM WITHDRAWAL</p>
            <p>
              Send{' '}
              <strong data-testid="send-confirm-amount" data-wei={send.valueWei.toString()}>
                {formatEth(send.valueWei, 18)} {symbol}
              </strong>{' '}
              to
            </p>
            <code className="wp-address" data-testid="send-confirm-to">
              {send.to}
            </code>
            <p className="wp-note" data-testid="send-fee" data-wei={send.feeWei.toString()} data-gas={send.gas.toString()}>
              Network fee: at most {formatEth(send.feeWei, 6)} {symbol}, paid on top. A transfer cannot be undone.
            </p>
            <div className="wp-actions">
              <button
                type="button"
                className="quiet"
                data-testid="send-back"
                disabled={sending}
                onClick={() => setSend({ step: 'form' })}
              >
                Back
              </button>
              <button
                type="button"
                className="primary"
                data-testid="send-confirm"
                data-autofocus
                disabled={sending}
                onClick={() => void confirm()}
              >
                {sending ? 'Sending...' : `Send ${symbol}`}
              </button>
            </div>
          </div>
        )}
        {problem !== null && (
          <p className="wallet-error wp-error" role="alert" data-testid="account-error">
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}
