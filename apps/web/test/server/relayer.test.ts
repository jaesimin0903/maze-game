// The at-least-once settlement loop (plan §3.7, AC-S11, audit X13) against the in-memory chain.

import type { GameView, Hex } from '@maze/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStore, type StoreEvent } from '../../src/server/store';
import {
  api,
  deadEndRoute,
  makeEnv,
  ONCHAIN,
  openGame,
  PLAYERS,
  type OpenedGame,
  type TestEnv,
} from './helpers';

let env: TestEnv;

afterEach(async () => {
  await env.close();
});

function logged(event: string, gameId?: Hex): Record<string, unknown>[] {
  return env.logs.filter(
    (line) => line.event === event && (gameId === undefined || line.gameId === gameId),
  );
}

async function settledEvents(gameId: Hex): Promise<number> {
  const head = await env.chain.head();
  const events = await env.chain.events(0n, head.number);
  return events.filter((event) => event.type === 'settled' && event.gameId === gameId).length;
}

/** One block: a second of chain time and a worker pass. */
async function block(count = 1): Promise<void> {
  for (let i = 0; i < count; i++) {
    env.advance(1);
    await env.tick();
  }
}

async function cashOut(game: OpenedGame): Promise<GameView> {
  const reply = await api.cashout<GameView>(game.gameId, game.token, { step: 0 });
  expect(reply.status).toBe(200);
  await env.container.relayer.drain();
  return reply.body;
}

async function lose(game: OpenedGame): Promise<void> {
  const route = deadEndRoute(game.maze);
  for (let k = 0; k < route.length; k++) {
    await api.move(game.gameId, game.token, { step: k, dir: route[k] });
  }
  await env.container.relayer.drain();
}

describe('settlement sending', () => {
  it('a game is settled as soon as it ends, by one transaction with the signed result', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    const view = await cashOut(game);

    expect(env.chain.sent).toHaveLength(1);
    expect(env.chain.sent[0].args).toEqual({
      gameId: game.gameId,
      outcome: 1,
      steps: 0,
      payoutWei: BigInt(view.terminal!.payoutWei),
      serverSeed: view.terminal!.serverSeed,
      signature: view.terminal!.signature,
    });
    await block();
    expect(env.chain.games.get(game.gameId)!.status).toBe(ONCHAIN.Settled);
    expect(env.container.service.get(game.gameId)!.final).toBe('settled');

    await block(25);
    expect(env.chain.sent).toHaveLength(1);
    expect(await settledEvents(game.gameId)).toBe(1);
  });

  it('AC-S11: a dropped transaction is sent again after 10 chain seconds, and settles once', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    env.chain.sendMode = 'drop';
    await cashOut(game);
    expect(env.chain.sent).toHaveLength(1);
    expect(env.chain.pending()).toBe(0);
    env.chain.sendMode = 'accept';

    // Nine blocks: the first transaction is still younger than ten chain seconds.
    await block(9);
    expect(env.chain.sent).toHaveLength(1);
    expect(env.chain.games.get(game.gameId)!.status).toBe(ONCHAIN.Active);

    await block();
    expect(env.chain.sent).toHaveLength(2);
    await block();
    expect(env.chain.games.get(game.gameId)!.status).toBe(ONCHAIN.Settled);

    await block(30);
    expect(env.chain.sent).toHaveLength(2);
    expect(await settledEvents(game.gameId)).toBe(1);
    expect(logged('settle-sent', game.gameId)).toHaveLength(2);
    expect(logged('settle-mined', game.gameId)).toHaveLength(1);
    // The read shows the transaction that was actually mined.
    const read = await api.game<GameView>(game.gameId, game.token);
    expect(read.body.terminal!.settleTxHash).toBe(env.chain.sent[1].hash);
  });

  it('keeps sending every 10 chain seconds for as long as nothing is mined', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    env.chain.sendMode = 'drop';
    await cashOut(game);
    await block(35);
    expect(env.chain.sent).toHaveLength(4);
    const times = logged('settle-sent', game.gameId).map((line) => line.chainSec as number);
    expect(times.map((at) => at - times[0])).toEqual([0, 10, 20, 30]);
  });

  it('a send that fails outright is retried on the next block', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    env.chain.sendMode = 'fail';
    await cashOut(game);
    expect(env.chain.sent).toHaveLength(0);
    expect(logged('settle-send-failed', game.gameId)).toHaveLength(1);

    env.chain.sendMode = 'accept';
    await block();
    expect(env.chain.sent).toHaveLength(1);
    await block();
    expect(env.chain.games.get(game.gameId)!.status).toBe(ONCHAIN.Settled);
  });

  it('a send that fails outright is retried on the next pass, also when the chain clock has not moved', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    env.chain.sendMode = 'fail';
    await cashOut(game);
    expect(env.chain.sent).toHaveLength(0);

    // No new block: the chain second is the one of the failed attempt.
    const second = env.chain.time;
    await env.tick();
    expect(env.chain.sent).toHaveLength(0);
    expect(logged('settle-send-failed', game.gameId)).toHaveLength(2);

    env.chain.sendMode = 'accept';
    await env.tick();
    expect(env.chain.time).toBe(second);
    expect(env.chain.sent).toHaveLength(1);
    expect(logged('settle-sent', game.gameId)).toEqual([expect.objectContaining({ chainSec: second })]);

    // Once the node has accepted a transaction, further passes in that second send nothing.
    await env.tick();
    await Promise.all([env.container.relayer.sweep(), env.container.relayer.sweep(), env.tick()]);
    expect(env.chain.sent).toHaveLength(1);
    env.chain.mine();
    await env.tick();
    expect(env.chain.games.get(game.gameId)!.status).toBe(ONCHAIN.Settled);
    expect(await settledEvents(game.gameId)).toBe(1);
  });

  it('a send the node accepted is not repeated when recording it failed: no duplicate inside 10 chain seconds', async () => {
    let failing = true;
    const inner = createMemoryStore();
    env = await makeEnv({
      store: {
        load: () => inner.load(),
        close: () => inner.close(),
        append(events) {
          const list = Array.isArray(events) ? events : [events];
          if (failing && list.some((event: StoreEvent) => event.type === 'settle-sent')) {
            return Promise.reject(new Error('disk full'));
          }
          return inner.append(events);
        },
      },
    });
    const game = await openGame(env);
    env.chain.sendMode = 'drop';
    await cashOut(game);
    expect(env.chain.sent).toHaveLength(1);
    expect(env.container.service.get(game.gameId)!.settle.lastSentSec).toBeNull();

    // The log does not know about the transaction, the relayer does: nothing is sent again
    // for the next nine chain seconds, in however many passes.
    await env.tick();
    await block(9);
    expect(env.chain.sent).toHaveLength(1);
    failing = false;
    await block();
    expect(env.chain.sent).toHaveLength(2);
  });

  it('simultaneous passes send one transaction', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    env.advance(env.table.timing.idleTimeoutSec);
    const { relayer } = env.container;
    await env.container.service.expireDue();
    await Promise.all([relayer.sweep(), relayer.sweep(), env.tick(), relayer.drain()]);
    await relayer.drain();
    expect(env.chain.sent).toHaveLength(1);
    expect(env.chain.sent[0].args.gameId).toBe(game.gameId);
  });
});

