// The panels beside the console: recent games and the leaderboards, read from the server, and
// the house bankroll, read from the chain. Every row comes from the stub's answer.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry, FeedResponse, Hex, LeaderboardBoard, LeaderboardResponse } from '@maze/shared';
import { Bankroll, Leaderboard, RecentGames, formatAgo } from '../../src/client/components/SidePanels';
import { shortHex } from '../../src/client/format';
import { CONTRACT, PLAYER, anvilAccount } from './helpers';

afterEach(() => cleanup());

const NOW = 1_700_000_000;
const OTHER: Hex = anvilAccount(3).address;
const THIRD: Hex = anvilAccount(4).address;
const gameId = (k: number): Hex => `0x${k.toString(16).padStart(64, '0')}`;

const attr = (testId: string, name: string): string | null =>
  screen.getByTestId(testId).getAttribute(name);
const rows = (testId: string): HTMLElement[] => [
  ...screen.getByTestId(testId).querySelectorAll<HTMLElement>('li'),
];

describe('formatAgo', () => {
  it('counts in seconds, minutes, hours, then days', () => {
    expect(formatAgo(0)).toBe('0s ago');
    expect(formatAgo(59.9)).toBe('59s ago');
    expect(formatAgo(60)).toBe('1m ago');
    expect(formatAgo(3599)).toBe('59m ago');
    expect(formatAgo(3600)).toBe('1h ago');
    expect(formatAgo(86_399)).toBe('23h ago');
    expect(formatAgo(86_400)).toBe('1d ago');
    expect(formatAgo(-5)).toBe('0s ago');
  });
});

describe('RecentGames', () => {
  const GAMES: FeedEntry[] = [
    { gameId: gameId(1), player: PLAYER, n: 5, betWei: '10000000000000000', payoutWei: '25500000000000000', outcome: 'exit', endedAtSec: NOW - 8 },
    { gameId: gameId(2), player: OTHER, n: 7, betWei: '20000000000000000', payoutWei: '0', outcome: 'loss', endedAtSec: NOW - 180 },
    { gameId: gameId(3), player: THIRD, n: 10, betWei: '10000000000000000', payoutWei: '7300000000000000', outcome: 'cashout', endedAtSec: NOW - 7200 },
    { gameId: gameId(4), player: OTHER, n: 5, betWei: '10000000000000000', payoutWei: '6694000000000000', outcome: 'auto-cashout', endedAtSec: NOW - 5 * 86_400 },
    { gameId: gameId(5), player: PLAYER, n: 5, betWei: '10000000000000000', payoutWei: '10000000000000000', outcome: 'reclaimed', endedAtSec: NOW - 61 },
  ];
  const feedOf = (games: FeedEntry[]) => {
    const calls: number[] = [];
    return {
      calls,
      api: {
        feed: async (): Promise<FeedResponse> => {
          calls.push(calls.length);
          return { games, chainNowSec: NOW };
        },
      },
    };
  };

  it('lists the finished games the server sent, newest first, with "You" for the connected wallet', async () => {
    const { api } = feedOf(GAMES);
    // The chain clock is not known yet: the server's chain second dates the games.
    render(<RecentGames api={api} me={PLAYER.toLowerCase() as Hex} now={0} refreshKey="a" />);
    await waitFor(() => expect(rows('recent-feed')).toHaveLength(GAMES.length));
    const items = rows('recent-feed');

    expect(items.map((li) => li.getAttribute('data-outcome'))).toEqual(GAMES.map((g) => g.outcome));
    expect(items.map((li) => li.getAttribute('data-me'))).toEqual(['true', 'false', 'false', 'false', 'true']);
    const who = items.map((li) => li.querySelector('.feed-who')?.textContent);
    expect(who).toEqual([
      'You · 5×5',
      `${shortHex(OTHER)} · 7×7`,
      `${shortHex(THIRD)} · 10×10`,
      `${shortHex(OTHER)} · 5×5`,
      'You · 5×5',
    ]);
    expect(items.map((li) => li.querySelector('.feed-result')?.textContent)).toEqual([
      'Escaped',
      'Died',
      'Cashed out',
      'Auto cash-out',
      'Reclaimed',
    ]);
    // A win is signed, a loss shows the lost bet, the rest show what was paid back.
    expect(items.map((li) => li.querySelector('.feed-amount')?.textContent)).toEqual([
      '+0.0255 ETH',
      '-0.02 ETH',
      '0.0073 ETH',
      '0.0066 ETH',
      '0.01 ETH',
    ]);
    expect(items.map((li) => li.querySelector('.feed-ago')?.textContent)).toEqual([
      '8s ago',
      '3m ago',
      '2h ago',
      '5d ago',
      '1m ago',
    ]);
  });

  it('shows no one as "You" without a wallet, and asks again when the page refreshes', async () => {
    const { api, calls } = feedOf(GAMES.slice(0, 1));
    const { rerender } = render(<RecentGames api={api} me={null} now={NOW + 52} refreshKey="a" />);
    await waitFor(() => expect(rows('recent-feed')).toHaveLength(1));
    expect(rows('recent-feed')[0].textContent).toContain(shortHex(PLAYER));
    expect(rows('recent-feed')[0].textContent).not.toContain('You');
    // The later of the two clocks dates the game.
    expect(rows('recent-feed')[0].textContent).toContain('1m ago');
    expect(calls).toHaveLength(1);

    rerender(<RecentGames api={api} me={null} now={NOW + 52} refreshKey="b" />);
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it('keeps the newest answer: a slow reply to an older request does not replace it', async () => {
    let releaseFirst = (): void => undefined;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    let asked = 0;
    const api = {
      feed: async (): Promise<FeedResponse> => {
        asked += 1;
        if (asked === 1) {
          await firstHeld;
          return { games: GAMES.slice(0, 1), chainNowSec: NOW };
        }
        return { games: GAMES.slice(1, 3), chainNowSec: NOW };
      },
    };
    const { rerender } = render(<RecentGames api={api} me={null} now={NOW} refreshKey="a" />);
    rerender(<RecentGames api={api} me={null} now={NOW} refreshKey="b" />);
    await waitFor(() => expect(rows('recent-feed')).toHaveLength(2));
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rows('recent-feed').map((li) => li.getAttribute('data-outcome'))).toEqual(['loss', 'cashout']);
  });

  it('says so when there are no games yet, and when the feed cannot be loaded', async () => {
    render(<RecentGames api={feedOf([]).api} me={PLAYER} now={NOW} refreshKey="a" />);
    await waitFor(() => expect(screen.getByTestId('recent-feed').textContent).toContain('No finished games yet.'));
    expect(rows('recent-feed')).toEqual([]);
    cleanup();

    render(
      <RecentGames
        api={{ feed: () => Promise.reject(new Error('down')) }}
        me={PLAYER}
        now={NOW}
        refreshKey="a"
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('recent-feed').textContent).toContain('Recent games could not be loaded.'),
    );
  });
});

