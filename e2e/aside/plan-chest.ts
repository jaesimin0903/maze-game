// The offline chest planner of scenario 12 (plan-moves.ts --goal chest), kept apart from the
// command line so that it can be imported and tested (apps/web/test/server/chest-planner.test.ts).
//
// Given a game's maze and final seed (rebuilt offline from the game id through the test seed
// hook), it finds the shortest route from the start that passes at least one path chest and ends
// in a dead end that holds a chest, without passing the exit, and lists every chest of the maze.
// The chests come from the shared chest rule (@maze/shared chest.ts, rule 2), the one the server
// and the verify screen use.

import {
  CHEST_RULE_VERSION,
  chestAt,
  chestsOf,
  exitCell,
  neighbor,
  openDirs,
  START_CELL,
  type ChestKind,
  type Hex,
  type Maze,
} from '@maze/shared';

export interface PlannedChest {
  cell: number;
  x: number;
  y: number;
  kind: ChestKind;
  rewardBps: number;
}

/** A chest on the planned route, found by the move that makes `step` moves. */
export interface RouteChest extends PlannedChest {
  step: number;
}

export interface ChestPlan {
  /** Cells of the route, the start and the chest's dead end included. */
  cells: number[];
  /** The chest in the dead end the route ends in. */
  chest: PlannedChest;
  /** The path chests the route passes, in the order it enters them (at least one). */
  pathChests: RouteChest[];
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
 * The shortest route that passes at least one path chest and ends in a dead end holding a chest,
 * without passing the exit (ties: the lower cell number), or `null` when the maze has none.
 */
export function planChest(maze: Maze, finalSeed: Hex): ChestPlan | null {
  const w = maze.w;
  const at = (cell: number, kind: ChestKind, rewardBps: number): PlannedChest => ({
    cell,
    x: cell % w,
    y: Math.floor(cell / w),
    kind,
    rewardBps,
  });
  const parent = parents(maze);
  const exit = exitCell(maze);
  let best: Omit<ChestPlan, 'chests' | 'chestRule'> | null = null;
  for (let cell = 0; cell < maze.w * maze.h; cell++) {
    const chest = chestAt(finalSeed, maze, cell, CHEST_RULE_VERSION);
    if (chest === null || chest.kind !== 'dead-end' || parent[cell] === -1) continue;
    const cells = [cell];
    while (cells[0] !== START_CELL) cells.unshift(parent[cells[0]]);
    if (cells.includes(exit)) continue;
    const pathChests = cells.slice(1, -1).flatMap((on, i): RouteChest[] => {
      const found = chestAt(finalSeed, maze, on, CHEST_RULE_VERSION);
      return found === null ? [] : [{ ...at(on, found.kind, found.rewardBps), step: i + 1 }];
    });
    if (pathChests.length === 0) continue;
    if (best === null || cells.length < best.cells.length) {
      best = { cells, chest: at(cell, chest.kind, chest.rewardBps), pathChests };
    }
  }
  if (best === null) return null;
  return {
    ...best,
    chests: chestsOf(finalSeed, maze, CHEST_RULE_VERSION).map((chest) => at(chest.cell, chest.kind, chest.rewardBps)),
    chestRule: CHEST_RULE_VERSION,
  };
}
