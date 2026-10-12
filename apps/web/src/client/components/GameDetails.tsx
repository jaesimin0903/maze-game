'use client';

// The game's details, as a dialog over the page opened from the transaction log: what the bet
// agreed to (the board, the bet, the rules, the cash-out value after every step) and every value
// the fairness check uses (the seeds, the server's commitment, the transactions). Before a bet it
// shows the same for the lobby's choice, so the cash-out values can be read before any money is
// committed (plan AC-W6).

import { useEffect, useRef, useState } from 'react';
import {
  exitPayoutWei,
  refundWei,
  startSideOf,
  type ConfigResponse,
  type Hex,
  type TuningTable,
} from '@maze/shared';
import { formatEth, formatMultiplier, formatPercent } from '../format';
import { explorerLink, useNetwork } from '../network';
import { isHex32 } from '../seed';

/** The game the dialog shows, as the page knows it now. */
export interface DetailsGame {
  gameId: Hex;
  tier: number;
  /** The bet, when known. */
  betWei: bigint | null;
  clientSeed: Hex;
  commitment: Hex;
  /** The server seed, once the game has ended and the server has revealed it. */
  serverSeed: Hex | null;
  /** The bet transaction, once it is sent, and whether it is on chain. */
  betTx: Hex | null;
  betConfirmed: boolean;
  /** What the bet transaction cost in fees, from its receipt, once read. */
  betFeeWei: bigint | null;
  /** The transaction that settled the game, once the chain has shown it. */
  settleTx: Hex | null;
  /** Where the settlement stands: not due yet, on its way, or done on chain. */
  settle: 'none' | 'settling' | 'settled';
  /** The bet handed back by `reclaim`; `txHash` is null when someone else sent it. */
  reclaimed: { txHash: Hex | null; amountWei: bigint } | null;
  ended: boolean;
}

interface Props {
  config: Pick<ConfigResponse, 'idleTimeoutSec' | 'maxGameSec'>;
  table: TuningTable;
  /** The current game, or `null` before a bet: the dialog then shows the lobby's choice. */
  game: DetailsGame | null;
  /** What A would bet now. */
  lobby: { tier: number; betWei: bigint; seedText: string };
  /** Takes a seed the player pasted (it keeps the start side already picked); `null` once betting. */
  onOwnSeed: ((text: string) => void) | null;
  /** Closes this dialog and opens the fairness check of the game. */
  onVerify(gameId: Hex): void;
  onClose(): void;
}

/**
 * What the player can take back after every step, and what the exit pays (plan AC-W6): one row
 * per entry of the size's refund table.
 */
