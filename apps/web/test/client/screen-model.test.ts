// What the console screen draws (AC-W2): a (2n+1)² tile grid built only from the cells the
// server has shown, the way the hero faces, and why a direction cannot be taken.

import { describe, expect, it } from 'vitest';
import {
  DIR_BIT,
  deriveFinalSeed,
  generateMaze,
  solve,
  type Dir,
  type Maze,
  type Observation,
} from '@maze/shared';
import { adjacent, legalMoves } from '../../src/client/board-view';
import {
  FACING,
  blockedReason,
  cellBox,
  dirOfFacing,
  facingOf,
  playTiles,
  readyTiles,
  screenCols,
  startFacing,
  type Tile,
  type TileKind,
} from '../../src/client/screen-model';
import { CLIENT_SEED, SERVER_SEED, firstGameId } from './helpers';

const N = 1;
const E = 2;
const S = 4;
const W = 8;

/** The tile at tile column `tx`, row `ty` of an `n × n` screen. */
const at = (tiles: Tile[], n: number, tx: number, ty: number): Tile => tiles[ty * screenCols(n) + tx];
/** The tile drawing maze cell `cell`. */
const cellTile = (tiles: Tile[], n: number, cell: number): Tile =>
  at(tiles, n, 2 * (cell % n) + 1, 2 * Math.floor(cell / n) + 1);

/** A 3×3 walk (0,0) -> (1,0): the start opens east, (1,0) opens west and south. */
const WALK: Observation[] = [
  { step: 0, cell: 0, open: E },
  { step: 1, cell: 1, open: W | S },
];

/**
 * A 3×3 walk along the top row and back along the middle one, ending at (1,1), which opens east
 * (visited) and west (to the hidden (0,1)).
 */
const BACK: Observation[] = [
  { step: 0, cell: 0, open: E },
  { step: 1, cell: 1, open: W | E },
  { step: 2, cell: 2, open: W | S },
  { step: 3, cell: 5, open: N | W },
  { step: 4, cell: 4, open: E | W },
];

function realMaze(n: number): Maze {
  return generateMaze(deriveFinalSeed({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, gameId: firstGameId }), n);
}

describe('screen geometry', () => {
  it('has 2n+1 tiles a side and places every cell on the odd rows and columns', () => {
    expect(screenCols(5)).toBe(11);
    expect(screenCols(10)).toBe(21);
    expect(cellBox(5, 0)).toEqual({ left: '9.0909%', top: '9.0909%', size: '9.0909%' });
    // (4,4) of a 5×5 maze: tile column and row 9 of 11.
    expect(cellBox(5, 24)).toEqual({ left: '81.8182%', top: '81.8182%', size: '9.0909%' });
    expect(cellBox(5, 7)).toEqual({ left: '45.4545%', top: '27.2727%', size: '9.0909%' });
  });
});

describe('readyTiles', () => {
  it('before a game: the grid of cells, the start and exit as floor, nothing between the cells', () => {
    for (const n of [3, 5, 7]) {
      const tiles = readyTiles(n);
      const cols = screenCols(n);
      expect(tiles).toHaveLength(cols * cols);
      const cells = tiles.filter((tile) => tile.cell !== null).map((tile) => tile.cell);
      expect(cells).toEqual([...Array(n * n).keys()]);
      tiles.forEach((tile, index) => {
        const tx = index % cols;
        const ty = Math.floor(index / cols);
        if (tx % 2 === 1 && ty % 2 === 1) {
          expect(tile.cell).toBe(((ty - 1) / 2) * n + (tx - 1) / 2);
          expect(tile.kind).toBe(tile.cell === 0 || tile.cell === n * n - 1 ? 'floor' : 'cell');
        } else {
          expect(tile).toEqual({ kind: 'void', cell: null });
        }
      });
    }
  });
});

describe('readyTiles with a picked start side', () => {
  it('walls the start cell in on every side but the picked one, and changes nothing else', () => {
    for (const n of [3, 5, 10]) {
      const plain = readyTiles(n);
      expect(readyTiles(n, null)).toEqual(plain);
      for (const side of ['E', 'S'] as const) {
        const ringed = readyTiles(n, side);
        const cols = screenCols(n);
        expect(ringed).toHaveLength(cols * cols);
        ringed.forEach((tile, index) => {
          const tx = index % cols;
          const ty = Math.floor(index / cols);
          const where = `${n}×${n} ${side} tile ${tx},${ty}`;
          const ring = tx <= 2 && ty <= 2 && !(tx === 1 && ty === 1);
          if (!ring) {
            expect(tile, where).toEqual(plain[index]);
            return;
          }
          const open = side === 'E' ? tx === 2 && ty === 1 : tx === 1 && ty === 2;
          expect(tile, where).toEqual({ kind: open ? 'floor' : 'wall', cell: null });
        });
        // Exactly one opening out of the start.
        expect(ringed.filter((tile) => tile.cell === null && tile.kind === 'floor')).toHaveLength(1);
      }
    }
  });

  it('the hero starts facing the opening: right for east, down for south and when no side is known', () => {
    expect(startFacing('E')).toBe('R');
    expect(startFacing('S')).toBe('D');
    expect(startFacing(null)).toBe('D');
  });
});

