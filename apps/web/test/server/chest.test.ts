// AC-P3: a move into a dead end that holds a chest awards it, once, stored with the ending; no
// other ending awards anything. AC-P5: the points ledger is derived from the event log, survives
// a restart, and is read through GET /api/points/:address.

import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  chestAt,
  chestPoints,
  deriveFinalSeed,
  POINTS_RECENT_LIMIT,
  type ChestDraw,
  type GameView,
  type Hex,
  type PointsResponse,
} from '@maze/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { LedgerAccount } from '../../src/server/points';
import { toPointsResponse } from '../../src/server/serializer';
import { createMemoryStore, openFileStore, type StoreEvent } from '../../src/server/store';
import {
  api,
  BET,
  cellsOf,
  deadEndRoute,
  exitRoute,
  FakeChain,
  fixtureTable,
  makeEnv,
  openGame,
  PLAYERS,
  type OpenedGame,
  type TestEnv,
} from './helpers';

const TERMINAL_KEYS = ['serverSeed', 'clientSeed', 'outcome', 'steps', 'payoutWei', 'signature', 'settleTxHash'];

let env: TestEnv | null = null;

afterEach(async () => {
  await env?.close();
  env = null;
});

const xy = (cell: number, n: number): { x: number; y: number } => ({ x: cell % n, y: Math.floor(cell / n) });

function current(): TestEnv {
  if (env === null) throw new Error('no environment');
  return env;
}

function finalSeedOf(game: OpenedGame): Hex {
  const serverSeed = current().container.service.get(game.gameId)!.serverSeed;
  return deriveFinalSeed({ serverSeed, clientSeed: game.clientSeed, gameId: game.gameId });
}

/** Walks `dirs` and checks that no in-game answer mentions a chest or points. */
async function walkTo(game: OpenedGame, dirs: readonly number[]): Promise<void> {
  for (let k = 0; k < dirs.length; k++) {
    const reply = await api.move<GameView>(game.gameId, game.token, { step: k, dir: dirs[k] });
    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe('active');
    expect(reply.text).not.toMatch(/chest|points/i);
  }
}

/** Walks the whole dead-end route of the game; the last move ends it. */
async function intoDeadEnd(game: OpenedGame): Promise<GameView> {
  const route = deadEndRoute(game.maze);
  await walkTo(game, route.slice(0, -1));
  const last = await api.move<GameView>(game.gameId, game.token, { step: route.length - 1, dir: route.at(-1) });
  expect(last.status).toBe(200);
  expect(last.body.status).toBe('lost');
  return last.body;
}

async function eventsOf(gameId: Hex): Promise<StoreEvent[]> {
  return (await current().store.load()).filter((event) => 'gameId' in event && event.gameId === gameId);
}

/** Every chest draw places a chest worth `rewardBps`, and the cells asked about are recorded. */
function everywhere(rewardBps: number, asked: number[] = []): (finalSeed: Hex, cell: number) => ChestDraw {
  return (_finalSeed, cell) => {
    asked.push(cell);
    return { placed: true, rewardBps };
  };
}

