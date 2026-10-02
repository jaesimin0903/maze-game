// AC-X2: non-interference. Two games whose mazes differ only in cells the player has not
// visited answer every request with byte-identical bodies. The clock is injected, so the time
// fields agree; the only thing normalized is the random game id.

import { generateMaze, type Dir, type Hex, type Maze } from '@maze/shared';
import { describe, expect, it } from 'vitest';
import {
  api,
  cellsOf,
  exitRoute,
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

/** Runs one fixed request script against a server whose game has `maze`. */
async function transcript(maze: Maze): Promise<string[]> {
  const env = await makeEnv({ mazeFactory: () => maze });
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
    return lines;
  } finally {
    await env.close();
  }
}

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
