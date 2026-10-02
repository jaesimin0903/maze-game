// Maze generation and inspection (plan §3.4, `mazeVersion = 1`).
//
// Cells are numbered `y * w + x`; x grows east, y grows south. The start is cell 0 (top-left)
// and the exit is the last cell (bottom-right). `open[cell]` is a bitmask of the directions
// that have a passage: N = 1, E = 2, S = 4, W = 8.

import { seedRng, type Rng } from './rng';
import { DIR_BIT, type Dir, type Hex, type Maze } from './types';

/** Column and row offsets, indexed by `Dir` (N, E, S, W). */
const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;
const DIRS: readonly Dir[] = [0, 1, 2, 3];

export const START_CELL = 0;

export function exitCell(maze: Maze): number {
  return maze.w * maze.h - 1;
}

function assertCell(maze: Maze, cell: number): void {
  if (!Number.isInteger(cell) || cell < 0 || cell >= maze.w * maze.h) {
    throw new RangeError(`cell ${cell} is outside the ${maze.w}x${maze.h} grid`);
  }
}

/** The maze of a game: an `n × n` grid driven by the production stream of `finalSeed`. */
export function generateMaze(finalSeed: Hex, n: number): Maze {
  return generateGridFromRng(seedRng(finalSeed), n, n);
}

/**
 * Uniform spanning tree of the `w × h` grid conditioned on the start cell having exactly one
 * opening (the "start corridor"), drawn with Wilson's algorithm.
 *
 * 1. `b = nextBelow(2)`: `b = 0` deletes the start cell's east edge, `b = 1` its south edge.
 * 2. The exit cell is the initial tree. For each cell in index order that is not yet in the
 *    tree, a loop-erased random walk runs from it until it reaches the tree and is then added.
 *    Every step draws `nextBelow(4)` (N, E, S, W); a direction that leaves the grid or crosses
 *    the deleted edge is redrawn.
 */
export function generateGridFromRng(rng: Rng, w: number, h: number): Maze {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w > 255 || h > 255) {
    throw new RangeError(`maze size must be integers in 2 .. 255, got ${w}x${h}`);
  }
  const cells = w * h;
  const open = new Uint8Array(cells);
  const inTree = new Uint8Array(cells);
  // Direction of the most recent step out of each cell; following these from the walk's first
  // cell traces the loop-erased path.
  const lastExit = new Uint8Array(cells);
  const offset = [-w, 1, w, -1];

  // The deleted edge joins the start cell and `blocked`.
  const blocked = rng.nextBelow(2) === 0 ? 1 : w;

  inTree[cells - 1] = 1;
  for (let first = 0; first < cells; first++) {
    if (inTree[first] === 1) continue;

    let cell = first;
    let x = first % w;
    let y = (first - x) / w;
    while (inTree[cell] === 0) {
      const dir = rng.nextBelow(4);
      const nx = x + DX[dir];
      const ny = y + DY[dir];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const next = cell + offset[dir];
      if ((cell === START_CELL && next === blocked) || (next === START_CELL && cell === blocked)) {
        continue;
      }
      lastExit[cell] = dir;
      cell = next;
      x = nx;
      y = ny;
    }

    cell = first;
    while (inTree[cell] === 0) {
      const dir = lastExit[cell];
      const next = cell + offset[dir];
      open[cell] = open[cell] | DIR_BIT[dir];
      open[next] = open[next] | DIR_BIT[(dir + 2) & 3];
      inTree[cell] = 1;
      cell = next;
    }
  }
  return { w, h, open };
}

/** Open directions of `cell` in the order N, E, S, W. Reads only `maze.open[cell]`. */
export function openDirs(maze: Maze, cell: number): Dir[] {
  assertCell(maze, cell);
  const mask = maze.open[cell];
  return DIRS.filter((dir) => (mask & DIR_BIT[dir]) !== 0);
}

/**
 * The cell next to `cell` in direction `dir`, or `null` when that is outside the grid.
 * Purely geometric: it ignores walls and never reads `maze.open`.
 */
export function neighbor(maze: Maze, cell: number, dir: Dir): number | null {
  assertCell(maze, cell);
  const x = (cell % maze.w) + DX[dir];
  const y = Math.floor(cell / maze.w) + DY[dir];
  if (x < 0 || x >= maze.w || y < 0 || y >= maze.h) return null;
  return y * maze.w + x;
}

/**
 * Cells of the shortest start-to-exit path, both ends included. In a perfect maze this is the
 * only such path. Empty when the exit cannot be reached.
 */
export function solve(maze: Maze): number[] {
  const exit = exitCell(maze);
  const parent = new Int32Array(maze.w * maze.h).fill(-1);
  parent[START_CELL] = START_CELL;
  const queue = [START_CELL];
  for (let head = 0; head < queue.length && parent[exit] === -1; head++) {
    const cell = queue[head];
    for (const dir of openDirs(maze, cell)) {
      const next = neighbor(maze, cell, dir);
      if (next !== null && parent[next] === -1) {
        parent[next] = cell;
        queue.push(next);
      }
    }
  }
  if (parent[exit] === -1) return [];
  const path = [exit];
  while (path[path.length - 1] !== START_CELL) path.push(parent[path[path.length - 1]]);
  return path.reverse();
}

/**
 * True when the passages form a spanning tree of the grid: every opening stays inside the
 * grid and is matched on the other side, there are exactly `w * h - 1` passages, and every
 * cell is reachable from the start.
 */
export function isPerfect(maze: Maze): boolean {
  const cells = maze.w * maze.h;
  if (cells < 1 || maze.open.length !== cells) return false;
  let openings = 0;
  for (let cell = 0; cell < cells; cell++) {
    if (maze.open[cell] > 15) return false;
    for (const dir of openDirs(maze, cell)) {
      const next = neighbor(maze, cell, dir);
      if (next === null) return false;
      if ((maze.open[next] & DIR_BIT[(dir + 2) & 3]) === 0) return false;
      openings += 1;
    }
  }
  if (openings !== 2 * (cells - 1)) return false;

  const seen = new Uint8Array(cells);
  seen[START_CELL] = 1;
  const stack = [START_CELL];
  let reached = 1;
  while (stack.length > 0) {
    const cell = stack.pop()!;
    for (const dir of openDirs(maze, cell)) {
      const next = neighbor(maze, cell, dir)!;
      if (seen[next] === 0) {
        seen[next] = 1;
        reached += 1;
        stack.push(next);
      }
    }
  }
  return reached === cells;
}

/**
 * True when a player who arrived at `cell` from the adjacent cell `from` (`null` at the start)
 * has no way forward: `cell` is not the exit and has no opening other than the one leading
 * back to `from`. Reads only `maze.open[cell]`.
 */
export function isDeadEnd(maze: Maze, cell: number, from: number | null): boolean {
  assertCell(maze, cell);
  if (cell === exitCell(maze)) return false;
  for (const dir of openDirs(maze, cell)) {
    if (from === null || neighbor(maze, cell, dir) !== from) return false;
  }
  return true;
}
