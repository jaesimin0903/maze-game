// AC-X2: non-interference. Two games whose mazes differ only in cells the player has not
// visited answer every request with byte-identical bodies. The clock is injected, so the time
// fields agree; the only thing normalized is the random game id.
// AC-P4: the same holds when the chests differ as well: answers and log lines of a game in
// progress do not depend on where the chests are.

import { generateMaze, type ChestDraw, type Dir, type GameView, type Hex, type Maze } from '@maze/shared';
import { describe, expect, it } from 'vitest';
import {
  api,
  cellsOf,
  deadEndRoute,
  exitRoute,
  findDeadEndRoute,
  fixtureTable,
  makeEnv,
  openGame,
  outDir,
  wallDir,
  type Reply,
} from './helpers';

const N = 5;
const BASE: Maze = generateMaze(`0x${'07'.repeat(32)}`, N);
const ROUTE: Dir[] = exitRoute(BASE).slice(0, 3);
const VISITED: number[] = cellsOf(BASE, ROUTE);
const CLIENT_SEED: Hex = `0x${'c5'.repeat(32)}`;

/** `BASE` with the open mask of every cell outside `keep` replaced by `change(mask, cell)`. */
function variant(keep: readonly number[], change: (mask: number, cell: number) => number): Maze {
  const open = Uint8Array.from(BASE.open);
  for (let cell = 0; cell < open.length; cell++) {
    if (!keep.includes(cell)) open[cell] = change(open[cell], cell) & 15;
  }
  return { w: N, h: N, open };
}

/**
 * Runs one fixed request script against a server whose game has `maze`. With `chestDraw`, the
 * server's chests are those; with `logs`, the server's log lines (game id normalized) are
 * pushed there once the script has run.
 */
async function transcript(
  maze: Maze,
  options: { chestDraw?: (finalSeed: Hex, cell: number) => ChestDraw; logs?: string[] } = {},
): Promise<string[]> {
  const env = await makeEnv({ mazeFactory: () => maze, chestDraw: options.chestDraw });
  try {
    const game = await openGame(env, { clientSeed: CLIENT_SEED });
    const lines: string[] = [];
    const record = (label: string, reply: Reply): void => {
      lines.push(`${label} ${reply.status} ${reply.text.replaceAll(game.gameId, '<gameId>')}`);
    };
    const { gameId, token } = game;
    const wallAtStart = wallDir(BASE, 0)!;
    const outAtStart = outDir(BASE, 0)!;

    record('start', await api.start(gameId, token));
    record('read', await api.game(gameId, token));
    record('wall', await api.move(gameId, token, { step: 0, dir: wallAtStart }));
    record('bounds', await api.move(gameId, token, { step: 0, dir: outAtStart }));
    record('stale', await api.move(gameId, token, { step: 3, dir: ROUTE[0] }));
    record('unauthorized', await api.move(gameId, 'not-the-token', { step: 0, dir: ROUTE[0] }));
    record('bad-request', await api.move(gameId, token, { step: 0, dir: 7 }));

    record('move-1', await api.move(gameId, token, { step: 0, dir: ROUTE[0] }));
    record('read', await api.game(gameId, token));
    env.advance(7);
    record('move-2', await api.move(gameId, token, { step: 1, dir: ROUTE[1] }));
    record('visited', await api.move(gameId, token, { step: 2, dir: ((ROUTE[1] + 2) % 4) as Dir }));
    record('restart', await api.start(gameId, token));
    env.advance(31);
    record('move-3', await api.move(gameId, token, { step: 2, dir: ROUTE[2] }));
    record('read', await api.game(gameId, token));
    record('not-revealable', await api.reveal(gameId));

    env.advance(fixtureTable.timing.idleTimeoutSec);
    record('deadline', await api.move(gameId, token, { step: 3, dir: ROUTE[0] }));
    record('deadline', await api.cashout(gameId, token, { step: 3 }));
    record('read', await api.game(gameId, token));
    // The fake chain gives every transaction a random hash; like the game id, it is normalized.
    options.logs?.push(
      ...env.logs.map((line) =>
        JSON.stringify({ ...line, txHash: line.txHash === null ? null : '<tx>' }).replaceAll(gameId, '<gameId>'),
      ),
    );
    return lines;
  } finally {
    await env.close();
  }
}

/** Chest draws from a small generator: which cells hold a chest, and their rewards, vary with `seed`. */
function randomChests(seed: number, asked: number[] = []): (finalSeed: Hex, cell: number) => ChestDraw {
  return (_finalSeed, cell) => {
    asked.push(cell);
    const mix = (Math.imul(seed ^ (cell * 0x9e3779b1), 0x85ebca6b) >>> 0) ^ (seed >>> 3);
    return { placed: (mix & 1) === 1, rewardBps: 1000 + (mix % 2001) };
  };
}

