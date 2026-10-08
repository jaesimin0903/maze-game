// What a response may contain (plan AC-S1, AC-S2, §7.3 allow-list).

import {
  commitmentOf,
  deriveFinalSeed,
  refundWei,
  type ConfigResponse,
  type GameView,
  type Hex,
} from '@maze/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Game } from '../../src/server/game-service';
import { toPublicView } from '../../src/server/serializer';
import {
  api,
  BET,
  cellsOf,
  exitRoute,
  fixtureTable,
  makeEnv,
  openGame,
  PLAYERS,
  T0,
  wallDir,
  type TestEnv,
} from './helpers';

const VIEW_KEYS = [
  'gameId',
  'tier',
  'n',
  'status',
  'auto',
  'step',
  'cell',
  'open',
  'betWei',
  'refundableWei',
  'exitPayoutWei',
  'chainNowSec',
  'idleDeadlineSec',
  'gameDeadlineSec',
  'settleDeadlineSec',
  'chestRule',
  'chests',
];
const TERMINAL_KEYS = [
  'serverSeed',
  'clientSeed',
  'outcome',
  'steps',
  'payoutWei',
  'signature',
  'settleTxHash',
];

let env: TestEnv;

beforeEach(async () => {
  env = await makeEnv();
});

afterEach(async () => {
  await env.close();
});

describe('AC-S1: in-game responses', () => {
  it('start and move carry exactly the allowed keys and only the current cell', async () => {
    const game = await openGame(env);
    const route = exitRoute(game.maze);
    const cells = cellsOf(game.maze, route);

    const start = await api.start<GameView>(game.gameId, game.token);
    expect(Object.keys(start.body)).toEqual(VIEW_KEYS);
    expect(start.body.open).toBe(game.maze.open[0]);

    for (let k = 0; k < 3; k++) {
      const reply = await api.move<GameView>(game.gameId, game.token, { step: k, dir: route[k] });
      expect(Object.keys(reply.body)).toEqual(VIEW_KEYS);
      const cell = cells[k + 1];
      expect(reply.body.cell).toEqual({ x: cell % game.n, y: Math.floor(cell / game.n) });
      expect(reply.body.open).toBe(game.maze.open[cell]);
      expect(reply.body.status).toBe('active');
    }
  });

  it('the resume read adds the visited cells, in order, and nothing else', async () => {
    const game = await openGame(env);
    const route = exitRoute(game.maze).slice(0, 3);
    const cells = cellsOf(game.maze, route);
    for (let k = 0; k < route.length; k++) {
      await api.move(game.gameId, game.token, { step: k, dir: route[k] });
    }

    const reply = await api.game<GameView>(game.gameId, game.token);
    expect(Object.keys(reply.body)).toEqual([...VIEW_KEYS, 'path']);
    expect(reply.body.path).toEqual(
      cells.map((cell) => ({
        x: cell % game.n,
        y: Math.floor(cell / game.n),
        open: game.maze.open[cell],
      })),
    );
  });

  it('AC-S2: no in-game or error response contains a seed', async () => {
    const game = await openGame(env);
    const record = env.container.service.get(game.gameId)!;
    const serverSeed = record.serverSeed.slice(2);
    const finalSeed = deriveFinalSeed({
      serverSeed: record.serverSeed,
      clientSeed: game.clientSeed,
      gameId: game.gameId,
    }).slice(2);
    const route = exitRoute(game.maze);

    const replies = [
      await api.start(game.gameId, game.token),
      await api.move(game.gameId, game.token, { step: 0, dir: route[0] }),
      await api.move(game.gameId, game.token, { step: 1, dir: route[1] }),
      await api.game(game.gameId, game.token),
      await api.move(game.gameId, game.token, { step: 0, dir: route[0] }),
      await api.move(game.gameId, game.token, { step: 2, dir: wallDir(game.maze, cellsOf(game.maze, route)[2]) ?? 9 }),
      await api.game(game.gameId, 'wrong-token'),
      await api.reveal(game.gameId),
      await api.config(),
    ];
    for (const reply of replies) {
      expect(reply.text).not.toContain(serverSeed);
      expect(reply.text).not.toContain(finalSeed);
      expect(reply.text).not.toContain('terminal');
      expect(reply.text).not.toContain('Seed');
    }
  });

  it('every error body is exactly { error: { code, message } }', async () => {
    const game = await openGame(env);
    const replies = [
      await api.move(game.gameId, game.token, { step: 5, dir: 1 }),
      await api.move(game.gameId, 'wrong', { step: 0, dir: 1 }),
      await api.move(game.gameId, game.token, { step: 0 }),
      await api.game(`0x${'00'.repeat(32)}`, game.token),
      await api.reveal(game.gameId),
    ];
    for (const reply of replies) {
      expect(reply.status).toBeGreaterThanOrEqual(400);
      const body = reply.body as { error: Record<string, unknown> };
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body.error)).toEqual(['code', 'message']);
    }
  });
});

