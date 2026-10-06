// Audit X33, the ticket part: what a flood of ticket requests can make the server hold in
// memory and write to its event log is bounded.
//
// Before the fix tickets needed no signature, were never forgotten and were limited per address
// only, so fresh addresses could grow the server's memory and its log without limit: 30,000
// tickets in two minutes against a real stack, and a log that could no longer be read at boot.

import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ErrorResponse, RevealResponse, TicketResponse } from '@maze/shared';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TICKET_GLOBAL_RATE_MAX,
  TICKET_GLOBAL_WINDOW_SEC,
  TICKET_OUTSTANDING_MAX,
  TICKET_RETENTION_SEC,
} from '../../src/server/game-service';
import { openFileStore } from '../../src/server/store';
import { api, BET, keyOf, makeEnv, newToken, PLAYERS, signTicketBody, type TestEnv } from './helpers';

let env: TestEnv;
let dir: string | null = null;

afterEach(async () => {
  await env.close();
  if (dir !== null) await rm(dir, { recursive: true, force: true });
  dir = null;
});

/** One signed request from an address nobody has seen before, as a flood would send it. */
async function fresh(): Promise<{ status: number; body: TicketResponse | ErrorResponse }> {
  const reply = await api.ticket<TicketResponse | ErrorResponse>(await signTicketBody(generatePrivateKey()));
  return { status: reply.status, body: reply.body };
}

async function freshTicket(): Promise<TicketResponse> {
  const reply = await fresh();
  expect(reply.status).toBe(201);
  return reply.body as TicketResponse;
}

function expectRateLimited(reply: { status: number; body: unknown }): void {
  expect(reply.status).toBe(429);
  expect(reply.body).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String) } });
}

describe('X33: global limits on ticket issuance', () => {
  it('at most 60 ticket lines are written per 60 chain seconds, over all addresses', async () => {
    env = await makeEnv();
    // The numbers the audit states (X33).
    expect({
      TICKET_OUTSTANDING_MAX,
      TICKET_GLOBAL_RATE_MAX,
      TICKET_GLOBAL_WINDOW_SEC,
      TICKET_RETENTION_SEC,
    }).toEqual({
      TICKET_OUTSTANDING_MAX: 64,
      TICKET_GLOBAL_RATE_MAX: 60,
      TICKET_GLOBAL_WINDOW_SEC: 60,
      TICKET_RETENTION_SEC: 3600,
    });
    for (let i = 0; i < TICKET_GLOBAL_RATE_MAX; i++) await freshTicket();
    expectRateLimited(await fresh());
    expect(env.signs.ticket).toBe(TICKET_GLOBAL_RATE_MAX);
    expect(env.logs.filter((line) => line.event === 'ticket-capacity-reached')).toEqual([
      expect.objectContaining({ level: 'warn', detail: { limit: 'rate' } }),
    ]);

    // One second before the window has passed nothing is issued; when it has, issuing resumes.
    env.advance(TICKET_GLOBAL_WINDOW_SEC - 1);
    expectRateLimited(await fresh());
    env.advance(1);
    await freshTicket();
    expect(env.signs.ticket).toBe(TICKET_GLOBAL_RATE_MAX + 1);
  });

  it('a re-binding is a ticket line too: it counts toward the same rate', async () => {
    env = await makeEnv();
    const key = keyOf(PLAYERS[0]);
    expect((await api.ticket(await signTicketBody(key))).status).toBe(201);
    for (let i = 1; i < TICKET_GLOBAL_RATE_MAX; i++) await freshTicket();
    // The budget of this window is used up: the owner's re-binding has to wait as well.
    expectRateLimited(await api.ticket(await signTicketBody(key)));
    env.advance(TICKET_GLOBAL_WINDOW_SEC);
    expect((await api.ticket(await signTicketBody(key))).status).toBe(201);
    expect((await env.store.load()).filter((event) => event.type === 'ticket-rebound')).toHaveLength(1);
  });

  it('at most 64 tickets are outstanding at once; expiry and a game on chain free a slot', async () => {
    env = await makeEnv();
    const first: TicketResponse[] = [];
    for (let i = 0; i < TICKET_GLOBAL_RATE_MAX; i++) first.push(await freshTicket());
    env.advance(TICKET_GLOBAL_WINDOW_SEC);
    for (let i = TICKET_GLOBAL_RATE_MAX; i < TICKET_OUTSTANDING_MAX; i++) await freshTicket();
    expect(env.container.service.counts().uncreatedTickets).toBe(TICKET_OUTSTANDING_MAX);

    // The rate would allow 56 more in this window; the cap on outstanding tickets does not.
    expectRateLimited(await fresh());
    const honest = keyOf(PLAYERS[0]);
    for (let i = 0; i < 12; i++) expectRateLimited(await api.ticket(await signTicketBody(honest)));
    expect(env.logs.filter((line) => line.event === 'ticket-capacity-reached')).toEqual([
      expect.objectContaining({ detail: { limit: 'outstanding' } }),
    ]);
    expect(env.signs.ticket).toBe(TICKET_OUTSTANDING_MAX);

    // A ticket whose game is on chain is no longer outstanding. The address that was turned
    // away twelve times gets the free slot: refusals for capacity are not held against it.
    env.chain.createGame({ ...first[0], betWei: BET, clientSeed: `0x${'41'.repeat(32)}` });
    await env.tick();
    expect((await api.ticket(await signTicketBody(honest))).status).toBe(201);
    expectRateLimited(await fresh());

    // At their expiry second the first 60 still count; one second later they do not.
    env.advance(first[1].expirySec - env.chain.time);
    expectRateLimited(await fresh());
    env.advance(1);
    await freshTicket();
  });

  it('concurrent requests from many addresses cannot pass the limits together', async () => {
    env = await makeEnv();
    const bodies = await Promise.all(
      Array.from({ length: 150 }, () => signTicketBody(generatePrivateKey())),
    );
    const replies = await Promise.all(bodies.map((body) => api.ticket(body)));
    expect(replies.filter((reply) => reply.status === 201)).toHaveLength(TICKET_GLOBAL_RATE_MAX);
    expect(replies.filter((reply) => reply.status === 429)).toHaveLength(150 - TICKET_GLOBAL_RATE_MAX);
    expect(env.signs.ticket).toBe(TICKET_GLOBAL_RATE_MAX);
  });
});