describe('playTiles', () => {
  it('draws the current cell as floor, visited cells as trail, the cells one may enter as near and the exit as floor', () => {
    const tiles = playTiles(3, WALK, true);
    expect(tiles).toHaveLength(49);
    expect(cellTile(tiles, 3, 1)).toEqual({ kind: 'floor', cell: 1 });
    expect(cellTile(tiles, 3, 0)).toEqual({ kind: 'trail', cell: 0 });
    // (1,1) is the only legal move: through the open south side to an unvisited cell.
    expect(cellTile(tiles, 3, 4)).toEqual({ kind: 'near', cell: 4 });
    // The exit is unseen, yet drawn as floor for the door to stand on.
    expect(cellTile(tiles, 3, 8)).toEqual({ kind: 'floor', cell: 8 });
    for (const cell of [2, 3, 5, 6, 7]) expect(cellTile(tiles, 3, cell)).toEqual({ kind: 'fog', cell });

    // Without `showNear` (the game has ended) no cell is offered.
    const ended = playTiles(3, WALK, false);
    expect(cellTile(ended, 3, 4).kind).toBe('fog');
    expect(ended.some((tile) => tile.kind === 'near')).toBe(false);
  });

  it('draws the passage between two visited cells as trail, an opening out of a visited cell as floor, every other side of it as wall', () => {
    const tiles = playTiles(3, WALK, true);
    const kind = (tx: number, ty: number): TileKind => at(tiles, 3, tx, ty).kind;
    // (0,0) -> (1,0): the way the player came.
    expect(kind(2, 1)).toBe('trail');
    // (1,0) opens south to the unseen (1,1).
    expect(kind(3, 2)).toBe('floor');
    // Closed sides of known cells, inner and outer.
    expect(kind(4, 1)).toBe('wall'); // (1,0) | (2,0)
    expect(kind(1, 2)).toBe('wall'); // (0,0) / (0,1)
    expect(kind(0, 1)).toBe('wall'); // west edge of (0,0)
    expect(kind(1, 0)).toBe('wall'); // north edge of (0,0)
    expect(kind(3, 0)).toBe('wall'); // north edge of (1,0)
    // Sides that touch no known cell stay fog, whatever the maze has there.
    expect(kind(5, 2)).toBe('fog'); // (2,0) / (2,1)
    expect(kind(4, 3)).toBe('fog'); // (1,1) | (2,1), next to the near cell only
    expect(kind(6, 1)).toBe('fog'); // east edge of (2,0)
    expect(kind(3, 4)).toBe('fog'); // (1,1) / (1,2)
    for (const tile of tiles) if (tile.cell === null) expect(tile.kind).not.toBe('void');
  });

  it('reads a side from the known cell when only the cell right of it or below it is known', () => {
    const tiles = playTiles(3, BACK, true);
    const kind = (tx: number, ty: number): TileKind => at(tiles, 3, tx, ty).kind;
    expect(cellTile(tiles, 3, 4).kind).toBe('floor');
    for (const cell of [0, 1, 2, 5]) expect(cellTile(tiles, 3, cell).kind).toBe('trail');
    // (1,1) opens west to the hidden (0,1), which is the one move left.
    expect(cellTile(tiles, 3, 3).kind).toBe('near');
    expect(kind(2, 3)).toBe('floor');
    // (1,0) / (1,1): both known, closed.
    expect(kind(3, 2)).toBe('wall');
    // (1,1) | (2,1): the way the player came.
    expect(kind(4, 3)).toBe('trail');
    // (1,1) / (1,2) and (2,1) / (2,2): closed sides of known cells.
    expect(kind(3, 4)).toBe('wall');
    expect(kind(5, 4)).toBe('wall');
    // (0,1) / (0,2) touches no known cell.
    expect(kind(1, 4)).toBe('fog');
  });

  it('puts a corner post wherever a known cell touches it, and nowhere else', () => {
    const tiles = playTiles(3, WALK, true);
    const kind = (tx: number, ty: number): TileKind => at(tiles, 3, tx, ty).kind;
    expect(kind(0, 0)).toBe('wall'); // corner of (0,0)
    expect(kind(2, 0)).toBe('wall'); // between (0,0) and (1,0)
    expect(kind(4, 0)).toBe('wall'); // corner of (1,0)
    expect(kind(4, 2)).toBe('wall'); // corner of (1,0)
    expect(kind(2, 2)).toBe('wall'); // corner of both
    expect(kind(6, 0)).toBe('fog'); // corner of (2,0) only
    expect(kind(0, 4)).toBe('fog');
    expect(kind(2, 4)).toBe('fog');
    expect(kind(6, 6)).toBe('fog');
  });

  it('AC-W2: on a real maze, every tile follows from the cells shown and the true walls, and no wall stands away from a known cell', () => {
    const n = 7;
    const maze = realMaze(n);
    const path = solve(maze);
    const cols = screenCols(n);
    const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < n && y < n;
    for (const length of [1, 2, Math.ceil(path.length / 2), path.length - 1]) {
      const observations = path.slice(0, length).map((cell, step) => ({ step, cell, open: maze.open[cell] }));
      const known = new Set(observations.map((o) => o.cell));
      const current = observations.at(-1)!.cell;
      const near = new Set(legalMoves(n, observations).map((dir) => adjacent(n, current, dir)));
      const isKnown = (x: number, y: number): boolean => inside(x, y) && known.has(y * n + x);
      const tiles = playTiles(n, observations, true);
      expect(tiles).toHaveLength(cols * cols);

      tiles.forEach((tile, index) => {
        const tx = index % cols;
        const ty = Math.floor(index / cols);
        const where = `${length} cells shown, tile ${tx},${ty}`;
        if (tx % 2 === 1 && ty % 2 === 1) {
          const cell = ((ty - 1) / 2) * n + (tx - 1) / 2;
          const expected: TileKind =
            cell === current
              ? 'floor'
              : known.has(cell)
                ? 'trail'
                : near.has(cell)
                  ? 'near'
                  : cell === n * n - 1
                    ? 'floor'
                    : 'fog';
          expect(tile, where).toEqual({ kind: expected, cell });
          return;
        }
        expect(tile.cell, where).toBeNull();
        const xs = tx % 2 === 1 ? [(tx - 1) / 2] : [tx / 2 - 1, tx / 2];
        const ys = ty % 2 === 1 ? [(ty - 1) / 2] : [ty / 2 - 1, ty / 2];
        const touchesKnown = xs.some((x) => ys.some((y) => isKnown(x, y)));
        if (!touchesKnown) {
          expect(tile.kind, where).toBe('fog');
          return;
        }
        if (xs.length === 2 && ys.length === 2) {
          expect(tile.kind, where).toBe('wall');
          return;
        }
        // A side between cell a (left or above) and cell b; the true maze says whether it is open.
        const [ax, ay] = [xs[0], ys[0]];
        const [bx, by] = xs.length === 2 ? [xs[1], ys[0]] : [xs[0], ys[1]];
        const toward = xs.length === 2 ? DIR_BIT[1] : DIR_BIT[2];
        const open = inside(ax, ay) && inside(bx, by) && (maze.open[ay * n + ax] & toward) !== 0;
        const both = isKnown(ax, ay) && isKnown(bx, by);
        expect(tile.kind, where).toBe(open ? (both ? 'trail' : 'floor') : 'wall');
      });
    }
  });
});

