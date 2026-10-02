// Exact computation on 3×3, 4×4 and 5×4: enumeration, the optimal policy and the exactness gate.

import { describe, expect, it } from 'vitest';
import { isPerfect } from '@maze/shared';
import { createBot, type Bot } from '../src/bots/index';
import { CASH_OUT, Game, runGames, type MazeSource } from '../src/engine';
import {
  ASYMMETRY_MINIMUM,
  BOT_VARIANTS,
  enumerateCorridorMazes,
  exactBranch,
  exactGateGrid,
  exactOptimal,
  exactRtp,
  SYMMETRY_TOLERANCE,
  type EnumeratedMazes,
} from '../src/exact';
import { CURVE_II, consistentMazes, econFor, mazeAt, temporaryDirectory, testRunner } from './helpers';

const grid3 = enumerateCorridorMazes(3, 3);
const grid4 = enumerateCorridorMazes(4, 4);
const grid54 = enumerateCorridorMazes(5, 4);

function enumSource(e: EnumeratedMazes): MazeSource {
  return { kind: 'enum', stream: 'B', mazes: e.mazes, count: e.count };
}

/**
 * The optimal policy written from its definition, without the in-place partitioning of the
 * implementation: mazes are grouped with a Map by what a cell turns out to look like, and the
 * value of a position is the larger of cashing out and of the best child, a child being worth
 * the sum of the values of the positions it can lead to.
 */
class BruteForceOptimal implements Bot {
  constructor(private readonly e: EnumeratedMazes) {}

  begin(): void {}

  /** Total value (bps summed over `mazes`) of standing on the last cell of `path`, and the best action there. */
  value(mazes: number[], path: number[], k: number, g: Game): { total: number; action: number } {
    const { e } = this;
    const cell = path[path.length - 1];
    const open = mazeAt(e, mazes[0]);
    const offset = [-e.w, 1, e.w, -1];
    const children: number[] = [];
    for (let dir = 0; dir < 4; dir++) {
      if ((open[cell] & (1 << dir)) === 0) continue;
      const next = cell + offset[dir];
      if (!path.includes(next)) children.push(next);
    }
    let best = g.refund[k] * mazes.length;
    let action = CASH_OUT;
    children.forEach((child, index) => {
      let total = 0;
      if (child === g.exit) {
        total = g.multiplierBps * mazes.length;
      } else {
        const groups = new Map<number, number[]>();
        for (const maze of mazes) {
          const mask = mazeAt(e, maze)[child];
          const group = groups.get(mask);
          if (group === undefined) groups.set(mask, [maze]);
          else group.push(maze);
        }
        for (const [mask, group] of groups) {
          const openings = [1, 2, 4, 8].filter((bit) => (mask & bit) !== 0).length;
          if (openings > 1) total += this.value(group, [...path, child], k + 1, g).total;
        }
      }
      if (total > best) {
        best = total;
        action = index;
      }
    });
    return { total: best, action };
  }

  /** Value of the whole grid: the two start directions are separate information states. */
  rootValue(g: Game): number {
    const east: number[] = [];
    const south: number[] = [];
    for (let i = 0; i < this.e.count; i++) (mazeAt(this.e, i)[0] === 2 ? east : south).push(i);
    return this.value(east, [0], 0, g).total + this.value(south, [0], 0, g).total;
  }

  decide(g: Game): number {
    const path = Array.from(g.path.subarray(0, g.k + 1));
    return this.value(consistentMazes(this.e, g), path, g.k, g).action;
  }
}