describe('Leaderboard', () => {
  const RESETS = (Math.floor(NOW / 86_400) + 1) * 86_400;
  const BOARDS: Record<LeaderboardBoard, LeaderboardResponse> = {
    today: {
      board: 'today',
      rows: [
        { rank: 1, address: OTHER, value: '15500000000000000' },
        { rank: 2, address: PLAYER, value: '-10000000000000000' },
      ],
      me: { rank: 2, address: PLAYER, value: '-10000000000000000' },
      resetsAtSec: RESETS,
      chainNowSec: RESETS - 3661,
    },
    all: { board: 'all', rows: [], me: null, chainNowSec: NOW },
    points: {
      board: 'points',
      rows: [
        { rank: 1, address: PLAYER, value: '1234567' },
        { rank: 2, address: THIRD, value: '300' },
      ],
      me: { rank: 1, address: PLAYER, value: '1234567' },
      chainNowSec: NOW,
    },
  };
  const boardsOf = (answer: (board: LeaderboardBoard) => Promise<LeaderboardResponse>) => {
    const calls: [LeaderboardBoard, Hex | null][] = [];
    return {
      calls,
      api: {
        leaderboard: (board: LeaderboardBoard, address: Hex | null): Promise<LeaderboardResponse> => {
          calls.push([board, address]);
          return answer(board);
        },
      },
    };
  };
  const lbRows = (): { rank: string | null; who: string; value: string }[] =>
    [...screen.getByTestId('side-leaderboard').querySelectorAll<HTMLElement>('ol li')].map((li) => ({
      rank: li.getAttribute('data-rank'),
      who: li.querySelector('.lb-addr')?.textContent ?? '',
      value: li.querySelector('.lb-value')?.textContent ?? '',
    }));

  it('shows today\'s board with signed profit, "You" for the connected wallet, its own rank and the reset countdown', async () => {
    const { api, calls } = boardsOf(async (board) => BOARDS[board]);
    render(<Leaderboard api={api} me={PLAYER} now={0} refreshKey="a" flash={0} />);
    await waitFor(() => expect(lbRows()).toHaveLength(2));
    expect(calls).toEqual([['today', PLAYER]]);
    expect(lbRows()).toEqual([
      { rank: '1', who: shortHex(OTHER), value: '+0.0155' },
      { rank: '2', who: 'You', value: '-0.01' },
    ]);
    const me = screen.getByTestId('lb-me');
    expect(me.textContent).toContain('#2');
    expect(me.textContent).toContain('You');
    expect(me.textContent).toContain('-0.01');
    expect(screen.getByTestId('side-leaderboard').textContent).toContain('Resets daily at 00:00 UTC · 1:01:01 left');
    expect(attr('lb-tab-today', 'aria-selected')).toBe('true');
  });

  it('switches boards: points show as points with no cash value, an empty board and a missing own row say so', async () => {
    let releaseAll = (): void => undefined;
    const allHeld = new Promise<void>((resolve) => (releaseAll = resolve));
    const { api, calls } = boardsOf(async (board) => {
      if (board === 'all') await allHeld;
      return BOARDS[board];
    });
    render(<Leaderboard api={api} me={PLAYER} now={NOW} refreshKey="a" flash={0} />);
    await waitFor(() => expect(lbRows()).toHaveLength(2));

    // While the next board is on its way, the last one is not shown under its tab.
    fireEvent.click(screen.getByTestId('lb-tab-all'));
    await waitFor(() => expect(attr('lb-tab-all', 'aria-selected')).toBe('true'));
    expect(lbRows()).toEqual([]);
    expect(screen.getByTestId('side-leaderboard').textContent).toContain('Loading...');
    releaseAll();
    await waitFor(() =>
      expect(screen.getByTestId('side-leaderboard').textContent).toContain('No one is on this board yet.'),
    );
    expect(screen.getByTestId('side-leaderboard').textContent).toContain('Net profit since launch');
    expect(screen.getByTestId('lb-me').textContent).toContain('No entry yet');

    fireEvent.click(screen.getByTestId('lb-tab-points'));
    await waitFor(() => expect(lbRows()).toHaveLength(2));
    expect(lbRows()).toEqual([
      { rank: '1', who: 'You', value: '1,234,567' },
      { rank: '2', who: shortHex(THIRD), value: '300' },
    ]);
    expect(screen.getByTestId('side-leaderboard').textContent).toContain('Points from treasure chests · no cash value');
    expect(screen.getByTestId('lb-me').textContent).toContain('#1');
    expect(screen.getByTestId('lb-me').textContent).toContain('1,234,567');
    expect(attr('lb-tab-today', 'aria-selected')).toBe('false');
    expect(calls).toEqual([
      ['today', PLAYER],
      ['all', PLAYER],
      ['points', PLAYER],
    ]);
  });

  it('a slow answer for the board left behind does not replace the board now chosen', async () => {
    let releaseToday = (): void => undefined;
    const todayHeld = new Promise<void>((resolve) => (releaseToday = resolve));
    const { api } = boardsOf(async (board) => {
      if (board === 'today') await todayHeld;
      return BOARDS[board];
    });
    render(<Leaderboard api={api} me={PLAYER} now={NOW} refreshKey="a" flash={0} />);
    fireEvent.click(screen.getByTestId('lb-tab-points'));
    await waitFor(() => expect(lbRows()).toHaveLength(2));
    releaseToday();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attr('lb-tab-points', 'aria-selected')).toBe('true');
    expect(lbRows().map((row) => row.value)).toEqual(['1,234,567', '300']);
    expect(screen.getByTestId('lb-me').textContent).toContain('#1');
  });

  it('without a wallet asks for no own row and invites the player to connect; a failed read says so', async () => {
    const { api, calls } = boardsOf(async (board) => ({ ...BOARDS[board], me: null }));
    render(<Leaderboard api={api} me={null} now={NOW} refreshKey="a" flash={0} />);
    await waitFor(() => expect(lbRows()).toHaveLength(2));
    expect(calls).toEqual([['today', null]]);
    expect(lbRows().map((row) => row.who)).toEqual([shortHex(OTHER), shortHex(PLAYER)]);
    expect(screen.getByTestId('lb-me').textContent).toBe('Connect a wallet to see your rank');
    cleanup();

    render(
      <Leaderboard
        api={{ leaderboard: () => Promise.reject(new Error('down')) }}
        me={PLAYER}
        now={NOW}
        refreshKey="a"
        flash={0}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('side-leaderboard').textContent).toContain('The leaderboard could not be loaded.'),
    );
  });
});

describe('Bankroll', () => {
  it('shows the contract balance read from the chain', async () => {
    const asked: Hex[] = [];
    const chain = {
      balanceOf: async (address: Hex): Promise<bigint> => {
        asked.push(address);
        return 1_234_567n * 10n ** 12n;
      },
    };
    render(<Bankroll chain={chain} contract={CONTRACT} refreshKey="a" />);
    await waitFor(() => expect(attr('bankroll', 'data-wei')).toBe((1_234_567n * 10n ** 12n).toString()));
    expect(screen.getByTestId('bankroll').textContent).toContain('1.2345 ETH');
    expect(asked).toEqual([CONTRACT]);
  });
});