describe('AC-P3: chest awards', () => {
  it("AC-P3 a move into a dead end that holds a chest loses the bet and awards the chest's points", async () => {
    env = await makeEnv();
    const game = await openGame(env, { chest: true });
    const route = deadEndRoute(game.maze);
    const end = cellsOf(game.maze, route)[route.length];
    const chest = chestAt(finalSeedOf(game), game.maze, end)!;
    expect(chest).not.toBeNull();
    const points = chestPoints(BET, chest.rewardBps);

    const last = await intoDeadEnd(game);
    expect(Object.keys(last.terminal!)).toEqual([...TERMINAL_KEYS, 'chestRule', 'chest']);
    expect(last.terminal).toMatchObject({
      outcome: 2,
      payoutWei: '0',
      chestRule: 1,
      chest: { cell: xy(end, game.n), rewardBps: chest.rewardBps, points: points.toString() },
    });
    // The resume read says the same.
    expect((await api.game<GameView>(game.gameId, game.token)).body.terminal?.chest).toEqual(last.terminal!.chest);

    const events = await eventsOf(game.gameId);
    expect(events.filter((event) => event.type === 'chest-awarded')).toEqual([
      {
        type: 'chest-awarded',
        gameId: game.gameId,
        player: game.player,
        n: game.n,
        cell: end,
        betWei: BET.toString(),
        rewardBps: chest.rewardBps,
        points: points.toString(),
        chestRule: 1,
        atSec: env.chain.time,
      },
    ]);
    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      outcome: 2,
      cause: 'dead-end',
      chestRule: 1,
      payoutWei: '0',
    });

    const ledger = await api.points<PointsResponse>(game.player);
    expect(ledger.status).toBe(200);
    expect(ledger.body).toEqual({
      address: game.player,
      totalPoints: points.toString(),
      awardCount: 1,
      awards: [
        {
          gameId: game.gameId,
          n: game.n,
          cell: xy(end, game.n),
          betWei: BET.toString(),
          rewardBps: chest.rewardBps,
          points: points.toString(),
          chestRule: 1,
          atSec: env.chain.time,
        },
      ],
      cashValue: false,
    });

    const lines = env.logs.filter((line) => line.gameId === game.gameId).map((line) => line.event);
    const ending = lines.indexOf('ended');
    expect(lines.slice(ending - 1, ending + 2)).toEqual(['move', 'ended', 'chest-awarded']);
    expect(lines.filter((line) => line === 'chest-awarded')).toHaveLength(1);
    const logText = JSON.stringify(env.logs.filter((line) => line.gameId === game.gameId));
    expect(logText).not.toMatch(/[sS]eed/);
    expect(logText).not.toContain(finalSeedOf(game).slice(2));
    expect(logText).not.toContain(env.container.service.get(game.gameId)!.serverSeed.slice(2));
  });

  it('AC-P3 a dead end without a chest ends the game with an empty chest and awards nothing', async () => {
    env = await makeEnv();
    const game = await openGame(env, { chest: false });
    const last = await intoDeadEnd(game);
    expect(last.terminal).toMatchObject({ chestRule: 1, chest: null });
    expect((await eventsOf(game.gameId)).some((event) => event.type === 'chest-awarded')).toBe(false);
    expect((await api.points<PointsResponse>(game.player)).body).toMatchObject({
      totalPoints: '0',
      awardCount: 0,
      awards: [],
    });
  });

  it('AC-P3 a cash-out, an exit and an idle auto cash-out award nothing, even where every dead end holds a chest', async () => {
    const asked: number[] = [];
    env = await makeEnv({ chestDraw: everywhere(3000, asked) });

    const cashed = await openGame(env, { player: PLAYERS[0], deadEnd: true });
    const cashRoute = deadEndRoute(cashed.maze);
    await walkTo(cashed, cashRoute.slice(0, -1));
    const cashout = await api.cashout<GameView>(cashed.gameId, cashed.token, { step: cashRoute.length - 1 });
    expect(cashout.body.status).toBe('cashed_out');
    expect(Object.keys(cashout.body.terminal!)).toEqual(TERMINAL_KEYS);

    const won = await openGame(env, { player: PLAYERS[1] });
    const exit = exitRoute(won.maze);
    await walkTo(won, exit.slice(0, -1));
    const exited = await api.move<GameView>(won.gameId, won.token, { step: exit.length - 1, dir: exit.at(-1) });
    expect(exited.body.status).toBe('won');
    expect(Object.keys(exited.body.terminal!)).toEqual(TERMINAL_KEYS);

    const idle = await openGame(env, { player: PLAYERS[2], deadEnd: true });
    await walkTo(idle, deadEndRoute(idle.maze).slice(0, -1));
    env.advance(env.table.timing.idleTimeoutSec);
    await env.tick();
    const auto = await api.game<GameView>(idle.gameId, idle.token);
    expect(auto.body).toMatchObject({ status: 'cashed_out', auto: true });
    expect(Object.keys(auto.body.terminal!)).toEqual(TERMINAL_KEYS);

    expect(asked).toEqual([]);
    const events = await env.store.load();
    expect(events.some((event) => event.type === 'chest-awarded')).toBe(false);
    const endings = events.filter((event) => event.type === 'ended');
    expect(endings).toHaveLength(3);
    expect(endings.every((event) => event.type === 'ended' && event.chestRule === undefined)).toBe(true);
    for (const player of PLAYERS.slice(0, 3)) {
      expect((await api.points<PointsResponse>(player)).body.totalPoints).toBe('0');
    }
  });

  it('AC-P3 points are the same share of the bet at the smallest and the largest bet', async () => {
    env = await makeEnv({ chestDraw: everywhere(2345) });
    const small = await openGame(env, { player: PLAYERS[0], deadEnd: true, betWei: 10n ** 15n });
    const large = await openGame(env, { player: PLAYERS[1], deadEnd: true, betWei: 10n ** 17n });
    await intoDeadEnd(small);
    await intoDeadEnd(large);
    expect((await api.points<PointsResponse>(small.player)).body.totalPoints).toBe('234');
    expect((await api.points<PointsResponse>(large.player)).body.totalPoints).toBe('23450');
  });

  it('AC-P3 the move into the dead end, the ending and the award are one line of the event log', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'maze-chest-'));
    const store = await openFileStore(dataDir);
    env = await makeEnv({ store, chestDraw: everywhere(1500) });
    const game = await openGame(env, { deadEnd: true });
    await intoDeadEnd(game);

    const lines = (await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')).trim().split('\n');
    const grouped = lines
      .map((line) => JSON.parse(line) as { type: string; events?: { type: string; gameId?: Hex }[] })
      .filter((line) => line.type === 'group' && line.events?.some((event) => event.type === 'chest-awarded'));
    expect(grouped).toHaveLength(1);
    expect(grouped[0].events!.map((event) => event.type)).toEqual(['move', 'ended', 'chest-awarded']);
    expect(grouped[0].events!.every((event) => event.gameId === game.gameId)).toBe(true);
  });
});

