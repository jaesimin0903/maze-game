// The offline chest planner of scenario 12 (plan-moves.ts --goal chest), kept apart from the
// command line so that it can be imported and tested (apps/web/test/server/chest-planner.test.ts).
//
// Given a game's maze and final seed (rebuilt offline from the game id through the test seed
// hook), it finds the shortest route from the start into a dead end that holds a chest, without
// passing the exit, and lists every chest of the maze. The chests come from the shared chest rule
// (@maze/shared chest.ts), the one the server and the verify screen use.

import {
  CHEST_RULE_VERSION,
  chestAt,
  chestsOf,
  exitCell,
  neighbor,
  openDirs,
  START_CELL,
  type Hex,
  type Maze,
} from '@maze/shared';

export interface PlannedChest {
  cell: number;
  x: number;
  y: number;
  rewardBps: number;
}

export interface ChestPlan {
  /** Cells of the route, the start and the chest's dead end included. */
  cells: number[];
  chest: PlannedChest;
  /** Every chest of the maze, in cell order. */
  chests: PlannedChest[];
  chestRule: number;
}

/** Parent of every cell on the way from the start (the maze is a tree), the start its own parent. */
function parents(maze: Maze): Int32Array {
  const parent = new Int32Array(maze.w * maze.h).fill(-1);
  parent[START_CELL] = START_CELL;
  const queue = [START_CELL];
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    for (const dir of openDirs(maze, cell)) {
      const next = neighbor(maze, cell, dir);
      if (next !== null && parent[next] === -1) {
        parent[next] = cell;
        queue.push(next);
      }
    }
  }
  return parent;
}

/**
 * The shortest route into a dead end holding a chest that does not pass the exit (ties: the
 * lower cell number), or `null` when every chest of the maze lies beyond the exit or there is none.
 */
export function planChest(maze: Maze, finalSeed: Hex): ChestPlan | null {
  const w = maze.w;
  const at = (cell: number, rewardBps: number): PlannedChest => ({ cell, x: cell % w, y: Math.floor(cell / w), rewardBps });
  const parent = parents(maze);
  const exit = exitCell(maze);
  let best: { cells: number[]; chest: PlannedChest } | null = null;
  for (let cell = 0; cell < maze.w * maze.h; cell++) {
    const chest = chestAt(finalSeed, maze, cell, CHEST_RULE_VERSION);
    if (chest === null || parent[cell] === -1) continue;
    const cells = [cell];
    while (cells[0] !== START_CELL) cells.unshift(parent[cells[0]]);
    if (cells.includes(exit)) continue;
    if (best === null || cells.length < best.cells.length) best = { cells, chest: at(cell, chest.rewardBps) };
  }
  if (best === null) return null;
  return {
    ...best,
    chests: chestsOf(finalSeed, maze, CHEST_RULE_VERSION).map((chest) => at(chest.cell, chest.rewardBps)),
    chestRule: CHEST_RULE_VERSION,
  };
}
