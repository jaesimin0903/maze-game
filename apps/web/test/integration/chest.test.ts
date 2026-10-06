// AC-P5, AC-P10 on a real chain: a game that walks past path chests into a dead end holding a
// chest settles as a loss of 0 on chain (the money rules do not change); every chest is awarded
// as its cell is entered, listed in the views and in the points ledger, and a server started
// again on the same data directory rebuilds the ledger from its event log. A route without
// chests awards nothing.

import { chestAt, chestPoints, deriveFinalSeed, type GameView, type PointsResponse } from '@maze/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testServerSeed } from '../../src/server/test-hooks';
import { api, cellsOf, deadEndRoute } from '../server/helpers';
import {
  BET,
  onchainGame,
  openGame,
  playerOf,
  SEED_SECRET,
  startHarness,
  startServer,
  waitSettled,
  walk,
  type Harness,
  type LiveGame,
  type Server,
} from './setup';

let h: Harness;
let server: Server | null = null;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await server?.stop();
  await h?.stop();
});

async function intoDeadEnd(game: LiveGame): Promise<GameView> {
  const views = await walk(game, deadEndRoute(game.maze));
  return views[views.length - 1];
}

describe('AC-P5: chests on a real chain', () => {
  it('AC-P5 AC-P10 a route past path chests into a chest dead end settles as a loss of 0, awards every chest, and the ledger survives a restart', async () => {
    const first = (server = await startServer(h));
    const game = await openGame(h, playerOf(h, 0), { chest: true, pathChest: true });
    const route = deadEndRoute(game.maze);
    const cells = cellsOf(game.maze, route);
    const end = cells[route.length];
    const finalSeed = deriveFinalSeed({
      serverSeed: testServerSeed(SEED_SECRET, game.gameId),
      clientSeed: game.clientSeed,
      gameId: game.gameId,
    });
    const xy = (cell: number): { x: number; y: number } => ({ x: cell % game.n, y: Math.floor(cell / game.n) });
    // Every chest on the route, in the order the route enters them: path chests, then the dead end's.
    const expected = cells.flatMap((cell, step) => {
      const chest = step === 0 ? null : chestAt(finalSeed, game.maze, cell);
      return chest === null
        ? []
        : [{ cell: xy(cell), kind: chest.kind, rewardBps: chest.rewardBps, points: chestPoints(BET, chest.rewardBps).toString(), step }];
    });
    const chest = expected.at(-1)!;
    expect(chest.kind).toBe('dead-end');
    expect(expected.filter((found) => found.kind === 'path').length).toBeGreaterThan(0);
    const total = expected.reduce((sum, found) => sum + BigInt(found.points), 0n).toString();

    const views = await walk(game, route);
    // Each answer lists the chests of the cells entered so far, no more.
    views.forEach((view, k) => {
      expect(view.chestRule).toBe(2);
      expect(view.chests).toEqual(expected.filter((found) => found.step <= k + 1));
    });
    const last = views.at(-1)!;
    expect(last.status).toBe('lost');
    expect(last.terminal).toMatchObject({
      outcome: 2,
      payoutWei: '0',
      chestRule: 2,
      chest: { cell: xy(end), rewardBps: chest.rewardBps, points: chest.points },
    });

    // On chain nothing about the game changed: a loss pays 0.
    const settled = await waitSettled(h, game.gameId);
    expect([settled.outcome, settled.steps, settled.payoutWei]).toEqual([2, route.length, 0n]);
    expect((await onchainGame(h, game.gameId)).status).toBe(2);

    const ledger = await api.points<PointsResponse>(game.player.address);
    expect(ledger.body).toMatchObject({ totalPoints: total, awardCount: expected.length, cashValue: false });
    expect(ledger.body.awards[0]).toMatchObject({
      gameId: game.gameId,
      kind: 'dead-end',
      rewardBps: chest.rewardBps,
      points: chest.points,
      chestRule: 2,
      step: route.length,
    });
    expect(ledger.body.awards.slice(1).every((award) => award.kind === 'path')).toBe(true);

    // A route without any chest, of another player, awards nothing.
    const empty = await openGame(h, playerOf(h, 1), { chest: false, pathChest: false });
    const emptyLast = await intoDeadEnd(empty);
    expect(emptyLast.terminal).toMatchObject({ chestRule: 2, chest: null });
    expect(emptyLast.chests).toEqual([]);
    await waitSettled(h, empty.gameId);
    expect((await api.points<PointsResponse>(empty.player.address)).body.totalPoints).toBe('0');

    const before = (await api.points(game.player.address)).text;
    await first.stop();
    server = null;

    server = await startServer(h, { dataDir: first.dataDir });
    expect((await api.points(game.player.address)).text).toBe(before);
    const read = await api.game<GameView>(game.gameId, game.token);
    expect(read.body.chests).toEqual(expected);
    expect(read.body.terminal?.chest).toEqual(last.terminal?.chest);
    expect(read.body.terminal?.settleTxHash).toBe(settled.txHash);
  });
});
