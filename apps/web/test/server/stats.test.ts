// Recent games (GET /api/feed) and leaderboards (GET /api/leaderboard): derived from the endings,
// reclaims and chest awards of the event log only, rebuilt identically when the log is replayed,
// and bounded by players rather than games.

import {
  chestPoints,
  exitPayoutWei,
  FEED_LIMIT,
  LEADERBOARD_LIMIT,
  refundWei,
  type ChestDraw,
  type ChestKind,
  type Dir,
  type FeedResponse,
  type GameView,
  type Hex,
  type LeaderboardResponse,
} from '@maze/shared';
import { getAddress } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { GET as feedGet } from '../../app/api/feed/route';
import { GET as leaderboardGet } from '../../app/api/leaderboard/route';
import type { RouteHandler } from '../../src/server/http';
import { DAY_SEC, GameStats, type StatsGame } from '../../src/server/stats';
import { createMemoryStore } from '../../src/server/store';
import {
  api,
  BET,
  deadEndRoute,
  exitRoute,
  FakeChain,
  fixtureTable,
  makeEnv,
  openGame,
  PLAYERS,
  T0,
  type OpenedGame,
  type TestEnv,
} from './helpers';

// ----- the aggregator on its own -----

/** Checksummed addresses whose lower-case order is the order of `i`. */
const addr = (i: number): Hex => getAddress(`0x${(0xa0 + i).toString(16).padStart(40, '0')}`);
const gid = (i: number): Hex => `0x${i.toString(16).padStart(64, '0')}`;
/** The start of the UTC day of `T0`. */
const DAY = Math.floor(T0 / DAY_SEC) * DAY_SEC;

function statsGame(i: number, player: Hex, betWei = 100n, n = 5): StatsGame {
  return { gameId: gid(i), player, n, betWei };
}

describe('GameStats: the feed', () => {
  it('lists the newest endings first, by ending time then log order, at most FEED_LIMIT, with every outcome named', () => {
    const stats = new GameStats();
    const endings = [
      { outcome: 0, auto: false }, // exit
      { outcome: 2, auto: false }, // loss
      { outcome: 1, auto: false }, // cashout
      { outcome: 1, auto: true }, // auto-cashout
    ] as const;
    // Twelve games; game 6 is stored late with an earlier time, games 9 and 10 end in the same second.
    const times = [10, 20, 30, 40, 50, 60, 15, 70, 80, 90, 90, 100];
    times.forEach((atSec, i) => {
      const { outcome, auto } = endings[i % 4];
      stats.ended(statsGame(i, addr(i), 100n, 5 + i), { outcome, auto, payoutWei: 50n, atSec: DAY + atSec });
    });

    const feed = stats.recentGames();
    expect(feed).toHaveLength(FEED_LIMIT);
    // Newest first; game 10 is later in the log than game 9 at the same second; games 0 and 6 fell off.
    expect(feed.map((game) => game.gameId)).toEqual([11, 10, 9, 8, 7, 5, 4, 3, 2, 1].map(gid));
    expect(feed.map((game) => game.outcome)).toEqual([
      'auto-cashout',
      'cashout',
      'loss',
      'exit',
      'auto-cashout',
      'loss',
      'exit',
      'auto-cashout',
      'cashout',
      'loss',
    ]);
    expect(feed[0]).toEqual({
      gameId: gid(11),
      player: addr(11),
      n: 16,
      betWei: 100n,
      payoutWei: 50n,
      outcome: 'auto-cashout',
      endedAtSec: DAY + 100,
    });
  });

  it('a game reclaimed after an ending nobody settled is listed once, as reclaimed, with the amount and time of the reclaim', () => {
    const stats = new GameStats();
    const a = addr(1);
    stats.ended(statsGame(1, a), { outcome: 1, auto: false, payoutWei: 40n, atSec: DAY + 10 });
    stats.ended(statsGame(2, addr(2)), { outcome: 0, auto: false, payoutWei: 200n, atSec: DAY + 20 });
    stats.reclaimed(statsGame(1, a), { payoutWei: 40n, atSec: DAY + 10 }, 100n, DAY + 30);

    expect(stats.recentGames().map((game) => [game.gameId, game.outcome, game.payoutWei, game.endedAtSec])).toEqual([
      [gid(1), 'reclaimed', 100n, DAY + 30],
      [gid(2), 'exit', 200n, DAY + 20],
    ]);
    // The cash-out no longer counts: the reclaim gave the bet back, a net of zero.
    expect(stats.standings('all', a, DAY + 30).me).toEqual({ rank: 2, address: a, value: 0n });
    expect(stats.standings('today', a, DAY + 30).me).toEqual({ rank: 2, address: a, value: 0n });
  });

  it('a reclaim of a game whose ending was on an earlier day corrects all time and counts today once', () => {
    const stats = new GameStats();
    const a = addr(1);
    const nextDay = DAY + DAY_SEC;
    stats.ended(statsGame(1, a), { outcome: 2, auto: false, payoutWei: 0n, atSec: DAY + 10 });
    stats.reclaimed(statsGame(1, a), { payoutWei: 0n, atSec: DAY + 10 }, 100n, nextDay + 5);
    expect(stats.standings('all', null, nextDay + 5).rows).toEqual([{ rank: 1, address: a, value: 0n }]);
    expect(stats.standings('today', null, nextDay + 5).rows).toEqual([{ rank: 1, address: a, value: 0n }]);
    // A game reclaimed without any ending counts the same way.
    stats.reclaimed(statsGame(2, a), null, 100n, nextDay + 6);
    expect(stats.recentGames().map((game) => game.outcome)).toEqual(['reclaimed', 'reclaimed']);
    expect(stats.standings('today', null, nextDay + 6).rows).toEqual([{ rank: 1, address: a, value: 0n }]);
  });
});

