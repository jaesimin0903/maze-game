// What an agent can know about its game from the walls it has seen (sim/posterior.ts).
//
// The server shows only the open sides of visited cells. From those, the exact posterior gives,
// for each forward opening of the current cell, the probability that the exit lies beyond it.
// Their sum is the probability that the exit can still be reached at all: the rest of the mass
// sits behind openings passed earlier, which a player can no longer go back to.

import type { Dir, GameView, Rng, TierConfig } from '@maze/shared';
import { Game } from '@maze/sim/src/engine';
import { Posterior } from '@maze/sim/src/posterior';

export const DIR_NAMES = ['N', 'E', 'S', 'W'] as const;
export type DirName = (typeof DIR_NAMES)[number];

/** One visited cell as `GET /api/games/:id` lists it. */
export type ObservedCell = NonNullable<GameView['path']>[number];

export interface Option {
  dir: DirName;
  /** Probability that the exit lies beyond this opening, given every wall seen so far. */
  exitProbability: number;
}

export interface Advice {
  step: number;
  /** Forward openings of the current cell, N, E, S, W order. Empty at a dead end. */
  options: Option[];
  /** Probability that the exit can still be reached: the sum over `options`. */
  reachable: number;
  /** The opening with the largest `exitProbability`, or `null` when there is none. */
  best: DirName | null;
  /** Refund for cashing out now, in basis points of the bet. */
  refundNowBps: number;
  /** Refund for cashing out one move later, in basis points of the bet. */
  refundNextBps: number | null;
  multiplierBps: number;
}

const NO_RNG: Rng = { nextU32: () => 0, nextBelow: () => 0 };

/** The simulator's game state rebuilt from the cells the player has visited, in visiting order. */
export function rebuildGame(tier: TierConfig, path: readonly ObservedCell[]): Game {
  const n = tier.n;
  if (path.length === 0 || path[0].x !== 0 || path[0].y !== 0) {
    throw new Error('the path must start on the start cell (0, 0)');
  }
  const g = new Game({ w: n, h: n, multiplierBps: tier.multiplierBps, refundBps: tier.refundBps });
  // Unvisited cells stay 0: the engine and the posterior read `open` only at visited cells.
  const open = new Uint8Array(n * n);
  for (const cell of path) open[cell.y * n + cell.x] = cell.open;
  g.begin(open, NO_RNG);
  for (let i = 1; i < path.length; i++) {
    const cell = path[i].y * n + path[i].x;
    let child = -1;
    for (let c = 0; c < g.nc; c++) if (g.childCell[c] === cell) child = c;
    if (child === -1) throw new Error(`visited cell (${path[i].x}, ${path[i].y}) is not a forward opening`);
    g.advance(child);
  }
  return g;
}

export function advise(tier: TierConfig, path: readonly ObservedCell[]): Advice {
  const g = rebuildGame(tier, path);
  const q = new Float64Array(4);
  if (g.nc > 0) new Posterior(g.w, g.h).childPosterior(g, q);
  const options: Option[] = [];
  let reachable = 0;
  let best: Option | null = null;
  for (let c = 0; c < g.nc; c++) {
    const option = { dir: DIR_NAMES[g.childDir[c]], exitProbability: q[c] };
    options.push(option);
    reachable += q[c];
    if (best === null || option.exitProbability > best.exitProbability) best = option;
  }
  return {
    step: g.k,
    options,
    reachable: Math.min(1, reachable),
    best: best?.dir ?? null,
    refundNowBps: tier.refundBps[g.k],
    refundNextBps: g.k + 1 < tier.refundBps.length ? tier.refundBps[g.k + 1] : null,
    multiplierBps: tier.multiplierBps,
  };
}

export function dirOf(name: DirName): Dir {
  return DIR_NAMES.indexOf(name) as Dir;
}
