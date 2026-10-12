'use client';

import { useEffect, useRef, useState } from 'react';
import { exitPayoutWei, refundWei, type Hex, type StartSide, type TuningTable } from '@maze/shared';
import { stepText } from '../bet-form';
import { formatEth, formatPercent } from '../format';
import { useNetwork } from '../network';
import { isHex32 } from '../seed';
import type { BetStep } from '../use-game';
import type { WalletKind } from '../wallet';

interface Props {
  size: string;
  multiplier: string;
  betWei: bigint | null;
  exitWei: bigint | null;
  /** The client seed's short name ("3F9A"), or `null` when the seed is not valid hex. */
  seedCode: string | null;
  /** The side the seed opens the start to, when it picks one. */
  startSide: StartSide | null;
  /** The whole client seed, shown only when the player opens "Use your own seed". */
  seedText: string;
  /** Takes a seed the player pasted (it keeps the start side already picked). */
  onOwnSeed(text: string): void;
  /** Non-null while the bet is being placed. */
  step: BetStep | null;
  walletKind: WalletKind | null;
  /** Why the bet cannot be placed yet, or `null`. */
  blocked: string | null;
  /** The server's commit, once the ticket has arrived. */
  commitment: Hex | null;
  error: string | null;
  /** The table's rules the bet agrees to. */
  rules: { idleSec: number; maxGameSec: number; refundStartBps: number; refundStep1Bps: number };
  /** The payout table and the chosen size, for the refund after every step. */
  table: TuningTable;
  tier: number;
  onSubmit(): void;
  onClose(): void;
}

/**
 * A key press on "Sign and bet" this soon after the sheet opened is the press that opened it (A)
 * coming twice, not a decision: with an account wallet it would bet without a prompt.
 */
const SUBMIT_GUARD_MS = 300;

const STEPS: { key: BetStep; label: string }[] = [
  { key: 'sign', label: 'Sign the ticket request' },
  { key: 'ticket', label: 'Server commits to its seed' },
  { key: 'tx', label: 'Send the bet transaction' },
  { key: 'confirm', label: 'Bet lands on chain' },
];

/**
 * What the player can take back after every step, and what the exit pays, before any money is
 * committed (plan AC-W6): one row per entry of the size's refund table.
 */
function RefundTable({ table, tier, betWei }: { table: TuningTable; tier: number; betWei: bigint | null }) {
  const { symbol } = useNetwork();
  const { refundBps, multiplierBps } = table.tiers[tier];
  const exitWei = betWei === null ? null : exitPayoutWei(table, betWei, tier);
  return (
    <details
      className="sheet-box schedule"
      data-testid="refund-schedule"
      data-tier={tier}
      data-bet-wei={betWei?.toString() ?? ''}
    >
      <summary className="sheet-label">Cash-out value after every step</summary>
      <ol className="schedule-rows">
        {refundBps.map((bps, k) => {
          const wei = betWei === null ? null : refundWei(table, betWei, tier, k);
          return (
            <li
              key={k}
              className="schedule-row"
              data-testid={`schedule-row-${k}`}
              data-step={k}
              data-bps={bps}
              data-wei={wei?.toString() ?? ''}
            >
              <span>{k === 0 ? 'At bet' : `Step ${k}`}</span>
              <span className="schedule-bar" aria-hidden="true">
                <i style={{ width: `${bps / 100}%` }} />
              </span>
              <span className="schedule-pct">{formatPercent(bps)}</span>
              <span className="schedule-amt">{wei === null ? '—' : `${formatEth(wei)} ${symbol}`}</span>
            </li>
          );
        })}
      </ol>
      <p
        className="sheet-note"
        data-testid="schedule-exit-payout"
        data-wei={exitWei?.toString() ?? ''}
        data-multiplier-bps={multiplierBps}
      >
        Reaching the exit pays {exitWei === null ? '—' : `${formatEth(exitWei)} ${symbol}`}.
      </p>
    </details>
  );
}

