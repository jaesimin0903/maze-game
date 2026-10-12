import { describe, expect, it } from 'vitest';
import { generateMaze, type Hex, type Rng, type TuningTable } from '@maze/shared';
import tuningJson from '@maze/shared/tuning.json';
import { harmonicChoice } from '@maze/sim/src/bots/harmonic';
import { Game } from '@maze/sim/src/engine';
import { Posterior } from '@maze/sim/src/posterior';
import { advise, DIR_NAMES, type ObservedCell } from '../src/advise';

const tuning = tuningJson as unknown as TuningTable;
const NO_RNG: Rng = { nextU32: () => 0, nextBelow: () => 0 };

function seed(i: number): Hex {
  return `0x${i.toString(16).padStart(64, '0')}`;
}

describe('advise', () => {
  it('gives the posterior the simulator computes, for every position of harmonic games', () => {
    for (const tier of tuning.tiers) {
      const n = tier.n;
      const posterior = new Posterior(n, n);
      const q = new Float64Array(4);
      for (let i = 1; i <= 20; i++) {
        const maze = generateMaze(seed(i * 7919 + n), n);
        const g = new Game({ w: n, h: n, multiplierBps: tier.multiplierBps, refundBps: tier.refundBps });
        g.begin(maze.open, NO_RNG);
        for (;;) {
          // What the server lists: the visited cells and their open sides, in visiting order.
          const path: ObservedCell[] = [];
          for (let k = 0; k <= g.k; k++) {
            const cell = g.path[k];
            path.push({ x: cell % n, y: Math.floor(cell / n), open: maze.open[cell] });
          }
          const advice = advise(tier, path);
          expect(advice.step).toBe(g.k);
          expect(advice.refundNowBps).toBe(tier.refundBps[g.k]);
          expect(advice.options.map((o) => o.dir)).toEqual(
            Array.from(g.childDir.subarray(0, g.nc), (d) => DIR_NAMES[d]),
          );
          if (g.nc === 0) break;
          posterior.childPosterior(g, q);
          let sum = 0;
          for (let c = 0; c < g.nc; c++) {
            expect(advice.options[c].exitProbability).toBeCloseTo(q[c], 12);
            sum += q[c];
          }
          expect(advice.reachable).toBeCloseTo(Math.min(1, sum), 12);
          g.advance(harmonicChoice(g, q));
          if (g.cell === g.exit) break;
        }
      }
    }
  });

  it('puts all the mass on the openings while no branch has been passed', () => {
    const tier = tuning.tiers[0];
    const maze = generateMaze(seed(1), tier.n);
    const advice = advise(tier, [{ x: 0, y: 0, open: maze.open[0] }]);
    expect(advice.options).toHaveLength(1);
    expect(advice.reachable).toBeCloseTo(1, 12);
  });

  it('refuses a path that does not follow the walls', () => {
    const tier = tuning.tiers[0];
    // The start cell opens east only, so (0, 1) cannot come next.
    expect(() =>
      advise(tier, [
        { x: 0, y: 0, open: 2 },
        { x: 0, y: 1, open: 1 },
      ]),
    ).toThrow(/not a forward opening/);
  });
});