describe('AC-S11: deadline handling', () => {
  it('logs an alert 300 seconds before the deadline and gives up after it', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    const deadline = env.chain.games.get(game.gameId)!.settleDeadlineSec;
    env.chain.sendMode = 'drop';
    await cashOut(game);

    env.advance(deadline - 301 - env.chain.time);
    await env.tick();
    expect(logged('settle-overdue')).toHaveLength(0);

    await block();
    const alerts = logged('settle-overdue', game.gameId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ level: 'alert', chainSec: deadline - 300, outcome: 1, step: 0 });
    await block(20);
    expect(logged('settle-overdue')).toHaveLength(1);

    // Still trying right up to the deadline.
    const sentBefore = env.chain.sent.length;
    env.advance(deadline - env.chain.time);
    await env.tick();
    expect(env.chain.sent.length).toBe(sentBefore + 1);

    // After it the contract would refuse `settle`, so nothing more is sent.
    await block(15);
    expect(env.chain.sent.length).toBe(sentBefore + 1);
    expect(logged('settle-abandoned', game.gameId)).toHaveLength(1);

    env.chain.reclaim(game.gameId);
    await env.tick();
    expect(env.container.service.get(game.gameId)!.final).toBe('reclaimed');
    expect(logged('reclaimed', game.gameId)).toHaveLength(1);
  });

  it('a transaction sent in time is still mined before the deadline', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    const deadline = env.chain.games.get(game.gameId)!.settleDeadlineSec;
    env.chain.sendMode = 'drop';
    await cashOut(game);
    env.advance(deadline - 300 - env.chain.time);
    await env.tick();
    expect(logged('settle-overdue')).toHaveLength(1);

    env.chain.sendMode = 'accept';
    await block(11);
    expect(env.chain.games.get(game.gameId)!.status).toBe(ONCHAIN.Settled);
    expect(env.chain.time).toBeLessThan(deadline);
    expect(await settledEvents(game.gameId)).toBe(1);
  });
});

