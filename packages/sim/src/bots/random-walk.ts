// random-walk (plan §3.3): uniform choice among the forward openings, never cashes out.
//
// Its win probability on a given maze is exactly the product of 1 / |C| along the solution
// path, so the engine scores it by that conditional expectation (`winProbability`) instead of
// by sampled games. `decide` is the sampled behaviour and is used by the tests that check the
// exact formula against it.

import { markSolution, SolutionScratch, type Game } from '../engine';
import type { Bot } from './types';

export class RandomWalk implements Bot {
  private readonly scratch: SolutionScratch;

  constructor(g: Game) {
    this.scratch = new SolutionScratch(g.cells);
  }

  begin(): void {}

  decide(g: Game): number {
    return g.nc === 1 ? 0 : g.rng.nextBelow(g.nc);
  }

  winProbability(g: Game, open: Uint8Array): number {
    return markSolution(g, open, this.scratch);
  }
}

/** The same walk scored by sampled games. */
export class SampledRandomWalk implements Bot {
  begin(): void {}

  decide(g: Game): number {
    return g.nc === 1 ? 0 : g.rng.nextBelow(g.nc);
  }
}
