// The chain scan on a public chain. A fresh event log starts at the head (or MAZE_START_BLOCK),
// never at block 0; every `eth_getLogs` range stays within MAZE_LOG_CHUNK_BLOCKS (Monad's public
// RPC refuses ranges over 100 blocks); events and markers come from blocks at the scan tag
// (Monad's `latest` is a proposed block that may still be replaced); a marker on a replaced block
// is passed over at boot; and the boot catch-up survives a failing range.

import { parseTuning, type TuningTable } from '@maze/shared';
import fixtureJson from '@maze/shared/fixtures/tuning.fixture.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainEvent, ChainHead } from '../../src/server/chain';
import { MARK_EVERY_RANGES, MARK_EVERY_SEC } from '../../src/server/chain';
import { uninstallContainer } from '../../src/server/container';
import { ApiError } from '../../src/server/errors';
import { singleFlight } from '../../src/server/mutex';
import { createMemoryStore, type StoreEvent } from '../../src/server/store';
import { SCAN_WAIT_MS } from '../../src/server/game-service';
import {
  api,
  BET,
  FakeChain,
  fixtureTable,
  makeEnv,
  openGame,
  PLAYERS,
  requestTicket,
  ticketBody,
  type TestEnv,
} from './helpers';

afterEach(async () => {
  await uninstallContainer();
});

/** A chain whose head is block `head`. */
function chainAt(head: number, table: TuningTable = fixtureTable): FakeChain {
  const chain = new FakeChain(table);
  for (let i = 0; i < head; i++) chain.mine();
  return chain;
}

/** Block numbers of the scan markers in a log, in log order. */
function markerBlocks(log: readonly StoreEvent[]): number[] {
  return log.flatMap((event) => (event.type === 'block-scanned' ? [Number(event.blockNumber)] : []));
}

/** A node that answers `null` for the blocks in `missing`, as one out of sync or pruned does. */
class PrunedChain extends FakeChain {
  readonly missing = new Set<bigint>();

  override async block(blockNumber: bigint): Promise<ChainHead | null> {
    return this.missing.has(blockNumber) ? null : super.block(blockNumber);
  }
}

/** A node that takes 20 ms to answer for its head. */
class SlowChain extends FakeChain {
  override async head(tag?: Parameters<FakeChain['head']>[0]): Promise<ChainHead> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return super.head(tag);
  }
}

/** Fails the next `failures` event reads, then reads normally. */
class FlakyChain extends FakeChain {
  failures = 0;

  override async events(fromBlock: bigint, toBlock: bigint): Promise<ChainEvent[]> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new ApiError('CHAIN_UNAVAILABLE');
    }
    return super.events(fromBlock, toBlock);
  }
}

