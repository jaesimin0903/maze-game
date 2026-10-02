import { describe, expect, it } from 'vitest';
import type { Observation } from '@maze/shared';
import { adjacent, boardCells, legalMoves } from '../../src/client/board-view';

// A 3×3 walk: start (0,0) open east, then (1,0) open west + south, then (1,1) open north + east + south.
const WALK: Observation[] = [
  { step: 0, cell: 0, open: 2 },
  { step: 1, cell: 1, open: 8 | 4 },
  { step: 2, cell: 4, open: 1 | 2 | 4 },
];

describe('boardCells', () => {
  it('AC-W2: visited and current cells carry their walls, every other cell is hidden without wall data', () => {
    const cells = boardCells(3, WALK);
    expect(cells).toHaveLength(9);
    expect(cells[0]).toMatchObject({ x: 0, y: 0, state: 'visited', open: 2 });
    expect(cells[1]).toMatchObject({ x: 1, y: 0, state: 'visited', open: 12 });
    expect(cells[4]).toMatchObject({ x: 1, y: 1, state: 'current', open: 7 });
    for (const index of [2, 3, 5, 6, 7, 8]) {
      expect(cells[index].state).toBe('hidden');
      expect(cells[index].open).toBeNull();
    }
  });

  it('AC-W2: marks the start at the top-left cell and the exit at the bottom-right cell', () => {
    const cells = boardCells(3, WALK);
    expect(cells.filter((c) => c.start).map((c) => c.cell)).toEqual([0]);
    expect(cells.filter((c) => c.exit).map((c) => c.cell)).toEqual([8]);
  });

  it('points only at hidden cells the player may step into now', () => {
    const cells = boardCells(3, WALK);
    expect(cells[5].via).toBe(1);
    expect(cells[7].via).toBe(2);
    // North of the current cell is open but already visited.
    expect(cells[1].via).toBeNull();
    expect(cells.filter((c) => c.via !== null)).toHaveLength(2);
  });

  it('is all fog, with nothing to step into, before the server has shown the first cell', () => {
    const cells = boardCells(5, []);
    expect(cells).toHaveLength(25);
    expect(cells.every((c) => c.state === 'hidden' && c.open === null && c.via === null)).toBe(true);
  });
});

describe('legalMoves', () => {
  it('AC-R5: excludes walls, visited cells and the edge of the grid', () => {
    expect(legalMoves(3, WALK)).toEqual([1, 2]);
    expect(legalMoves(3, WALK.slice(0, 1))).toEqual([1]);
    // A mask that claims an opening off the grid never yields a move.
    expect(legalMoves(3, [{ step: 0, cell: 0, open: 1 | 8 }])).toEqual([]);
    expect(legalMoves(3, [])).toEqual([]);
  });
});

describe('adjacent', () => {
  it('returns null outside the grid', () => {
    expect(adjacent(3, 0, 0)).toBeNull();
    expect(adjacent(3, 0, 3)).toBeNull();
    expect(adjacent(3, 8, 1)).toBeNull();
    expect(adjacent(3, 8, 2)).toBeNull();
    expect(adjacent(3, 4, 0)).toBe(1);
    expect(adjacent(3, 4, 3)).toBe(3);
  });
});
