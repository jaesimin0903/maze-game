// oracle-stop (plan §3.3): moves like harmonic and cashes out the moment it has left the
// solution path. It reads the whole maze, which no player can: it is a diagnostic upper
// reference and is excluded from every gate.

import { CASH_OUT, markSolution, SolutionScratch, type Game } from '../engine';
import { Posterior } from '../posterior';
import { harmonicChoice } from './harmonic';
import type { Bot } from './types';

export class OracleStop implements Bot {
  private readonly posterior: Posterior;
  private readonly q = new Float64Array(4);
  private readonly scratch: SolutionScratch;

  constructor(g: Game) {
    this.posterior = new Posterior(g.w, g.h);
    this.scratch = new SolutionScratch(g.cells);
  }

  begin(g: Game): void {
    markSolution(g, g.open, this.scratch);
  }

  decide(g: Game): number {
    if (this.scratch.onPath[g.cell] === 0) return CASH_OUT;
    if (g.nc === 1) return 0;
    this.posterior.childPosterior(g, this.q);
    return harmonicChoice(g, this.q);
  }
}
