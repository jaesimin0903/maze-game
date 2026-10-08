'use client';

// The panels beside the console: the latest games on the server, the leaderboard, and the
// house's bankroll. Every figure comes from the server or the chain; nothing is
// made up when there is nothing to show.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedEntry, FeedOutcome, Hex, LeaderboardBoard, LeaderboardResponse } from '@maze/shared';
import type { ApiClient } from '../api';
import type { ChainApi } from '../chain';
import { formatEth, formatPoints, shortHex } from '../format';
import { explorerLink, useNetwork } from '../network';
import { useInterval } from '../poll';

const FEED_MS = 10_000;
const BOARD_MS = 15_000;
const BANKROLL_MS = 30_000;

const OUTCOME: Record<FeedOutcome, { text: string; tone: string }> = {
  exit: { text: 'Escaped', tone: 'tone-win' },
  loss: { text: 'Died', tone: 'tone-loss' },
  cashout: { text: 'Cashed out', tone: 'tone-even' },
  'auto-cashout': { text: 'Auto cash-out', tone: 'tone-even' },
  reclaimed: { text: 'Reclaimed', tone: 'tone-even' },
};

const same = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/** "8s ago", "3m ago", "2h ago", "5d ago". */
export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** Seconds as `h:mm:ss`. */
function formatHms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** What a finished game shows in the feed: the payout, or the lost bet. */
function feedAmount(g: FeedEntry): string {
  if (g.outcome === 'loss') return `-${formatEth(BigInt(g.betWei), 4)}`;
  const paid = formatEth(BigInt(g.payoutWei), 4);
  return g.outcome === 'exit' ? `+${paid}` : paid;
}

function signedEth(wei: bigint): string {
  return `${wei >= 0n ? '+' : '-'}${formatEth(wei >= 0n ? wei : -wei, 4)}`;
}

/**
 * Numbers each request so only the latest one's reply is used: a slow reply to an older request
 * (another tab, say) cannot overwrite a newer one, and no reply lands after the panel is gone.
 */
function useLatestRequest(): () => () => boolean {
  const latest = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => {
    const ticket = ++latest.current;
    return () => mounted.current && latest.current === ticket;
  }, []);
}

