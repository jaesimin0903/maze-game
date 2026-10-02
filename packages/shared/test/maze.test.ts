import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  exitCell,
  fastRng,
  generateGridFromRng,
  generateMaze,
  isDeadEnd,
  isPerfect,
  MAZE_VERSION,
  neighbor,
  openDirs,
  seedRng,
  solve,
  START_CELL,
  type Hex,
  type Maze,
  type Rng,
} from '../src';
import { expectVector, mazeVectors, vectorsMazeVersion } from './vectors';

function seedOf(label: string): Hex {
  return `0x${createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

/** The maze stream of the plan (§3.4 step 1), from node:crypto. */
function* referenceStream(finalSeed: Hex): Generator<number, never> {
  for (let i = 0; ; i++) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(i);
    const block = createHash('sha256')
      .update(Buffer.from(finalSeed.slice(2), 'hex'))
      .update(counter)
      .digest();
    for (let j = 0; j < 8; j++) yield block.readUInt32BE(4 * j);
  }
}

/**
 * Wilson with the start corridor, written from the plan (§3.4) with an explicit path whose
 * loops are erased as they close. Shares no code with the module.
 */
function referenceMaze(finalSeed: Hex, w: number, h: number): number[] {
  const stream = referenceStream(finalSeed);
  const below = (m: number): number => stream.next().value % m; // 2 and 4 divide 2^32: no rejection
  const other = below(2) === 0 ? 1 : w;
  const deleted = (p: number, q: number): boolean =>
    (p === 0 && q === other) || (q === 0 && p === other);
  const inTree = new Set([w * h - 1]);
  const open = new Array<number>(w * h).fill(0);
  for (let first = 0; first < w * h; first++) {
    if (inTree.has(first)) continue;
    let path = [first];
    while (!inTree.has(path[path.length - 1])) {
      const cell = path[path.length - 1];
      const dir = below(4);
      const x = (cell % w) + [0, 1, 0, -1][dir];
      const y = Math.floor(cell / w) + [-1, 0, 1, 0][dir];
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const next = y * w + x;
      if (deleted(cell, next)) continue;
      const at = path.indexOf(next);
      if (at >= 0) path = path.slice(0, at + 1);
      else path.push(next);
    }
    for (let i = 0; i + 1 < path.length; i++) {
      const delta = path[i + 1] - path[i];
      const [bit, back] = delta === -w ? [1, 4] : delta === 1 ? [2, 8] : delta === w ? [4, 1] : [8, 2];
      open[path[i]] |= bit;
      open[path[i + 1]] |= back;
      inTree.add(path[i]);
    }
  }
  return open;
}

/** Structure of a maze, computed without the module's own helpers. */
function analyse(maze: Maze): {
  reachable: number;
  passages: number;
  consistent: boolean;
  startOpenings: number;
  paths: number[][];
} {
  const { w, h, open } = maze;
  const cells = w * h;
  const adjacent: number[][] = Array.from({ length: cells }, () => []);
  let openings = 0;
  let consistent = open.length === cells;
  for (let cell = 0; cell < cells; cell++) {
    const x = cell % w;
    const y = Math.floor(cell / w);
    const sides = [
      [1, x, y - 1, 4],
      [2, x + 1, y, 8],
      [4, x, y + 1, 1],
      [8, x - 1, y, 2],
    ];
    for (const [bit, nx, ny, back] of sides) {
      if ((open[cell] & bit) === 0) continue;
      openings += 1;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
        consistent = false;
        continue;
      }
      if ((open[ny * w + nx] & back) === 0) consistent = false;
      adjacent[cell].push(ny * w + nx);
    }
  }

  const seen = new Set([0]);
  const stack = [0];
  while (stack.length > 0) {
    for (const next of adjacent[stack.pop()!]) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }

  // Every simple path from the start to the exit.
  const paths: number[][] = [];
  const onTrail = new Uint8Array(cells);
  const trail = [0];
  const walk = (cell: number): void => {
    if (cell === cells - 1) {
      paths.push([...trail]);
      return;
    }
    onTrail[cell] = 1;
    for (const next of adjacent[cell]) {
      if (onTrail[next] === 0) {
        trail.push(next);
        walk(next);
        trail.pop();
      }
    }
    onTrail[cell] = 0;
  };
  walk(0);

  const startOpenings = [1, 2, 4, 8].filter((bit) => (open[0] & bit) !== 0).length;
  return { reachable: seen.size, passages: openings / 2, consistent, startOpenings, paths };
}

/** An `Rng` that replays a script and checks the modulus of every draw. */
function scripted(draws: [m: number, value: number][]): Rng & { remaining(): number } {
  let used = 0;
  return {
    nextU32() {
      throw new Error('the generator must draw through nextBelow');
    },
    nextBelow(m) {
      if (used >= draws.length) throw new Error('the script ran out of draws');
      const [expectedM, value] = draws[used++];
      expect(m).toBe(expectedM);
      return value;
    },
    remaining: () => draws.length - used,
  };
}

/** Wraps `maze.open` so that every indexed read is recorded. */
function recording(maze: Maze): { maze: Maze; reads: number[] } {
  const reads: number[] = [];
  const open = new Proxy(maze.open, {
    get(target, property) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads.push(Number(property));
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { maze: { w: maze.w, h: maze.h, open }, reads };
}

// 0 1 2      passages: 0-3, 3-4, 4-1, 1-2, 4-5, 5-8, 3-6, 6-7
// 3 4 5      solution: 0 3 4 5 8; dead ends: 2 and 7
// 6 7 8
const HAND: Maze = { w: 3, h: 3, open: Uint8Array.from([4, 6, 8, 7, 11, 12, 3, 8, 1]) };

describe('fixed vectors', () => {
  it('AC-M1 there are at least three vectors for each game size and they are for this maze version', () => {
    expect(vectorsMazeVersion).toBe(MAZE_VERSION);
    expect(mazeVectors).toHaveLength(9);
    for (const n of [5, 7, 10]) {
      expect(mazeVectors.filter((v) => v.n === n).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('AC-M1 runs in Node without a browser window', () => {
    expect('window' in globalThis).toBe(false);
  });

  it.each(mazeVectors)('AC-M1 vector $id (n = $n) is reproduced in Node', (vector) => {
    expectVector(vector);
  });
});

describe('generateGridFromRng', () => {
  it('AC-M1 follows the draw protocol: b = 0 deletes the east edge, walks redraw blocked directions', () => {
    // 0 1
    // 2 3   exit = 3
    const rng = scripted([
      [2, 0], // start corridor: delete the east edge 0-1
      [4, 1], // from 0: east crosses the deleted edge, redraw
      [4, 0], // north leaves the grid, redraw
      [4, 3], // west leaves the grid, redraw
      [4, 2], // south to 2
      [4, 0], // from 2: north back to 0, closing a loop that is erased
      [4, 2], // from 0: south to 2 again
      [4, 1], // from 2: east to 3, the tree
      [4, 3], // walk from 1: west crosses the deleted edge, redraw
      [4, 2], // south to 3, the tree
    ]);
    const maze = generateGridFromRng(rng, 2, 2);
    expect(Array.from(maze.open)).toEqual([4, 4, 3, 9]);
    expect(rng.remaining()).toBe(0);
  });

  it('AC-M1 follows the draw protocol: b = 1 deletes the south edge, cells are walked in index order', () => {
    const rng = scripted([
      [2, 1], // start corridor: delete the south edge 0-2
      [4, 2], // from 0: south crosses the deleted edge, redraw
      [4, 1], // east to 1
      [4, 2], // from 1: south to 3, the tree
      [4, 0], // walk from 2 (cell 1 is already in the tree): north crosses the deleted edge
      [4, 1], // east to 3, the tree
    ]);
    const maze = generateGridFromRng(rng, 2, 2);
    expect(Array.from(maze.open)).toEqual([2, 12, 2, 9]);
    expect(rng.remaining()).toBe(0);
  });

  it('AC-M1 matches an independent reference implementation, rectangles included', () => {
    const mismatches: string[] = [];
    for (const [w, h] of [[2, 2], [3, 3], [4, 4], [5, 4], [4, 5], [5, 5], [7, 7], [10, 10]]) {
      for (let i = 0; i < 300; i++) {
        const seed = seedOf(`reference ${w}x${h} #${i}`);
        const maze = generateGridFromRng(seedRng(seed), w, h);
        if (Array.from(maze.open).join() !== referenceMaze(seed, w, h).join()) {
          mismatches.push(`${w}x${h} #${i}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('AC-M1 generateMaze is the square grid driven by the production stream of the seed', () => {
    for (const n of [5, 7, 10]) {
      const seed = seedOf(`square ${n}`);
      const maze = generateMaze(seed, n);
      expect([maze.w, maze.h, maze.open.length]).toEqual([n, n, n * n]);
      expect(Array.from(maze.open)).toEqual(Array.from(generateGridFromRng(seedRng(seed), n, n).open));
      expect(Array.from(generateMaze(seed, n).open)).toEqual(Array.from(maze.open));
    }
    expect(Array.from(generateMaze(seedOf('a'), 5).open)).not.toEqual(
      Array.from(generateMaze(seedOf('b'), 5).open),
    );
  });

  it.each([5, 7, 10])(
    'AC-M2 n = %i: 10,000 seeds give perfect mazes whose start cell has exactly one opening',
    (n) => {
      const seeds = 10_000;
      const failures: string[] = [];
      let eastStarts = 0;
      for (let i = 0; i < seeds; i++) {
        const maze = generateMaze(seedOf(`AC-M2 n=${n} seed=${i}`), n);
        const found = analyse(maze);
        const ok =
          found.consistent &&
          found.reachable === n * n &&
          found.passages === n * n - 1 &&
          found.paths.length === 1 &&
          found.startOpenings === 1 &&
          isPerfect(maze) &&
          solve(maze).join() === found.paths[0].join();
        if (!ok) failures.push(`seed ${i}: ${JSON.stringify({ ...found, paths: found.paths.length })}`);
        if (maze.open[START_CELL] === 2) eastStarts += 1;
      }
      expect(failures).toEqual([]);
      // The start corridor is a fair coin (six standard deviations of slack).
      expect(eastStarts).toBeGreaterThan(seeds / 2 - 300);
      expect(eastStarts).toBeLessThan(seeds / 2 + 300);
    },
  );

  it('AC-M2 rectangles are perfect too, with either random source', () => {
    const failures: string[] = [];
    for (const [w, h] of [[5, 4], [4, 5], [3, 3], [4, 4], [2, 2], [2, 7], [9, 2]]) {
      for (let i = 0; i < 2000; i++) {
        const sources: [string, Rng][] = [
          ['seedRng', seedRng(seedOf(`rect ${w}x${h} #${i}`))],
          ['fastRng', fastRng(BigInt(i) * 1000n + BigInt(w * 16 + h))],
        ];
        for (const [name, rng] of sources) {
          const maze = generateGridFromRng(rng, w, h);
          const found = analyse(maze);
          const ok =
            maze.w === w &&
            maze.h === h &&
            found.consistent &&
            found.reachable === w * h &&
            found.passages === w * h - 1 &&
            found.paths.length === 1 &&
            found.startOpenings === 1 &&
            isPerfect(maze);
          if (!ok) failures.push(`${name} ${w}x${h} #${i}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('the simulator source is deterministic per seed', () => {
    const a = generateGridFromRng(fastRng(123n), 10, 10);
    const b = generateGridFromRng(fastRng(123n), 10, 10);
    const c = generateGridFromRng(fastRng(124n), 10, 10);
    expect(Array.from(a.open)).toEqual(Array.from(b.open));
    expect(Array.from(a.open)).not.toEqual(Array.from(c.open));
  });

  it('rejects sizes that are not integers in 2 .. 255', () => {
    for (const [w, h] of [[1, 5], [5, 1], [0, 0], [2.5, 3], [256, 4], [3, Number.NaN]]) {
      expect(() => generateGridFromRng(fastRng(1n), w, h)).toThrow(RangeError);
    }
    expect(() => generateMaze(seedOf('x'), 1)).toThrow(RangeError);
  });
});

describe('inspection helpers', () => {
  it('exitCell and START_CELL name the two corners', () => {
    expect(START_CELL).toBe(0);
    expect(exitCell(HAND)).toBe(8);
    expect(exitCell({ w: 5, h: 4, open: new Uint8Array(20) })).toBe(19);
  });

  it('openDirs lists open directions in the order N, E, S, W', () => {
    expect(openDirs(HAND, 0)).toEqual([2]);
    expect(openDirs(HAND, 3)).toEqual([0, 1, 2]);
    expect(openDirs(HAND, 4)).toEqual([0, 1, 3]);
    expect(openDirs(HAND, 5)).toEqual([2, 3]);
    expect(openDirs({ w: 2, h: 2, open: Uint8Array.from([15, 0, 0, 0]) }, 0)).toEqual([0, 1, 2, 3]);
  });

  it('neighbor is geometric: it ignores walls and returns null outside the grid', () => {
    expect(neighbor(HAND, 4, 0)).toBe(1);
    expect(neighbor(HAND, 4, 1)).toBe(5);
    expect(neighbor(HAND, 4, 2)).toBe(7); // there is a wall between 4 and 7
    expect(neighbor(HAND, 4, 3)).toBe(3);
    expect(neighbor(HAND, 0, 0)).toBeNull();
    expect(neighbor(HAND, 0, 3)).toBeNull();
    expect(neighbor(HAND, 8, 1)).toBeNull();
    expect(neighbor(HAND, 8, 2)).toBeNull();
    expect(neighbor(HAND, 2, 1)).toBeNull(); // no wrap to the next row
    const wide: Maze = { w: 5, h: 4, open: new Uint8Array(20) };
    expect(neighbor(wide, 7, 2)).toBe(12);
    expect(neighbor(wide, 15, 2)).toBeNull();
    expect(neighbor(wide, 4, 1)).toBeNull();
  });

  it('solve returns the start-to-exit path, or an empty list when there is none', () => {
    expect(solve(HAND)).toEqual([0, 3, 4, 5, 8]);
    const sealed: Maze = { w: 3, h: 3, open: Uint8Array.from([4, 6, 8, 7, 9, 0, 3, 8, 0]) };
    expect(solve(sealed)).toEqual([]);
  });

  it('isDeadEnd: no opening other than the way back, and never the exit', () => {
    expect(isDeadEnd(HAND, 2, 1)).toBe(true);
    expect(isDeadEnd(HAND, 7, 6)).toBe(true);
    expect(isDeadEnd(HAND, 3, 0)).toBe(false);
    expect(isDeadEnd(HAND, 1, 4)).toBe(false);
    expect(isDeadEnd(HAND, 8, 5)).toBe(false); // the exit has one opening but is a win
    expect(isDeadEnd(HAND, 0, null)).toBe(false);
    expect(isDeadEnd(HAND, 2, null)).toBe(false); // nowhere came from: its one opening is a way on
  });

  it('AC-M2 the start cell of a generated maze is never a dead end', () => {
    for (let i = 0; i < 500; i++) {
      const maze = generateMaze(seedOf(`start ${i}`), 5);
      expect(isDeadEnd(maze, START_CELL, null)).toBe(false);
    }
  });

  it('openDirs and isDeadEnd read only the wall entry of the given cell; neighbor reads none', () => {
    const maze = generateMaze(seedOf('access'), 7);
    for (let cell = 0; cell < 49; cell++) {
      const open = recording(maze);
      openDirs(open.maze, cell);
      expect(new Set(open.reads)).toEqual(new Set([cell]));

      const dead = recording(maze);
      for (const from of [null, ...([0, 1, 2, 3] as const).map((dir) => neighbor(maze, cell, dir))]) {
        isDeadEnd(dead.maze, cell, from);
      }
      expect(new Set(dead.reads).size).toBeLessThanOrEqual(1);
      expect(dead.reads.every((index) => index === cell)).toBe(true);

      const near = recording(maze);
      for (const dir of [0, 1, 2, 3] as const) neighbor(near.maze, cell, dir);
      expect(near.reads).toEqual([]);
    }
  });

  it('cell arguments outside the grid are rejected', () => {
    for (const bad of [-1, 9, 1.5, Number.NaN]) {
      expect(() => openDirs(HAND, bad)).toThrow(RangeError);
      expect(() => neighbor(HAND, bad, 0)).toThrow(RangeError);
      expect(() => isDeadEnd(HAND, bad, null)).toThrow(RangeError);
    }
  });
});

describe('isPerfect', () => {
  const variant = (change: (open: Uint8Array) => void): Maze => {
    const open = Uint8Array.from(HAND.open);
    change(open);
    return { w: 3, h: 3, open };
  };

  it('accepts a spanning tree', () => {
    expect(isPerfect(HAND)).toBe(true);
  });

  it('rejects a maze with a closed-off cell', () => {
    expect(
      isPerfect(
        variant((open) => {
          open[6] &= ~2; // wall up between 6 and 7
          open[7] &= ~8;
        }),
      ),
    ).toBe(false);
  });

  it('rejects a maze with a loop', () => {
    expect(
      isPerfect(
        variant((open) => {
          open[7] |= 2; // extra passage 7-8
          open[8] |= 8;
        }),
      ),
    ).toBe(false);
  });

  it('rejects the right number of passages when they do not connect everything', () => {
    expect(
      isPerfect(
        variant((open) => {
          open[6] &= ~2; // remove 6-7 ...
          open[7] &= ~8;
          open[1] |= 8; // ... and add 0-1, which closes a loop and leaves 7 alone
          open[0] |= 2;
        }),
      ),
    ).toBe(false);
  });

  it('rejects an opening that is not matched on the other side', () => {
    expect(isPerfect(variant((open) => (open[7] |= 2)))).toBe(false);
  });

  it('rejects an opening that leaves the grid', () => {
    expect(isPerfect(variant((open) => (open[0] |= 1)))).toBe(false);
  });

  it('rejects a wall array of the wrong length or with unknown bits', () => {
    expect(isPerfect({ w: 3, h: 3, open: HAND.open.slice(0, 8) })).toBe(false);
    expect(isPerfect(variant((open) => (open[4] |= 16)))).toBe(false);
  });
});