const NO_CHESTS = (): ChestDraw => ({ placed: false, rewardBps: 1000 });

describe('AC-X2: responses do not depend on unvisited cells', () => {
  it('start, move, resume and error bodies are byte-identical for two such mazes', async () => {
    const flipped = variant(VISITED, (mask) => mask ^ 15);
    expect(Array.from(flipped.open)).not.toEqual(Array.from(BASE.open));

    const a = await transcript(BASE);
    const b = await transcript(flipped);
    expect(b).toEqual(a);

    // The script really exercised what it claims to.
    expect(a).toHaveLength(18);
    expect(a.filter((line) => / 200 /.test(line))).toHaveLength(8);
    for (const code of [
      'INVALID_MOVE_WALL',
      'INVALID_MOVE_BOUNDS',
      'INVALID_MOVE_VISITED',
      'STALE_STEP',
      'UNAUTHORIZED',
      'BAD_REQUEST',
      'NOT_REVEALABLE',
      'DEADLINE_PASSED',
    ]) {
      expect(a.some((line) => line.includes(`"code":"${code}"`))).toBe(true);
    }
  });

  it('holds for arbitrary contents of the unvisited cells', async () => {
    const a = await transcript(BASE);
    let state = 0x2545f491;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state >>> 28;
    };
    for (let round = 0; round < 12; round++) {
      expect(await transcript(variant(VISITED, () => next()))).toEqual(a);
    }
  });

  it('negative control: a difference in a visited cell does change the responses', async () => {
    const a = await transcript(BASE);
    // Close nothing the script walks through: add an opening to the second visited cell.
    const cell = VISITED[2];
    const spare = ([0, 1, 2, 3] as const).find((dir) => (BASE.open[cell] & (1 << dir)) === 0)!;
    const changed = variant(
      VISITED.filter((visited) => visited !== cell),
      (mask, at) => (at === cell ? mask | (1 << spare) : mask),
    );
    // Only that one cell differs.
    expect(Array.from(changed.open).filter((mask, at) => mask !== BASE.open[at])).toHaveLength(1);
    expect(await transcript(changed)).not.toEqual(a);
  });
});

describe('AC-P4: responses and log lines of a game in progress do not depend on the chests', () => {
  it('AC-P4 two games that differ only in chest placement and unvisited walls give byte-identical transcripts and log lines', async () => {
    const baseLogs: string[] = [];
    const base = await transcript(BASE, { chestDraw: NO_CHESTS, logs: baseLogs });
    expect(base).toHaveLength(18);
    expect(baseLogs.length).toBeGreaterThan(5);

    let state = 0x1b873593;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state >>> 28;
    };
    for (let round = 0; round < 10; round++) {
      const asked: number[] = [];
      const logs: string[] = [];
      const lines = await transcript(variant(VISITED, () => next()), {
        chestDraw: randomChests(0x2545f491 + round, asked),
        logs,
      });
      expect(lines).toEqual(base);
      expect(logs).toEqual(baseLogs);
      // Not a single question about a chest was asked while the game was in progress.
      expect(asked).toEqual([]);
    }
  });

  it('AC-P4 negative control: only the answer to the move into a dead end shows whether it held a chest', async () => {
    // A maze of this seed family whose shortest dead-end route is at least two moves long.
    let maze: Maze | null = null;
    for (let seed = 1; maze === null; seed++) {
      const candidate = generateMaze(`0x${seed.toString(16).padStart(64, '0')}`, 5);
      const route = findDeadEndRoute(candidate);
      if (route !== null && route.length >= 2) maze = candidate;
    }
    const route = deadEndRoute(maze);
    const play = async (draw: (finalSeed: Hex, cell: number) => ChestDraw): Promise<{ inGame: string[]; last: GameView }> => {
      const env = await makeEnv({ mazeFactory: () => maze, chestDraw: draw });
      try {
        const game = await openGame(env, { clientSeed: CLIENT_SEED });
        const inGame: string[] = [];
        for (let k = 0; k < route.length - 1; k++) {
          const reply = await api.move(game.gameId, game.token, { step: k, dir: route[k] });
          inGame.push(reply.text.replaceAll(game.gameId, '<gameId>'));
        }
        const read = await api.game(game.gameId, game.token);
        inGame.push(read.text.replaceAll(game.gameId, '<gameId>'));
        const last = await api.move<GameView>(game.gameId, game.token, { step: route.length - 1, dir: route.at(-1) });
        return { inGame, last: last.body };
      } finally {
        await env.close();
      }
    };
    const withChest = await play(() => ({ placed: true, rewardBps: 2222 }));
    const without = await play(NO_CHESTS);
    expect(withChest.inGame).toEqual(without.inGame);
    expect(withChest.last.terminal?.chest).toMatchObject({ rewardBps: 2222 });
    expect(without.last.terminal?.chest).toBeNull();
  });
});
