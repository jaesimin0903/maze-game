// AC-S10, AC-S2, audit X9: `/reveal` is decided by the chain, never by the server's own log.

import { commitmentOf, type GameView, type RevealResponse } from '@maze/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  BET,
  exitRoute,
  makeEnv,
  ONCHAIN,
  openGame,
  requestTicket,
  type Reply,
  type TestEnv,
} from './helpers';

let env: TestEnv;

afterEach(async () => {
  await env.close();
});

function expectNotRevealable(reply: Reply): void {
  expect(reply.status).toBe(409);
  expect(reply.body).toEqual({ error: { code: 'NOT_REVEALABLE', message: expect.any(String) } });
}

describe('AC-S10: reveal', () => {
  it('an unknown game is NOT_FOUND', async () => {
    env = await makeEnv();
    expect((await api.reveal(`0x${'ee'.repeat(32)}`)).status).toBe(404);
    expect((await api.reveal('0xnope')).status).toBe(400);
  });

  it('an unused ticket is revealed only by a block more than 60 s past its expiry', async () => {
    env = await makeEnv();
    const { ticket } = await requestTicket();
    expectNotRevealable(await api.reveal(ticket.gameId));

    env.advance(ticket.expirySec + 60 - env.chain.time);
    expectNotRevealable(await api.reveal(ticket.gameId));

    env.advance(1);
    const reply = await api.reveal<RevealResponse>(ticket.gameId);
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body)).toEqual(['gameId', 'commitment', 'serverSeed', 'reason']);
    expect(reply.body).toMatchObject({
      gameId: ticket.gameId,
      commitment: ticket.commitment,
      reason: 'ticket-expired',
    });
    expect(commitmentOf({ mazeVersion: 1, n: 5, serverSeed: reply.body.serverSeed })).toBe(
      ticket.commitment,
    );
  });

  it('the block time decides, not the time of the request', async () => {
    env = await makeEnv();
    const { ticket } = await requestTicket();
    // Chain time has moved on, but no block carries it yet.
    env.chain.time = ticket.expirySec + 500;
    expectNotRevealable(await api.reveal(ticket.gameId));
    env.chain.mine();
    expect((await api.reveal(ticket.gameId)).status).toBe(200);
  });

  it('X9: with the watcher off, a game that is Active on chain is not revealed', async () => {
    env = await makeEnv({ watcher: false });
    const { ticket, token } = await requestTicket();
    // Created in the last valid second of the ticket.
    env.advance(ticket.expirySec - env.chain.time - 1);
    env.chain.time += 1;
    env.chain.createGame({ ...ticket, betWei: BET, clientSeed: `0x${'31'.repeat(32)}` });
    await env.tick();

    // The server's log knows nothing about the game.
    expect(env.container.service.get(ticket.gameId)!.chain).toBeNull();
    expect((await api.start(ticket.gameId, token)).status).toBe(409);

    env.advance(61);
    expectNotRevealable(await api.reveal(ticket.gameId));
    env.advance(5000);
    await env.tick();
    expectNotRevealable(await api.reveal(ticket.gameId));
    expect(env.chain.games.get(ticket.gameId)!.status).toBe(ONCHAIN.Active);

    // Once the chain says the game is over, the same server reveals, still without its watcher.
    env.chain.reclaim(ticket.gameId);
    const reply = await api.reveal<RevealResponse>(ticket.gameId);
    expect(reply.body.reason).toBe('reclaimed');
    expect(commitmentOf({ mazeVersion: 1, n: 5, serverSeed: reply.body.serverSeed })).toBe(
      ticket.commitment,
    );
  });

  it('AC-S2: a game in play is never revealed, however old its ticket', async () => {
    env = await makeEnv({ config: { idleTimeoutSec: 120, maxGameSec: 900 } });
    const game = await openGame(env);
    const route = exitRoute(game.maze);
    expectNotRevealable(await api.reveal(game.gameId));
    for (let k = 0; k < 3; k++) {
      env.advance(100);
      await api.move(game.gameId, game.token, { step: k, dir: route[k] });
      expectNotRevealable(await api.reveal(game.gameId));
    }
    expect(env.chain.time).toBeGreaterThan(game.ticket.expirySec + 60);
  });

  it('an ended game is revealed only once its settlement is on chain', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    env.chain.sendMode = 'drop';
    const ended = await api.cashout<GameView>(game.gameId, game.token, { step: 0 });
    await env.container.relayer.drain();
    // Ended in the server's log, still Active on chain.
    expectNotRevealable(await api.reveal(game.gameId));

    env.chain.sendMode = 'accept';
    for (let i = 0; i < 12; i++) {
      env.advance(1);
      await env.tick();
    }
    const reply = await api.reveal<RevealResponse>(game.gameId);
    expect(reply.body).toEqual({
      gameId: game.gameId,
      commitment: game.ticket.commitment,
      serverSeed: ended.body.terminal!.serverSeed,
      reason: 'settled',
    });
  });

  it('a chain that cannot be read reveals nothing', async () => {
    env = await makeEnv();
    const { ticket } = await requestTicket();
    env.advance(ticket.expirySec + 100 - env.chain.time);
    env.chain.offline = true;
    const reply = await api.reveal(ticket.gameId);
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: { code: 'CHAIN_UNAVAILABLE', message: expect.any(String) } });
    env.chain.offline = false;
  });
});