describe('AC-P5: the points ledger', () => {
  it('AC-P5 is rebuilt from the event log when the server boots again', async () => {
    const store = createMemoryStore();
    const chain = new FakeChain(fixtureTable);
    env = await makeEnv({ store, chain });
    const games = [await openGame(env, { chest: true }), await openGame(env, { player: PLAYERS[1], chest: true })];
    for (const game of games) await intoDeadEnd(game);
    const before = await Promise.all(games.map(async (game) => (await api.points(game.player)).text));
    const terminal = (await api.game<GameView>(games[0].gameId, games[0].token)).body.terminal;
    await env.close();
    env = null;

    env = await makeEnv({ store, chain });
    const after = await Promise.all(games.map(async (game) => (await api.points(game.player)).text));
    expect(after).toEqual(before);
    expect((JSON.parse(after[0]) as PointsResponse).totalPoints).not.toBe('0');
    expect((await api.game<GameView>(games[0].gameId, games[0].token)).body.terminal).toEqual(terminal);
  });

  it('AC-P5 a log that awards one game twice, or awards a game that did not end in a dead end, does not boot', async () => {
    const store = createMemoryStore();
    const chain = new FakeChain(fixtureTable);
    env = await makeEnv({ store, chain, chestDraw: everywhere(2000) });
    const game = await openGame(env, { deadEnd: true });
    await intoDeadEnd(game);
    const events = await store.load();
    await env.close();
    env = null;

    const award = events.find((event) => event.type === 'chest-awarded')!;
    await expect(
      makeEnv({ store: createMemoryStore([...events, award]), chain, install: false }),
    ).rejects.toThrow(/does not fit|second chest award/);
    const stray = events
      .filter((event) => event.type !== 'chest-awarded')
      .map((event): StoreEvent => {
        if (event.type !== 'ended') return event;
        const { chestRule: _rule, ...rest } = event;
        return { ...rest, cause: 'cashout' };
      })
      .concat([award]);
    await expect(makeEnv({ store: createMemoryStore(stray), chain, install: false })).rejects.toThrow(/does not fit/);
    env = await makeEnv({ store: createMemoryStore(events), chain });
    expect((await api.points<PointsResponse>(game.player)).body.totalPoints).toBe(chestPoints(BET, 2000).toString());
  });

  it('AC-P5 GET /api/points/:address is public, takes any letter case, and refuses a malformed address', async () => {
    env = await makeEnv({ chestDraw: everywhere(2500) });
    const game = await openGame(env, { deadEnd: true });
    await intoDeadEnd(game);

    const lower = await api.points<PointsResponse>(game.player.toLowerCase());
    const upper = await api.points<PointsResponse>(`0x${game.player.slice(2).toUpperCase()}`);
    expect(lower.status).toBe(200);
    expect(lower.body.address).toBe(game.player);
    expect(upper.text).toBe(lower.text);
    expect(lower.body.totalPoints).toBe(chestPoints(BET, 2500).toString());

    const stranger = await api.points<PointsResponse>(PLAYERS[5]);
    expect(stranger.body).toEqual({
      address: PLAYERS[5],
      totalPoints: '0',
      awardCount: 0,
      awards: [],
      cashValue: false,
    });

    for (const bad of ['0x1234', 'not-an-address', `${game.player}00`, `0x${'zz'.repeat(20)}`]) {
      const reply = await api.points(bad);
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({ error: { code: 'BAD_REQUEST', message: expect.any(String) } });
    }
  });

  it('AC-P5 lists the newest awards first, at most twenty, with the total over all of them', () => {
    const awards = Array.from({ length: 25 }, (_, i) => ({
      gameId: `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex,
      n: 7,
      cell: 10 + i,
      betWei: BET,
      rewardBps: 1000 + i,
      points: BigInt(1000 + i),
      chestRule: 1,
      atSec: 1_700_000_000 + i,
    }));
    const account: LedgerAccount = {
      address: PLAYERS[0],
      totalPoints: awards.reduce((sum, award) => sum + award.points, 0n),
      awards,
    };
    const response = toPointsResponse(PLAYERS[0], account);
    expect(POINTS_RECENT_LIMIT).toBe(20);
    expect(response.awardCount).toBe(25);
    expect(response.totalPoints).toBe('25300');
    expect(response.awards).toHaveLength(20);
    expect(response.awards[0]).toEqual({
      gameId: awards[24].gameId,
      n: 7,
      cell: { x: 34 % 7, y: Math.floor(34 / 7) },
      betWei: BET.toString(),
      rewardBps: 1024,
      points: '1024',
      chestRule: 1,
      atSec: 1_700_000_024,
    });
    expect(response.awards.at(-1)!.gameId).toBe(awards[5].gameId);
  });
});
