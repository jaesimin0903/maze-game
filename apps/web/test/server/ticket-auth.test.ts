// Audit X34: a ticket is issued only to the address that signed the request for it.
//
// Before the fix `POST /api/games` needed no proof of the address. Because an address has one
// ticket slot, anyone could occupy another address's slot once per ticket lifetime and keep it
// at `ALREADY_ACTIVE`, and a player who rejected the wallet prompt locked themselves out until
// the unused ticket expired.

import type { ErrorResponse, GameView, Hex, TicketResponse } from '@maze/shared';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../src/server/store';
import {
  api,
  BET,
  CONTRACT,
  keyOf,
  makeEnv,
  newToken,
  PLAYERS,
  signTicketBody,
  ticketBody,
  type TestEnv,
  type TicketBody,
} from './helpers';

const VICTIM = PLAYERS[0];
const ATTACKER_KEY = generatePrivateKey();

let env: TestEnv;

beforeEach(async () => {
  env = await makeEnv();
});

afterEach(async () => {
  await env.close();
});

function expectUnauthorized(reply: { status: number; body: unknown }): void {
  expect(reply.status).toBe(401);
  expect(reply.body).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
}

async function ticketLines(): Promise<string[]> {
  return (await env.store.load()).map((event) => event.type).filter((type) => type.startsWith('ticket'));
}

/** Requests for the victim's address that the victim did not sign. */
async function forgeries(): Promise<Record<string, unknown>[]> {
  const good = await ticketBody(VICTIM);
  const { signature: _signature, ...unsigned } = good;
  const otherHash = newToken().sessionTokenHash;
  return [
    // No signature at all: the request the server accepted before the fix.
    unsigned,
    // Signed by somebody else's key, for the victim's address.
    await signTicketBody(ATTACKER_KEY, { player: VICTIM }),
    // The victim's signature for another tier, another session, another chain, another contract.
    { ...good, tier: 1 },
    { ...good, sessionTokenHash: otherHash },
    await signTicketBody(keyOf(VICTIM), { player: VICTIM }, { chainId: 1, contract: CONTRACT }),
    await signTicketBody(
      keyOf(VICTIM),
      { player: VICTIM },
      { chainId: 31337, contract: '0x000000000000000000000000000000000000bEEF' },
    ),
    // Not a signature.
    { ...unsigned, signature: '0x' },
    { ...unsigned, signature: `0x${'00'.repeat(65)}` },
    { ...unsigned, signature: `0x${'11'.repeat(64)}` },
    { ...unsigned, signature: 12 },
    { ...unsigned, signature: null },
  ];
}

describe('X34: a ticket request is signed by the address it names', () => {
  it('a missing or wrong signature is UNAUTHORIZED and creates no state', async () => {
    for (const body of await forgeries()) expectUnauthorized(await api.ticket<ErrorResponse>(body));

    expect(env.signs.ticket).toBe(0);
    expect(await ticketLines()).toEqual([]);
    expect(env.container.service.counts()).toEqual({ games: 0, uncreatedTickets: 0 });
    expect(env.logs.some((line) => line.event === 'ticket-issued')).toBe(false);
  });

  it("forged requests use up neither the address's rate allowance nor its ticket slot", async () => {
    // Far more than the 10 requests per minute an address is allowed.
    for (let round = 0; round < 5; round++) {
      for (const body of await forgeries()) expectUnauthorized(await api.ticket(body));
    }

    // The owner still has the whole allowance: ten signed requests are answered, the eleventh is not.
    const body = await ticketBody(VICTIM);
    for (let i = 0; i < 10; i++) expect((await api.ticket(body)).status).toBe(201);
    expect((await api.ticket(body)).status).toBe(429);
    expect(env.signs.ticket).toBe(1);
  });

  it('an attacker cannot keep an address locked out: the owner gets a ticket in 10 of 10 rounds', async () => {
    const lifetime = env.table.timing.ticketExpirySec;
    const tickets = new Set<Hex>();
    for (let round = 0; round < 10; round++) {
      // One request per ticket lifetime was enough to hold the slot before the fix.
      const { signature: _signature, ...unsigned } = await ticketBody(VICTIM);
      expectUnauthorized(await api.ticket(unsigned));
      expectUnauthorized(await api.ticket(await signTicketBody(ATTACKER_KEY, { player: VICTIM })));

      const reply = await api.ticket<TicketResponse>(await ticketBody(VICTIM));
      expect(reply.status, `round ${round}`).toBe(201);
      tickets.add(reply.body.gameId);
      env.advance(lifetime + 1);
    }
    expect(tickets.size).toBe(10);
    expect(env.signs.ticket).toBe(10);
  });

  it('accepts the signature whatever the letter case of the address in the request', async () => {
    const body = await ticketBody(VICTIM);
    const reply = await api.ticket<TicketResponse>({ ...body, player: VICTIM.toLowerCase() });
    expect(reply.status).toBe(201);
    expect(reply.body.player).toBe(VICTIM);
  });

  it('an account without a key cannot ask for a ticket: only the key holder of the address can', async () => {
    // What a contract wallet could offer: an address, and a signature made by its owner's key.
    const owner = privateKeyToAccount(generatePrivateKey());
    const wallet: Hex = '0x00000000000000000000000000000000000c0de5';
    expectUnauthorized(await api.ticket(await signTicketBody(generatePrivateKey(), { player: wallet })));
    expectUnauthorized(
      await api.ticket({ ...(await signTicketBody(generatePrivateKey())), player: owner.address }),
    );
  });
});