/** The bet sheet: the client seed, what the bet buys, and each wallet and chain step as it happens. */
export function SignSheet(p: Props) {
  const { symbol } = useNetwork();
  const busy = p.step !== null;
  const sheet = useRef<HTMLDivElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const own = useRef<HTMLInputElement>(null);
  const openedAt = useRef(0);
  const [ownError, setOwnError] = useState<string | null>(null);
  // Focus moves into the sheet when it opens (the bet button, or the first control that can take
  // it while the bet is blocked) and goes back where it was when the sheet closes.
  useEffect(() => {
    openedAt.current = performance.now();
    const before = document.activeElement;
    const target =
      submit.current !== null && !submit.current.disabled
        ? submit.current
        : sheet.current?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)');
    target?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  const at = p.step === null ? -1 : STEPS.findIndex((s) => s.key === p.step);

  return (
    <div
      className="sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) p.onClose();
      }}
    >
      <div
        ref={sheet}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sign-title"
        data-testid="sign-sheet"
        onKeyDown={(event) => {
          // A held Enter or Space opened the sheet as A: its repeats must not press "Sign and bet",
          // which with an account wallet bets without a prompt. Each bet takes a press of its own,
          // and not one that comes right on top of the press that opened the sheet.
          const press = event.key === 'Enter' || event.key === ' ' || event.code === 'Space';
          const early = event.target === submit.current && performance.now() - openedAt.current < SUBMIT_GUARD_MS;
          if (press && (event.repeat || early)) {
            event.preventDefault();
            return;
          }
          // Escape closes the sheet from anywhere in it, the seed field included.
          if (event.key !== 'Escape' && event.code !== 'Escape') return;
          event.preventDefault();
          if (!busy) p.onClose();
        }}
        onKeyUp={(event) => {
          // Space presses a button on its release: the same guard.
          const early = event.target === submit.current && performance.now() - openedAt.current < SUBMIT_GUARD_MS;
          if (early && (event.key === ' ' || event.code === 'Space')) event.preventDefault();
        }}
      >
        <div className="sheet-head">
          <h2 id="sign-title" className="sheet-title">
            SIGN &amp; BET
          </h2>
          <button type="button" className="quiet" onClick={p.onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </div>

        <dl className="sheet-summary">
          <div>
            <dt>Maze</dt>
            <dd>
              {p.size} {p.multiplier}
            </dd>
          </div>
          <div>
            <dt>Bet</dt>
            <dd>{p.betWei === null ? '—' : `${formatEth(p.betWei)} ${symbol}`}</dd>
          </div>
          <div>
            <dt>Escape pays</dt>
            <dd className="tone-win">{p.exitWei === null ? '—' : `${formatEth(p.exitWei, 4)} ${symbol}`}</dd>
          </div>
        </dl>

        <div className="sheet-box" data-testid="sheet-seed">
          <span className="sheet-label">
            Your dungeon{' '}
            <span className="mono" data-testid="sheet-seed-code">
              {p.seedCode === null ? '—' : `SEED ${p.seedCode}`}
            </span>
            {p.startSide !== null && (
              <span data-testid="sheet-start-side" data-side={p.startSide}>
                {' '}
                · start opens {p.startSide === 'E' ? 'east →' : 'south ↓'}
              </span>
            )}
          </span>
          <p className="sheet-note">
            The server fixed the hash of its own seed before you picked yours, and the maze is built from both. Your
            seed only picks the start side, which does not change the odds. When the game ends the server seed is
            revealed, so you can rebuild the maze yourself.
          </p>
          <details data-testid="sheet-own-seed">
            <summary className="sheet-note">Use your own seed</summary>
            <p className="sheet-note">
              Seed now:{' '}
              <code className="mono seed-full" data-testid="sheet-full-seed">
                {p.seedText}
              </code>
            </p>
            <div className="seed-row">
              <input
                ref={own}
                className="mono"
                data-testid="own-seed-input"
                aria-label="Your own client seed"
                placeholder="0x and 64 hex digits"
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
              />
              <button
                type="button"
                className="quiet"
                data-testid="own-seed-apply"
                disabled={busy}
                onClick={() => {
                  const text = own.current?.value.trim() ?? '';
                  if (!isHex32(text)) {
                    setOwnError('Enter 0x followed by 64 hex digits');
                    return;
                  }
                  setOwnError(null);
                  p.onOwnSeed(text);
                }}
              >
                Use
              </button>
            </div>
            <p className="sheet-note" data-testid="own-seed-note" role={ownError ? 'alert' : undefined}>
              {ownError ?? 'Its last four bytes become the mark for the start side you picked.'}
            </p>
          </details>
        </div>

        <RefundTable table={p.table} tier={p.tier} betWei={p.betWei} />

        <ul className="sheet-note" data-testid="bet-rules" style={{ display: 'grid', gap: 4 }}>
          <li>
            · Cash out any time before a dead end. Right after the bet you get back{' '}
            {formatPercent(p.rules.refundStartBps)}, after the first step {formatPercent(p.rules.refundStep1Bps)}, and
            less with every step.
          </li>
          <li>· If you do not move for {p.rules.idleSec}s, the game cashes out at that moment&apos;s amount.</li>
          <li>· {p.rules.maxGameSec}s after the start, the game is settled at that moment&apos;s amount.</li>
          <li>· One game per wallet at a time. A dead end loses the whole bet.</li>
        </ul>

        {p.commitment !== null && (
          <div className="sheet-box">
            <span className="sheet-label">Server commit</span>
            <span className="mono" data-testid="sheet-commitment">
              {p.commitment}
            </span>
          </div>
        )}

        {busy && (
          <ol className="steps" aria-label="Bet progress">
            {STEPS.map((s, k) => (
              <li key={s.key} data-state={k < at ? 'done' : k === at ? 'now' : 'todo'}>
                {s.label}
              </li>
            ))}
          </ol>
        )}

        <p
          className="bet-status"
          data-testid="bet-status"
          data-step={p.step ?? ''}
          data-blocked={!busy && p.blocked !== null}
          aria-live="polite"
        >
          {p.step !== null ? stepText(p.step, p.walletKind) : (p.blocked ?? '')}
        </p>
        {p.error !== null && !busy && (
          <p className="bet-status" data-blocked="true" role="alert" data-testid="sheet-error">
            {p.error}
          </p>
        )}

        <div className="sheet-actions">
          <button type="button" onClick={p.onClose} disabled={busy}>
            Cancel
          </button>
          <button
            ref={submit}
            type="button"
            className="primary"
            data-testid="bet-submit"
            disabled={busy || p.blocked !== null}
            onClick={p.onSubmit}
          >
            {p.betWei === null ? 'Sign and bet' : `Sign and bet ${formatEth(p.betWei)} ${symbol}`}
          </button>
        </div>
      </div>
    </div>
  );
}