describe('enumeration', () => {
  it('finds 112, 60,032 and 2,483,688 mazes, half opening east and half south', () => {
    // Establishes: the enumeration covers exactly the mazes the generator can produce (plan §2.4).
    expect(grid3.count).toBe(112);
    expect(grid4.count).toBe(60_032);
    expect(grid54.count).toBe(2_483_688);
    for (const e of [grid3, grid4, grid54]) {
      let east = 0;
      for (let i = 0; i < e.count; i++) if (e.mazes[i * e.w * e.h] === 2) east += 1;
      expect(east).toBe(e.count / 2);
    }
  });

  it('every enumerated maze is a perfect maze with a start corridor, and no maze appears twice', () => {
    for (const e of [grid3, grid4]) {
      const seen = new Set<string>();
      for (let i = 0; i < e.count; i++) {
        const open = mazeAt(e, i);
        if (i % 97 === 0 || e === grid3) expect(isPerfect({ w: e.w, h: e.h, open })).toBe(true);
        expect([2, 4]).toContain(open[0]);
        seen.add(Array.from(open).join(','));
      }
      expect(seen.size).toBe(e.count);
    }
  });
});

describe('exact-optimal', () => {
  it('equals a brute-force expectimax played through the engine on all 112 mazes of 3×3', () => {
    // Establishes: the optimal value, and that the engine pays what the optimal policy expects.
    for (const multiplierBps of [11_939, 15_000, 20_000, 40_000]) {
      const econ = econFor(3, 3, multiplierBps);
      const g = new Game(econ);
      const played = runGames(g, new BruteForceOptimal(grid3), enumSource(grid3), 0, grid3.count);
      expect(exactOptimal(grid3, econ).totalBps).toBe(played.sum);
    }
  });

  it('equals the definition-based expectimax on all 60,032 mazes of 4×4', () => {
    // Establishes: the in-place partitioned recursion computes the same value as the plain recurrence.
    for (const multiplierBps of [17_200, 30_000]) {
      const econ = econFor(4, 4, multiplierBps);
      expect(exactOptimal(grid4, econ).totalBps).toBe(new BruteForceOptimal(grid4).rootValue(new Game(econ)));
    }
  });

  it('no legal bot beats it, and the illegal oracle does', () => {
    const econ = econFor(4, 4, 17_200);
    const g = new Game(econ);
    const optimal = exactOptimal(grid4, econ).totalBps;
    for (const spec of [
      { bot: 'immediate-cashout' },
      { bot: 'one-step-cashout' },
      { bot: 'naive-greedy' },
      { bot: 'harmonic' },
      { bot: 'fixed-k-cashout', k: 3 },
      { bot: 'junction-quit', j: 2 },
      { bot: 'start-selective', side: 'E' },
    ] as const) {
      const stats = runGames(g, createBot(spec, g), enumSource(grid4), 0, grid4.count);
      expect(stats.sum).toBeLessThanOrEqual(optimal);
    }
    const oracle = runGames(g, createBot({ bot: 'oracle-stop' }, g), enumSource(grid4), 0, grid4.count);
    expect(oracle.sum).toBeGreaterThan(optimal);
  });

  it('cashes out at once when the multiplier is too low to play, and its value never falls as the multiplier rises', () => {
    const low = exactOptimal(grid4, econFor(4, 4, 10_000));
    expect(exactRtp(low)).toBe(0.95);
    let previous = 0;
    for (const multiplierBps of [10_000, 15_000, 17_000, 18_000, 25_000]) {
      const value = exactOptimal(grid4, econFor(4, 4, multiplierBps)).totalBps;
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('AC-X8 the optimal value is the same for both start directions on 3×3 and 4×4 and differs on 5×4', () => {
    // Establishes: seeing the start direction gives no edge on square grids. 5×4 is the negative
    // control: there the two directions are not mirror images and the values must differ.
    for (const [e, multiplierBps] of [
      [grid3, 15_000],
      [grid4, 17_200],
    ] as const) {
      const v = exactOptimal(e, econFor(e.w, e.h, multiplierBps));
      expect(Math.abs(v.eastBps / v.eastCount - v.southBps / v.southCount) / 10_000).toBeLessThanOrEqual(SYMMETRY_TOLERANCE);
    }
    const v = exactOptimal(grid54, econFor(5, 4, 21_000));
    expect(Math.abs(v.eastBps / v.eastCount - v.southBps / v.southCount) / 10_000).toBeGreaterThan(ASYMMETRY_MINIMUM);
  });
});

describe('AC-T1 exactness gate', () => {
  it('AC-T1 value-lsm calibrated to an exact 96.00% leaves the optimum within 0.50 points on 3×3 and 4×4', async () => {
    // Establishes, at a reduced training size (each 4×4 maze once per pass instead of 17 times):
    // the calibration lands at or just under 96.00% and the exact optimum is within the gate.
    // The full gate, with 5×4 and production training sizes, is `pnpm sim:exact`.
    const runner = testRunner(temporaryDirectory(), { exactTrainGames: 60_032 });
    for (const [w, h] of [
      [3, 3],
      [4, 4],
    ]) {
      const grid = await exactGateGrid(runner, CURVE_II, w, h, BOT_VARIANTS[0]);
      expect(grid.botRtp).toBeLessThanOrEqual(0.96);
      expect(grid.botRtp).toBeGreaterThan(0.9595);
      expect(grid.optimalRtp).toBeGreaterThanOrEqual(grid.botRtp);
      expect(grid.gap).toBeLessThanOrEqual(0.005);
      expect(grid.gapToBot).toBeCloseTo(grid.optimalRtp - grid.botRtp, 12);
      if (w === 3) expect(grid.gap).toBeLessThan(0.0005);
      // A second call is answered from the cache with the same numbers.
      expect(await exactGateGrid(runner, CURVE_II, w, h, BOT_VARIANTS[0])).toEqual(grid);
    }
  }, 900_000);

  it('AC-T1 the verdict follows the failure branches of plan §3.3', () => {
    // Pass: every gap within 0.50 points.
    expect(exactBranch({ '3x3': 0, '4x4': 0.0005, '5x4': 0.0014 }, 0)).toMatchObject({ pass: true, branch: 'pass', ceilingBps: 9600, e0Bps: 500 });
    expect(exactBranch({ '3x3': 0, '4x4': 0.004, '5x4': 0.005 }, 0).branch).toBe('pass');
    // Branch 1: a stronger bot is still untried.
    for (const level of [0, 1, 2]) expect(exactBranch({ '3x3': 0, '4x4': 0.004, '5x4': 0.0051 }, level).branch).toBe('improve-bot');
    // Branch 2 after the last improvement: gap <= 2.0 points and not growing by more than 0.25 points.
    expect(exactBranch({ '3x3': 0, '4x4': 0.01, '5x4': 0.012 }, 3)).toMatchObject({ pass: false, branch: 'lower-ceiling', ceilingBps: 9530, e0Bps: 570 });
    expect(exactBranch({ '3x3': 0.0127, '4x4': 0.0051, '5x4': 0.007 }, 3)).toMatchObject({ branch: 'lower-ceiling', ceilingBps: 9523, e0Bps: 577 });
    // Branch 3: growing trend, or a gap above 2.0 points.
    expect(exactBranch({ '3x3': 0, '4x4': 0.01, '5x4': 0.0126 }, 3).branch).toBe('blocked');
    expect(exactBranch({ '3x3': 0, '4x4': 0.019, '5x4': 0.0201 }, 3).branch).toBe('blocked');
    // The reviewers' posterior-argmax bot (1.27 / 0.51 / 0.90 points) is rejected at every level it is tried at.
    expect(exactBranch({ '3x3': 0.0127, '4x4': 0.0051, '5x4': 0.009 }, 0).branch).toBe('improve-bot');
    expect(exactBranch({ '3x3': 0.0127, '4x4': 0.0051, '5x4': 0.009 }, 3).branch).toBe('blocked');
  });

  it('the improvement ladder is cumulative and level 2 cannot differ from level 1', () => {
    expect(BOT_VARIANTS.map((variant) => variant.level)).toEqual([0, 1, 2, 3]);
    expect(BOT_VARIANTS[0].hyper).toEqual({ lookahead: 'near-tie', threshold: 0.2 });
    expect(BOT_VARIANTS[1].hyper.lookahead).toBe('all');
    expect(BOT_VARIANTS[2].hyper).toEqual(BOT_VARIANTS[1].hyper);
    expect(BOT_VARIANTS[3].rBins).toBeGreaterThan(1);
  });
});
