// Audit X33, the event log at boot. A flood of ticket requests once grew `events.jsonl` to
// 875,809 ticket lines (537 MB); the server read the file as one string, which the runtime
// cannot hold, so `openFileStore` threw `Invalid string length` and the server could never boot
// on that log again. The log is now read as a stream and compacted as it is opened.
//
// These tests write logs of that size and larger to a temporary directory. They need no chain:
// the server boots over the in-memory chain of the unit tests.

import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Hex, RevealResponse, TicketResponse } from '@maze/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { TICKET_RETENTION_SEC } from '../../src/server/game-service';
import { openFileStore } from '../../src/server/store';
import {
  api,
  CONTRACT,
  FakeChain,
  fixtureTable,
  makeEnv,
  ticketBody,
  type TestEnv,
} from '../server/helpers';

/** The log the review could not boot: 875,809 ticket lines, 537 MB. */
const FAILING_LINES = 875_809;
/** The longest string the runtime holds is just under 2^29 characters. */
const STRING_LIMIT_BYTES = 2 ** 29;
/** Tickets per chain second in the flood that produced that log. */
const FLOOD_PER_SEC = 250;

const FILL = (byte: string, bytes: number): string => byte.repeat(bytes);

function ticketLine(id: string, expirySec: number): string {
  return (
    `{"type":"ticket-issued","gameId":"0x${id}","player":"0x${id.slice(24)}","tier":0,"n":5,` +
    `"serverSeed":"0x${FILL('5e', 32)}","commitment":"0x${FILL('c0', 32)}",` +
    `"sessionTokenHash":"0x${FILL('70', 32)}","expirySec":${expirySec},` +
    `"signature":"0x${FILL('ab', 65)}","atSec":${expirySec - 120}}`
  );
}

const idOf = (i: number): string => i.toString(16).padStart(64, '0');

/** The expiry of the last of `count` flood tickets issued from chain second `fromSec`. */
function lastExpiryOf(count: number, fromSec: number): number {
  return fromSec + Math.floor((count - 1) / FLOOD_PER_SEC) + 120;
}

/** Writes a log: the header, `count` flood tickets issued from `fromSec`, then `tail`. */
async function writeFloodLog(file: string, count: number, fromSec: number, tail: string[]): Promise<void> {
  const handle = await open(file, 'w');
  try {
    await handle.appendFile(`{"type":"meta","chainId":31337,"contract":"${CONTRACT}"}\n`);
    const BATCH = 20_000;
    for (let from = 0; from < count; from += BATCH) {
      const lines: string[] = [];
      for (let i = from; i < Math.min(count, from + BATCH); i++) {
        lines.push(ticketLine(idOf(i), fromSec + Math.floor(i / FLOOD_PER_SEC) + 120));
      }
      await handle.appendFile(`${lines.join('\n')}\n`);
    }
    await handle.appendFile(tail.map((line) => `${line}\n`).join(''));
  } finally {
    await handle.close();
  }
}

function replayed(booted: TestEnv): number {
  const boot = booted.logs.find((line) => line.event === 'boot') as { detail: { replayedEvents: number } };
  return boot.detail.replayedEvents;
}

let dir: string;
let env: TestEnv | null = null;

afterEach(async () => {
  await env?.close();
  env = null;
  await rm(dir, { recursive: true, force: true });
});

describe('X33: a very large event log', () => {
  it('1,500,000 ticket lines, far beyond what one string could hold, boot as a compacted log', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'maze-biglog-'));
    const file = path.join(dir, 'events.jsonl');
    const COUNT = 1_500_000;
    const chain = new FakeChain(fixtureTable);
    const from = chain.time;

    // The server's last scan marker lies past the retention window of every flood ticket. One
    // more ticket expired only five minutes before it: that one is still owed its reveal.
    chain.time = lastExpiryOf(COUNT, from) + TICKET_RETENTION_SEC + 600;
    const head = chain.mine();
    const young = `0x${FILL('f1', 32)}` as Hex;
    await writeFloodLog(file, COUNT, from, [
      ticketLine(FILL('f1', 32), head.timestamp - 300),
      `{"type":"block-scanned","blockNumber":"${head.number}","blockHash":"${head.hash}","timestampSec":${head.timestamp}}`,
    ]);
    const before = (await stat(file)).size;
    expect(before).toBeGreaterThan(1.6 * STRING_LIMIT_BYTES);
    expect(COUNT).toBeGreaterThan(1.7 * FAILING_LINES);

    const store = await openFileStore(dir, { ticketRetentionSec: TICKET_RETENTION_SEC });
    const booted = (env = await makeEnv({ chain, store }));

    // Only the header, the young ticket and the marker were left to replay.
    expect((await stat(file)).size).toBeLessThan(2000);
    expect(replayed(booted)).toBe(3);
    expect(booted.container.service.counts()).toEqual({ games: 1, uncreatedTickets: 1 });
    expect(booted.container.service.get(`0x${idOf(0)}`)).toBeUndefined();
    expect(booted.container.service.get(`0x${idOf(COUNT - 1)}`)).toBeUndefined();

    // The server serves: the young ticket's seed is revealed, and a new ticket is issued.
    const reveal = await api.reveal<RevealResponse>(young);
    expect(reveal.status).toBe(200);
    expect(reveal.body.reason).toBe('ticket-expired');
    expect((await api.ticket<TicketResponse>(await ticketBody())).status).toBe(201);
    expect((await api.health()).status).toBe(200);
  });

  it('a log of the size that could not be read, written before markers carried a timestamp, boots and is compacted one boot later', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'maze-biglog-'));
    const file = path.join(dir, 'events.jsonl');
    const COUNT = 876_000;
    const chain = new FakeChain(fixtureTable);
    const from = chain.time;
    chain.time = lastExpiryOf(COUNT, from) + TICKET_RETENTION_SEC + 600;
    const head = chain.mine();
    // The old marker: no timestamp, so the file alone does not prove that any ticket is dead.
    await writeFloodLog(file, COUNT, from, [
      `{"type":"block-scanned","blockNumber":"${head.number}","blockHash":"${head.hash}"}`,
    ]);
    const before = (await stat(file)).size;
    expect(COUNT).toBeGreaterThan(FAILING_LINES);
    expect(before).toBeGreaterThan(STRING_LIMIT_BYTES);

    const first = (env = await makeEnv({
      chain,
      store: await openFileStore(dir, { ticketRetentionSec: TICKET_RETENTION_SEC }),
    }));
    expect(replayed(first)).toBe(COUNT + 2);
    // The pass at boot read the chain past every expiry: the dead tickets are out of memory.
    expect(first.container.service.counts()).toEqual({ games: 0, uncreatedTickets: 0 });
    expect((await api.ticket<TicketResponse>(await ticketBody())).status).toBe(201);
    // The file still holds them all: nothing in it proves that they are dead.
    expect((await stat(file)).size).toBeGreaterThan(before);

    // The running server writes a marker with a timestamp (every 20 blocks at the latest)...
    for (let i = 0; i < 20; i++) {
      first.advance(1);
      await first.tick();
    }
    await first.close();
    env = null;

    // ...and with it the next boot cuts the dead tickets out of the file.
    const second = (env = await makeEnv({
      chain,
      store: await openFileStore(dir, { ticketRetentionSec: TICKET_RETENTION_SEC }),
    }));
    expect((await stat(file)).size).toBeLessThan(5000);
    expect(replayed(second)).toBeLessThan(10);
    expect(second.container.service.counts()).toEqual({ games: 1, uncreatedTickets: 1 });
  });
});
