// AC-X3: the move handler reads the maze at the arrival cell only. The maze handed to the
// server records every read of `maze.open`; nothing else can observe unvisited cells.
// AC-P4: the chest rule is asked about the cell an accepted move enters and about no other cell,
// with the kind that cell's own open mask gives it; nothing else ever asks.

import { chestKindOf, generateMaze, type ChestKind, type Dir, type Maze } from '@maze/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  cellsOf,
  deadEndRoute,
  exitRoute,
  makeEnv,
  openGame,
  outDir,
  wallDir,
  type TestEnv,
} from './helpers';

const BASE: Maze = generateMaze(`0x${'3c'.repeat(32)}`, 5);

interface Recording {
  maze: Maze;
  /** Cell indices read through `maze.open[cell]`, in order. */
  reads: number[];
  /** Any other property read from `maze.open` (`length`, methods, ...). */
  others: string[];
}

function recording(base: Maze): Recording {
  const reads: number[] = [];
  const others: string[] = [];
  const open = new Proxy(base.open, {
    get(target, property) {
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        reads.push(Number(property));
        return target[Number(property)];
      }
      others.push(String(property));
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { maze: { w: base.w, h: base.h, open }, reads, others };
}

let env: TestEnv;

afterEach(async () => {
  await env.close();
});

interface ChestCall {
  cell: number;
  kind: ChestKind;
}

async function setup(
  chestCalls: ChestCall[] = [],
): Promise<{ rec: Recording; built: () => number; gameId: string; token: string }> {
  const rec = recording(BASE);
  let built = 0;
  env = await makeEnv({
    mazeFactory: () => {
      built += 1;
      return rec.maze;
    },
    // Every cell the chest rule is asked about. A chest everywhere, so an award is always possible.
    chestDraw: (_finalSeed, cell, kind) => {
      chestCalls.push({ cell, kind });
      return { placed: true, rewardBps: 1000 };
    },
  });
  const game = await openGame(env);
  return { rec, built: () => built, gameId: game.gameId, token: game.token };
}

function drain(rec: Recording): number[] {
  return rec.reads.splice(0, rec.reads.length);
}

describe('AC-X3: maze access', () => {
  it('creating the game reads the start cell only, and start reads nothing', async () => {
    const { rec, built, gameId, token } = await setup();
    expect(built()).toBe(1);
    expect(new Set(drain(rec))).toEqual(new Set([0]));

    expect((await api.start(gameId, token)).status).toBe(200);
    expect((await api.game(gameId, token)).status).toBe(200);
    expect(drain(rec)).toEqual([]);
  });

  it('every move up to the exit reads the arrival cell and no other', async () => {
    const { rec, built, gameId, token } = await setup();
    drain(rec);
    const route = exitRoute(BASE);
    const cells = cellsOf(BASE, route);

    for (let k = 0; k < route.length; k++) {
      const here = cells[k];
      // Refused requests read nothing at all.
      const refused = [
        await api.move(gameId, token, { step: k, dir: outDir(BASE, here) ?? 9 }),
        await api.move(gameId, token, { step: k, dir: wallDir(BASE, here) ?? 9 }),
        await api.move(gameId, token, { step: k + 1, dir: route[k] }),
        await api.move(gameId, 'wrong-token', { step: k, dir: route[k] }),
        ...(k > 0 ? [await api.move(gameId, token, { step: k, dir: ((route[k - 1] + 2) % 4) as Dir })] : []),
      ];
      for (const reply of refused) expect(reply.status).toBeGreaterThanOrEqual(400);
      expect((await api.game(gameId, token)).status).toBe(200);
      expect(drain(rec)).toEqual([]);

      const reply = await api.move(gameId, token, { step: k, dir: route[k] });
      expect(reply.status).toBe(200);
      const read = drain(rec);
      expect(read.length).toBeGreaterThan(0);
      expect(new Set(read)).toEqual(new Set([cells[k + 1]]));
    }

    expect((await api.game<{ status: string }>(gameId, token)).body.status).toBe('won');
    expect(drain(rec)).toEqual([]);
    // The maze was built once, when the game appeared on chain, and never by a request.
    expect(built()).toBe(1);
    expect(rec.others).toEqual([]);
  });

  it('a losing move reads the dead end only, and a cash-out reads nothing', async () => {
    const first = await setup();
    drain(first.rec);
    const route = deadEndRoute(BASE);
    const cells = cellsOf(BASE, route);
    for (let k = 0; k < route.length; k++) {
      const reply = await api.move<{ status: string }>(first.gameId, first.token, {
        step: k,
        dir: route[k],
      });
      expect(reply.status).toBe(200);
      expect(new Set(drain(first.rec))).toEqual(new Set([cells[k + 1]]));
      expect(reply.body.status).toBe(k === route.length - 1 ? 'lost' : 'active');
    }
    await env.close();

    const second = await setup();
    drain(second.rec);
    await api.move(second.gameId, second.token, { step: 0, dir: route[0] });
    drain(second.rec);
    expect((await api.cashout(second.gameId, second.token, { step: 1 })).status).toBe(200);
    env.advance(1);
    await env.tick();
    expect((await api.game(second.gameId, second.token)).status).toBe(200);
    expect(drain(second.rec)).toEqual([]);
    expect(second.rec.others).toEqual([]);
  });

  it('the idle auto cash-out reads nothing', async () => {
    const { rec, gameId, token } = await setup();
    await api.move(gameId, token, { step: 0, dir: exitRoute(BASE)[0] });
    drain(rec);
    env.advance(env.table.timing.idleTimeoutSec);
    await env.tick();
    expect((await api.game<{ status: string }>(gameId, token)).body.status).toBe('cashed_out');
    expect(drain(rec)).toEqual([]);
  });
});

describe('AC-P4: chest access', () => {
  it('AC-P4 every move up to the exit asks the chest rule about the cell it enters and no other; creating, starting, reading and refused moves never ask', async () => {
    const calls: ChestCall[] = [];
    const { gameId, token } = await setup(calls);
    expect((await api.start(gameId, token)).status).toBe(200);
    const route = exitRoute(BASE);
    const cells = cellsOf(BASE, route);
    for (let k = 0; k < route.length; k++) {
      await api.move(gameId, token, { step: k, dir: wallDir(BASE, cells[k]) ?? 9 });
      await api.move(gameId, token, { step: k + 1, dir: route[k] });
      await api.move(gameId, 'wrong-token', { step: k, dir: route[k] });
      await api.game(gameId, token);
      // Refused requests and reads ask nothing.
      expect(calls).toHaveLength(k);
      expect((await api.move(gameId, token, { step: k, dir: route[k] })).status).toBe(200);
      // An accepted move asks about its arrival only; the exit holds no chest and is not asked about.
      const arrival = cells[k + 1];
      expect(calls.slice(k)).toEqual(k === route.length - 1 ? [] : [{ cell: arrival, kind: chestKindOf(BASE, arrival) }]);
    }
    expect((await api.game<{ status: string }>(gameId, token)).body.status).toBe('won');
    expect(calls).toEqual(cells.slice(1, -1).map((cell) => ({ cell, kind: 'path' })));
  });

  it('AC-P4 the move into a dead end asks about that cell once, as a dead end; a cash-out and an idle auto cash-out never ask', async () => {
    const calls: ChestCall[] = [];
    const first = await setup(calls);
    const route = deadEndRoute(BASE);
    const cells = cellsOf(BASE, route);
    for (let k = 0; k < route.length; k++) {
      expect(calls).toHaveLength(k);
      await api.move(first.gameId, first.token, { step: k, dir: route[k] });
    }
    expect(calls).toEqual(
      cells.slice(1).map((cell, i) => ({ cell, kind: i === route.length - 1 ? 'dead-end' : 'path' })),
    );
    await api.game(first.gameId, first.token);
    expect(calls).toHaveLength(route.length);
    await env.close();

    const cashCalls: ChestCall[] = [];
    const second = await setup(cashCalls);
    await api.move(second.gameId, second.token, { step: 0, dir: route[0] });
    expect((await api.cashout(second.gameId, second.token, { step: 1 })).status).toBe(200);
    expect(cashCalls).toEqual([{ cell: cells[1], kind: chestKindOf(BASE, cells[1]) }]);
    await env.close();

    const idleCalls: ChestCall[] = [];
    const third = await setup(idleCalls);
    await api.move(third.gameId, third.token, { step: 0, dir: route[0] });
    env.advance(env.table.timing.idleTimeoutSec);
    await env.tick();
    expect((await api.game<{ status: string }>(third.gameId, third.token)).body.status).toBe('cashed_out');
    expect(idleCalls).toEqual([{ cell: cells[1], kind: chestKindOf(BASE, cells[1]) }]);
  });

  it('AC-P4 the chest rule is asked about the arrival only: no maze read beyond the arrival, whatever the chests', async () => {
    const calls: ChestCall[] = [];
    const { rec, gameId, token } = await setup(calls);
    drain(rec);
    const route = exitRoute(BASE);
    const cells = cellsOf(BASE, route);
    for (let k = 0; k < route.length - 1; k++) {
      const reply = await api.move<{ chests: { cell: { x: number; y: number } }[] }>(gameId, token, { step: k, dir: route[k] });
      expect(new Set(drain(rec))).toEqual(new Set([cells[k + 1]]));
      // Every chest the answer lists stands on a cell already entered.
      const entered = new Set(cells.slice(1, k + 2));
      expect(reply.body.chests.every((chest) => entered.has(chest.cell.y * BASE.w + chest.cell.x))).toBe(true);
      expect(reply.body.chests).toHaveLength(k + 1);
    }
    expect(calls.map((call) => call.cell)).toEqual(cells.slice(1, -1));
    expect(rec.others).toEqual([]);
  });
});
