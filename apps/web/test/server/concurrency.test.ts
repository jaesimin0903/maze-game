// AC-X5, AC-S5, audit X14-X16: simultaneous requests for one game yield exactly one outcome
// and exactly one settlement signature, and a refused request learns nothing.

import { generateMaze, neighbor, openDirs, refundWei, type Dir, type GameView, type Hex, type Maze } from '@maze/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  BET,
  cellsOf,
  deadEndRoute,
  exitRoute,
  makeEnv,
  ONCHAIN,
  openGame,
  type OpenedGame,
  type Reply,
  type TestEnv,
} from './helpers';

let env: TestEnv;

afterEach(async () => {
  await env.close();
});

async function endings(gameId: Hex): Promise<{ outcome: number; steps: number; auto: boolean }[]> {
  const events = await env.store.load();
  return events.flatMap((event) =>
    event.type === 'ended' && event.gameId === gameId
      ? [{ outcome: event.outcome, steps: event.steps, auto: event.auto }]
      : [],
  );
}

async function moveCount(gameId: Hex): Promise<number> {
  const events = await env.store.load();
  return events.filter((event) => event.type === 'move' && event.gameId === gameId).length;
}

function codeOf(reply: Reply): string {
  return (reply.body as { error: { code: string } }).error.code;
}

/** A refused answer is the bare error body: no cell, wall, path or seed. */
function expectNoState(reply: Reply): void {
  expect(Object.keys(reply.body as object)).toEqual(['error']);
  expect(reply.text).not.toMatch(/"(cell|open|path|terminal|step|serverSeed|refundableWei)"/);
}

async function walk(game: OpenedGame, dirs: readonly Dir[]): Promise<void> {
  for (let k = 0; k < dirs.length; k++) {
    const reply = await api.move(game.gameId, game.token, { step: k, dir: dirs[k] });
    expect(reply.status).toBe(200);
  }
}

/** A 5×5 maze whose exit route has a cell with two ways forward, and the index of that cell. */
function mazeWithJunction(): { maze: Maze; at: number; forward: Dir[] } {
  for (let seed = 1; seed < 200; seed++) {
    const maze = generateMaze(`0x${seed.toString(16).padStart(64, '0')}`, 5);
    const route = exitRoute(maze);
    const cells = cellsOf(maze, route);
    for (let at = 1; at < route.length - 1; at++) {
      const forward = openDirs(maze, cells[at]).filter(
        (dir) => neighbor(maze, cells[at], dir) !== cells[at - 1],
      );
      if (forward.length >= 2) return { maze, at, forward };
    }
  }
  throw new Error('no maze with a junction found');
}

describe('AC-X5: simultaneous moves', () => {
  it('X15: of twelve identical moves with the same step exactly one is applied', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    const dir = exitRoute(game.maze)[0];

    const replies = await Promise.all(
      Array.from({ length: 12 }, () => api.move(game.gameId, game.token, { step: 0, dir })),
    );
    const accepted = replies.filter((reply) => reply.status === 200);
    const refused = replies.filter((reply) => reply.status !== 200);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(11);
    for (const reply of refused) {
      expect(reply.status).toBe(409);
      expect(codeOf(reply)).toBe('STALE_STEP');
      expectNoState(reply);
    }
    expect(await moveCount(game.gameId)).toBe(1);
    expect((await api.game<GameView>(game.gameId, game.token)).body.step).toBe(1);
  });

  it('X15: two different directions from a junction, as from two tabs: one is accepted', async () => {
    const { maze, at, forward } = mazeWithJunction();
    const route = exitRoute(maze);
    for (const order of [forward, [...forward].reverse()]) {
      env = await makeEnv({ mazeFactory: () => maze });
      const game = await openGame(env);
      await walk(game, route.slice(0, at));

      const replies = await Promise.all(
        order.map((dir) => api.move(game.gameId, game.token, { step: at, dir })),
      );
      const refused = replies.filter((reply) => reply.status !== 200);
      expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
      expect(refused).toHaveLength(order.length - 1);
      for (const reply of refused) {
        expect(['STALE_STEP', 'GAME_NOT_ACTIVE']).toContain(codeOf(reply));
        expectNoState(reply);
      }
      const read = await api.game<GameView>(game.gameId, game.token);
      expect(read.body.step).toBe(at + 1);
      expect(read.body.path).toHaveLength(at + 2);
      expect(await moveCount(game.gameId)).toBe(at + 1);
      expect((await endings(game.gameId)).length).toBeLessThanOrEqual(1);
      await env.close();
    }
    env = await makeEnv();
  });
});