describe('chain scan: where it starts and how far each read goes', () => {
  it('a fresh log starts at the head: there is no ticket whose game could lie before it', async () => {
    const chain = chainAt(250);
    const env = await makeEnv({ chain, install: false });
    expect(chain.eventReads).toEqual([[250n, 250n]]);
    // The first scan of a process always leaves a marker, before any ticket is handed out.
    expect(markerBlocks(await env.store.load())).toEqual([250]);
    await env.close();
  });

  it('with MAZE_START_BLOCK a fresh log scans from there, in ranges no longer than the chunk size', async () => {
    const chain = chainAt(250);
    const env = await makeEnv({ chain, config: { startBlock: 200, logChunkBlocks: 25 } });
    expect(chain.eventReads).toEqual([
      [200n, 224n],
      [225n, 249n],
      [250n, 250n],
    ]);

    chain.eventReads.length = 0;
    for (let i = 0; i < 30; i++) chain.mine();
    await env.tick();
    expect(chain.eventReads).toEqual([
      [251n, 275n],
      [276n, 280n],
    ]);

    // Games created after the start block are found as before.
    const game = await openGame(env);
    expect(env.container.service.get(game.gameId)!.chain).not.toBeNull();
    for (const [from, to] of chain.eventReads) expect(to - from + 1n).toBeLessThanOrEqual(25n);
    await env.close();
  });

  it('a log with a scan marker resumes from the marker, whatever the start block says', async () => {
    const chain = chainAt(40);
    const first = await makeEnv({ chain, install: false });
    const log = await first.store.load();
    await first.close();
    expect(markerBlocks(log)).toEqual([40]);

    chain.eventReads.length = 0;
    for (let i = 0; i < 10; i++) chain.mine();
    const second = await makeEnv({
      chain,
      store: createMemoryStore(log),
      config: { startBlock: 1_000, logChunkBlocks: 100 },
      install: false,
    });
    // Five blocks before the marker, as on every reboot.
    expect(chain.eventReads).toEqual([[35n, 50n]]);
    await second.close();
  });

  it('a start block beyond the head is refused, and the head itself is accepted', async () => {
    const chain = chainAt(10);
    await expect(makeEnv({ chain, config: { startBlock: 11 }, install: false })).rejects.toMatchObject({
      code: 'CHAIN_UNAVAILABLE',
      message: 'MAZE_START_BLOCK 11 is beyond the latest block 10',
    });
    // Refused before any event was read.
    expect(chain.eventReads).toEqual([]);

    const env = await makeEnv({ chain, config: { startBlock: 10 }, install: false });
    expect(chain.eventReads).toEqual([[10n, 10n]]);
    await env.close();
  });

  it('a log that holds tickets but no marker (an older server) scans from block 0 on Anvil and needs MAZE_START_BLOCK elsewhere', async () => {
    const chain = chainAt(30);
    const first = await makeEnv({ chain });
    await requestTicket();
    const log = (await first.store.load()).filter((event) => event.type !== 'block-scanned');
    await first.close();

    chain.eventReads.length = 0;
    const anvil = await makeEnv({ chain, store: createMemoryStore(log), install: false });
    expect(chain.eventReads[0]).toEqual([0n, 30n]);
    await anvil.close();

    // The same log on a public chain.
    const { fixture: _fixture, ...rest } = fixtureJson;
    const calibrated = parseTuning({ ...rest, calibration: { ...rest.calibration, calibrated: true } });
    const monad = chainAt(30, calibrated);
    monad.chainIdValue = 10143;
    const onMonad = log.map((event) => (event.type === 'meta' ? { ...event, chainId: 10143 } : event));
    const config = { chainId: 10143, testHooks: false, scanTag: 'finalized' as const };
    await expect(
      makeEnv({ table: calibrated, chain: monad, store: createMemoryStore(onMonad), config, install: false }),
    ).rejects.toMatchObject({ code: 'CHAIN_UNAVAILABLE', message: expect.stringMatching(/holds tickets but no scan marker/) });
    const started = await makeEnv({
      table: calibrated,
      chain: monad,
      store: createMemoryStore(onMonad),
      config: { ...config, startBlock: 20 },
      install: false,
    });
    expect(monad.eventReads[0]).toEqual([20n, 30n]);
    await started.close();
  });
});

describe('chain scan: the scan tag', () => {
  it('reads only blocks that have reached the tag; /start answers NOT_ON_CHAIN until the game has', async () => {
    const chain = chainAt(5);
    chain.tagLag.finalized = 2;
    const env = await makeEnv({ chain, config: { scanTag: 'finalized' } });
    // The head at the tag, two blocks behind `latest`.
    expect(chain.eventReads).toEqual([[3n, 3n]]);

    const game = await openGame(env);
    expect(env.container.service.get(game.gameId)!.chain).toBeNull();
    expect((await api.start(game.gameId, game.token)).body).toMatchObject({ error: { code: 'NOT_ON_CHAIN' } });

    // Once the block of `GameCreated` is finalized, the same request starts the game.
    chain.mine();
    chain.mine();
    const started = await api.start(game.gameId, game.token);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ status: 'active', step: 0 });
    // Every marker names a block at the tag, never one that is only `latest`.
    const log = await env.store.load();
    expect(Math.max(...markerBlocks(log))).toBeLessThanOrEqual(Number((await chain.head('finalized')).number));
    await env.close();
  });
});

