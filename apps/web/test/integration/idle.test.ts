// AC-S4, AC-E2: idle games are cashed out by the server on the chain clock and settled by its
// relayer. The idle timeout is shortened to 5 chain seconds, as the browser scenarios do.

import { refundWei, type GameView } from '@maze/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, exitRoute } from '../server/helpers';
import {
  BET,
  onchainGame,
  openGame,
  playerOf,
  startHarness,
  startServer,
  until,
  waitSettled,
  walk,
  type Harness,
  type Server,
} from './setup';

const IDLE_SEC = 5;

let h: Harness;
let server: Server;

beforeAll(async () => {
  h = await startHarness();
  server = await startServer(h, { idleTimeoutSec: IDLE_SEC });
});

afterAll(async () => {
  await server?.stop();
  await h?.stop();
});

describe('AC-S4: idle auto cash-out', () => {
  it('two moves, then nothing: refund(2) is paid, by the relayer, soon after the deadline', async () => {
    const player = playerOf(h, 0);
    const game = await openGame(h, player);
    const balanceAfterBet = await h.publicClient.getBalance({ address: player.address });
    const views = await walk(game, exitRoute(game.maze).slice(0, 2));
    const idleDeadline = views[1].idleDeadlineSec;
    expect(idleDeadline).toBe(views[1].chainNowSec + IDLE_SEC);

    // AC-W7's basis: a poll of the read shows the ending within 5 chain seconds of the deadline.
    const ended = await until('the automatic ending', async () => {
      const reply = await api.game<GameView>(game.gameId, game.token);
      return reply.body.status === 'active' ? null : reply.body;
    });
    expect(ended).toMatchObject({ status: 'cashed_out', auto: true, step: 2 });
    expect(ended.chainNowSec).toBeGreaterThanOrEqual(idleDeadline);
    expect(ended.chainNowSec - idleDeadline).toBeLessThanOrEqual(5);

    const expected = refundWei(h.table, BET, 0, 2);
    const settled = await waitSettled(h, game.gameId);
    expect(settled).toMatchObject({ outcome: 1, steps: 2, payoutWei: expected });
    expect(settled.from.toLowerCase()).toBe(h.relayer.toLowerCase());
    expect(settled.timestamp - idleDeadline).toBeLessThanOrEqual(5);
    // The player sent no transaction after the bet, yet has the refund.
    expect(await h.publicClient.getBalance({ address: player.address })).toBe(
      balanceAfterBet + expected,
    );

    const late = await api.move(game.gameId, game.token, { step: 2, dir: exitRoute(game.maze)[2] });
    expect(late.status).toBe(409);
    expect((late.body as { error: { code: string } }).error.code).toBe('GAME_NOT_ACTIVE');
  });

  it('a game whose player never called /start is cashed out at k = 0 for 95%', async () => {
    const player = playerOf(h, 1);
    const game = await openGame(h, player, { start: false });
    const settled = await waitSettled(h, game.gameId);
    expect(settled).toMatchObject({
      outcome: 1,
      steps: 0,
      payoutWei: (BET * 9500n) / 10_000n,
    });
    // The clock ran from the creation block.
    expect(settled.timestamp).toBeGreaterThanOrEqual(game.createdAtSec + IDLE_SEC);
    expect(settled.timestamp - (game.createdAtSec + IDLE_SEC)).toBeLessThanOrEqual(5);
    expect((await onchainGame(h, game.gameId)).status).toBe(2);

    const read = await api.game<GameView>(game.gameId, game.token);
    expect(read.body).toMatchObject({ status: 'cashed_out', auto: true, step: 0 });
  });

  it('each move restarts the idle timer', async () => {
    const player = playerOf(h, 2);
    const game = await openGame(h, player);
    const route = exitRoute(game.maze);
    let last: GameView | null = null;
    for (let k = 0; k < 3; k++) {
      // Wait most of the timeout, then move.
      const dueAt: number = (last?.chainNowSec ?? game.createdAtSec) + IDLE_SEC - 2;
      await until('the next move time', async () => {
        const now = Number((await h.publicClient.getBlock({ blockTag: 'latest' })).timestamp);
        return now >= dueAt;
      });
      const reply = await api.move<GameView>(game.gameId, game.token, { step: k, dir: route[k] });
      expect(reply.status).toBe(200);
      last = reply.body;
    }
    // Three moves spread over more than one idle timeout: the game is still in play.
    expect(last!.chainNowSec - game.createdAtSec).toBeGreaterThan(IDLE_SEC);
    expect(last!.status).toBe('active');
    await api.cashout(game.gameId, game.token, { step: 3 });
    expect((await waitSettled(h, game.gameId)).steps).toBe(3);
  });
});
