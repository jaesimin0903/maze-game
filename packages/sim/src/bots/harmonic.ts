// harmonic (plan §3.3): move to the child with the largest exact posterior q_c; never cashes
// out. Ties: the smaller distance to the exit, then the order N, E, S, W.

import type { Game } from '../engine';
import { Posterior } from '../posterior';
import type { Bot } from './types';

/** Two posteriors closer than this are the same number up to rounding. */
export const Q_TIE = 1e-9;

/** The child with the largest `q`; ties go to the smaller distance, then to the earlier direction. */
export function harmonicChoice(g: Game, q: Float64Array): number {
  let best = 0;
  for (let i = 1; i < g.nc; i++) {
    const diff = q[i] - q[best];
    if (diff > Q_TIE || (diff >= -Q_TIE && g.dist[g.childCell[i]] < g.dist[g.childCell[best]])) best = i;
  }
  return best;
}

export class Harmonic implements Bot {
  private readonly posterior: Posterior;
  private readonly q = new Float64Array(4);

  constructor(g: Game) {
    this.posterior = new Posterior(g.w, g.h);
  }

  begin(): void {}

  decide(g: Game): number {
    // A single opening needs no posterior: there is nothing to choose and nothing to stop for.
    if (g.nc === 1) return 0;
    this.posterior.childPosterior(g, this.q);
    return harmonicChoice(g, this.q);
  }
}