describe('chain scan: answers while the scan trails the clock', () => {
  it('a game created in the last seconds of its ticket is NOT_ON_CHAIN, not TICKET_EXPIRED, until the scan has passed the expiry', async () => {
    const chain = chainAt(5);
    chain.tagLag.finalized = 2;
    const env = await makeEnv({ chain, config: { scanTag: 'finalized' } });
    const played = await requestTicket();
    const unused = await requestTicket({ player: PLAYERS[1] });

    // Created in a block at the expiry second, which the contract still accepts; then the chain
    // moves on, but the scan has not reached that block.
    chain.time = played.ticket.expirySec;
    chain.createGame({ ...played.ticket, betWei: BET, clientSeed: `0x${'42'.repeat(32)}` });
    chain.time += 5;
    chain.mine();
    for (const ticket of [played, unused]) {
      expect((await api.start(ticket.ticket.gameId, ticket.token)).body).toMatchObject({ error: { code: 'NOT_ON_CHAIN' } });
    }
    // The address is busy: its ticket may have a game, so no second ticket is issued.
    const second = api.ticket(await ticketBody());
    setTimeout(() => chain.mine(), 50);
    expect((await second).body).toMatchObject({ error: { code: 'ALREADY_ACTIVE' } });

    // Once the scan is past the expiry, the game starts and the unused ticket is expired.
    chain.mine();
    chain.mine();
    expect((await api.start(played.ticket.gameId, played.token)).status).toBe(200);
    expect((await api.start(unused.ticket.gameId, unused.token)).body).toMatchObject({ error: { code: 'TICKET_EXPIRED' } });
    await env.close();
  });

  it('a ticket request right after a settlement waits for the scan to show it, instead of answering ALREADY_ACTIVE', async () => {
    const chain = chainAt(5);
    chain.tagLag.finalized = 1;
    const env = await makeEnv({ chain, config: { scanTag: 'finalized' } });
    const game = await openGame(env);
    chain.mine();
    await env.tick();
    await api.cashout(game.gameId, game.token, { step: 0 });
    await env.container.relayer.drain();
    // The settlement is mined at `latest`; the scan sees it one block later.
    chain.mine();
    const body = await ticketBody();
    const started = performance.now();
    const reply = api.ticket(body);
    setTimeout(() => chain.mine(), 300);
    expect((await reply).status).toBe(201);
    expect(performance.now() - started).toBeLessThan(SCAN_WAIT_MS);
    await env.close();
  });

  it('a game whose settlement has not been sent is still refused at once', async () => {
    const chain = chainAt(5);
    chain.tagLag.finalized = 1;
    const env = await makeEnv({ chain, config: { scanTag: 'finalized' } });
    const game = await openGame(env);
    chain.mine();
    await env.tick();
    chain.sendMode = 'fail';
    await api.cashout(game.gameId, game.token, { step: 0 });
    await env.container.relayer.drain();
    const started = performance.now();
    expect((await api.ticket(await ticketBody())).body).toMatchObject({ error: { code: 'ALREADY_ACTIVE' } });
    expect(performance.now() - started).toBeLessThan(SCAN_WAIT_MS / 4);
    await env.close();
  });
});

describe('chain scan: shared scans while the scan trails the clock', () => {
  it('singleFlight: callers during a run share the next one, and each waits for a run that began after its call', async () => {
    let runs = 0;
    const gates: (() => void)[] = [];
    const sync = singleFlight(() => {
      runs += 1;
      return new Promise<void>((resolve) => gates.push(resolve));
    });
    const first = sync();
    const second = sync();
    const third = sync();
    expect(second).toBe(third);
    expect(runs).toBe(1);
    let secondDone = false;
    void second.then(() => (secondDone = true));

    gates[0]();
    await first;
    await vi.waitFor(() => expect(runs).toBe(2));
    expect(secondDone).toBe(false);
    gates[1]();
    await Promise.all([second, third]);
    expect(runs).toBe(2);

    // Nothing running: a call starts a run of its own, and a failed run fails only its callers.
    const failing = singleFlight(() => Promise.reject(new Error('rpc down')));
    await expect(failing()).rejects.toThrow('rpc down');
    await expect(failing()).rejects.toThrow('rpc down');
  });

  it('a burst of requests for a game not scanned yet costs two scans, not one each; on chain 31337 nothing changes', async () => {
    for (const scanTag of ['finalized', 'latest'] as const) {
      const chain = new SlowChain(fixtureTable);
      for (let i = 0; i < 5; i++) chain.mine();
      chain.tagLag.finalized = 2;
      const env = await makeEnv({ chain, config: { scanTag } });
      const { ticket, token } = await requestTicket();
      // Not created yet: every request scans the chain for it.
      const before = chain.headReads[scanTag];
      const replies = await Promise.all(Array.from({ length: 6 }, () => api.start(ticket.gameId, token)));
      for (const reply of replies) expect(reply.body).toMatchObject({ error: { code: 'NOT_ON_CHAIN' } });
      expect(chain.headReads[scanTag] - before, scanTag).toBe(scanTag === 'finalized' ? 2 : 6);
      await env.close();
    }
  });

  it('a ticket request that waits for the scan gives up at the deadline', async () => {
    const chain = chainAt(5);
    chain.tagLag.finalized = 1;
    const env = await makeEnv({ chain, config: { scanTag: 'finalized' } });
    const game = await openGame(env);
    chain.mine();
    await env.tick();
    await api.cashout(game.gameId, game.token, { step: 0 });
    await env.container.relayer.drain();
    // Mined at `latest`, and no block after it: the scan never shows the settlement.
    chain.mine();
    const started = performance.now();
    expect((await api.ticket(await ticketBody())).body).toMatchObject({ error: { code: 'ALREADY_ACTIVE' } });
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(SCAN_WAIT_MS - 50);
    expect(waited).toBeLessThan(SCAN_WAIT_MS + 400);
    await env.close();
  });
});