describe('ended games', () => {
  it('AC-S2: the terminal block appears only once the game has ended', async () => {
    const game = await openGame(env);
    const route = exitRoute(game.maze);
    await api.move(game.gameId, game.token, { step: 0, dir: route[0] });
    const reply = await api.cashout<GameView>(game.gameId, game.token, { step: 1 });

    expect(Object.keys(reply.body)).toEqual([...VIEW_KEYS, 'terminal']);
    // A chest rule 2 game names its rule on every ending; only a dead end adds `chest`.
    expect(Object.keys(reply.body.terminal!)).toEqual([...TERMINAL_KEYS, 'chestRule']);
    // AC-M4: the revealed seed opens the commitment the ticket was signed with.
    expect(
      commitmentOf({ mazeVersion: 1, n: game.n, serverSeed: reply.body.terminal!.serverSeed }),
    ).toBe(game.ticket.commitment);

    const read = await api.game<GameView>(game.gameId, game.token);
    expect(Object.keys(read.body)).toEqual([...VIEW_KEYS, 'path', 'terminal']);
    expect(read.body.path).toHaveLength(2);
  });
});

describe('toPublicView', () => {
  const game = {
    gameId: `0x${'a1'.repeat(32)}`,
    player: PLAYERS[0],
    tier: 0,
    n: 5,
    serverSeed: `0x${'5e'.repeat(32)}`,
    commitment: `0x${'c0'.repeat(32)}`,
    sessionTokenHash: `0x${'70'.repeat(32)}`,
    expirySec: T0 + 120,
    chain: {
      clientSeed: `0x${'c1'.repeat(32)}`,
      betWei: BET,
      maxPayoutWei: BET * 2n,
      createdAtSec: T0,
      settleDeadlineSec: T0 + 1800,
      blockNumber: 7n,
      chestRule: 2,
    },
    moves: [1, 2],
    path: [
      { cell: 0, open: 2 },
      { cell: 1, open: 12 },
      { cell: 6, open: 7 },
    ],
    lastActivitySec: T0 + 9,
    ended: null,
    chests: [{ cell: 1, kind: 'path', rewardBps: 321, points: 3210n, chestRule: 2, step: 1, atSec: T0 + 5 }],
    settle: { lastSentSec: null, lastTxHash: null, sends: 0, minedTxHash: null },
    final: null,
    // Things a careless serializer could pick up.
    maze: { w: 5, h: 5, open: new Uint8Array(25).fill(15) },
    finalSeed: `0x${'f5'.repeat(32)}`,
  } as unknown as Game;
  const args = { table: fixtureTable, nowSec: T0 + 10, idleTimeoutSec: 120, maxGameSec: 900 };

  it('copies only the allowed keys, whatever else the record holds', () => {
    const view = toPublicView({ ...args, game, withPath: true });
    expect(Object.keys(view)).toEqual([...VIEW_KEYS, 'path']);
    expect(view).toMatchObject({
      status: 'active',
      auto: false,
      step: 2,
      cell: { x: 1, y: 1 },
      open: 7,
      idleDeadlineSec: T0 + 129,
      gameDeadlineSec: T0 + 900,
      settleDeadlineSec: T0 + 1800,
      chestRule: 2,
      chests: [{ cell: { x: 1, y: 0 }, kind: 'path', rewardBps: 321, points: '3210', step: 1 }],
    });
    expect(Object.keys(view.chests![0])).toEqual(['cell', 'kind', 'rewardBps', 'points', 'step']);
    const text = JSON.stringify(view);
    expect(text).not.toContain('5e5e');
    expect(text).not.toContain('f5f5');
    expect(text).not.toContain('c0c0');
  });

  it('builds the terminal block only for an ended game', () => {
    const ended = {
      ...game,
      ended: {
        outcome: 1,
        steps: 2,
        payoutWei: 6_694n,
        signature: `0x${'ab'.repeat(65)}`,
        auto: true,
        cause: 'idle',
        atSec: T0 + 130,
      },
      settle: { lastSentSec: T0 + 130, lastTxHash: `0x${'d1'.repeat(32)}`, sends: 1, minedTxHash: null },
    } as unknown as Game;
    const view = toPublicView({ ...args, game: ended, withPath: false });
    expect(Object.keys(view)).toEqual([...VIEW_KEYS, 'terminal']);
    expect(view.status).toBe('cashed_out');
    expect(view.auto).toBe(true);
    expect(view.terminal).toEqual({
      serverSeed: game.serverSeed,
      clientSeed: `0x${'c1'.repeat(32)}`,
      outcome: 1,
      steps: 2,
      payoutWei: '6694',
      signature: `0x${'ab'.repeat(65)}`,
      settleTxHash: `0x${'d1'.repeat(32)}`,
    });
  });

  it('X7: the refundable amount is a function of (table, tier, step, bet) alone', () => {
    for (const step of [0, 1, 2]) {
      const a = { ...game, moves: game.moves.slice(0, step), path: game.path.slice(0, step + 1) } as Game;
      const b = {
        ...a,
        gameId: `0x${'b2'.repeat(32)}` as Hex,
        serverSeed: `0x${'99'.repeat(32)}` as Hex,
        path: a.path.map((cell) => ({ cell: cell.cell, open: cell.open ^ 15 })),
      } as Game;
      const expected = refundWei(fixtureTable, BET, 0, step).toString();
      expect(toPublicView({ ...args, game: a, withPath: false }).refundableWei).toBe(expected);
      expect(toPublicView({ ...args, game: b, withPath: false }).refundableWei).toBe(expected);
    }
  });
});