export function RecentGames(p: {
  api: Pick<ApiClient, 'feed'>;
  /** The connected wallet, shown as "You". */
  me: Hex | null;
  /** Chain seconds, or 0 while unknown. */
  now: number;
  /** Changes when a game of this page ends. */
  refreshKey: string;
}) {
  const { api } = p;
  const { symbol } = useNetwork();
  const [games, setGames] = useState<FeedEntry[] | null>(null);
  const [serverNow, setServerNow] = useState(0);
  const [failed, setFailed] = useState(false);
  const begin = useLatestRequest();

  const load = useCallback(async (): Promise<void> => {
    const current = begin();
    try {
      const reply = await api.feed();
      if (!current()) return;
      setGames(reply.games);
      setServerNow(reply.chainNowSec);
      setFailed(false);
    } catch {
      if (current()) setFailed(true);
    }
  }, [api, begin]);

  useEffect(() => {
    void load();
  }, [load, p.refreshKey]);
  useInterval(() => void load(), FEED_MS);

  const now = Math.max(p.now, serverNow);
  return (
    <section className="card" data-testid="recent-feed" aria-labelledby="feed-title" style={{ gap: 8 }}>
      <div className="card-head">
        <h2 id="feed-title" className="ctitle">
          Recent games
        </h2>
        <span className="live">LIVE</span>
      </div>
      {games === null ? (
        <p className="card-empty">{failed ? 'Recent games could not be loaded.' : 'Loading...'}</p>
      ) : games.length === 0 ? (
        <p className="card-empty">No finished games yet.</p>
      ) : (
        <ul>
          {games.map((g) => {
            const mine = same(g.player, p.me);
            const o = OUTCOME[g.outcome];
            return (
              <li key={g.gameId} className="feed-row" data-me={mine} data-outcome={g.outcome}>
                <span className="feed-who">
                  {mine ? 'You' : shortHex(g.player)} <span className="feed-tier">· {g.n}×{g.n}</span>
                </span>
                <span className={`feed-result ${o.tone}`}>{o.text}</span>
                <span className="feed-ago">{formatAgo(now - g.endedAtSec)}</span>
                <span className={`feed-amount ${o.tone}`}>
                  {feedAmount(g)} {symbol}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const TABS: { board: LeaderboardBoard; label: string }[] = [
  { board: 'today', label: 'Today' },
  { board: 'all', label: 'All time' },
  { board: 'points', label: 'Points' },
];

export function Leaderboard(p: {
  api: Pick<ApiClient, 'leaderboard'>;
  me: Hex | null;
  now: number;
  refreshKey: string;
  /** Changes on every SELECT press: the panel flashes. */
  flash: number;
}) {
  const { api, me } = p;
  const [board, setBoard] = useState<LeaderboardBoard>('today');
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const begin = useLatestRequest();

  const load = useCallback(async (): Promise<void> => {
    const current = begin();
    try {
      const reply = await api.leaderboard(board, me);
      if (!current()) return;
      setData(reply);
      setFailed(false);
    } catch {
      if (current()) setFailed(true);
    }
  }, [api, board, me, begin]);

  useEffect(() => {
    void load();
  }, [load, p.refreshKey]);
  useInterval(() => void load(), BOARD_MS);

  const shown = data !== null && data.board === board ? data : null;
  const value = (v: string): string => (board === 'points' ? formatPoints(v) : signedEth(BigInt(v)));
  const now = Math.max(p.now, shown?.chainNowSec ?? 0);
  const note =
    board === 'today'
      ? `Resets daily at 00:00 UTC${shown?.resetsAtSec ? ` · ${formatHms(shown.resetsAtSec - now)} left` : ''}`
      : board === 'all'
        ? 'Net profit since launch'
        : 'Points from treasure chests · no cash value';

  return (
    <section
      className={`card${p.flash ? (p.flash % 2 ? ' flashA' : ' flashB') : ''}`}
      data-testid="side-leaderboard"
      aria-labelledby="lb-title"
      style={{ gap: 10 }}
    >
      <h2 id="lb-title" className="lb-title">
        LEADERBOARD
      </h2>
      <div className="lb-tabs" role="tablist" aria-label="Leaderboard period">
        {TABS.map((t) => (
          <button
            key={t.board}
            type="button"
            role="tab"
            className="tab"
            data-testid={`lb-tab-${t.board}`}
            aria-selected={board === t.board}
            onClick={() => setBoard(t.board)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="lb-note">{note}</p>
      {shown === null ? (
        <p className="card-empty">{failed ? 'The leaderboard could not be loaded.' : 'Loading...'}</p>
      ) : shown.rows.length === 0 ? (
        <p className="card-empty">No one is on this board yet.</p>
      ) : (
        <ol>
          {shown.rows.map((r) => (
            <li key={r.address} className="lb-row" data-rank={r.rank}>
              <span className="lb-rank">{r.rank}</span>
              <span className="lb-addr">{same(r.address, me) ? 'You' : shortHex(r.address)}</span>
              <span className={`lb-value ${board === 'points' ? 'tone-win' : ''}`}>{value(r.value)}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="lb-me" data-testid="lb-me">
        {me === null ? (
          <span style={{ gridColumn: '1 / -1', fontSize: 13 }}>Connect a wallet to see your rank</span>
        ) : (
          <>
            <span className="lb-rank">{shown?.me ? `#${shown.me.rank}` : '—'}</span>
            <span style={{ fontSize: 13, fontWeight: 700 }}>You</span>
            <span className="lb-value">{shown?.me ? value(shown.me.value) : 'No entry yet'}</span>
          </>
        )}
      </div>
    </section>
  );
}

/** The contract's balance: what the house holds to pay winners. */
export function Bankroll(p: { chain: Pick<ChainApi, 'balanceOf'>; contract: Hex; refreshKey: string }) {
  const { chain, contract } = p;
  const [wei, setWei] = useState<bigint | null>(null);
  const load = useCallback(async (): Promise<void> => {
    try {
      setWei(await chain.balanceOf(contract));
    } catch {
      // The chain clock already reports an unreachable RPC.
    }
  }, [chain, contract]);
  useEffect(() => {
    void load();
  }, [load, p.refreshKey]);
  useInterval(() => void load(), BANKROLL_MS);

  const { symbol, explorerUrl } = useNetwork();
  const contractUrl = explorerLink(explorerUrl, 'address', contract);
  return (
    <span className="stat-chip bankroll" data-testid="bankroll" data-wei={wei?.toString() ?? ''} title="The contract's balance">
      <svg viewBox="0 0 9 9" width="16" height="16" shapeRendering="crispEdges" aria-hidden="true" style={{ fill: 'var(--muted)' }}>
        <path d="M4 0h1v1H4zM3 1h3v1H3zM1 2h7v1H1zM0 3h9v1H0zM1 4h1v3H1zM4 4h1v3H4zM7 4h1v3H7zM0 7h9v2H0z" />
      </svg>
      {contractUrl === null ? (
        <span className="stat-label">Bankroll</span>
      ) : (
        <a className="stat-label" href={contractUrl} target="_blank" rel="noreferrer" title="The contract on the block explorer">
          Bankroll
        </a>
      )}
      <span className="stat-value">{wei === null ? '—' : `${formatEth(wei, 4)} ${symbol}`}</span>
    </span>
  );
}
