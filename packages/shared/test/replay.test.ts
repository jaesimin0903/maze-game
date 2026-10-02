import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateMaze,
  openDirs,
  Outcome,
  replayMoves,
  solve,
  type Dir,
  type Hex,
  type Maze,
} from '../src';

// 0 1 2      passages: 0-3, 3-4, 4-1, 1-2, 4-5, 5-8, 3-6, 6-7
// 3 4 5      solution: 0 3 4 5 8; dead ends: 2 and 7
// 6 7 8
const HAND: Maze = { w: 3, h: 3, open: Uint8Array.from([4, 6, 8, 7, 11, 12, 3, 8, 1]) };
const N = 0;
const E = 1;
const S = 2;
const W = 3;

function seedOf(label: string): Hex {
  return `0x${createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

/** Directions that walk the given cell path. */
function dirsOf(path: number[], w: number): Dir[] {
  return path.slice(1).map((cell, i) => {
    const delta = cell - path[i];
    return delta === -w ? N : delta === 1 ? E : delta === w ? S : W;
  });
}

/** The unique tree path from the start to `target`. */
function pathTo(maze: Maze, target: number): number[] {
  const parent = new Map<number, number>([[0, 0]]);
  const queue = [0];
  for (const cell of queue) {
    for (const dir of openDirs(maze, cell)) {
      const next = cell + [-maze.w, 1, maze.w, -1][dir];
      if (!parent.has(next)) {
        parent.set(next, cell);
        queue.push(next);
      }
    }
  }
  const path = [target];
  while (path[0] !== 0) path.unshift(parent.get(path[0])!);
  return path;
}

describe('replayMoves', () => {
  it('a walk to the exit ends as Exit', () => {
    expect(replayMoves(HAND, [S, E, E, S])).toEqual({
      outcome: Outcome.Exit,
      steps: 4,
      path: [0, 3, 4, 5, 8],
      invalidAt: null,
    });
  });

  it('AC-R4 arriving at a cell with no way forward ends as Loss', () => {
    expect(replayMoves(HAND, [S, S, E])).toEqual({
      outcome: Outcome.Loss,
      steps: 3,
      path: [0, 3, 6, 7],
      invalidAt: null,
    });
    expect(replayMoves(HAND, [S, E, N, E])).toEqual({
      outcome: Outcome.Loss,
      steps: 4,
      path: [0, 3, 4, 1, 2],
      invalidAt: null,
    });
  });

  it('a walk that has not ended has no outcome', () => {
    expect(replayMoves(HAND, [])).toEqual({ outcome: null, steps: 0, path: [0], invalidAt: null });
    expect(replayMoves(HAND, [S, E])).toEqual({ outcome: null, steps: 2, path: [0, 3, 4], invalidAt: null });
  });

  it('cashOutAt = k ends the game as CashOut after exactly k moves, k = 0 included', () => {
    expect(replayMoves(HAND, [], 0)).toEqual({ outcome: Outcome.CashOut, steps: 0, path: [0], invalidAt: null });
    expect(replayMoves(HAND, [S, E], 2)).toEqual({
      outcome: Outcome.CashOut,
      steps: 2,
      path: [0, 3, 4],
      invalidAt: null,
    });
    // Not enough moves to reach the cash-out step: still in progress.
    expect(replayMoves(HAND, [S, E], 3).outcome).toBeNull();
    expect(replayMoves(HAND, [S, E], 3).invalidAt).toBeNull();
  });

  it('a move that ends the game takes precedence over a cash-out at the same step', () => {
    expect(replayMoves(HAND, [S, S, E], 3).outcome).toBe(Outcome.Loss);
    expect(replayMoves(HAND, [S, E, E, S], 4).outcome).toBe(Outcome.Exit);
  });

  it('a move after the game ended is invalid', () => {
    expect(replayMoves(HAND, [S, E, E, S, N])).toEqual({
      outcome: null,
      steps: 4,
      path: [0, 3, 4, 5, 8],
      invalidAt: 4,
    });
    expect(replayMoves(HAND, [S, S, E, W])).toMatchObject({ outcome: null, steps: 3, invalidAt: 3 });
    expect(replayMoves(HAND, [S, E, E], 2)).toEqual({
      outcome: null,
      steps: 2,
      path: [0, 3, 4],
      invalidAt: 2,
    });
    expect(replayMoves(HAND, [S], 0)).toMatchObject({ outcome: null, steps: 0, invalidAt: 0 });
  });

  it('AC-R5 a move into a wall, off the grid or onto a visited cell is invalid and changes nothing', () => {
    // Wall: east of the start, and south of cell 4.
    expect(replayMoves(HAND, [E])).toEqual({ outcome: null, steps: 0, path: [0], invalidAt: 0 });
    expect(replayMoves(HAND, [S, E, S])).toEqual({ outcome: null, steps: 2, path: [0, 3, 4], invalidAt: 2 });
    // Off the grid, with or without an (impossible) opening on that side.
    expect(replayMoves(HAND, [N])).toMatchObject({ steps: 0, invalidAt: 0 });
    const leaky: Maze = { w: 3, h: 3, open: Uint8Array.from([5, 6, 8, 7, 11, 12, 3, 8, 1]) };
    expect(replayMoves(leaky, [N])).toMatchObject({ outcome: null, steps: 0, invalidAt: 0 });
    // Backtracking onto the previous cell.
    expect(replayMoves(HAND, [S, N])).toEqual({ outcome: null, steps: 1, path: [0, 3], invalidAt: 1 });
    // Onto an earlier cell through a loop (only possible in a maze that is not perfect).
    const loop: Maze = { w: 3, h: 3, open: Uint8Array.from([6, 14, 8, 7, 11, 12, 3, 8, 1]) };
    expect(replayMoves(loop, [S, E, N, W])).toEqual({
      outcome: null,
      steps: 3,
      path: [0, 3, 4, 1],
      invalidAt: 3,
    });
  });

  it('a value that is not a direction is invalid', () => {
    for (const bad of [4, -1, 1.5, '1', null, undefined]) {
      expect(replayMoves(HAND, [S, bad as unknown as Dir])).toMatchObject({
        outcome: null,
        steps: 1,
        invalidAt: 1,
      });
    }
  });

  it('cashOutAt must be a non-negative integer', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => replayMoves(HAND, [], bad)).toThrow(RangeError);
    }
  });

  it('never reads the walls of a cell the walk has not entered', () => {
    const reads: number[] = [];
    const open = new Proxy(HAND.open, {
      get(target, property) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads.push(Number(property));
        return Reflect.get(target, property);
      },
    });
    const result = replayMoves({ w: 3, h: 3, open }, [S, E, N]);
    expect(result.path).toEqual([0, 3, 4, 1]);
    expect([...new Set(reads)].sort((a, b) => a - b)).toEqual([0, 1, 3, 4]);
  });

  it.each([5, 7, 9, 10])('n = %i: generated mazes replay to the outcome their structure dictates', (n) => {
    const exit = n * n - 1;
    for (let i = 0; i < 200; i++) {
      const maze = generateMaze(seedOf(`replay ${n} #${i}`), n);
      const solution = solve(maze);
      const moves = dirsOf(solution, n);

      expect(replayMoves(maze, moves)).toEqual({
        outcome: Outcome.Exit,
        steps: solution.length - 1,
        path: solution,
        invalidAt: null,
      });
      for (let k = 0; k < moves.length; k++) {
        expect(replayMoves(maze, moves.slice(0, k), k)).toMatchObject({
          outcome: Outcome.CashOut,
          steps: k,
          invalidAt: null,
        });
      }

      // Every leaf other than the exit is a loss, reached by the unique path to it,
      // unless that path runs through the exit (then the game ended there).
      for (let cell = 1; cell < exit; cell++) {
        if (openDirs(maze, cell).length !== 1) continue;
        const path = pathTo(maze, cell);
        const result = replayMoves(maze, dirsOf(path, n));
        if (path.includes(exit)) {
          expect(result.invalidAt).toBe(path.indexOf(exit));
        } else {
          expect(result).toEqual({ outcome: Outcome.Loss, steps: path.length - 1, path, invalidAt: null });
        }
      }
    }
  });
});
