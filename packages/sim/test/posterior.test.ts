// Exact posterior: harmonic measure on the uniform spanning tree, checked against the full
// enumeration of every maze of a small grid.

import { describe, expect, it } from 'vitest';
import { fastRng, isPerfect } from '@maze/shared';
import { FREE, Game, HEAD, VISITED } from '../src/engine';
import { enumerateCorridorMazes } from '../src/exact';
import { Posterior, samplePosteriorMaze, WilsonScratch } from '../src/posterior';
import { consistentMazes, econFor, exitBelow, mazeAt, visitedCells } from './helpers';

const grid3 = enumerateCorridorMazes(3, 3);
const grid4 = enumerateCorridorMazes(4, 4);

/** Largest |q − enumeration| over the children of the game's current position. */
function posteriorError(e: typeof grid3, g: Game, posterior: Posterior, q: Float64Array): number {
  const consistent = consistentMazes(e, g);
  const visited = visitedCells(g);
  posterior.childPosterior(g, q);
  let worst = 0;
  for (let i = 0; i < g.nc; i++) {
    const below = consistent.filter((index) => exitBelow(mazeAt(e, index), e.w, g.childCell[i], visited)).length;
    worst = Math.max(worst, Math.abs(below / consistent.length - q[i]));
  }
  return worst;
}

describe('posterior q_c', () => {
  it('equals the enumeration at every information state of the 3×3 grid', () => {
    // Establishes: q_c = P(exit below c | everything seen), exactly, for all 112 mazes and every walk in them.
    const g = new Game(econFor(3, 3, 20_000));
    const posterior = new Posterior(3, 3);
    const q = new Float64Array(4);
    const rng = fastRng(1n);
    let states = 0;
    let worst = 0;
    const walk = (open: Uint8Array, choices: number[]): void => {
      g.begin(open, rng);
      for (const choice of choices) g.advance(choice);
      if (g.cell === g.exit || g.nc === 0) return;
      states += 1;
      worst = Math.max(worst, posteriorError(grid3, g, posterior, q));
      const branches = g.nc;
      for (let i = 0; i < branches; i++) walk(open, [...choices, i]);
    };
    for (let index = 0; index < grid3.count; index++) walk(mazeAt(grid3, index), []);
    expect(states).toBeGreaterThan(300);
    expect(worst).toBeLessThan(1e-12);
  });

  it('equals the enumeration at the states of 300 random walks on the 4×4 grid', () => {
    const g = new Game(econFor(4, 4, 20_000));
    const posterior = new Posterior(4, 4);
    const q = new Float64Array(4);
    const rng = fastRng(2n);
    let worst = 0;
    for (let trial = 0; trial < 300; trial++) {
      g.begin(mazeAt(grid4, rng.nextBelow(grid4.count)), rng);
      while (g.cell !== g.exit && g.nc > 0) {
        worst = Math.max(worst, posteriorError(grid4, g, posterior, q));
        g.advance(rng.nextBelow(g.nc));
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('the log-determinant counts the mazes: 56, 30,016 and 1,241,844 per start direction', () => {
    // Establishes: exp(logTrees) is the number of spanning trees of the conditioned graph (matrix-tree theorem).
    for (const [w, h, perDirection] of [
      [3, 3, 56],
      [4, 4, 30_016],
      [5, 4, 1_241_844],
    ]) {
      const status = new Uint8Array(w * h);
      status[0] = VISITED;
      status[1] = HEAD;
      const posterior = new Posterior(w, h);
      expect(posterior.factor(status)).toBe(true);
      expect(Math.exp(posterior.logTrees)).toBeCloseTo(perDirection, 4);
    }
    expect(grid3.count).toBe(112);
    expect(grid4.count).toBe(60_032);
  });

  it('a child that is the exit has posterior 1 and its siblings 0', () => {
    const g = new Game(econFor(3, 3, 20_000));
    const posterior = new Posterior(3, 3);
    const q = new Float64Array(4);
    const rng = fastRng(3n);
    let checked = 0;
    for (let index = 0; index < grid3.count; index++) {
      g.begin(mazeAt(grid3, index), rng);
      while (g.cell !== g.exit && g.nc > 0) {
        let exitChild = -1;
        for (let i = 0; i < g.nc; i++) if (g.childCell[i] === g.exit) exitChild = i;
        if (exitChild >= 0) {
          posterior.childPosterior(g, q);
          for (let i = 0; i < g.nc; i++) expect(q[i]).toBe(i === exitChild ? 1 : 0);
          checked += 1;
        }
        g.advance(0);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('a graph with a free cell cut off from the root has no spanning tree', () => {
    // 3×3: the centre is free and all four of its neighbours are visited.
    const status = new Uint8Array(9).fill(VISITED);
    status[4] = FREE;
    const posterior = new Posterior(3, 3);
    expect(posterior.factor(status)).toBe(false);
    expect(posterior.logTrees).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('conditional Wilson', () => {
  it('samples exactly the mazes consistent with the observations, uniformly', () => {
    // Establishes: the rollout bot's sampled mazes come from the exact posterior.
    const g = new Game(econFor(3, 3, 20_000));
    const rng = fastRng(4n);
    const scratch = new WilsonScratch(9);
    const out = new Uint8Array(9);
    const keyOf = (open: Uint8Array): string => Array.from(open).join(',');
    let states = 0;
    for (const mazeIndex of [0, 17, 60, 111]) {
      g.begin(mazeAt(grid3, mazeIndex), rng);
      for (let step = 0; step < 2 && g.nc > 0 && g.cell !== g.exit; step++) {
        const consistent = new Map(consistentMazes(grid3, g).map((index) => [keyOf(mazeAt(grid3, index)), 0]));
        const samples = 4000 * consistent.size;
        for (let s = 0; s < samples; s++) {
          samplePosteriorMaze(g, rng, scratch, out);
          const key = keyOf(out);
          expect(consistent.has(key)).toBe(true);
          consistent.set(key, consistent.get(key)! + 1);
        }
        // 4,000 expected per maze; sd ≈ 63, so 10% is more than six standard deviations.
        for (const count of consistent.values()) expect(Math.abs(count - 4000)).toBeLessThan(400);
        expect(isPerfect({ w: 3, h: 3, open: out })).toBe(true);
        states += 1;
        g.advance(0);
      }
    }
    expect(states).toBeGreaterThanOrEqual(4);
  });
});
