// Audit X31: the "one active game per address" rule (plan §7.3) must hold against a client that
// pre-issues several tickets before creating any game on chain. Each created game reserves
// `max(bet, maxPayout)` of the house balance, so a bypass lets one address lock up many times its
// stake in house liquidity. The rule is server-only (the contract does not enforce it), so these
// are server unit tests over the in-memory chain.

import type { TicketResponse } from '@maze/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { api, makeEnv, ONCHAIN, openGame, PLAYERS, ticketBody, type TestEnv } from './helpers';

let env: TestEnv;

afterEach(async () => {
  await env.close();
});

describe('X31: one live ticket-or-game per address', () => {
  it('no second ticket is issued while the first is still outstanding (no game on chain yet)', async () => {
    env = await makeEnv({ watcher: false });
    const first = await api.ticket<TicketResponse>(await ticketBody());
    expect(first.status).toBe(201);
    // No createGame, no watcher: the first ticket is purely an in-memory outstanding entry. The
    // owner's next signed request gets that ticket back, never a second one.
    const second = await api.ticket<TicketResponse>(await ticketBody());
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    // A different address is unaffected.
    const other = await api.ticket<TicketResponse>(await ticketBody(PLAYERS[1]));
    expect(other.status).toBe(201);
    expect(other.body.gameId).not.toBe(first.body.gameId);
    expect(env.signs.ticket).toBe(2);
  });

  it('pre-issuing cannot yield several concurrent games for one address', async () => {
    env = await makeEnv();
    const tickets: TicketResponse[] = [];
    for (let i = 0; i < 5; i++) {
      const reply = await api.ticket<TicketResponse>(await ticketBody());
      expect(reply.status).toBe(201);
      tickets.push(reply.body);
    }
    // Five requests, one ticket: a game id can be used once, so one game can be created.
    expect(new Set(tickets.map((ticket) => ticket.gameId)).size).toBe(1);
    expect(env.signs.ticket).toBe(1);
    env.chain.createGame({ ...tickets[0], betWei: 10_000_000_000_000_000n, clientSeed: `0x${'12'.repeat(32)}` });
    expect((await api.ticket(await ticketBody())).status).toBe(409);
    expect(await env.chain.totalReserved()).toBe(
      (10_000_000_000_000_000n * BigInt(env.table.tiers[0].multiplierBps)) / 10_000n,
    );
  });

  it('concurrent requests for one address issue exactly one ticket (no TOCTOU)', async () => {
    env = await makeEnv({ watcher: false });
    const bodies = await Promise.all(Array.from({ length: 8 }, () => ticketBody()));
    const replies = await Promise.all(bodies.map((body) => api.ticket<TicketResponse>(body)));
    expect(replies.every((reply) => reply.status === 201)).toBe(true);
    expect(new Set(replies.map((reply) => reply.body.gameId)).size).toBe(1);
    expect(env.signs.ticket).toBe(1);
    const log = await env.store.load();
    expect(log.filter((event) => event.type === 'ticket-issued')).toHaveLength(1);
  });

  it('a ticket whose GameCreated is on chain but not yet ingested still blocks a second', async () => {
    env = await makeEnv();
    const ticket = (await api.ticket<TicketResponse>(await ticketBody())).body;
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
    // The on-the-spot scan sees the active game: the ticket is not handed out again.
    const reply = await api.ticket(await ticketBody());
    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({
      error: { code: 'ALREADY_ACTIVE', message: 'This address already has an active game.' },
    });
  });

  it('an expired, unused ticket no longer stands for the address: a new one is issued', async () => {
    env = await makeEnv({ watcher: false });
    const first = (await api.ticket<TicketResponse>(await ticketBody())).body;
    expect((await api.ticket<TicketResponse>(await ticketBody())).body.gameId).toBe(first.gameId);
    env.advance(env.table.timing.ticketExpirySec + 1);
    const next = await api.ticket<TicketResponse>(await ticketBody());
    expect(next.status).toBe(201);
    expect(next.body.gameId).not.toBe(first.gameId);
    expect(env.signs.ticket).toBe(2);
  });

  it('a settled game does not hold the address: the next ticket is issued (Phase 3 preserved)', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    expect((await api.ticket(await ticketBody())).status).toBe(409);
    await api.cashout(game.gameId, game.token, { step: 0 });
    await env.container.relayer.drain();
    env.advance(1);
    expect(env.chain.games.get(game.gameId)!.status).toBe(ONCHAIN.Settled);
    // Settlement is on chain; the on-the-spot scan clears the address and a ticket is issued.
    expect((await api.ticket<TicketResponse>(await ticketBody())).status).toBe(201);
  });
});
