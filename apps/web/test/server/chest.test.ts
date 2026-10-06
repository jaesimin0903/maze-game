// AC-P3: a move into a dead end that holds a chest awards it, once, stored with the ending; a dead
// end is asked about only by the move that enters it. AC-P10 (chest rule 2): a move into a path
// cell that holds a chest awards it at once, in the same log line as the move; the chest is in
// that answer, in every later view and in the ledger, and it is kept whatever the ending. A game
// recorded under rule 1 keeps rule 1. AC-P5: the points ledger is derived from the event log,
// survives a restart, and is read through GET /api/points/:address.

import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  chestAt,
  chestKindOf,
  chestPoints,
  deriveFinalSeed,
  POINTS_RECENT_LIMIT,
  type ChestDraw,
  type ChestKind,
  type FoundChest,
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

type Draw = (finalSeed: Hex, cell: number, kind: ChestKind, rule: number) => ChestDraw;
interface Ask {
  cell: number;
  kind: ChestKind;
  rule: number;
}
type Rewards = Partial<Record<ChestKind, number>>;

/** Every cell of a kind in `rewards` holds a chest worth that many basis points; questions go to `asked`. */
function placing(rewards: Rewards, asked: Ask[] = []): Draw {
  return (_finalSeed, cell, kind, rule) => {
    asked.push({ cell, kind, rule });
    const rewardBps = rewards[kind];
    return rewardBps === undefined ? { placed: false, rewardBps: 0 } : { placed: true, rewardBps };
  };
}

function found(game: OpenedGame, cell: number, kind: ChestKind, rewardBps: number, step: number): FoundChest {
  return { cell: xy(cell, game.n), kind, rewardBps, points: chestPoints(game.betWei, rewardBps).toString(), step };
}

/** The chests the real rule puts on `cells` (a route, the start first), in the order entered. */
function routeChests(game: OpenedGame, cells: readonly number[]): FoundChest[] {
  const finalSeed = finalSeedOf(game);
  return cells.flatMap((cell, step) => {
    const chest = step === 0 ? null : chestAt(finalSeed, game.maze, cell);
    return chest === null ? [] : [found(game, cell, chest.kind, chest.rewardBps, step)];
  });
}

/** The chests `placing(rewards)` puts on `cells` (a route, the start first), in the order entered. */
function placedChests(game: OpenedGame, cells: readonly number[], rewards: Rewards): FoundChest[] {
  return cells.flatMap((cell, step) => {
    const kind = step === 0 ? null : chestKindOf(game.maze, cell);
    const rewardBps = kind === null ? undefined : rewards[kind];
    return kind === null || rewardBps === undefined ? [] : [found(game, cell, kind, rewardBps, step)];
  });
}

/**
 * Walks `dirs` from the start. Every answer is in play, names rule 2, and lists exactly the
 * chests of `expected` whose cells have been entered.
 */
async function walkTo(game: OpenedGame, dirs: readonly number[], expected: readonly FoundChest[] = []): Promise<void> {
  for (let k = 0; k < dirs.length; k++) {
    const reply = await api.move<GameView>(game.gameId, game.token, { step: k, dir: dirs[k] });
    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe('active');
    expect(reply.body.chestRule).toBe(2);
    expect(reply.body.chests).toEqual(expected.filter((chest) => chest.step <= k + 1));
    expect(reply.body.terminal).toBeUndefined();
  }
}

/** Walks the whole dead-end route of the game; the last move ends it. */
async function intoDeadEnd(game: OpenedGame, expected: readonly FoundChest[] = []): Promise<GameView> {
  const route = deadEndRoute(game.maze);
  await walkTo(game, route.slice(0, -1), expected);
  const last = await api.move<GameView>(game.gameId, game.token, { step: route.length - 1, dir: route.at(-1) });
  expect(last.status).toBe(200);
  expect(last.body.status).toBe('lost');
  return last.body;
}

async function eventsOf(gameId: Hex): Promise<StoreEvent[]> {
  return (await current().store.load()).filter((event) => 'gameId' in event && event.gameId === gameId);
}

const sumOf = (chests: readonly FoundChest[]): string =>
  chests.reduce((sum, chest) => sum + BigInt(chest.points), 0n).toString();

