// What the console screen draws (plan §5.5 AC-W2). The screen is a (2n+1)² tile grid: maze cells
// on odd rows and columns, the wall or passage between two cells on the tiles between them.
// Everything is built from the cells the server has shown; a hidden cell and the walls around it
// stay fog.

import { DIR_BIT, type Dir, type Observation, type StartSide } from '@maze/shared';
import { adjacent, legalMoves } from './board-view';

export type TileKind = 'void' | 'cell' | 'fog' | 'near' | 'floor' | 'trail' | 'wall';

export interface Tile {
  kind: TileKind;
  /** The maze cell this tile draws, for tiles on odd rows and columns; `null` otherwise. */
  cell: number | null;
}

/** Sprite row of the hero, by `Dir` (N, E, S, W). */
export type Facing = 'U' | 'R' | 'D' | 'L';
export const FACING: readonly Facing[] = ['U', 'R', 'D', 'L'];

/** Why a move in some direction is not possible from the current cell. */
export type Blocked = 'wall' | 'visited' | 'edge';

/** Tiles per side of the screen for an `n × n` maze. */
export function screenCols(n: number): number {
  return 2 * n + 1;
}

/** Position and size of a maze cell on the screen, as percentages of the screen side. */
export function cellBox(n: number, cell: number): { left: string; top: string; size: string } {
  const cols = screenCols(n);
  const pct = (tiles: number): string => `${((tiles * 100) / cols).toFixed(4)}%`;
  return { left: pct(2 * (cell % n) + 1), top: pct(2 * Math.floor(cell / n) + 1), size: pct(1) };
}

/**
 * Before a game: the grid of cells (so the size reads at a glance), the start and the exit. When
 * the client seed picks the start side, the start cell is walled in on every other side, so the
 * one way out shows before the bet.
 */
export function readyTiles(n: number, side: StartSide | null = null): Tile[] {
  const cols = screenCols(n);
  const tiles: Tile[] = [];
  for (let ty = 0; ty < cols; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      if (tx % 2 === 1 && ty % 2 === 1) {
        const cell = ((ty - 1) / 2) * n + (tx - 1) / 2;
        tiles.push({ kind: cell === 0 || cell === n * n - 1 ? 'floor' : 'cell', cell });
      } else if (side !== null && tx <= 2 && ty <= 2) {
        // The ring around the start cell (tiles 0..2 on both axes): the picked side is open.
        const open = (side === 'E' && tx === 2 && ty === 1) || (side === 'S' && tx === 1 && ty === 2);
        tiles.push({ kind: open ? 'floor' : 'wall', cell: null });
      } else {
        tiles.push({ kind: 'void', cell: null });
      }
    }
  }
  return tiles;
}

/** How the hero faces at the start: toward the start's opening. */
export function startFacing(side: StartSide | null): Facing {
  return side === 'E' ? 'R' : 'D';
}

/**
 * During and after a game. Visited cells are floor (trail behind the player), the passage between
 * two visited cells is trail, an opening out of a visited cell is floor, every other side of a
 * visited cell is wall. Cells the player may step into now are `near` when `showNear` is set. The
 * exit is always drawn as floor so the door has somewhere to stand.
 */
export function playTiles(n: number, observations: Observation[], showNear: boolean): Tile[] {
  const cols = screenCols(n);
  const open = new Map<number, number>();
  for (const o of observations) if (!open.has(o.cell)) open.set(o.cell, o.open);
  const current = observations.at(-1)?.cell ?? null;
  const near = new Set<number>();
  if (showNear && current !== null) {
    for (const dir of legalMoves(n, observations)) {
      const target = adjacent(n, current, dir);
      if (target !== null) near.add(target);
    }
  }
  const known = (cell: number): boolean => cell >= 0 && open.has(cell);

  const tiles: Tile[] = [];
  for (let ty = 0; ty < cols; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const oddX = tx % 2 === 1;
      const oddY = ty % 2 === 1;
      if (oddX && oddY) {
        const cell = ((ty - 1) / 2) * n + (tx - 1) / 2;
        const kind: TileKind = known(cell)
          ? cell === current
            ? 'floor'
            : 'trail'
          : near.has(cell)
            ? 'near'
            : cell === n * n - 1
              ? 'floor'
              : 'fog';
        tiles.push({ kind, cell });
      } else if (oddX !== oddY) {
        // Between cell `a` (left or above) and cell `b` (right or below); -1 is outside the grid.
        let a: number;
        let b: number;
        let towardB: number;
        let towardA: number;
        if (!oddX) {
          const y = (ty - 1) / 2;
          const left = tx / 2 - 1;
          const right = tx / 2;
          a = left >= 0 ? y * n + left : -1;
          b = right < n ? y * n + right : -1;
          towardB = DIR_BIT[1];
          towardA = DIR_BIT[3];
        } else {
          const x = (tx - 1) / 2;
          const up = ty / 2 - 1;
          const down = ty / 2;
          a = up >= 0 ? up * n + x : -1;
          b = down < n ? down * n + x : -1;
          towardB = DIR_BIT[2];
          towardA = DIR_BIT[0];
        }
        const knownA = known(a);
        const knownB = known(b);
        if (!knownA && !knownB) {
          tiles.push({ kind: 'fog', cell: null });
          continue;
        }
        const passable = knownA ? b >= 0 && (open.get(a)! & towardB) !== 0 : a >= 0 && (open.get(b)! & towardA) !== 0;
        tiles.push({ kind: passable ? (knownA && knownB ? 'trail' : 'floor') : 'wall', cell: null });
      } else {
        // A corner post stands wherever a known cell touches it.
        let wall = false;
        for (const [dx, dy] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ] as const) {
          const x = (tx + dx - 1) / 2;
          const y = (ty + dy - 1) / 2;
          if (x >= 0 && y >= 0 && x < n && y < n && known(y * n + x)) {
            wall = true;
            break;
          }
        }
        tiles.push({ kind: wall ? 'wall' : 'fog', cell: null });
      }
    }
  }
  return tiles;
}

/**
 * The way the hero faces: the direction of the last move, or, before the first move, down when
 * the start cell opens south and right otherwise.
 */
export function facingOf(observations: Observation[], moves: readonly Dir[]): Facing {
  const last = moves.at(-1);
  if (last !== undefined) return FACING[last];
  const start = observations[0];
  if (start === undefined) return 'D';
  return (start.open & DIR_BIT[2]) !== 0 ? 'D' : 'R';
}

/** Why `dir` is not a legal move from the current cell, or `null` when it is. */
export function blockedReason(n: number, observations: Observation[], dir: Dir): Blocked | null {
  const current = observations.at(-1);
  if (!current) return null;
  const target = adjacent(n, current.cell, dir);
  if (target === null) return 'edge';
  if ((current.open & DIR_BIT[dir]) === 0) return 'wall';
  if (observations.some((o) => o.cell === target)) return 'visited';
  return null;
}
