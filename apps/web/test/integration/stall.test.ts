// AC-X4: a player cannot stall their way to the full-refund `reclaim` path. Whatever they do
// not do, the server ends the game on the chain clock and settles it for less than the bet,
// long before the contract's settle deadline. Timeouts are shortened: idle 5 s, game 25 s.

import { mazeBetAbi, refundWei, type GameView } from '@maze/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, exitRoute } from '../server/helpers';
import {
  BET,
  jump,
  linesOf,
  onchainGame,
  openGame,
  playerOf,
  reclaimRevert,
  startHarness,
  startServer,
  waitChainTime,
  waitSettled,
  walk,
  type Harness,
  type LiveGame,
  type Server,
  type Settlement,
} from './setup';

const IDLE_SEC = 5;
const MAX_GAME_SEC = 25;

let h: Harness;
let server: Server;
const finished: LiveGame[] = [];

beforeAll(async () => {
  h = await startHarness();
  server = await startServer(h, { idleTimeoutSec: IDLE_SEC, maxGameSec: MAX_GAME_SEC });
});

afterAll(async () => {
  await server?.stop();
  await h?.stop();
});

/** The game was settled for less than the bet, in time, and `reclaim` is closed for it. */
async function expectSettledNotReclaimable(game: LiveGame, steps: number): Promise<Settlement> {
  const settled = await waitSettled(h, game.gameId);
  const expected = refundWei(h.table, game.betWei, game.tier, steps);
  expect(settled).toMatchObject({ outcome: 1, steps, payoutWei: expected });
  expect(settled.payoutWei).toBeLessThan(game.betWei);

  const onchain = await onchainGame(h, game.gameId);
  expect(onchain.status).toBe(2);
  expect(settled.timestamp).toBeLessThan(Number(onchain.settleDeadline) - 300);
  expect(await reclaimRevert(h, game.gameId, game.player.address)).toBe('GameNotActive');
  finished.push(game);
  return settled;
}

describe('AC-X4: stalling never reaches a full refund', () => {
  it('never calling /start', async () => {
    const game = await openGame(h, playerOf(h, 0), { start: false });
    // While the game is open, the deadline has not been reached.
    expect(await reclaimRevert(h, game.gameId, game.player.address)).toBe('DeadlineNotReached');

    const settled = await expectSettledNotReclaimable(game, 0);
    expect(settled.payoutWei).toBe((BET * 9500n) / 10_000n);
    expect(settled.timestamp - game.createdAtSec).toBeLessThanOrEqual(IDLE_SEC + 5);
  });

  it('calling /start late', async () => {
    const game = await openGame(h, playerOf(h, 1), { start: false });
    await waitChainTime(h, game.createdAtSec + IDLE_SEC - 2);
    const started = await api.start<GameView>(game.gameId, game.token);
    // Accepted or already too late; either way the deadline is the creation block's.
    if (started.status === 200) {
      expect(started.body.idleDeadlineSec).toBe(game.createdAtSec + IDLE_SEC);
    } else {
      expect(['DEADLINE_PASSED', 'GAME_NOT_ACTIVE']).toContain(
        (started.body as unknown as { error: { code: string } }).error.code,
      );
    }

    const settled = await expectSettledNotReclaimable(game, 0);
    // Starting late bought no time: the clock began at the creation block.
    expect(settled.timestamp - game.createdAtSec).toBeLessThanOrEqual(IDLE_SEC + 5);
    const again = await api.start(game.gameId, game.token);
    expect((again.body as { error: { code: string } }).error.code).toBe('GAME_NOT_ACTIVE');
  });

  it('stalling in the middle of a game', async () => {
    const game = await openGame(h, playerOf(h, 2));
    const views = await walk(game, exitRoute(game.maze).slice(0, 3));
    expect(await reclaimRevert(h, game.gameId, game.player.address)).toBe('DeadlineNotReached');

    const settled = await expectSettledNotReclaimable(game, 3);
    expect(settled.timestamp - views[2].idleDeadlineSec).toBeLessThanOrEqual(5);
    expect(linesOf(server, game.gameId).find((line) => line.event === 'ended')?.detail).toMatchObject({
      cause: 'idle',
      auto: true,
    });
  });

  it('stalling at k = 0 after /start', async () => {
    const game = await openGame(h, playerOf(h, 3));
    const settled = await expectSettledNotReclaimable(game, 0);
    expect(settled.payoutWei).toBe((BET * 9500n) / 10_000n);
  });

  it('keeping the idle timer alive: the game is force-settled at the maximum game time', async () => {
    const game = await openGame(h, playerOf(h, 4), { tier: 2 });
    const route = exitRoute(game.maze);
    const gameDeadline = game.createdAtSec + MAX_GAME_SEC;
    let accepted = 0;
    let lastMoveAt = game.createdAtSec;
    let refusal = '';
    while (refusal === '') {
      // Well inside the 5 s idle timeout, so only the game deadline can stop the player.
      await waitChainTime(h, lastMoveAt + 2);
      const reply = await api.move<GameView>(game.gameId, game.token, {
        step: accepted,
        dir: route[accepted],
      });
      if (reply.status === 200) {
        accepted += 1;
        lastMoveAt = reply.body.chainNowSec;
        expect(reply.body.gameDeadlineSec).toBe(gameDeadline);
        expect(lastMoveAt).toBeLessThan(gameDeadline);
      } else {
        refusal = (reply.body as unknown as { error: { code: string } }).error.code;
      }
    }
    expect(accepted).toBeGreaterThanOrEqual(5);
    expect(['DEADLINE_PASSED', 'GAME_NOT_ACTIVE']).toContain(refusal);

    const settled = await expectSettledNotReclaimable(game, accepted);
    expect(settled.timestamp).toBeGreaterThanOrEqual(gameDeadline);
    expect(settled.timestamp - gameDeadline).toBeLessThanOrEqual(5);
    expect(linesOf(server, game.gameId).find((line) => line.event === 'ended')?.detail).toMatchObject({
      cause: 'max-game',
      auto: true,
    });
  });

  it('after the settle deadline has passed, none of those games can be reclaimed', async () => {
    expect(finished).toHaveLength(5);
    await jump(h, h.table.timing.settleWindowSec + 10);
    const third = playerOf(h, 7);
    for (const game of finished) {
      expect(await reclaimRevert(h, game.gameId, third.address)).toBe('GameNotActive');
      expect(await reclaimRevert(h, game.gameId, game.player.address)).toBe('GameNotActive');
    }
    // No GameReclaimed was ever emitted, and nothing is left reserved.
    const reclaimed = await h.publicClient.getContractEvents({
      address: h.contract,
      abi: mazeBetAbi,
      eventName: 'GameReclaimed',
      fromBlock: 0n,
    });
    expect(reclaimed).toHaveLength(0);
    expect(
      await h.publicClient.readContract({
        address: h.contract,
        abi: mazeBetAbi,
        functionName: 'totalReserved',
      }),
    ).toBe(0n);
  });
});
