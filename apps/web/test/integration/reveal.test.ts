// AC-S10 on a real chain: `/reveal` answers from the chain. In particular, a server whose
// watcher is off, and whose log therefore has no trace of the game, still refuses to reveal the
// seed of a game that is `Active` on chain.

import { commitmentOf, mazeBetAbi, type GameView, type RevealResponse } from '@maze/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api } from '../server/helpers';
import {
  BET,
  chainTime,
  createOnChain,
  jump,
  onchainGame,
  openGame,
  playerOf,
  reclaimRevert,
  requestTicket,
  revertName,
  startHarness,
  startServer,
  waitSettled,
  type Harness,
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

function expectNotRevealable(reply: { status: number; body: unknown }): void {
  expect(reply.status).toBe(409);
  expect(reply.body).toEqual({ error: { code: 'NOT_REVEALABLE', message: expect.any(String) } });
}

describe('AC-S10: reveal with the watcher running', () => {
  it('a settled game is revealed with reason settled', async () => {
    server = await startServer(h);
    const game = await openGame(h, playerOf(h, 0));
    expectNotRevealable(await api.reveal(game.gameId));
    const ended = await api.cashout<GameView>(game.gameId, game.token, { step: 0 });
    const settled = await waitSettled(h, game.gameId);

    const reveal = await api.reveal<RevealResponse>(game.gameId);
    expect(reveal.status).toBe(200);
    expect(reveal.body).toEqual({
      gameId: game.gameId,
      commitment: game.ticket.commitment,
      serverSeed: settled.serverSeed,
      reason: 'settled',
    });
    expect(reveal.body.serverSeed).toBe(ended.body.terminal!.serverSeed);
  });

  it('an unused ticket is revealed only once a block is more than 60 s past its expiry', async () => {
    const player = playerOf(h, 1);
    const { ticket } = await requestTicket(player.address);
    expectNotRevealable(await api.reveal(ticket.gameId));

    // Expired, but not yet by more than 60 seconds.
    await jump(h, ticket.expirySec + 20 - (await chainTime(h)));
    expectNotRevealable(await api.reveal(ticket.gameId));
    expect((await onchainGame(h, ticket.gameId)).status).toBe(0);

    await jump(h, ticket.expirySec + 62 - (await chainTime(h)));
    const reveal = await api.reveal<RevealResponse>(ticket.gameId);
    expect(reveal.status).toBe(200);
    expect(reveal.body.reason).toBe('ticket-expired');
    expect(commitmentOf({ mazeVersion: 1, n: 5, serverSeed: reveal.body.serverSeed })).toBe(
      ticket.commitment,
    );

    // The revealed seed is worthless: the contract no longer accepts this ticket.
    expect(
      await revertName(() =>
        h.publicClient.simulateContract({
          address: h.contract,
          abi: mazeBetAbi,
          functionName: 'createGame',
          args: [
            ticket.gameId,
            ticket.tier,
            ticket.commitment,
            BigInt(ticket.expirySec),
            `0x${'61'.repeat(32)}`,
            ticket.signature,
          ],
          value: BET,
          account: player.address,
        }),
      ),
    ).toBe('TicketExpired');
  });
});

describe('AC-S10: reveal with the watcher disabled', () => {
  it('a game that is Active on chain is NOT_REVEALABLE although the server has no record of it', async () => {
    await server?.stop();
    const blind = (server = await startServer(h, { watcher: false, background: false }));

    const player = playerOf(h, 2);
    const { ticket, token } = await requestTicket(player.address);
    await createOnChain(h, player, ticket, BET, `0x${'62'.repeat(32)}`);
    await blind.container.worker.tick();

    // The server is blind to the game: its log has only the ticket.
    expect(blind.container.service.get(ticket.gameId)!.chain).toBeNull();
    expect((await api.start(ticket.gameId, token)).status).toBe(409);
    expect((await onchainGame(h, ticket.gameId)).status).toBe(1);

    // Well past expiry + 60 s. A reveal decided by the local log would hand out the seed here.
    await jump(h, ticket.expirySec + 90 - (await chainTime(h)));
    await blind.container.worker.tick();
    expectNotRevealable(await api.reveal(ticket.gameId));
    await jump(h, 600);
    expectNotRevealable(await api.reveal(ticket.gameId));

    // The server never settles it. After the deadline it is reclaimed, and then revealed.
    const third = playerOf(h, 7);
    expect(await reclaimRevert(h, ticket.gameId, third.address)).toBe('DeadlineNotReached');
    await jump(h, h.table.timing.settleWindowSec);
    const hash = await third.wallet.writeContract({
      address: h.contract,
      abi: mazeBetAbi,
      functionName: 'reclaim',
      args: [ticket.gameId],
    });
    expect((await h.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success');
    expect((await onchainGame(h, ticket.gameId)).status).toBe(3);

    const reveal = await api.reveal<RevealResponse>(ticket.gameId);
    expect(reveal.status).toBe(200);
    expect(reveal.body.reason).toBe('reclaimed');
    expect(commitmentOf({ mazeVersion: 1, n: 5, serverSeed: reveal.body.serverSeed })).toBe(
      ticket.commitment,
    );
    expect(blind.container.service.get(ticket.gameId)!.chain).toBeNull();
  });
});