describe('facingOf', () => {
  it('faces the way of the last move', () => {
    const start: Observation[] = [{ step: 0, cell: 0, open: E }];
    expect(facingOf(start, [0])).toBe('U');
    expect(facingOf(start, [1])).toBe('R');
    expect(facingOf(start, [1, 2])).toBe('D');
    expect(facingOf(start, [2, 1, 3])).toBe('L');
  });

  it('before the first move: down when the start opens south, right otherwise; down before any cell', () => {
    expect(facingOf([{ step: 0, cell: 0, open: S }], [])).toBe('D');
    expect(facingOf([{ step: 0, cell: 0, open: E | S }], [])).toBe('D');
    expect(facingOf([{ step: 0, cell: 0, open: E }], [])).toBe('R');
    expect(facingOf([], [])).toBe('D');
  });

  it('turns a facing back into its direction', () => {
    expect(FACING).toEqual(['U', 'R', 'D', 'L']);
    FACING.forEach((facing, dir) => expect(dirOfFacing(facing)).toBe(dir));
  });
});

describe('blockedReason', () => {
  it('names the edge, a wall, or a visited cell, and nothing for a legal move', () => {
    const start = WALK.slice(0, 1);
    expect(blockedReason(3, start, 0)).toBe('edge');
    expect(blockedReason(3, start, 3)).toBe('edge');
    expect(blockedReason(3, start, 2)).toBe('wall');
    expect(blockedReason(3, start, 1)).toBeNull();

    // At (1,0): west leads back to the start, east is closed, south is open, north is the edge.
    expect(blockedReason(3, WALK, 3)).toBe('visited');
    expect(blockedReason(3, WALK, 1)).toBe('wall');
    expect(blockedReason(3, WALK, 2)).toBeNull();
    expect(blockedReason(3, WALK, 0)).toBe('edge');

    expect(blockedReason(3, [], 1)).toBeNull();
  });

  it('agrees with the legal moves along a real maze', () => {
    const n = 5;
    const maze = realMaze(n);
    const path = solve(maze);
    for (let length = 1; length < path.length; length++) {
      const observations = path.slice(0, length).map((cell, step) => ({ step, cell, open: maze.open[cell] }));
      const legal = legalMoves(n, observations);
      for (const dir of [0, 1, 2, 3] as Dir[]) {
        expect(blockedReason(n, observations, dir) === null, `step ${length - 1} dir ${dir}`).toBe(legal.includes(dir));
      }
    }
  });
});