describe('other responses', () => {
  it('AC-T8: /api/config carries the runtime chain settings and the table in use', async () => {
    const reply = await api.config<ConfigResponse>();
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body)).toEqual([
      'chainId',
      'rpcUrl',
      'contract',
      'mazeVersion',
      'tableVersion',
      'tableHash',
      'calibrated',
      'fixture',
      'testHooks',
      'tiers',
      'minBetWei',
      'maxBetWei',
      'idleTimeoutSec',
      'maxGameSec',
      'settleWindowSec',
      'chainNowSec',
      'devWallet',
      'chest',
      'network',
      'privyAppId',
    ]);
    // AC-P5, AC-P9: the chest rule version, both kinds of chest, and that points have no cash value.
    expect(reply.body.chest).toEqual({
      ruleVersion: 2,
      rateBps: 3000,
      rewardMinBps: 1000,
      rewardMaxBps: 3000,
      pointUnitWei: '1000000000000',
      cashValue: false,
      pathRateBps: 1000,
      pathRewardMinBps: 200,
      pathRewardMaxBps: 500,
    });
    expect(reply.body).toMatchObject({
      chainId: 31337,
      rpcUrl: 'http://127.0.0.1:8546',
      contract: env.container.config.contract,
      tableHash: env.chain.tableHashValue,
      fixture: true,
      calibrated: false,
      testHooks: true,
      devWallet: false,
      tiers: fixtureTable.tiers,
      minBetWei: fixtureTable.limits.minBetWei,
      maxBetWei: fixtureTable.limits.maxBetWei,
      idleTimeoutSec: 120,
      maxGameSec: 900,
      settleWindowSec: 1800,
      chainNowSec: env.chain.time,
    });
  });
});