describe('GameStats: the boards', () => {
  it('profit boards rank by net profit, may be negative, break ties by address, and split today from all time', () => {
    const stats = new GameStats();
    const [a, b, c, d] = [addr(1), addr(2), addr(3), addr(4)];
    // Day 0: a +50, b -100, c +50 (a tie with a), d -40.
    stats.ended(statsGame(1, c), { outcome: 1, auto: false, payoutWei: 150n, atSec: DAY + 1 });
    stats.ended(statsGame(2, a), { outcome: 0, auto: false, payoutWei: 150n, atSec: DAY + 2 });
    stats.ended(statsGame(3, b), { outcome: 2, auto: false, payoutWei: 0n, atSec: DAY + 3 });
    stats.ended(statsGame(4, d), { outcome: 1, auto: true, payoutWei: 60n, atSec: DAY + 4 });

    const today = stats.standings('today', null, DAY + 100);
    expect(today.rows).toEqual([
      { rank: 1, address: a, value: 50n },
      { rank: 2, address: c, value: 50n },
      { rank: 3, address: d, value: -40n },
      { rank: 4, address: b, value: -100n },
    ]);
    expect(today.resetsAtSec).toBe(DAY + DAY_SEC);
    expect(stats.standings('all', null, DAY + 100)).toEqual({ ...today, resetsAtSec: null });

    // The clock passes midnight: today starts over, all time keeps everything.
    const day1 = DAY + DAY_SEC;
    expect(stats.standings('today', a, day1)).toEqual({ rows: [], me: null, resetsAtSec: DAY + 2 * DAY_SEC });
    expect(stats.standings('all', a, day1).rows).toHaveLength(4);

    // Day 1: b wins 300 and leads both boards; nothing of day 0 is in today's.
    stats.ended(statsGame(5, b), { outcome: 0, auto: false, payoutWei: 400n, atSec: day1 + 7 });
    expect(stats.standings('today', null, day1 + 8).rows).toEqual([{ rank: 1, address: b, value: 300n }]);
    expect(stats.standings('all', null, day1 + 8).rows).toEqual([
      { rank: 1, address: b, value: 200n },
      { rank: 2, address: a, value: 50n },
      { rank: 3, address: c, value: 50n },
      { rank: 4, address: d, value: -40n },
    ]);
    // An ending stored late with a time of day 0 counts for all time only.
    stats.ended(statsGame(6, d), { outcome: 0, auto: false, payoutWei: 200n, atSec: DAY + 5 });
    expect(stats.standings('today', d, day1 + 9)).toEqual({
      rows: [{ rank: 1, address: b, value: 300n }],
      me: null,
      resetsAtSec: DAY + 2 * DAY_SEC,
    });
    expect(stats.standings('all', d, day1 + 9).me).toEqual({ rank: 2, address: d, value: 60n });
  });

  it('the points board ranks every awarded address by its total points', () => {
    const stats = new GameStats();
    const [a, b] = [addr(1), addr(2)];
    stats.awarded(a, 30n);
    stats.awarded(b, 20n);
    stats.awarded(b, 15n);
    expect(stats.standings('points', b.toLowerCase(), DAY)).toEqual({
      rows: [
        { rank: 1, address: b, value: 35n },
        { rank: 2, address: a, value: 30n },
      ],
      me: { rank: 1, address: b, value: 35n },
      resetsAtSec: null,
    });
    expect(stats.standings('points', addr(9), DAY).me).toBeNull();
  });

  it('rows stop at LEADERBOARD_LIMIT; the asked-for address is ranked among everyone, in any letter case', () => {
    const stats = new GameStats();
    const count = LEADERBOARD_LIMIT + 3;
    for (let i = 0; i < count; i++) {
      // Player i wins i wei and holds i + 1 points: the last player leads, player 0 is last.
      stats.ended(statsGame(i, addr(i)), { outcome: 0, auto: false, payoutWei: 100n + BigInt(i), atSec: DAY + i });
      stats.awarded(addr(i), BigInt(i + 1));
    }
    const upper = `0x${addr(0).slice(2).toUpperCase()}`;
    for (const board of ['today', 'all', 'points'] as const) {
      const standing = stats.standings(board, upper, DAY + count);
      expect(standing.rows).toHaveLength(LEADERBOARD_LIMIT);
      expect(standing.rows.map((row) => row.rank)).toEqual([...Array(LEADERBOARD_LIMIT).keys()].map((k) => k + 1));
      expect(standing.rows[0].address).toBe(addr(count - 1));
      expect(standing.me).toEqual({ rank: count, address: addr(0), value: board === 'points' ? 1n : 0n });
    }
    expect(stats.standings('all', null, DAY).me).toBeNull();
    expect(stats.standings('all', addr(99), DAY).me).toBeNull();
  });
});

