// Replaying a recorded game over a maze (plan §7.1).

import { exitCell, isDeadEnd, neighbor, START_CELL } from './maze';
import { DIR_BIT, Outcome, type Dir, type Maze } from './types';

export interface ReplayResult {
  /** How the walk ended, or `null` when it is still in progress or the record is invalid. */
  outcome: Outcome | null;
  /** Valid moves applied. */
  steps: number;
  /** Cells visited in order, starting with the start cell; `path[k]` is the cell after `k` moves. */
  path: number[];
  /** Index into `moves` of the first move that could not be applied, or `null`. */
  invalidAt: number | null;
}

/** The cell reached from `cell` through its open side `dir`, or `null` when there is none. */
function through(maze: Maze, cell: number, dir: Dir): number | null {
  const isDir = dir === 0 || dir === 1 || dir === 2 || dir === 3;
  return isDir && (maze.open[cell] & DIR_BIT[dir]) !== 0 ? neighbor(maze, cell, dir) : null;
}

/**
 * Walks `moves` from the start cell under the game rules: a move must go through an open side
 * to a cell not visited before. Arriving at the exit ends the game as `Exit`; arriving at any
 * other cell with no way forward ends it as `Loss`. `cashOutAt = k` means the player cashed out
 * after exactly `k` moves, which ends the game as `CashOut` unless move `k` already ended it.
 *
 * A move through a wall, off the grid, onto a visited cell, with a value that is not a
 * direction, or made after the game ended is invalid: the walk stops there, `invalidAt` is its
 * index and `outcome` is `null`.
 */
export function replayMoves(maze: Maze, moves: Dir[], cashOutAt?: number): ReplayResult {
  if (cashOutAt !== undefined && (!Number.isInteger(cashOutAt) || cashOutAt < 0)) {
    throw new RangeError(`cashOutAt must be a non-negative integer, got ${cashOutAt}`);
  }
  const exit = exitCell(maze);
  const visited = new Uint8Array(maze.w * maze.h);
  visited[START_CELL] = 1;
  const path = [START_CELL];
  let cell = START_CELL;
  let outcome: Outcome | null = cashOutAt === 0 ? Outcome.CashOut : null;

  for (let i = 0; i < moves.length; i++) {
    const next = outcome === null ? through(maze, cell, moves[i]) : null;
    if (next === null || visited[next] === 1) {
      return { outcome: null, steps: path.length - 1, path, invalidAt: i };
    }
    visited[next] = 1;
    path.push(next);
    const from = cell;
    cell = next;
    if (cell === exit) outcome = Outcome.Exit;
    else if (isDeadEnd(maze, cell, from)) outcome = Outcome.Loss;
    else if (cashOutAt === path.length - 1) outcome = Outcome.CashOut;
  }
  return { outcome, steps: path.length - 1, path, invalidAt: null };
}
