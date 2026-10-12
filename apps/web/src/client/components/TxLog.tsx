'use client';

// The current game's log beside the console, entry by entry as it happens: the ticket, the bet
// transaction, the start, the result and the settlement (or the reclaim), with links to the block
// explorer. The panel and every entry open the game's details.

import type { Hex } from '@maze/shared';
import { formatEth, shortHex } from '../format';
import { explorerLink, useNetwork } from '../network';
import type { PlayRecord } from '../record';
import type { BetStep, GameResult, Phase, ResultOutcome } from '../use-game';

export interface TxEntry {
  key: 'none' | 'ticket' | 'bet' | 'start' | 'result' | 'settle' | 'reclaim';
  /** `now` while the page waits for it. */
  state: 'done' | 'now';
  label: string;
  detail: string | null;
  tone: 'win' | 'loss' | 'even' | null;
  tx: Hex | null;
}

interface Source {
  /** The game's record: from the ticket on, while betting, playing and after the end. */
  record: PlayRecord | null;
  phase: Phase;
  betStep: BetStep | null;
  result: GameResult | null;
  /** The chain shows the game settled or reclaimed. */
  settled: boolean;
}

const RESULT_TEXT: Record<Exclude<ResultOutcome, 'reclaimed'>, string> = {
  exit: 'Escaped',
  loss: 'Died',
  cashout: 'Cashed out',
  'auto-cashout': 'Auto cash-out',
};

/** The log's entries for the game as the page knows it now, oldest first. */
export function txEntries(s: Source, symbol: string): TxEntry[] {
  const r = s.record;
  const entry = (e: Partial<TxEntry> & Pick<TxEntry, 'key' | 'label'>): TxEntry => ({
    state: 'done',
    detail: null,
    tone: null,
    tx: null,
    ...e,
  });
  if (s.phase === 'lobby' || (r === null && s.phase !== 'betting')) {
    return [entry({ key: 'none', label: 'No bet yet', detail: 'Rules & odds' })];
  }
  const amount = (wei: bigint, digits = 4): string => `${formatEth(wei, digits)} ${symbol}`;
  const bet = r?.betWei === undefined ? null : BigInt(r.betWei);
  const entries: TxEntry[] = [
    r === null
      ? entry({ key: 'ticket', state: 'now', label: s.betStep === 'ticket' ? 'Getting ticket...' : 'Signing ticket...' })
      : entry({ key: 'ticket', label: 'Ticket signed', detail: `commit ${shortHex(r.commitment)}` }),
  ];
  const betText = bet === null ? null : amount(bet);
  if (s.phase === 'betting') {
    if (s.betStep === 'tx') entries.push(entry({ key: 'bet', state: 'now', label: 'Sending bet...', detail: betText }));
    if (s.betStep === 'confirm') {
      entries.push(
        entry({ key: 'bet', state: 'now', label: 'Bet sent, confirming...', detail: betText, tx: r?.createTxHash ?? null }),
      );
    }
    return entries;
  }
  if (r === null) return entries;
  entries.push(entry({ key: 'bet', label: 'Bet confirmed', detail: betText, tx: r.createTxHash ?? null }));
  if (r.observations.length > 0) {
    entries.push(entry({ key: 'start', label: 'Game started', detail: `${r.n}×${r.n}` }));
  } else if (s.phase === 'playing') {
    entries.push(entry({ key: 'start', state: 'now', label: 'Starting game...', detail: `${r.n}×${r.n}` }));
  }
  const res = s.result;
  if (res !== null && res.outcome !== 'reclaimed') {
    const detail =
      res.outcome === 'loss'
        ? bet === null
          ? null
          : `-${amount(bet)}`
        : res.outcome === 'exit'
          ? `+${amount(res.payoutWei)}`
          : `${amount(res.payoutWei)} back`;
    const tone = res.outcome === 'exit' ? 'win' : res.outcome === 'loss' ? 'loss' : 'even';
    entries.push(entry({ key: 'result', label: RESULT_TEXT[res.outcome], detail, tone }));
  }
  if (r.reclaimed) {
    entries.push(
      entry({
        key: 'reclaim',
        label: 'Bet reclaimed',
        detail: amount(BigInt(r.reclaimed.amountWei)),
        tx: r.reclaimed.txHash,
      }),
    );
  } else if (r.terminal) {
    // A settlement the server sent counts only once the chain shows it settled the game.
    const tx = res?.txHash ?? null;
    entries.push(
      tx !== null
        ? entry({ key: 'settle', label: 'Settled', tx })
        : s.settled
          ? entry({ key: 'settle', label: 'Settled on chain' })
          : entry({ key: 'settle', state: 'now', label: 'Settling...' }),
    );
  }
  return entries;
}

export function TxLog(p: Source & { onOpen(): void }) {
  const { symbol, explorerUrl } = useNetwork();
  const entries = txEntries(p, symbol);
  return (
    <section
      className="card txlog"
      data-testid="tx-log"
      data-game-id={p.record?.gameId ?? ''}
      aria-labelledby="txlog-title"
      onClick={(event) => {
        // A click anywhere on the panel opens the details; a link to the explorer is its own.
        if ((event.target as Element).closest('a, button') === null) p.onOpen();
      }}
    >
      <div className="card-head">
        <h2 id="txlog-title" className="ctitle">
          Transactions
        </h2>
        <button type="button" className="txlog-more" data-testid="tx-log-open" onClick={p.onOpen}>
          DETAILS
        </button>
      </div>
      <ol className="txlog-rows" aria-live="polite">
        {entries.map((e) => {
          const url = e.tx === null ? null : explorerLink(explorerUrl, 'tx', e.tx);
          return (
            <li key={e.key} className="txlog-row" data-testid={`txlog-${e.key}`} data-state={e.state} data-tx={e.tx ?? ''}>
              <button type="button" className="txlog-entry" onClick={p.onOpen}>
                {e.label}
                {e.detail !== null && (
                  <>
                    {' · '}
                    <span className={e.tone === null ? 'txlog-detail' : `txlog-detail tone-${e.tone}`}>{e.detail}</span>
                  </>
                )}
              </button>
              {e.tx !== null &&
                (url === null ? (
                  <span className="txlog-tx mono" title={e.tx}>
                    {shortHex(e.tx)}
                  </span>
                ) : (
                  <a className="txlog-tx mono" href={url} target="_blank" rel="noreferrer" title={e.tx}>
                    {shortHex(e.tx)}
                  </a>
                ))}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
