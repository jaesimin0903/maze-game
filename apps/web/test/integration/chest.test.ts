// AC-P5 on a real chain: a game that walks into a dead end holding a chest settles as a loss of 0
// on chain (the money rules do not change), the award is in the terminal view and in the points
// ledger, and a server started again on the same data directory rebuilds the ledger from its
// event log. A dead end without a chest awards nothing.

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
  it('AC-P5 a chest dead end settles as a loss of 0, awards the points, and the ledger survives a restart', async () => {
    const first = (server = await startServer(h));
    const game = await openGame(h, playerOf(h, 0), { chest: true });
    const route = deadEndRoute(game.maze);
    const end = cellsOf(game.maze, route)[route.length];
    const finalSeed = deriveFinalSeed({
      serverSeed: testServerSeed(SEED_SECRET, game.gameId),
      clientSeed: game.clientSeed,
      gameId: game.gameId,
    });
    const chest = chestAt(finalSeed, game.maze, end)!;
    const points = chestPoints(BET, chest.rewardBps).toString();

    const last = await intoDeadEnd(game);
    expect(last.status).toBe('lost');
    expect(last.terminal).toMatchObject({
      outcome: 2,
      payoutWei: '0',
      chestRule: 1,
      chest: { cell: { x: end % game.n, y: Math.floor(end / game.n) }, rewardBps: chest.rewardBps, points },
    });

    // On chain nothing about the game changed: a loss pays 0.
    const settled = await waitSettled(h, game.gameId);
    expect([settled.outcome, settled.steps, settled.payoutWei]).toEqual([2, route.length, 0n]);
    expect((await onchainGame(h, game.gameId)).status).toBe(2);

    const ledger = await api.points<PointsResponse>(game.player.address);
    expect(ledger.body).toMatchObject({ totalPoints: points, awardCount: 1, cashValue: false });
    expect(ledger.body.awards[0]).toMatchObject({ gameId: game.gameId, rewardBps: chest.rewardBps, points, chestRule: 1 });

    // An empty dead end of another player awards nothing.
    const empty = await openGame(h, playerOf(h, 1), { chest: false });
    const emptyLast = await intoDeadEnd(empty);
    expect(emptyLast.terminal).toMatchObject({ chestRule: 1, chest: null });
    await waitSettled(h, empty.gameId);
    expect((await api.points<PointsResponse>(empty.player.address)).body.totalPoints).toBe('0');

    const before = (await api.points(game.player.address)).text;
    await first.stop();
    server = null;

    server = await startServer(h, { dataDir: first.dataDir });
    expect((await api.points(game.player.address)).text).toBe(before);
    const read = await api.game<GameView>(game.gameId, game.token);
    expect(read.body.terminal?.chest).toEqual(last.terminal?.chest);
    expect(read.body.terminal?.settleTxHash).toBe(settled.txHash);
  });
});