describe('AC-X9 / X13: one game cannot hold up another', () => {
  it("a settlement that cannot be sent does not delay another game's loss", async () => {
    env = await makeEnv();
    const stuck = await openGame(env, { player: PLAYERS[0] });
    const other = await openGame(env, { player: PLAYERS[1], deadEnd: true });
    env.chain.failGames.add(stuck.gameId);

    await cashOut(stuck);
    await lose(other);
    expect(env.chain.sent.map((tx) => tx.args.gameId)).toEqual([other.gameId]);

    await block();
    expect(env.chain.games.get(other.gameId)!.status).toBe(ONCHAIN.Settled);
    expect(env.chain.games.get(stuck.gameId)!.status).toBe(ONCHAIN.Active);
    expect(logged('settle-send-failed', stuck.gameId).length).toBeGreaterThan(0);

    env.chain.failGames.clear();
    await block(2);
    expect(env.chain.games.get(stuck.gameId)!.status).toBe(ONCHAIN.Settled);
  });

  it('settlements of games that end together are in the pool together', async () => {
    env = await makeEnv();
    const a = await openGame(env, { player: PLAYERS[0] });
    const b = await openGame(env, { player: PLAYERS[1] });
    await Promise.all([
      api.cashout(a.gameId, a.token, { step: 0 }),
      api.cashout(b.gameId, b.token, { step: 0 }),
    ]);
    await env.container.relayer.drain();

    // Both were submitted, with consecutive nonces, before any block was mined.
    expect(env.chain.pending()).toBe(2);
    expect(env.chain.sent.map((tx) => tx.nonce).sort()).toEqual([0, 1]);
    await block();
    expect(env.chain.games.get(a.gameId)!.status).toBe(ONCHAIN.Settled);
    expect(env.chain.games.get(b.gameId)!.status).toBe(ONCHAIN.Settled);
  });

  it('a dropped transaction leaves a nonce gap that the loop closes by itself', async () => {
    env = await makeEnv();
    const a = await openGame(env, { player: PLAYERS[0] });
    const b = await openGame(env, { player: PLAYERS[1], deadEnd: true });
    env.chain.sendMode = 'drop';
    await cashOut(a);
    env.chain.sendMode = 'accept';
    await lose(b);
    // The node no longer has a's transaction, so b's got the same nonce and is mined at once.
    await block();
    expect(env.chain.games.get(b.gameId)!.status).toBe(ONCHAIN.Settled);
    await block(10);
    expect(env.chain.games.get(a.gameId)!.status).toBe(ONCHAIN.Settled);
    expect(await settledEvents(a.gameId)).toBe(1);
    expect(await settledEvents(b.gameId)).toBe(1);
  });
});

describe('settlements the relayer did not send', () => {
  it('a result submitted by someone else is recorded and ends the loop', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    env.chain.sendMode = 'drop';
    const view = await cashOut(game);
    env.chain.sendMode = 'accept';

    // The player submits the signed result from the response.
    const playerTx: Hex = `0x${'7e'.repeat(32)}`;
    env.chain.games.get(game.gameId)!.status = ONCHAIN.Settled;
    env.chain.time += 2;
    env.chain.mine([
      {
        type: 'settled',
        blockNumber: 0n,
        txHash: playerTx,
        gameId: game.gameId,
        player: game.player,
        outcome: 1,
        steps: 0,
        payoutWei: BigInt(view.terminal!.payoutWei),
        serverSeed: view.terminal!.serverSeed,
      },
    ]);
    await env.tick();

    expect(env.container.service.get(game.gameId)!.final).toBe('settled');
    expect((await api.game<GameView>(game.gameId, game.token)).body.terminal!.settleTxHash).toBe(playerTx);
    await block(25);
    expect(env.chain.sent).toHaveLength(1);
  });

  it('AC-S6: a game that ended before a restart is settled after it, with the stored signature', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    env.chain.sendMode = 'fail';
    const view = await cashOut(game);
    const log = await env.store.load();
    const { chain } = env;
    await env.close();

    chain.sendMode = 'accept';
    chain.time += 5;
    chain.mine();
    env = await makeEnv({ chain, store: createMemoryStore(log) });
    await env.container.relayer.drain();
    expect(env.signs.settlement).toBe(0);
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].args.signature).toBe(view.terminal!.signature);

    await block();
    expect(chain.games.get(game.gameId)!.status).toBe(ONCHAIN.Settled);
    expect(await settledEvents(game.gameId)).toBe(1);
  });
});