describe('X33: a ticket that can no longer create a game is forgotten', () => {
  it('its seed can be revealed from expiry + 60 s for the retention window, then the ticket is gone', async () => {
    env = await makeEnv();
    const ticket = await freshTicket();
    const kept = await freshTicket();
    env.chain.createGame({ ...kept, betWei: BET, clientSeed: `0x${'42'.repeat(32)}` });
    await env.tick();

    env.advance(ticket.expirySec + 61 - env.chain.time);
    await env.tick();
    const reveal = await api.reveal<RevealResponse>(ticket.gameId);
    expect(reveal.status).toBe(200);
    expect(reveal.body.reason).toBe('ticket-expired');

    // The last second of the retention window: still in memory, still revealed.
    env.advance(ticket.expirySec + TICKET_RETENTION_SEC - env.chain.time);
    await env.tick();
    expect(env.container.service.get(ticket.gameId)).toBeDefined();
    expect((await api.reveal<RevealResponse>(ticket.gameId)).body.serverSeed).toBe(reveal.body.serverSeed);

    env.advance(1);
    await env.tick();
    expect(env.container.service.get(ticket.gameId)).toBeUndefined();
    expect((await api.reveal(ticket.gameId)).status).toBe(404);
    // A ticket whose game exists on chain is never forgotten, however old.
    expect(env.container.service.get(kept.gameId)).toBeDefined();
    expect(env.container.service.counts()).toEqual({ games: 1, uncreatedTickets: 0 });
  });

  it('nothing is forgotten on the clock alone: the server must have read the chain past the expiry', async () => {
    env = await makeEnv({ watcher: false });
    const ticket = await freshTicket();
    env.advance(ticket.expirySec + TICKET_RETENTION_SEC + 500 - env.chain.time);
    await env.tick();
    // The watcher never ran, so the server cannot know that no game was created from the ticket.
    expect(env.container.service.get(ticket.gameId)).toBeDefined();
    expect((await api.reveal<RevealResponse>(ticket.gameId)).body.reason).toBe('ticket-expired');
  });
});

