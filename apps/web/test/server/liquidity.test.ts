// Audit X31: the "one active game per address" rule (plan §7.3) must hold against a client that
// pre-issues several tickets before creating any game on chain. Each created game reserves
// `max(bet, maxPayout)` of the house balance, so a bypass lets one address lock up many times its
// stake in house liquidity. The rule is server-only (the contract does not enforce it), so these
// are server unit tests over the in-memory chain.

import type { Hex, TicketResponse } from '@maze/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { api, makeEnv, newToken, ONCHAIN, openGame, PLAYERS, type TestEnv } from './helpers';

let env: TestEnv;

afterEach(async () => {
  await env.close();
});

function ticketBody(player: Hex = PLAYERS[0]): { player: Hex; tier: number; sessionTokenHash: Hex } {
  return { player, tier: 0, sessionTokenHash: newToken().sessionTokenHash };
}

describe('X31: one live ticket-or-game per address', () => {
  it('a second ticket is refused while the first is still outstanding (no game on chain yet)', async () => {
    env = await makeEnv({ watcher: false });
    expect((await api.ticket<TicketResponse>(ticketBody())).status).toBe(201);
    // No createGame, no watcher: the first ticket is purely an in-memory outstanding entry.
    expect((await api.ticket(ticketBody())).status).toBe(409);
    expect((await api.ticket(ticketBody())).body).toEqual({
      error: { code: 'ALREADY_ACTIVE', message: 'This address already has an active game.' },
    });
    // A different address is unaffected.
    expect((await api.ticket(ticketBody(PLAYERS[1]))).status).toBe(201);
    expect(env.signs.ticket).toBe(2);
  });

  it('pre-issuing cannot yield several concurrent games for one address', async () => {
    env = await makeEnv({ watcher: false });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await api.ticket(ticketBody())).status);
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
  });

  it('concurrent requests for one address issue exactly one ticket (no TOCTOU)', async () => {
    env = await makeEnv({ watcher: false });
    const replies = await Promise.all(Array.from({ length: 8 }, () => api.ticket(ticketBody())));
    expect(replies.filter((reply) => reply.status === 201)).toHaveLength(1);
    expect(replies.filter((reply) => reply.status === 409)).toHaveLength(7);
    expect(env.signs.ticket).toBe(1);
  });

  it('a ticket whose GameCreated is on chain but not yet ingested still blocks a second', async () => {
    env = await makeEnv();
    const ticket = (await api.ticket<TicketResponse>(ticketBody())).body;
    // Put the game on chain, but do not run a worker pass: activeByPlayer is still empty.
    env.chain.createGame({
      gameId: ticket.gameId,
      player: ticket.player,
      tier: ticket.tier,
      commitment: ticket.commitment,
      betWei: 10_000_000_000_000_000n,
      clientSeed: `0x${'11'.repeat(32)}`,
    });
    expect(env.container.service.get(ticket.gameId)!.chain).toBeNull();
    // The outstanding-ticket check blocks it; the on-the-spot scan then sees the active game.
    expect((await api.ticket(ticketBody())).status).toBe(409);
  });

  it('an expired, unused ticket no longer blocks a new one', async () => {
    env = await makeEnv({ watcher: false });
    expect((await api.ticket<TicketResponse>(ticketBody())).status).toBe(201);
    expect((await api.ticket(ticketBody())).status).toBe(409);
    env.advance(env.table.timing.ticketExpirySec + 1);
    expect((await api.ticket<TicketResponse>(ticketBody())).status).toBe(201);
  });

  it('a settled game does not hold the address: the next ticket is issued (Phase 3 preserved)', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    expect((await api.ticket(ticketBody())).status).toBe(409);
    await api.cashout(game.gameId, game.token, { step: 0 });
    await env.container.relayer.drain();
    env.advance(1);
    expect(env.chain.games.get(game.gameId)!.status).toBe(ONCHAIN.Settled);
    // Settlement is on chain; the on-the-spot scan clears the address and a ticket is issued.
    expect((await api.ticket<TicketResponse>(ticketBody())).status).toBe(201);
  });
});