describe('AC-S5: one outcome and one signature', () => {
  it('X14: a losing move sent together with a cash-out', async () => {
    for (let trial = 0; trial < 12; trial++) {
      env = await makeEnv();
      const game = await openGame(env, { deadEnd: true });
      const route = deadEndRoute(game.maze);
      const k = route.length - 1;
      await walk(game, route.slice(0, k));

      const move = (): Promise<Reply> =>
        api.move(game.gameId, game.token, { step: k, dir: route[k] });
      const cashout = (): Promise<Reply> => api.cashout(game.gameId, game.token, { step: k });
      const [first, second] = await Promise.all(
        trial % 2 === 0 ? [move(), cashout()] : [cashout(), move()],
      );
      const winner = first.status === 200 ? first : second;
      const loser = first.status === 200 ? second : first;

      expect(winner.status).toBe(200);
      expect(loser.status).toBe(409);
      expect(['STALE_STEP', 'GAME_NOT_ACTIVE']).toContain(codeOf(loser));
      expectNoState(loser);

      const ended = await endings(game.gameId);
      expect(ended).toHaveLength(1);
      expect(env.signs.settlement).toBe(1);
      const view = winner.body as GameView;
      if (view.status === 'lost') {
        expect(ended[0]).toEqual({ outcome: 2, steps: k + 1, auto: false });
        expect(view.terminal!.payoutWei).toBe('0');
      } else {
        expect(view.status).toBe('cashed_out');
        expect(ended[0]).toEqual({ outcome: 1, steps: k, auto: false });
        expect(view.terminal!.payoutWei).toBe(refundWei(env.table, BET, 0, k).toString());
      }

      // And exactly one settlement reaches the chain.
      await env.container.relayer.drain();
      env.advance(1);
      await env.tick();
      await env.tick();
      expect(env.chain.sent).toHaveLength(1);
      expect(env.chain.games.get(game.gameId)!.status).toBe(ONCHAIN.Settled);
      await env.close();
    }
    env = await makeEnv();
  });

  it('twenty simultaneous cash-outs settle once', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    const replies = await Promise.all(
      Array.from({ length: 20 }, () => api.cashout(game.gameId, game.token, { step: 0 })),
    );
    expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
    for (const reply of replies.filter((candidate) => candidate.status !== 200)) {
      expect(codeOf(reply)).toBe('GAME_NOT_ACTIVE');
      expectNoState(reply);
    }
    expect(await endings(game.gameId)).toHaveLength(1);
    expect(env.signs.settlement).toBe(1);

    await env.container.relayer.drain();
    for (let block = 0; block < 12; block++) {
      env.advance(1);
      await env.tick();
    }
    expect(env.chain.sent).toHaveLength(1);
  });

  it('X16: a losing move racing the idle auto cash-out', async () => {
    const hops: { micro: number; macro: number }[] = [
      ...Array.from({ length: 60 }, (_, micro) => ({ micro, macro: 0 })),
      ...Array.from({ length: 6 }, (_, index) => ({ micro: 0, macro: index + 1 })),
    ];
    let lostByMove = 0;
    let cashedOutByWorker = 0;

    for (const { micro, macro } of hops) {
      env = await makeEnv();
      const game = await openGame(env, { deadEnd: true });
      const route = deadEndRoute(game.maze);
      const k = route.length - 1;
      await walk(game, route.slice(0, k));

      // The move is in flight while the deadline passes and the worker's timeout pass runs.
      // The pass is called directly, so that it reaches the game while the move is still
      // between its deadline check and its write.
      const moving = api.move(game.gameId, game.token, { step: k, dir: route[k] });
      for (let i = 0; i < micro; i++) await Promise.resolve();
      for (let i = 0; i < macro; i++) await new Promise((resolve) => setImmediate(resolve));
      env.advance(env.table.timing.idleTimeoutSec);
      const [reply] = await Promise.all([moving, env.container.service.expireDue()]);
      await env.tick();

      const ended = await endings(game.gameId);
      expect(ended).toHaveLength(1);
      expect(env.signs.settlement).toBe(1);
      if (reply.status === 200) {
        lostByMove += 1;
        expect((reply.body as GameView).status).toBe('lost');
        expect(ended[0]).toEqual({ outcome: 2, steps: k + 1, auto: false });
      } else {
        cashedOutByWorker += 1;
        expect(['DEADLINE_PASSED', 'GAME_NOT_ACTIVE']).toContain(codeOf(reply));
        expectNoState(reply);
        expect(ended[0]).toEqual({ outcome: 1, steps: k, auto: true });
      }
      await env.close();
    }
    // Both orders of the race were actually produced.
    expect(lostByMove).toBeGreaterThan(0);
    expect(cashedOutByWorker).toBeGreaterThan(0);
    env = await makeEnv();
  });

  it('simultaneous worker passes end an idle game once', async () => {
    env = await makeEnv();
    const game = await openGame(env);
    env.advance(env.table.timing.idleTimeoutSec);
    const { service } = env.container;
    await Promise.all([env.tick(), service.expireDue(), service.expireDue(), service.expireDue()]);
    expect(await endings(game.gameId)).toEqual([{ outcome: 1, steps: 0, auto: true }]);
    expect(env.signs.settlement).toBe(1);
  });
});