// ----- through the server and its routes -----

let env: TestEnv | null = null;

afterEach(async () => {
  await env?.close();
  env = null;
});

function current(): TestEnv {
  if (env === null) throw new Error('no environment');
  return env;
}

interface Reply<T> {
  status: number;
  text: string;
  body: T;
}

async function get<T>(handler: RouteHandler, path: string): Promise<Reply<T>> {
  const response = await handler(new Request(`http://localhost${path}`), { params: Promise.resolve({}) });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as T };
}

const feed = () => get<FeedResponse>(feedGet, '/api/feed');
const board = (query: string) => get<LeaderboardResponse>(leaderboardGet, `/api/leaderboard${query}`);

/** Every dead end holds a chest worth `DEAD_END_BPS`; path cells hold none. */
const DEAD_END_BPS = 2500;
function deadEndChests(_finalSeed: Hex, _cell: number, kind: ChestKind): ChestDraw {
  return kind === 'dead-end' ? { placed: true, rewardBps: DEAD_END_BPS } : { placed: false, rewardBps: 0 };
}

async function walk(game: OpenedGame, dirs: readonly Dir[]): Promise<GameView> {
  let view: GameView | null = null;
  for (let step = 0; step < dirs.length; step++) {
    const reply = await api.move<GameView>(game.gameId, game.token, { step, dir: dirs[step] });
    expect(reply.status).toBe(200);
    view = reply.body;
  }
  if (view === null) throw new Error('walk needs at least one move');
  return view;
}