describe('X34: the owner of an outstanding ticket gets that ticket again', () => {
  it('a second signed request returns the same ticket, bound to the new session token', async () => {
    const first = newToken();
    const second = newToken();
    const key = keyOf(VICTIM);
    const issued = await api.ticket<TicketResponse>(
      await signTicketBody(key, { sessionTokenHash: first.sessionTokenHash }),
    );
    expect(issued.status).toBe(201);

    // The player rejected the wallet prompt, or reloaded: the page asks again with a new token.
    const body = await signTicketBody(key, { sessionTokenHash: second.sessionTokenHash });
    const again = await api.ticket<TicketResponse>(body);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(issued.body);
    expect(env.signs.ticket).toBe(1);
    expect(await ticketLines()).toEqual(['ticket-issued', 'ticket-rebound']);
    expect(env.container.service.counts()).toEqual({ games: 1, uncreatedTickets: 1 });

    // The same request once more changes nothing and writes nothing.
    expect((await api.ticket<TicketResponse>(body)).body).toEqual(issued.body);
    expect(await ticketLines()).toEqual(['ticket-issued', 'ticket-rebound']);

    // The game is played with the session of the last request; the replaced token is dead.
    env.chain.createGame({ ...issued.body, betWei: BET, clientSeed: `0x${'31'.repeat(32)}` });
    await env.tick();
    expect((await api.start(issued.body.gameId, first.token)).status).toBe(401);
    const started = await api.start<GameView>(issued.body.gameId, second.token);
    expect(started.status).toBe(200);
    expect(started.body.step).toBe(0);

    // With the game on chain the address is busy: no ticket, and no re-binding of the session.
    const late = await api.ticket<ErrorResponse>(await ticketBody(VICTIM));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ALREADY_ACTIVE');
    expect((await api.game(issued.body.gameId, second.token)).status).toBe(200);
  });

  it('nobody else can re-bind the ticket: the session stays with the owner', async () => {
    const owner = newToken();
    const issued = await api.ticket<TicketResponse>(
      await signTicketBody(keyOf(VICTIM), { sessionTokenHash: owner.sessionTokenHash }),
    );
    const thief = newToken();
    const { signature: _signature, ...unsigned } = await ticketBody(VICTIM);
    expectUnauthorized(await api.ticket({ ...unsigned, sessionTokenHash: thief.sessionTokenHash }));
    expectUnauthorized(
      await api.ticket(
        await signTicketBody(ATTACKER_KEY, { player: VICTIM, sessionTokenHash: thief.sessionTokenHash }),
      ),
    );
    expect(await ticketLines()).toEqual(['ticket-issued']);

    env.chain.createGame({ ...issued.body, betWei: BET, clientSeed: `0x${'32'.repeat(32)}` });
    await env.tick();
    expect((await api.start(issued.body.gameId, thief.token)).status).toBe(401);
    expect((await api.start(issued.body.gameId, owner.token)).status).toBe(200);
  });

  it('a re-binding is in the log: after a restart the last session token is the valid one', async () => {
    const first = newToken();
    const second = newToken();
    const key = keyOf(VICTIM);
    const issued = await api.ticket<TicketResponse>(
      await signTicketBody(key, { sessionTokenHash: first.sessionTokenHash }),
    );
    await api.ticket(await signTicketBody(key, { sessionTokenHash: second.sessionTokenHash }));
    const log = await env.store.load();
    const { chain } = env;
    await env.close();

    env = await makeEnv({ chain, store: createMemoryStore(log) });
    chain.createGame({ ...issued.body, betWei: BET, clientSeed: `0x${'33'.repeat(32)}` });
    await env.tick();
    expect((await api.start(issued.body.gameId, first.token)).status).toBe(401);
    expect((await api.start(issued.body.gameId, second.token)).status).toBe(200);
  });
});

describe('boundary: the live-entry check at the expiry second of a ticket', () => {
  async function request(): Promise<{ body: TicketBody; reply: TicketResponse; token: string }> {
    const { token, sessionTokenHash } = newToken();
    const body = await signTicketBody(keyOf(VICTIM), { sessionTokenHash });
    const reply = await api.ticket<TicketResponse>(body);
    expect(reply.status).toBe(201);
    return { body, reply: reply.body, token };
  }

  it('at the expiry second the ticket still stands for the address; one second later a new one is issued', async () => {
    const first = await request();
    expect(first.reply.expirySec).toBe(env.chain.time + env.table.timing.ticketExpirySec);

    // `createGame` accepts a ticket in a block whose timestamp equals its expiry, so at that
    // second the ticket is still the address's one live entry.
    env.advance(first.reply.expirySec - env.chain.time);
    expect(env.chain.time).toBe(first.reply.expirySec);
    const atExpiry = await request();
    expect(atExpiry.reply).toEqual(first.reply);
    expect(env.signs.ticket).toBe(1);
    const waiting = await api.start<ErrorResponse>(first.reply.gameId, atExpiry.token);
    expect(waiting.status).toBe(409);
    expect(waiting.body.error.code).toBe('NOT_ON_CHAIN');

    env.advance(1);
    const after = await request();
    expect(after.reply.gameId).not.toBe(first.reply.gameId);
    expect(after.reply.expirySec).toBe(env.chain.time + env.table.timing.ticketExpirySec);
    expect(env.signs.ticket).toBe(2);
    const gone = await api.start<ErrorResponse>(first.reply.gameId, atExpiry.token);
    expect(gone.status).toBe(410);
    expect(gone.body.error.code).toBe('TICKET_EXPIRED');
  });
});