function RefundTable({ table, tier, betWei }: { table: TuningTable; tier: number; betWei: bigint | null }) {
  const { symbol } = useNetwork();
  const { refundBps, multiplierBps } = table.tiers[tier];
  const exitWei = betWei === null ? null : exitPayoutWei(table, betWei, tier);
  return (
    <details
      open
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

/** A transaction hash, linked to the block explorer when the chain has one. */
function TxHash({ hash }: { hash: Hex }) {
  const { explorerUrl } = useNetwork();
  const url = explorerLink(explorerUrl, 'tx', hash);
  return url === null ? (
    <span className="mono seed-full">{hash}</span>
  ) : (
    <a className="mono seed-full" href={url} target="_blank" rel="noreferrer">
      {hash}
    </a>
  );
}

/** The player's own client seed, while the lobby may still change it. */
function OwnSeed({ onOwnSeed }: { onOwnSeed(text: string): void }) {
  const own = useRef<HTMLInputElement>(null);
  const [ownError, setOwnError] = useState<string | null>(null);
  return (
    <details className="sheet-box" data-testid="own-seed">
      <summary className="sheet-label">Use your own seed</summary>
      <div className="seed-row">
        <input
          ref={own}
          className="mono"
          data-testid="own-seed-input"
          aria-label="Your own client seed"
          placeholder="0x and 64 hex digits"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className="quiet"
          data-testid="own-seed-apply"
          onClick={() => {
            const text = own.current?.value.trim() ?? '';
            if (!isHex32(text)) {
              setOwnError('Enter 0x followed by 64 hex digits');
              return;
            }
            setOwnError(null);
            onOwnSeed(text);
          }}
        >
          Use
        </button>
      </div>
      <p className="sheet-note" data-testid="own-seed-note" role={ownError ? 'alert' : undefined}>
        {ownError ?? 'Its last four bytes become the mark for the start side you picked.'}
      </p>
    </details>
  );
}

/**
 * The details dialog: Escape, the close button or a click outside closes it, and focus goes back
 * where it was.
 */
export function GameDetails(p: Props) {
  const { symbol } = useNetwork();
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    dialog.current?.querySelector<HTMLElement>('[data-testid="details-close"]')?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  const g = p.game;
  const tier = g?.tier ?? p.lobby.tier;
  const t = p.table.tiers[tier];
  const betWei = g === null ? p.lobby.betWei : g.betWei;
  const exitWei = betWei === null ? null : exitPayoutWei(p.table, betWei, tier);
  const seed = g?.clientSeed ?? p.lobby.seedText.trim();
  const side = isHex32(seed) ? startSideOf(seed) : null;
  const refundStartBps = t.refundBps[0];
  const refundStep1Bps = t.refundBps[1] ?? refundStartBps;

  return (
    <div
      className="sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) p.onClose();
      }}
    >
      <div
        ref={dialog}
        className="sheet details-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="details-title"
        data-testid="game-details"
        data-mode={g === null ? 'preview' : 'live'}
        data-game-id={g?.gameId ?? ''}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' && event.code !== 'Escape') return;
          // A seed being typed is not thrown away by Escape; the close button still works.
          const target = event.target as HTMLElement;
          if (target.tagName === 'INPUT' && (target as HTMLInputElement).value !== '') return;
          event.preventDefault();
          p.onClose();
        }}
      >
        <div className="sheet-head">
          <h2 id="details-title" className="sheet-title">
            {g === null ? 'RULES & ODDS' : 'GAME DETAILS'}
          </h2>
          <button type="button" className="quiet" data-testid="details-close" onClick={p.onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {g === null && (
          <p className="sheet-note" data-testid="details-preview-note">
            No bet yet. Pressing A bets what the screen shows, with this maze and this client seed.
          </p>
        )}

        <dl className="sheet-summary">
          <div>
            <dt>Maze</dt>
            <dd data-testid="details-board" data-tier={tier} data-n={t.n} data-multiplier-bps={t.multiplierBps}>
              {t.n}×{t.n} {formatMultiplier(t.multiplierBps)}
            </dd>
          </div>
          <div>
            <dt>Bet</dt>
            <dd data-testid="details-bet" data-wei={betWei?.toString() ?? ''}>
              {betWei === null ? '—' : `${formatEth(betWei)} ${symbol}`}
            </dd>
          </div>
          <div>
            <dt>Exit pays</dt>
            <dd className="tone-win" data-testid="details-exit-payout" data-wei={exitWei?.toString() ?? ''}>
              {exitWei === null ? '—' : `${formatEth(exitWei, 4)} ${symbol}`}
            </dd>
          </div>
        </dl>

        <dl className="details-list">
          {g !== null && (
            <div>
              <dt>Game</dt>
              <dd className="mono seed-full" data-testid="details-game-id">
                {g.gameId}
              </dd>
            </div>
          )}
          <div>
            <dt>{g === null ? 'Client seed of the next bet' : 'Client seed'}</dt>
            <dd>
              <span className="mono seed-full" data-testid="details-client-seed">
                {isHex32(seed) ? seed : '—'}
              </span>
              {side !== null && (
                <span data-testid="details-start-side" data-side={side}>
                  {' '}
                  · start opens {side === 'E' ? 'east →' : 'south ↓'}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Server commitment</dt>
            <dd data-testid="details-commitment" data-pending={g === null}>
              {g === null ? (
                'Appears after the bet: the server fixes its seed before it sees yours.'
              ) : (
                <span className="mono seed-full">{g.commitment}</span>
              )}
            </dd>
          </div>
          {g !== null && (
            <>
              <div>
                <dt>Server seed</dt>
                <dd data-testid="details-server-seed" data-revealed={g.serverSeed !== null}>
                  {g.serverSeed === null ? (
                    'Revealed when the game ends.'
                  ) : (
                    <span className="mono seed-full">{g.serverSeed}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Bet transaction</dt>
                <dd data-testid="details-bet-tx" data-tx={g.betTx ?? ''} data-confirmed={g.betConfirmed}>
                  {g.betTx === null ? 'Sending...' : <TxHash hash={g.betTx} />}
                  {g.betTx !== null && (g.betConfirmed ? ' · confirmed' : ' · confirming...')}
                </dd>
              </div>
              {g.betFeeWei !== null && (
                <div>
                  <dt>Bet fee</dt>
                  <dd data-testid="details-bet-fee" data-wei={g.betFeeWei.toString()}>
                    {formatEth(g.betFeeWei)} {symbol}
                  </dd>
                </div>
              )}
              {g.reclaimed === null ? (
                <div>
                  <dt>Settlement</dt>
                  <dd data-testid="details-settle-tx" data-tx={g.settleTx ?? ''} data-state={g.settle}>
                    {g.settleTx !== null ? (
                      <TxHash hash={g.settleTx} />
                    ) : g.settle === 'settled' ? (
                      'Settled on chain'
                    ) : g.settle === 'settling' ? (
                      'Settling...'
                    ) : (
                      'When the game ends'
                    )}
                  </dd>
                </div>
              ) : (
                <div>
                  <dt>Reclaim</dt>
                  <dd data-testid="details-reclaim-tx" data-tx={g.reclaimed.txHash ?? ''}>
                    {formatEth(g.reclaimed.amountWei)} {symbol} back
                    {g.reclaimed.txHash !== null && (
                      <>
                        {' · '}
                        <TxHash hash={g.reclaimed.txHash} />
                      </>
                    )}
                  </dd>
                </div>
              )}
            </>
          )}
        </dl>

        {g === null && p.onOwnSeed !== null && <OwnSeed onOwnSeed={p.onOwnSeed} />}

        <ul className="sheet-note details-rules" data-testid="bet-rules">
          <li>
            · Cash out any time before a dead end. Right after the bet you get back {formatPercent(refundStartBps)},
            after the first step {formatPercent(refundStep1Bps)}, and less with every step.
          </li>
          <li>· If you do not move for {p.config.idleTimeoutSec}s, the game cashes out at that moment&apos;s amount.</li>
          <li>· {p.config.maxGameSec}s after the start, the game is settled at that moment&apos;s amount.</li>
          <li>· One game per wallet at a time. A dead end loses the whole bet.</li>
        </ul>

        <RefundTable table={p.table} tier={tier} betWei={betWei} />

        {g !== null && (
          <>
            <div className="sheet-actions">
              <button type="button" onClick={p.onClose}>
                Close
              </button>
              <button
                type="button"
                className="primary"
                data-testid="details-verify"
                disabled={!g.ended}
                onClick={() => p.onVerify(g.gameId)}
              >
                Verify this game
              </button>
            </div>
            {!g.ended && (
              <p className="sheet-note" data-testid="details-verify-note">
                The check opens once the game has ended and the server seed is revealed.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