describe('AC-P3: dead-end chests', () => {
  it("AC-P3 a move into a dead end that holds a chest loses the bet and awards the chest's points", async () => {
    env = await makeEnv();
    const game = await openGame(env, { chest: true, pathChest: false });
    const route = deadEndRoute(game.maze);
    const end = cellsOf(game.maze, route)[route.length];
    const chest = chestAt(finalSeedOf(game), game.maze, end)!;
    expect(chest.kind).toBe('dead-end');
    const points = chestPoints(BET, chest.rewardBps);

    const last = await intoDeadEnd(game);
    expect(Object.keys(last.terminal!)).toEqual([...TERMINAL_KEYS, 'chestRule', 'chest']);
    expect(last.terminal).toMatchObject({
      outcome: 2,
      payoutWei: '0',
      chestRule: 2,
      chest: { cell: xy(end, game.n), rewardBps: chest.rewardBps, points: points.toString() },
    });
    const listed = [found(game, end, 'dead-end', chest.rewardBps, route.length)];
    expect(last.chests).toEqual(listed);
    // The resume read says the same.
    const read = (await api.game<GameView>(game.gameId, game.token)).body;
    expect(read.terminal?.chest).toEqual(last.terminal!.chest);
    expect(read.chests).toEqual(listed);

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
        chestRule: 2,
        atSec: env.chain.time,
        kind: 'dead-end',
        step: route.length,
      },
    ]);
    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      outcome: 2,
      cause: 'dead-end',
      chestRule: 2,
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
          chestRule: 2,
          atSec: env.chain.time,
          kind: 'dead-end',
          step: route.length,
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
    const game = await openGame(env, { chest: false, pathChest: false });
    const last = await intoDeadEnd(game);
    expect(last.terminal).toMatchObject({ chestRule: 2, chest: null });
    expect(last.chests).toEqual([]);
    expect((await eventsOf(game.gameId)).some((event) => event.type === 'chest-awarded')).toBe(false);
    expect((await api.points<PointsResponse>(game.player)).body).toMatchObject({
      totalPoints: '0',
      awardCount: 0,
      awards: [],
    });
  });

  it('AC-P3 a cash-out, an exit and an idle auto cash-out award nothing and never ask about a dead end, even where every dead end holds a chest', async () => {
    const asked: Ask[] = [];
    env = await makeEnv({ chestDraw: placing({ 'dead-end': 3000 }, asked) });

    const cashed = await openGame(env, { player: PLAYERS[0], deadEnd: true });
    const cashRoute = deadEndRoute(cashed.maze);
    await walkTo(cashed, cashRoute.slice(0, -1));
    const cashout = await api.cashout<GameView>(cashed.gameId, cashed.token, { step: cashRoute.length - 1 });
    expect(cashout.body.status).toBe('cashed_out');
    expect(Object.keys(cashout.body.terminal!)).toEqual([...TERMINAL_KEYS, 'chestRule']);

    const won = await openGame(env, { player: PLAYERS[1] });
    const exit = exitRoute(won.maze);
    await walkTo(won, exit.slice(0, -1));
    const exited = await api.move<GameView>(won.gameId, won.token, { step: exit.length - 1, dir: exit.at(-1) });
    expect(exited.body.status).toBe('won');
    expect(Object.keys(exited.body.terminal!)).toEqual([...TERMINAL_KEYS, 'chestRule']);

    const idle = await openGame(env, { player: PLAYERS[2], deadEnd: true });
    const idleRoute = deadEndRoute(idle.maze);
    await walkTo(idle, idleRoute.slice(0, -1));
    env.advance(env.table.timing.idleTimeoutSec);
    await env.tick();
    const auto = await api.game<GameView>(idle.gameId, idle.token);
    expect(auto.body).toMatchObject({ status: 'cashed_out', auto: true, chests: [] });
    expect(Object.keys(auto.body.terminal!)).toEqual([...TERMINAL_KEYS, 'chestRule']);

    // Only the cells the moves entered were asked about, each as a path cell; the exit never.
    expect(asked).toHaveLength(cashRoute.length - 1 + exit.length - 1 + idleRoute.length - 1);
    expect(asked.every((ask) => ask.kind === 'path' && ask.rule === 2)).toBe(true);
    const events = await env.store.load();
    expect(events.some((event) => event.type === 'chest-awarded')).toBe(false);
    const endings = events.filter((event) => event.type === 'ended');
    expect(endings).toHaveLength(3);
    expect(endings.every((event) => event.type === 'ended' && event.chestRule === 2)).toBe(true);
    for (const player of PLAYERS.slice(0, 3)) {
      expect((await api.points<PointsResponse>(player)).body.totalPoints).toBe('0');
    }
  });

  it('AC-P3 points are the same share of the bet at the smallest and the largest bet', async () => {
    env = await makeEnv({ chestDraw: placing({ 'dead-end': 2345 }) });
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
    env = await makeEnv({ store, chestDraw: placing({ 'dead-end': 1500 }) });
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

describe('AC-P10: path chests', () => {
  it('AC-P10 a move into a path-chest cell awards it at once: in that answer, in later views, in the ledger and in the same log line as the move', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'maze-chest-'));
    const store = await openFileStore(dataDir);
    env = await makeEnv({ store });
    const game = await openGame(env, { deadEnd: true, chest: false, pathChest: true });
    const route = deadEndRoute(game.maze);
    const cells = cellsOf(game.maze, route);
    const expected = routeChests(game, cells);
    expect(expected.length).toBeGreaterThan(0);
    for (const chest of expected) {
      expect(chest.kind).toBe('path');
      expect(chest.rewardBps).toBeGreaterThanOrEqual(200);
      expect(chest.rewardBps).toBeLessThanOrEqual(500);
    }

    let total = 0n;
    for (let k = 0; k < route.length - 1; k++) {
      const reply = await api.move<GameView>(game.gameId, game.token, { step: k, dir: route[k] });
      expect(reply.status).toBe(200);
      expect(reply.body.status).toBe('active');
      const sofar = expected.filter((chest) => chest.step <= k + 1);
      expect(reply.body.chests).toEqual(sofar);
      total += BigInt(expected.find((chest) => chest.step === k + 1)?.points ?? '0');
      // In the ledger by the time the answer is out.
      expect((await api.points<PointsResponse>(game.player)).body.totalPoints).toBe(total.toString());
      // A later read lists the same chests, beside the visited cells only.
      const read = (await api.game<GameView>(game.gameId, game.token)).body;
      expect(read.chests).toEqual(sofar);
      expect(read.path).toHaveLength(k + 2);
    }
    expect(total.toString()).toBe(sumOf(expected));

    const last = await api.move<GameView>(game.gameId, game.token, { step: route.length - 1, dir: route.at(-1) });
    expect(last.body.status).toBe('lost');
    expect(last.body.terminal).toMatchObject({ chestRule: 2, chest: null });
    expect(last.body.chests).toEqual(expected);
    const ledger = (await api.points<PointsResponse>(game.player)).body;
    expect(ledger).toMatchObject({ totalPoints: sumOf(expected), awardCount: expected.length });
    expect(ledger.awards.map((award) => [award.kind, award.step])).toEqual(
      [...expected].reverse().map((chest) => ['path', chest.step]),
    );

    // The event log: each path chest is in the same line as the move into its cell.
    type Line = { type: string; events?: (StoreEvent & Record<string, unknown>)[] };
    const lines = (await readFile(path.join(dataDir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Line);
    const awardLines = lines.filter(
      (line) => line.type === 'group' && line.events!.some((event) => event.type === 'chest-awarded'),
    );
    expect(awardLines).toHaveLength(expected.length);
    awardLines.forEach((line, i) => {
      const chest = expected[i];
      expect(line.events!.map((event) => event.type)).toEqual(['move', 'chest-awarded']);
      expect(line.events![0]).toMatchObject({ gameId: game.gameId, step: chest.step, cell: cells[chest.step] });
      expect(line.events![1]).toMatchObject({
        gameId: game.gameId,
        player: game.player,
        cell: cells[chest.step],
        kind: 'path',
        step: chest.step,
        rewardBps: chest.rewardBps,
        points: chest.points,
        chestRule: 2,
      });
    });

    // The server log: the award follows the move that found it, and holds no seed.
    const gameLines = env.logs.filter((line) => line.gameId === game.gameId);
    for (const chest of expected) {
      const at = gameLines.findIndex((line) => line.event === 'chest-awarded' && line.step === chest.step);
      expect(gameLines[at - 1]).toMatchObject({ event: 'move', step: chest.step });
      expect(gameLines[at]).toMatchObject({
        outcome: null,
        detail: { kind: 'path', cell: cells[chest.step], rewardBps: chest.rewardBps, points: chest.points },
      });
    }
    const logText = JSON.stringify(gameLines);
    expect(logText).not.toMatch(/[sS]eed/);
    expect(logText).not.toContain(finalSeedOf(game).slice(2));
  });

  it('AC-P10 path chests are kept whatever the ending: exit, cash-out, idle auto cash-out and a later dead end', async () => {
    const rewards: Rewards = { path: 400, 'dead-end': 2000 };
    env = await makeEnv({ chestDraw: placing(rewards) });

    const won = await openGame(env, { player: PLAYERS[0] });
    const exit = exitRoute(won.maze);
    const wonChests = placedChests(won, cellsOf(won.maze, exit), rewards);
    expect(wonChests).toHaveLength(exit.length - 1);
    await walkTo(won, exit.slice(0, -1), wonChests);
    const exited = (await api.move<GameView>(won.gameId, won.token, { step: exit.length - 1, dir: exit.at(-1) })).body;
    expect(exited.status).toBe('won');
    expect(exited.chests).toEqual(wonChests);
    expect(Object.keys(exited.terminal!)).toEqual([...TERMINAL_KEYS, 'chestRule']);

    const cashed = await openGame(env, { player: PLAYERS[1] });
    const cashRoute = exitRoute(cashed.maze).slice(0, 2);
    const cashChests = placedChests(cashed, cellsOf(cashed.maze, cashRoute), rewards);
    expect(cashChests).toHaveLength(2);
    await walkTo(cashed, cashRoute, cashChests);
    const cashout = (await api.cashout<GameView>(cashed.gameId, cashed.token, { step: 2 })).body;
    expect(cashout.status).toBe('cashed_out');
    expect(cashout.chests).toEqual(cashChests);

    const idle = await openGame(env, { player: PLAYERS[2] });
    const idleRoute = exitRoute(idle.maze).slice(0, 1);
    const idleChests = placedChests(idle, cellsOf(idle.maze, idleRoute), rewards);
    await walkTo(idle, idleRoute, idleChests);
    env.advance(env.table.timing.idleTimeoutSec);
    await env.tick();
    const auto = (await api.game<GameView>(idle.gameId, idle.token)).body;
    expect(auto).toMatchObject({ status: 'cashed_out', auto: true });
    expect(auto.chests).toEqual(idleChests);

    const lost = await openGame(env, { player: PLAYERS[3], deadEnd: true });
    const deadRoute = deadEndRoute(lost.maze);
    const lostChests = placedChests(lost, cellsOf(lost.maze, deadRoute), rewards);
    expect(lostChests.at(-1)!.kind).toBe('dead-end');
    const last = await intoDeadEnd(lost, lostChests);
    expect(last.chests).toEqual(lostChests);
    expect(last.terminal!.chest).toMatchObject({ rewardBps: 2000 });

    for (const [game, chests] of [
      [won, wonChests],
      [cashed, cashChests],
      [idle, idleChests],
      [lost, lostChests],
    ] as const) {
      expect((await api.points<PointsResponse>(game.player)).body).toMatchObject({
        totalPoints: sumOf(chests),
        awardCount: chests.length,
      });
    }
    // A path chest of 400 bps is 4% of the bet.
    expect(wonChests[0].points).toBe((BET / 25n / 10n ** 12n).toString());
  });

  it('AC-P10 a restart in the middle of a game keeps the path chests found so far, and play goes on', async () => {
    const store = createMemoryStore();
    const chain = new FakeChain(fixtureTable);
    const rewards: Rewards = { path: 300 };
    env = await makeEnv({ store, chain, chestDraw: placing(rewards) });
    const game = await openGame(env);
    const route = exitRoute(game.maze);
    const chests = placedChests(game, cellsOf(game.maze, route), rewards);
    await walkTo(game, route.slice(0, 2), chests);
    const view = (await api.game(game.gameId, game.token)).text;
    const points = (await api.points(game.player)).text;
    await env.close();
    env = null;

    env = await makeEnv({ store, chain, chestDraw: placing(rewards) });
    expect((await api.game(game.gameId, game.token)).text).toBe(view);
    expect((await api.points(game.player)).text).toBe(points);
    for (let k = 2; k < route.length; k++) {
      expect((await api.move(game.gameId, game.token, { step: k, dir: route[k] })).status).toBe(200);
    }
    const final = (await api.game<GameView>(game.gameId, game.token)).body;
    expect(final.status).toBe('won');
    expect(final.chests).toEqual(chests);
    expect((await api.points<PointsResponse>(game.player)).body).toMatchObject({
      totalPoints: sumOf(chests),
      awardCount: route.length - 1,
    });
  });

  it('AC-P10 a log that awards a cell twice, a path chest after the ending or out of step, or a path chest under rule 1 does not boot', async () => {
    const store = createMemoryStore();
    const chain = new FakeChain(fixtureTable);
    const rewards: Rewards = { path: 300 };
    env = await makeEnv({ store, chain, chestDraw: placing(rewards) });
    const game = await openGame(env);
    const route = exitRoute(game.maze).slice(0, 2);
    await walkTo(game, route, placedChests(game, cellsOf(game.maze, route), rewards));
    expect((await api.cashout(game.gameId, game.token, { step: 2 })).status).toBe(200);
    const events = await store.load();
    await env.close();
    env = null;

    const awards = events.filter((event) => event.type === 'chest-awarded');
    expect(awards).toHaveLength(2);
    const boots = (log: StoreEvent[]): Promise<TestEnv> =>
      makeEnv({ store: createMemoryStore(log), chain, install: false });
    const withoutRule = (event: StoreEvent): StoreEvent => {
      if (event.type !== 'chain-created' && event.type !== 'ended') return event;
      const { chestRule: _rule, ...rest } = event;
      return rest;
    };

    // The first chest awarded a second time, right after the first award.
    const first = events.indexOf(awards[0]);
    await expect(boots([...events.slice(0, first + 1), awards[0], ...events.slice(first + 1)])).rejects.toThrow(
      /does not fit|second chest award/,
    );
    // The second chest, moved after the ending.
    const rest = events.filter((event) => event !== awards[1]);
    const ending = rest.findIndex((event) => event.type === 'ended');
    await expect(boots([...rest.slice(0, ending + 1), awards[1], ...rest.slice(ending + 1)])).rejects.toThrow(
      /does not fit/,
    );
    // An award that names another step than the move it is stored with.
    await expect(
      boots(events.map((event) => (event === awards[0] ? { ...awards[0], step: 2 } : event))),
    ).rejects.toThrow(/does not fit/);
    // The same game recorded under rule 1, which has no path chests.
    const rule1 = events.map(withoutRule);
    await expect(boots(rule1)).rejects.toThrow(/does not fit/);
    await expect(
      boots(rule1.map((event) => (event.type === 'chest-awarded' ? { ...event, chestRule: 1 } : event))),
    ).rejects.toThrow(/does not fit/);

    env = await makeEnv({ store: createMemoryStore(events), chain });
    expect((await api.points<PointsResponse>(game.player)).body.totalPoints).toBe(
      (2n * chestPoints(BET, 300)).toString(),
    );
  });

  it('AC-P10 a game recorded under rule 1 keeps rule 1 on a server with rule 2: no path chests, the dead end as before', async () => {
    const store = createMemoryStore();
    const chain = new FakeChain(fixtureTable);
    env = await makeEnv({ store, chain });
    const game = await openGame(env, { deadEnd: true });
    // The log as a server before rule 2 wrote it: `chain-created` without a rule.
    const recorded = (await store.load()).map((event): StoreEvent => {
      if (event.type !== 'chain-created') return event;
      const { chestRule: _rule, ...rest } = event;
      return rest;
    });
    await env.close();
    env = null;

    const asked: Ask[] = [];
    env = await makeEnv({
      store: createMemoryStore(recorded),
      chain,
      chestDraw: placing({ path: 500, 'dead-end': 2500 }, asked),
    });
    const route = deadEndRoute(game.maze);
    const end = cellsOf(game.maze, route)[route.length];
    for (let k = 0; k < route.length - 1; k++) {
      const reply = await api.move<GameView>(game.gameId, game.token, { step: k, dir: route[k] });
      expect(reply.body).toMatchObject({ status: 'active', chestRule: 1, chests: [] });
    }
    const last = (await api.move<GameView>(game.gameId, game.token, { step: route.length - 1, dir: route.at(-1) })).body;
    expect(last.status).toBe('lost');
    expect(Object.keys(last.terminal!)).toEqual([...TERMINAL_KEYS, 'chestRule', 'chest']);
    expect(last.terminal).toMatchObject({ chestRule: 1, chest: { cell: xy(end, game.n), rewardBps: 2500 } });
    expect(last.chests).toEqual([found(game, end, 'dead-end', 2500, route.length)]);
    // Only the dead end was asked about, under rule 1.
    expect(asked).toEqual([{ cell: end, kind: 'dead-end', rule: 1 }]);
    const events = await eventsOf(game.gameId);
    expect(events.find((event) => event.type === 'ended')).toMatchObject({ chestRule: 1 });
    expect(events.filter((event) => event.type === 'chest-awarded')).toMatchObject([
      { chestRule: 1, kind: 'dead-end', step: route.length },
    ]);
  });
});

describe('AC-P5: the points ledger', () => {
  it('AC-P5 is rebuilt from the event log when the server boots again', async () => {
    const store = createMemoryStore();
    const chain = new FakeChain(fixtureTable);
    env = await makeEnv({ store, chain });
    const games = [
      await openGame(env, { chest: true, pathChest: true }),
      await openGame(env, { player: PLAYERS[1], chest: true }),
    ];
    for (const game of games) await intoDeadEnd(game, routeChests(game, cellsOf(game.maze, deadEndRoute(game.maze))));
    const before = await Promise.all(games.map(async (game) => (await api.points(game.player)).text));
    const view = (await api.game(games[0].gameId, games[0].token)).text;
    await env.close();
    env = null;

    env = await makeEnv({ store, chain });
    const after = await Promise.all(games.map(async (game) => (await api.points(game.player)).text));
    expect(after).toEqual(before);
    expect((JSON.parse(after[0]) as PointsResponse).awardCount).toBeGreaterThan(1);
    expect((await api.game(games[0].gameId, games[0].token)).text).toBe(view);
  });

  it('AC-P5 a log that awards one game twice, or awards a game that did not end in a dead end, does not boot', async () => {
    const store = createMemoryStore();
    const chain = new FakeChain(fixtureTable);
    env = await makeEnv({ store, chain, chestDraw: placing({ 'dead-end': 2000 }) });
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
      .map((event): StoreEvent => (event.type === 'ended' ? { ...event, outcome: 1, cause: 'cashout' } : event))
      .concat([award]);
    await expect(makeEnv({ store: createMemoryStore(stray), chain, install: false })).rejects.toThrow(/does not fit/);
    env = await makeEnv({ store: createMemoryStore(events), chain });
    expect((await api.points<PointsResponse>(game.player)).body.totalPoints).toBe(chestPoints(BET, 2000).toString());
  });

  it('AC-P5 GET /api/points/:address is public, takes any letter case, and refuses a malformed address', async () => {
    env = await makeEnv({ chestDraw: placing({ 'dead-end': 2500 }) });
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
      kind: i % 2 === 0 ? ('path' as const) : ('dead-end' as const),
      betWei: BET,
      rewardBps: 1000 + i,
      points: BigInt(1000 + i),
      chestRule: 2,
      step: 3 + i,
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
      chestRule: 2,
      atSec: 1_700_000_024,
      kind: 'path',
      step: 27,
    });
    expect(response.awards.at(-1)!.gameId).toBe(awards[5].gameId);
  });
});
