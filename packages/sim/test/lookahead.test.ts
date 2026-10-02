// AC-T1 (unit part): the probabilities P(m) of the exact one-step lookahead agree with the full
// enumeration of the 4×4 grid, and so do the posteriors after each observation.

import { describe, expect, it } from 'vitest';
import { fastRng, generateGridFromRng } from '@maze/shared';
import { BIT, Game } from '../src/engine';
import { enumerateCorridorMazes, type EnumeratedMazes } from '../src/exact';
import { lookaheadByLogDeterminant, Posterior } from '../src/posterior';
import { consistentMazes, econFor, exitBelow, mazeAt, visitedCells } from './helpers';

const grid4 = enumerateCorridorMazes(4, 4);

interface PatternCheck {
  probability: number;
  posterior: number;
  sum: number;
  patterns: number;
}

/**
 * For every child of the current position and every open/closed pattern of its unknown edges:
 * the share of consistent mazes showing that pattern, and among those the share with the exit
 * below each opened neighbour, against both implementations.
 */
function checkPosition(e: EnumeratedMazes, g: Game, posterior: Posterior, q: Float64Array, worst: PatternCheck): void {
  const cells = e.w * e.h;
  const offset = [-e.w, 1, e.w, -1];
  const consistent = consistentMazes(e, g);
  const visited = visitedCells(g);
  for (let i = 0; i < g.nc; i++) {
    const child = g.childCell[i];
    if (child === g.exit) continue;
    const reference = lookaheadByLogDeterminant(g, child);
    posterior.childPosterior(g, q);
    const unknown = posterior.prepareChild(g, child);
    expect(Array.from(posterior.patternCell.subarray(0, unknown))).toEqual(reference.cells);
    const afterMove = visited.slice();
    afterMove[child] = 1;
    let sum = 0;
    for (let mask = 0; mask < 1 << unknown; mask++) {
      let matching = 0;
      const below = new Array<number>(unknown).fill(0);
      for (const index of consistent) {
        const open = mazeAt(e, index);
        let same = true;
        for (let a = 0; a < unknown && same; a++) {
          const dir = offset.indexOf(posterior.patternCell[a] - child);
          same = ((open[child] & BIT[dir]) !== 0) === (((mask >> a) & 1) === 1);
        }
        if (!same) continue;
        matching += 1;
        for (let a = 0; a < unknown; a++) {
          if (((mask >> a) & 1) === 1 && exitBelow(open, e.w, posterior.patternCell[a], afterMove)) below[a] += 1;
        }
      }
      const fast = posterior.pattern(mask);
      const byDeterminant = reference.patterns[mask].probability;
      sum += fast;
      worst.patterns += 1;
      worst.probability = Math.max(worst.probability, Math.abs(matching / consistent.length - fast), Math.abs(matching / consistent.length - byDeterminant));
      if (matching === 0) {
        expect(fast).toBe(0);
        continue;
      }
      for (let a = 0; a < unknown; a++) {
        if (((mask >> a) & 1) === 0) continue;
        worst.posterior = Math.max(
          worst.posterior,
          Math.abs(below[a] / matching - posterior.patternQ[a]),
          Math.abs(below[a] / matching - reference.patterns[mask].q[a]),
        );
      }
    }
    worst.sum = Math.max(worst.sum, Math.abs(sum - 1));
    expect(cells).toBe(g.cells);
  }
}

describe('AC-T1 lookahead probabilities', () => {
  it('AC-T1 P(m) and the posterior after m equal the 4×4 enumeration (400 random walks, every child, every pattern)', () => {
    // Establishes: the spanning-tree count ratios, by banded log-determinant and by the
    // Green's-function update the bots use, are the true conditional probabilities.
    const g = new Game(econFor(4, 4, 20_000));
    const posterior = new Posterior(4, 4);
    const q = new Float64Array(4);
    const rng = fastRng(11n);
    const worst: PatternCheck = { probability: 0, posterior: 0, sum: 0, patterns: 0 };
    for (let trial = 0; trial < 400; trial++) {
      g.begin(mazeAt(grid4, rng.nextBelow(grid4.count)), rng);
      while (g.cell !== g.exit && g.nc > 0) {
        checkPosition(grid4, g, posterior, q, worst);
        g.advance(rng.nextBelow(g.nc));
      }
    }
    expect(worst.patterns).toBeGreaterThan(5000);
    expect(worst.probability).toBeLessThan(1e-12);
    expect(worst.posterior).toBeLessThan(1e-12);
    expect(worst.sum).toBeLessThan(1e-12);
  });

  it('the two implementations agree on the game sizes 5×5, 7×7 and 10×10', () => {
    // Establishes: the fast update is the same function as the definition where enumeration is impossible.
    for (const n of [5, 7, 10]) {
      const g = new Game(econFor(n, n, 20_000));
      const posterior = new Posterior(n, n);
      const q = new Float64Array(4);
      const rng = fastRng(BigInt(100 + n));
      let worstProbability = 0;
      let worstPosterior = 0;
      let worstSum = 0;
      for (let trial = 0; trial < 120; trial++) {
        g.begin(generateGridFromRng(rng, n, n).open, rng);
        while (g.cell !== g.exit && g.nc > 0) {
          for (let i = 0; i < g.nc; i++) {
            const child = g.childCell[i];
            if (child === g.exit) continue;
            const reference = lookaheadByLogDeterminant(g, child);
            posterior.childPosterior(g, q);
            const unknown = posterior.prepareChild(g, child);
            let sum = 0;
            for (let mask = 0; mask < 1 << unknown; mask++) {
              const fast = posterior.pattern(mask);
              sum += fast;
              worstProbability = Math.max(worstProbability, Math.abs(fast - reference.patterns[mask].probability));
              if (fast === 0) continue;
              for (let a = 0; a < unknown; a++) {
                if ((mask >> a) & 1) worstPosterior = Math.max(worstPosterior, Math.abs(posterior.patternQ[a] - reference.patterns[mask].q[a]));
              }
            }
            worstSum = Math.max(worstSum, Math.abs(sum - 1));
          }
          g.advance(rng.nextBelow(g.nc));
        }
      }
      expect(worstProbability).toBeLessThan(1e-10);
      expect(worstPosterior).toBeLessThan(1e-10);
      expect(worstSum).toBeLessThan(1e-10);
    }
  });
});
