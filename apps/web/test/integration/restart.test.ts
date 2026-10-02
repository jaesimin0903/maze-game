// AC-S6: after a restart the server replays its event log, reads the blocks it missed from the
// stored block number, and settles the games that were left open.

import { refundWei, type GameView } from '@maze/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, exitRoute } from '../server/helpers';
import {
  BET,
  createOnChain,
  linesOf,
  openGame,
  playerOf,
  requestTicket,
  settlements,
  startHarness,
  startServer,
  until,
  waitChainTime,
  waitSettled,
  walk,
  type Harness,
  type Server,
} from './setup';

const IDLE_SEC = 8;

let h: Harness;
let server: Server | null = null;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await server?.stop();
  await h?.stop();
});

describe('AC-S6: restart recovery', () => {
  it('recovers a game in play, a game created while down and a game that had just ended', async () => {
    const first = (server = await startServer(h, { idleTimeoutSec: IDLE_SEC }));

    // A ticket whose game does not exist yet, a game two moves in, and a game ending right now.
    const waiting = playerOf(h, 0);
    const pendingTicket = await requestTicket(waiting);
    const inPlay = await openGame(h, playerOf(h, 1));
    await walk(inPlay, exitRoute(inPlay.maze).slice(0, 2));
    const before = (await api.game<GameView>(inPlay.gameId, inPlay.token)).body;
    const ending = await openGame(h, playerOf(h, 2));
    const ended = await api.cashout<GameView>(ending.gameId, ending.token, { step: 0 });
    expect(ended.status).toBe(200);

    await first.stop();
    server = null;

    // While the server is down the first player creates their game.
    const created = await createOnChain(h, waiting, pendingTicket.ticket, BET, `0x${'51'.repeat(32)}`);
    await waitChainTime(h, created.createdAtSec + 2);

    const second = (server = await startServer(h, { dataDir: first.dataDir, idleTimeoutSec: IDLE_SEC }));
    const boot = second.logs.find((line) => line.event === 'boot');
    expect(boot?.detail?.replayedEvents as number).toBeGreaterThan(5);

    // The game created during the downtime was read from the chain at boot.
    const createdLine = linesOf(second, pendingTicket.ticket.gameId).find(
      (line) => line.event === 'chain-created',
    );
    expect(createdLine?.txHash).toBe(created.hash);
    const missed = await api.game<GameView>(pendingTicket.ticket.gameId, pendingTicket.token);
    expect(missed.status).toBe(200);
    // Its clock runs from its creation block, not from the boot.
    expect(missed.body.idleDeadlineSec).toBe(created.createdAtSec + IDLE_SEC);

    // The game in play is exactly where it was.
    const after = (await api.game<GameView>(inPlay.gameId, inPlay.token)).body;
    expect(after.step).toBe(2);
    expect(after.path).toEqual(before.path);
    expect(after.idleDeadlineSec).toBe(before.idleDeadlineSec);
    expect(after.betWei).toBe(before.betWei);

    // All three end up settled on chain, each exactly once.
    const settledMissed = await waitSettled(h, pendingTicket.ticket.gameId);
    expect(settledMissed).toMatchObject({
      outcome: 1,
      steps: 0,
      payoutWei: refundWei(h.table, BET, 0, 0),
    });
    const settledInPlay = await waitSettled(h, inPlay.gameId);
    expect(settledInPlay).toMatchObject({
      outcome: 1,
      steps: 2,
      payoutWei: refundWei(h.table, BET, 0, 2),
    });
    const settledEnding = await waitSettled(h, ending.gameId);
    expect(settledEnding.serverSeed).toBe(ended.body.terminal!.serverSeed);

    for (const gameId of [pendingTicket.ticket.gameId, inPlay.gameId, ending.gameId]) {
      await until(`the server to record the settlement of ${gameId}`, async () =>
        second.container.service.get(gameId)?.final === 'settled',
      );
      expect(await settlements(h, gameId)).toHaveLength(1);
    }
    // The ending signed before the restart was not signed again.
    expect(linesOf(second, ending.gameId).some((line) => line.event === 'ended')).toBe(false);
    const read = await api.game<GameView>(ending.gameId, ending.token);
    expect(read.body.terminal!.signature).toBe(ended.body.terminal!.signature);
    expect(read.body.terminal!.settleTxHash).toBe(settledEnding.txHash);
  });
});