/** Every answer of the two routes, as raw text, for comparing a server with its restarted self. */
async function snapshot(address: Hex): Promise<string[]> {
  const replies = [
    await feed(),
    await board(''),
    await board(`?board=all&address=${address}`),
    await board(`?board=points&address=${address}`),
  ];
  for (const reply of replies) expect(reply.status).toBe(200);
  return replies.map((reply) => reply.text);
}

describe('GET /api/feed and GET /api/leaderboard', () => {
  it('report the games played through the routes, cross midnight on the chain clock, and come back the same after a restart', async () => {
    const store = createMemoryStore();
    const chain = new FakeChain(fixtureTable);
    env = await makeEnv({ store, chain, chestDraw: deadEndChests });
    const [a, b, c, d] = PLAYERS;
    const table = current().table;

    const won = await openGame(current(), { player: a });
    expect((await walk(won, exitRoute(won.maze))).status).toBe('won');
    const lost = await openGame(current(), { player: b, deadEnd: true });
    expect((await walk(lost, deadEndRoute(lost.maze))).status).toBe('lost');
    const cashed = await openGame(current(), { player: c });
    expect((await api.cashout(cashed.gameId, cashed.token, { step: 0 })).status).toBe(200);
    const idle = await openGame(current(), { player: d });
    current().advance(table.timing.idleTimeoutSec);
    await current().tick();
    await current().container.relayer.drain();

    const refund = refundWei(table, BET, 0, 0);
    const exitWin = exitPayoutWei(table, BET, 0);
    const bet = BET.toString();
    const first = await feed();
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      games: [
        { gameId: idle.gameId, player: d, n: 5, betWei: bet, payoutWei: refund.toString(), outcome: 'auto-cashout', endedAtSec: T0 + table.timing.idleTimeoutSec },
        // Three games ended in the same second: the later in the log comes first.
        { gameId: cashed.gameId, player: c, n: 5, betWei: bet, payoutWei: refund.toString(), outcome: 'cashout', endedAtSec: T0 },
        { gameId: lost.gameId, player: b, n: 5, betWei: bet, payoutWei: '0', outcome: 'loss', endedAtSec: T0 },
        { gameId: won.gameId, player: a, n: 5, betWei: bet, payoutWei: exitWin.toString(), outcome: 'exit', endedAtSec: T0 },
      ],
      chainNowSec: chain.time,
    });

    // c and d lost the same amount: the tie goes to the lower address.
    const [cd1, cd2] = c.toLowerCase() < d.toLowerCase() ? [c, d] : [d, c];
    const profits = [
      { address: a, value: (exitWin - BET).toString() },
      { address: cd1, value: (refund - BET).toString() },
      { address: cd2, value: (refund - BET).toString() },
      { address: b, value: (-BET).toString() },
    ].map((row, index) => ({ rank: index + 1, ...row }));
    const midnight = (Math.floor(T0 / DAY_SEC) + 1) * DAY_SEC;
    expect((await board('?board=today')).body).toEqual({
      board: 'today',
      rows: profits,
      me: null,
      resetsAtSec: midnight,
      chainNowSec: chain.time,
    });
    expect((await board(`?board=all&address=${b.toLowerCase()}`)).body).toEqual({
      board: 'all',
      rows: profits,
      me: profits[3],
      chainNowSec: chain.time,
    });
    const points = chestPoints(BET, DEAD_END_BPS).toString();
    expect((await board(`?board=points&address=${b}`)).body).toEqual({
      board: 'points',
      rows: [{ rank: 1, address: b, value: points }],
      me: { rank: 1, address: b, value: points },
      chainNowSec: chain.time,
    });
    expect(current().container.service.pointsOf(b)!.totalPoints.toString()).toBe(points);

    // Midnight on the chain clock: today's board starts over, all time keeps every game.
    current().advance(midnight - chain.time);
    await current().tick();
    expect((await board('')).body).toEqual({
      board: 'today',
      rows: [],
      me: null,
      resetsAtSec: midnight + DAY_SEC,
      chainNowSec: midnight,
    });
    const again = await openGame(current(), { player: a });
    await walk(again, exitRoute(again.maze));
    await current().container.relayer.drain();
    expect((await board(`?address=${a}`)).body).toMatchObject({
      rows: [{ rank: 1, address: a, value: (exitWin - BET).toString() }],
      me: { rank: 1, address: a, value: (exitWin - BET).toString() },
    });
    expect((await board('?board=all')).body.rows[0]).toEqual({
      rank: 1,
      address: a,
      value: (2n * (exitWin - BET)).toString(),
    });
    expect((await feed()).body.games.map((game) => game.gameId)).toEqual(
      [again, idle, cashed, lost, won].map((game) => game.gameId),
    );

    // The same log gives the same answers to a server that replays it.
    const before = await snapshot(a);
    await current().close();
    env = await makeEnv({ store, chain, chestDraw: deadEndChests });
    expect(await snapshot(a)).toEqual(before);
  });

  it('a game reclaimed after an ending nobody settled turns into a reclaim, in the feed and on both profit boards, before and after a restart', async () => {
    const store = createMemoryStore();
    const chain = new FakeChain(fixtureTable);
    env = await makeEnv({ store, chain });
    const player = PLAYERS[0];
    const game = await openGame(current(), { player });
    chain.sendMode = 'drop';
    expect((await api.cashout(game.gameId, game.token, { step: 0 })).status).toBe(200);
    await current().container.relayer.drain();
    const refund = refundWei(current().table, BET, 0, 0);
    expect((await feed()).body.games).toMatchObject([{ outcome: 'cashout', payoutWei: refund.toString() }]);
    expect((await board('?board=all')).body.rows).toEqual([{ rank: 1, address: player, value: (refund - BET).toString() }]);

    // The settlement never reaches the chain; after the deadline the player takes the bet back.
    const deadline = chain.games.get(game.gameId)!.settleDeadlineSec;
    current().advance(deadline + 1 - chain.time);
    await current().tick();
    chain.reclaim(game.gameId);
    await current().tick();
    expect(current().container.service.get(game.gameId)!.final).toBe('reclaimed');

    const reclaimedAt = chain.time;
    const expectReclaimed = async (): Promise<void> => {
      expect((await feed()).body.games).toEqual([
        { gameId: game.gameId, player, n: 5, betWei: BET.toString(), payoutWei: BET.toString(), outcome: 'reclaimed', endedAtSec: reclaimedAt },
      ]);
      const zero = [{ rank: 1, address: player, value: '0' }];
      expect((await board('?board=all')).body.rows).toEqual(zero);
      // Still the same UTC day: the cash-out is taken out of today's board as well.
      expect((await board('?board=today')).body.rows).toEqual(zero);
    };
    await expectReclaimed();
    await current().close();
    env = await makeEnv({ store, chain });
    await expectReclaimed();
  });

  it('refuse an unknown board and a malformed address with the error body of every other route', async () => {
    env = await makeEnv();
    const badRequest = await api.points('0x12');
    expect(badRequest.status).toBe(400);
    expect(badRequest.body).toEqual({ error: { code: 'BAD_REQUEST', message: expect.any(String) } });
    for (const query of [
      '?board=week',
      '?board=',
      '?board=ALL',
      '?board=all&address=0x12',
      '?board=points&address=',
      `?address=0x${'zz'.repeat(20)}`,
      `?address=${PLAYERS[0]}00`,
    ]) {
      const reply = await board(query);
      expect(reply.status, query).toBe(400);
      expect(reply.text, query).toBe(badRequest.text);
    }

    // No board is today's; an address without games has no row; an unknown parameter is ignored.
    const now = current().chain.time;
    expect((await board(`?address=${PLAYERS[1].toLowerCase()}&extra=1`)).body).toEqual({
      board: 'today',
      rows: [],
      me: null,
      resetsAtSec: (Math.floor(now / DAY_SEC) + 1) * DAY_SEC,
      chainNowSec: now,
    });
    expect((await board('?board=all')).body).toEqual({ board: 'all', rows: [], me: null, chainNowSec: now });
    expect((await feed()).body).toEqual({ games: [], chainNowSec: now });
  });
});