describe('chain scan: markers', () => {
  it('without events, a marker is stored once a minute of chain time has passed, not every few blocks', async () => {
    const env: TestEnv = await makeEnv({ chain: chainAt(5), install: false });
    for (let i = 0; i < MARK_EVERY_SEC - 1; i++) {
      env.advance(1);
      await env.tick();
    }
    expect(markerBlocks(await env.store.load())).toEqual([5]);
    env.advance(1);
    await env.tick();
    expect(markerBlocks(await env.store.load())).toEqual([5, 5 + MARK_EVERY_SEC]);
    await env.close();
  });

  it('a long scan stores a marker every few ranges, each on a block it has fully read', async () => {
    const chain = chainAt(1_000);
    const env = await makeEnv({ chain, config: { startBlock: 0, logChunkBlocks: 25 }, install: false });
    const markers = (await env.store.load()).filter((event) => event.type === 'block-scanned');
    const every = 25 * MARK_EVERY_RANGES;
    expect(markers.map((marker) => Number(marker.blockNumber))).toEqual([every - 1, 2 * every - 1, 3 * every - 1, 4 * every - 1]);
    for (const marker of markers) {
      expect(marker.blockHash).toBe((await chain.block(BigInt(marker.blockNumber)))!.hash);
    }
    await env.close();
  });

  it('boot passes over markers on replaced blocks and resumes from the newest one still on chain', async () => {
    const chain = chainAt(10);
    const first: TestEnv = await makeEnv({ chain, install: false });
    for (let i = 0; i < 3; i++) {
      first.advance(MARK_EVERY_SEC);
      await first.tick();
    }
    const log = await first.store.load();
    await first.close();
    expect(markerBlocks(log)).toEqual([10, 11, 12, 13]);

    // Blocks 12 and 13 were replaced.
    chain.replaceBlocksFrom(12);
    chain.eventReads.length = 0;
    const second = await makeEnv({ chain, store: createMemoryStore(log), install: false });
    expect(second.logs.filter((line) => line.event === 'scan-marker-rewound')).toEqual([
      expect.objectContaining({ level: 'alert', detail: expect.objectContaining({ newestBlock: '13', resumeBlock: '11' }) }),
    ]);
    // Five blocks before block 11, through the head.
    expect(chain.eventReads).toEqual([[6n, 13n]]);
    await second.close();

    // A chain that has none of the marked blocks is another chain instance.
    chain.replaceBlocksFrom(0);
    await expect(makeEnv({ chain, store: createMemoryStore(log), install: false })).rejects.toMatchObject({
      code: 'CHAIN_UNAVAILABLE',
      message: expect.stringMatching(/another chain instance/),
    });
  });
});

describe('chain scan: a node without the marked blocks', () => {
  it('is a read failure, not another chain: the boot is refused without giving up the log', async () => {
    const pruned = new PrunedChain(fixtureTable);
    for (let i = 0; i < 20; i++) pruned.mine();
    const first = await makeEnv({ chain: pruned, install: false });
    const log = await first.store.load();
    await first.close();
    expect(markerBlocks(log)).toEqual([20]);

    pruned.missing.add(20n);
    const refused = makeEnv({ chain: pruned, store: createMemoryStore(log), install: false });
    await expect(refused).rejects.toMatchObject({
      code: 'CHAIN_UNAVAILABLE',
      message: expect.stringMatching(/has no block 20: it is out of sync or pruned.*The event log is fine/),
    });
    await expect(refused).rejects.not.toMatchObject({ message: expect.stringMatching(/fresh data directory/) });

    // A node that has not reached the block yet.
    const behind = chainAt(5);
    await expect(makeEnv({ chain: behind, store: createMemoryStore(log), install: false })).rejects.toMatchObject({
      code: 'CHAIN_UNAVAILABLE',
      message: expect.stringMatching(/at block 5, behind block 20 of the event log/),
    });

    // Once the node has the block again, the same log boots.
    pruned.missing.clear();
    const again = await makeEnv({ chain: pruned, store: createMemoryStore(log), install: false });
    await again.close();
  });
});

describe('chain scan: the boot catch-up', () => {
  it('a failing range is tried again after a wait and the scan goes on from it; the boot is refused only when the waits run out', async () => {
    const chain = new FlakyChain(fixtureTable);
    for (let i = 0; i < 300; i++) chain.mine();
    chain.failures = 2;
    const env = await makeEnv({ chain, config: { startBlock: 0, logChunkBlocks: 100 }, catchUpRetryMs: [1, 1, 1], install: false });
    expect(env.logs.filter((line) => line.event === 'catch-up-retry')).toHaveLength(2);
    // Each range was read once: no range is read again from the start.
    expect(chain.eventReads).toEqual([
      [0n, 99n],
      [100n, 199n],
      [200n, 299n],
      [300n, 300n],
    ]);
    await env.close();

    const broken = new FlakyChain(fixtureTable);
    broken.failures = 10;
    await expect(makeEnv({ chain: broken, catchUpRetryMs: [1, 1], install: false })).rejects.toMatchObject({
      code: 'CHAIN_UNAVAILABLE',
      message: expect.stringMatching(/cannot catch up with the chain/),
    });
  });
});
