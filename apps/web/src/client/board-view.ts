// What the board may draw (plan §5.5 AC-W2). Built only from the cells the server has shown:
// visited cells and the current cell carry their walls, every other cell is hidden.

import { DIR_BIT, type Dir, type Observation } from '@maze/shared';

export type CellState = 'current' | 'visited' | 'hidden';

export interface CellView {
  x: number;
  y: number;
  cell: number;
  state: CellState;
  /** Open-direction bitmask, or `null` for a cell the player has not been to. */
  open: number | null;
  start: boolean;
  exit: boolean;
  /** For a hidden cell the player may step into now: the direction that leads there. */
  via: Dir | null;
}

export const DIRS: readonly Dir[] = [0, 1, 2, 3];
export const DIR_NAMES = ['N', 'E', 'S', 'W'] as const;

const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;

/** The cell next to `cell` in direction `dir`, or `null` outside the grid. */
export function adjacent(n: number, cell: number, dir: Dir): number | null {
  const x = (cell % n) + DX[dir];
  const y = Math.floor(cell / n) + DY[dir];
  return x < 0 || x >= n || y < 0 || y >= n ? null : y * n + x;
}

/**
 * Directions the player may move in from the latest observed cell: through an open side, inside
 * the grid, to a cell not visited before. Empty before the first observation.
 */
export function legalMoves(n: number, observations: Observation[]): Dir[] {
  const current = observations.at(-1);
  if (!current) return [];
  const visited = new Set(observations.map((o) => o.cell));
  return DIRS.filter((dir) => {
    if ((current.open & DIR_BIT[dir]) === 0) return false;
    const target = adjacent(n, current.cell, dir);
    return target !== null && !visited.has(target);
  });
}

/** Every cell of the `n × n` board in row order (`y * n + x`). */
export function boardCells(n: number, observations: Observation[]): CellView[] {
  const seen = new Map<number, number>();
  for (const o of observations) if (!seen.has(o.cell)) seen.set(o.cell, o.open);
  const current = observations.at(-1)?.cell ?? null;

  const via = new Map<number, Dir>();
  if (current !== null) {
    for (const dir of legalMoves(n, observations)) {
      const target = adjacent(n, current, dir);
      if (target !== null) via.set(target, dir);
    }
  }

  const cells: CellView[] = [];
  for (let cell = 0; cell < n * n; cell++) {
    const open = seen.get(cell);
    cells.push({
      x: cell % n,
      y: Math.floor(cell / n),
      cell,
      state: cell === current ? 'current' : open !== undefined ? 'visited' : 'hidden',
      open: open ?? null,
      start: cell === 0,
      exit: cell === n * n - 1,
      via: via.get(cell) ?? null,
    });
  }
  return cells;
}
