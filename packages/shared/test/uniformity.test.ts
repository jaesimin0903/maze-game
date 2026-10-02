// AC-M7: on the 3×3 grid the generator must be uniform over the 112 spanning trees whose start
// cell has one opening. 1,120,000 samples give an expected 10,000 per tree. The equivalence
// margins are fixed by the plan: every tree within 5% of its expected count and a total
// variation distance of at most 0.01. A depth-first generator must fail the same check.

import { describe, expect, it } from 'vitest';
import { fastRng, generateGridFromRng, generateMaze, type Hex, type Maze, type Rng } from '../src';

const SIDE = 3;
const CELLS = SIDE * SIDE;
const SAMPLES = 1_120_000;
const MAX_RELATIVE_DEVIATION = 0.05;
const MAX_TOTAL_VARIATION = 0.01;

/** A 3×3 maze as one number: four bits per cell. */
function keyOf(open: ArrayLike<number>): number {
  let key = 0;
  for (let cell = CELLS - 1; cell >= 0; cell--) key = key * 16 + open[cell];
  return key;
}

/** Every spanning tree of the 3×3 grid, by brute force over the 8-edge subsets of its 12 edges. */
function spanningTrees(): number[][] {
  const edges: [a: number, b: number, bitA: number, bitB: number][] = [];
  for (let cell = 0; cell < CELLS; cell++) {
    if (cell % SIDE < SIDE - 1) edges.push([cell, cell + 1, 2, 8]);
    if (cell + SIDE < CELLS) edges.push([cell, cell + SIDE, 4, 1]);
  }
  const trees: number[][] = [];
  for (let subset = 0; subset < 1 << edges.length; subset++) {
    const group = Array.from({ length: CELLS }, (_, cell) => cell);
    const find = (cell: number): number => (group[cell] === cell ? cell : (group[cell] = find(group[cell])));
    const open = new Array<number>(CELLS).fill(0);
    let used = 0;
    let acyclic = true;
    for (let e = 0; e < edges.length && acyclic; e++) {
      if ((subset & (1 << e)) === 0) continue;
      const [a, b, bitA, bitB] = edges[e];
      if (find(a) === find(b)) {
        acyclic = false;
      } else {
        group[find(a)] = find(b);
        open[a] |= bitA;
        open[b] |= bitB;
        used += 1;
      }
    }
    // Eight edges without a cycle on nine cells are a spanning tree.
    if (acyclic && used === CELLS - 1) trees.push(open);
  }
  return trees;
}

const allTrees = spanningTrees();
const corridorTrees = allTrees.filter((open) => open[0] === 2 || open[0] === 4);
const indexOfTree = new Map(corridorTrees.map((open, index) => [keyOf(open), index]));

function tally(make: (sample: number) => Maze): { counts: number[]; outside: number } {
  const counts = new Array<number>(corridorTrees.length).fill(0);
  let outside = 0;
  for (let sample = 0; sample < SAMPLES; sample++) {
    const index = indexOfTree.get(keyOf(make(sample).open));
    if (index === undefined) outside += 1;
    else counts[index] += 1;
  }
  return { counts, outside };
}

function uniformity(counts: number[]): { maxDeviation: number; totalVariation: number; pass: boolean } {
  const expected = SAMPLES / counts.length;
  let maxDeviation = 0;
  let totalVariation = 0;
  for (const count of counts) {
    maxDeviation = Math.max(maxDeviation, Math.abs(count - expected) / expected);
    totalVariation += Math.abs(count / SAMPLES - 1 / counts.length) / 2;
  }
  return {
    maxDeviation,
    totalVariation,
    pass: maxDeviation <= MAX_RELATIVE_DEVIATION && totalVariation <= MAX_TOTAL_VARIATION,
  };
}

/** Recursive backtracker with the same start corridor: the negative control. */
function depthFirstMaze(rng: Rng, w: number, h: number): Maze {
  const blocked = rng.nextBelow(2) === 0 ? 1 : w;
  const open = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
  visited[0] = 1;
  const stack = [0];
  while (stack.length > 0) {
    const cell = stack[stack.length - 1];
    const x = cell % w;
    const y = Math.floor(cell / w);
    const options: [next: number, bit: number, back: number][] = [];
    if (y > 0) options.push([cell - w, 1, 4]);
    if (x < w - 1) options.push([cell + 1, 2, 8]);
    if (y < h - 1) options.push([cell + w, 4, 1]);
    if (x > 0) options.push([cell - 1, 8, 2]);
    const free = options.filter(
      ([next]) => visited[next] === 0 && !(cell === 0 && next === blocked) && !(next === 0 && cell === blocked),
    );
    if (free.length === 0) {
      stack.pop();
      continue;
    }
    const [next, bit, back] = free[rng.nextBelow(free.length)];
    open[cell] |= bit;
    open[next] |= back;
    visited[next] = 1;
    stack.push(next);
  }
  return { w, h, open };
}

describe('AC-M7 3×3 uniformity', () => {
  it('AC-M7 the 3×3 grid has 192 spanning trees, 112 of them with a start corridor (56 east, 56 south)', () => {
    expect(allTrees).toHaveLength(192);
    expect(corridorTrees).toHaveLength(112);
    expect(corridorTrees.filter((open) => open[0] === 2)).toHaveLength(56);
    expect(corridorTrees.filter((open) => open[0] === 4)).toHaveLength(56);
    expect(indexOfTree.size).toBe(112);
    expect(SAMPLES / corridorTrees.length).toBe(10_000);
  });

  it('AC-M7 production stream: 1,120,000 seeds are uniform over the 112 trees', () => {
    const seedOf = (sample: number): Hex => `0x${sample.toString(16).padStart(64, '0')}`;
    const { counts, outside } = tally((sample) => generateMaze(seedOf(sample), SIDE));
    const result = uniformity(counts);
    expect(outside).toBe(0);
    expect(result.maxDeviation).toBeLessThanOrEqual(MAX_RELATIVE_DEVIATION);
    expect(result.totalVariation).toBeLessThanOrEqual(MAX_TOTAL_VARIATION);
    expect(result.pass).toBe(true);
  });

  it('AC-M7 simulator source: 1,120,000 mazes from fastRng are uniform over the 112 trees', () => {
    const rng = fastRng(0x4d617a65n);
    const { counts, outside } = tally(() => generateGridFromRng(rng, SIDE, SIDE));
    const result = uniformity(counts);
    expect(outside).toBe(0);
    expect(result.maxDeviation).toBeLessThanOrEqual(MAX_RELATIVE_DEVIATION);
    expect(result.totalVariation).toBeLessThanOrEqual(MAX_TOTAL_VARIATION);
    expect(result.pass).toBe(true);
  });

  it('AC-M7 negative control: a depth-first generator with the same sample size fails the check', () => {
    const rng = fastRng(0x4d617a65n);
    const { counts, outside } = tally(() => depthFirstMaze(rng, SIDE, SIDE));
    const result = uniformity(counts);
    // It only produces start-corridor trees, so the comparison is over the same 112 outcomes.
    expect(outside).toBe(0);
    expect(result.pass).toBe(false);
    expect(result.maxDeviation).toBeGreaterThan(MAX_RELATIVE_DEVIATION);
    expect(result.totalVariation).toBeGreaterThan(MAX_TOTAL_VARIATION);
  });
});