describe('X33: a flood of ticket requests', () => {
  it('is refused beyond the limits, and memory and log growth per chain minute stay bounded', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'maze-flood-'));
    const file = path.join(dir, 'events.jsonl');
    env = await makeEnv({ store: await openFileStore(dir) });
    const size = async (): Promise<number> => (await stat(file)).size;

    // Unsigned requests, the flood of the review: every one is refused and nothing is written.
    const before = await size();
    for (let i = 0; i < 300; i++) {
      const reply = await api.ticket({
        player: `0x${i.toString(16).padStart(40, '0')}`,
        tier: 0,
        sessionTokenHash: newToken().sessionTokenHash,
      });
      expect(reply.status).toBe(401);
    }
    expect(await size()).toBe(before);
    expect(env.container.service.counts()).toEqual({ games: 0, uncreatedTickets: 0 });

    // Signed requests from fresh addresses, five per chain second for six chain minutes.
    const MINUTES = 6;
    const PER_SECOND = 5;
    const lifetimeSec = env.table.timing.ticketExpirySec + 1;
    const accepted: TicketResponse[] = [];
    let refused = 0;
    let peakOutstanding = 0;
    const perMinute: { accepted: number; bytes: number }[] = [];
    for (let minute = 0; minute < MINUTES; minute++) {
      const bytesAtStart = await size();
      const acceptedAtStart = accepted.length;
      for (let second = 0; second < 60; second++) {
        for (let i = 0; i < PER_SECOND; i++) {
          const reply = await fresh();
          if (reply.status === 201) accepted.push(reply.body as TicketResponse);
          else {
            expectRateLimited(reply);
            refused += 1;
          }
        }
        const now = env.chain.time;
        peakOutstanding = Math.max(
          peakOutstanding,
          accepted.filter((ticket) => now <= ticket.expirySec).length,
        );
        env.advance(1);
        await env.tick();
      }
      perMinute.push({ accepted: accepted.length - acceptedAtStart, bytes: (await size()) - bytesAtStart });
    }

    // 1,800 requests were sent. The rate bounds every minute; the cap bounds what is outstanding.
    expect(accepted.length + refused).toBe(MINUTES * 60 * PER_SECOND);
    for (const minute of perMinute) {
      expect(minute.accepted).toBeLessThanOrEqual(TICKET_GLOBAL_RATE_MAX);
      // A ticket line is about 0.6 kB; a minute also holds a few block-scan markers.
      expect(minute.bytes).toBeLessThanOrEqual(TICKET_GLOBAL_RATE_MAX * 700 + 1024);
    }
    expect(peakOutstanding).toBe(TICKET_OUTSTANDING_MAX);
    // Over time the cap is the tighter limit: 64 tickets per ticket lifetime.
    expect(accepted.length).toBeLessThanOrEqual(
      TICKET_OUTSTANDING_MAX * Math.ceil((MINUTES * 60) / lifetimeSec),
    );
    expect(refused).toBeGreaterThan(MINUTES * 60 * PER_SECOND * 0.8);
    expect(env.signs.ticket).toBe(accepted.length);
    expect(env.container.service.counts().games).toBe(accepted.length);

    // Memory: what the flood left behind is forgotten once the retention window has passed,
    // and the next flood starts from nothing.
    const last = accepted[accepted.length - 1];
    env.advance(last.expirySec + TICKET_RETENTION_SEC + 1 - env.chain.time);
    await env.tick();
    expect(env.container.service.counts()).toEqual({ games: 0, uncreatedTickets: 0 });
    expect(accepted.every((ticket) => env.container.service.get(ticket.gameId) === undefined)).toBe(true);
    expect(env.storeFailures).toEqual([]);
    // Over 2,000 requests through the real store: about 4.5 s alone, more under load, so the
    // default 5 s limit made this a timing flake rather than a check of the limits.
  }, 30_000);
});
