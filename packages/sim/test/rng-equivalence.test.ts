// AC-T2: the simulator's fast generator feeds the same maze generator as the production stream
// and yields the same maze distribution. A Kruskal generator (not uniform) must fail the checks.

import { describe, expect, it } from 'vitest';
import { fastRng, generateGridFromRng, generateMaze, seedRng, solve, type Hex, type Maze, type Rng } from '@maze/shared';
import { enumerateCorridorMazes } from '../src/exact';
import { gameFinalSeed, gameSeed } from '../src/streams';

const UNIFORMITY_SAMPLES = 1_120_000;
const MAX_RELATIVE_DEVIATION = 0.05;
const MAX_TOTAL_VARIATION = 0.01;
const SHAPE_SAMPLES = 200_000;
const MAX_MEAN_DIFFERENCE = 0.005;
const START_TOLERANCE = 0.005;

const trees = enumerateCorridorMazes(3, 3);
const treeIndex = new Map<string, number>();
for (let i = 0; i < trees.count; i++) treeIndex.set(Array.from(trees.mazes.subarray(i * 9, i * 9 + 9)).join(','), i);

/** AC-M7 on a sample of 3×3 mazes: every tree within 5% of its expected count, total variation at most 0.01. */
function uniformity(make: (sample: number) => Maze): { outside: number; maxDeviation: number; totalVariation: number } {
  const counts = new Array<number>(trees.count).fill(0);
  let outside = 0;
  for (let sample = 0; sample < UNIFORMITY_SAMPLES; sample++) {
    const index = treeIndex.get(Array.from(make(sample).open).join(','));
    if (index === undefined) outside += 1;
    else counts[index] += 1;
  }
  const expected = UNIFORMITY_SAMPLES / trees.count;
  let maxDeviation = 0;
  let totalVariation = 0;
  for (const count of counts) {
    maxDeviation = Math.max(maxDeviation, Math.abs(count - expected) / expected);
    totalVariation += Math.abs(count / UNIFORMITY_SAMPLES - 1 / trees.count) / 2;
  }
  return { outside, maxDeviation, totalVariation };
}

interface Shape {
  /** Mean number of moves of the solution path. */
  pathLength: number;
  /** Mean number of cells with a single opening. */
  leaves: number;
  /** Share of mazes whose start cell opens east. */
  startEast: number;
}

function shape(n: number, make: (sample: number) => Maze): Shape {
  let pathLength = 0;
  let leaves = 0;
  let east = 0;
  for (let sample = 0; sample < SHAPE_SAMPLES; sample++) {
    const maze = make(sample);
    pathLength += solve(maze).length - 1;
    for (let cell = 0; cell < n * n; cell++) {
      const mask = maze.open[cell];
      if (mask === 1 || mask === 2 || mask === 4 || mask === 8) leaves += 1;
    }
    if (maze.open[0] === 2) east += 1;
  }
  return { pathLength: pathLength / SHAPE_SAMPLES, leaves: leaves / SHAPE_SAMPLES, startEast: east / SHAPE_SAMPLES };
}

/** Randomised Kruskal with the same start corridor: a spanning tree, but not a uniform one. */
function kruskalMaze(rng: Rng, n: number): Maze {
  const cells = n * n;
  const blocked = rng.nextBelow(2) === 0 ? 1 : n;
  const edges: [number, number, number, number][] = [];
  for (let cell = 0; cell < cells; cell++) {
    if (cell % n < n - 1 && !(cell === 0 && blocked === 1)) edges.push([cell, cell + 1, 2, 8]);
    if (cell + n < cells && !(cell === 0 && blocked === n)) edges.push([cell, cell + n, 4, 1]);
  }
  for (let i = edges.length - 1; i > 0; i--) {
    const j = rng.nextBelow(i + 1);
    [edges[i], edges[j]] = [edges[j], edges[i]];
  }
  const parent = Int32Array.from({ length: cells }, (_, cell) => cell);
  const find = (cell: number): number => {
    while (parent[cell] !== cell) {
      parent[cell] = parent[parent[cell]];
      cell = parent[cell];
    }
    return cell;
  };
  const open = new Uint8Array(cells);
  for (const [a, b, bitA, bitB] of edges) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    parent[ra] = rb;
    open[a] |= bitA;
    open[b] |= bitB;
  }
  return { w: n, h: n, open };
}

function relative(a: number, b: number): number {
  return Math.abs(a - b) / b;
}

describe('AC-T2 generator equivalence', () => {
  it('AC-T2 both random sources are uniform over the 112 trees of 3×3 (1,120,000 samples each)', () => {
    const production = uniformity((sample) => generateMaze(gameFinalSeed('E', 3, 3, sample), 3));
    expect(production.outside).toBe(0);
    expect(production.maxDeviation).toBeLessThanOrEqual(MAX_RELATIVE_DEVIATION);
    expect(production.totalVariation).toBeLessThanOrEqual(MAX_TOTAL_VARIATION);
    const fast = uniformity((sample) => generateGridFromRng(fastRng(gameSeed('E', 3, 3, sample)), 3, 3));
    expect(fast.outside).toBe(0);
    expect(fast.maxDeviation).toBeLessThanOrEqual(MAX_RELATIVE_DEVIATION);
    expect(fast.totalVariation).toBeLessThanOrEqual(MAX_TOTAL_VARIATION);
  }, 600_000);

  it('AC-T2 negative control: a Kruskal generator fails the 3×3 uniformity check', () => {
    const rng = fastRng(5n);
    const kruskal = uniformity(() => kruskalMaze(rng, 3));
    expect(kruskal.outside).toBe(0);
    expect(kruskal.maxDeviation > MAX_RELATIVE_DEVIATION || kruskal.totalVariation > MAX_TOTAL_VARIATION).toBe(true);
  }, 600_000);

  for (const n of [5, 7, 9, 10]) {
    it(`AC-T2 ${n}×${n}: path length and leaf count agree within 0.5% and the start direction is 0.5 ± 0.005 (200,000 mazes per source)`, () => {
      const production = shape(n, (sample) => generateGridFromRng(seedRng(gameFinalSeed('E', n, n, sample) as Hex), n, n));
      const fast = shape(n, (sample) => generateGridFromRng(fastRng(gameSeed('E', n, n, sample)), n, n));
      expect(relative(fast.pathLength, production.pathLength)).toBeLessThanOrEqual(MAX_MEAN_DIFFERENCE);
      expect(relative(fast.leaves, production.leaves)).toBeLessThanOrEqual(MAX_MEAN_DIFFERENCE);
      expect(Math.abs(production.startEast - 0.5)).toBeLessThanOrEqual(START_TOLERANCE);
      expect(Math.abs(fast.startEast - 0.5)).toBeLessThanOrEqual(START_TOLERANCE);

      if (n >= 7) {
        // Negative control: Kruskal's mazes have a different shape, and the same check must say so.
        const rng = fastRng(BigInt(n));
        const kruskal = shape(n, () => kruskalMaze(rng, n));
        const passes =
          relative(kruskal.pathLength, production.pathLength) <= MAX_MEAN_DIFFERENCE &&
          relative(kruskal.leaves, production.leaves) <= MAX_MEAN_DIFFERENCE &&
          Math.abs(kruskal.startEast - 0.5) <= START_TOLERANCE;
        expect(passes).toBe(false);
      }
    }, 600_000);
  }
});
