// harmonic-lsm (plan §3.3): moves like harmonic; cashes out when the backward-induction table
// says that continuing from the chosen afterstate (k + 1, bin(q), d) is worth less than
// refund(k). A member of the certified suite, not the calibration reference.

import { CASH_OUT, type Game } from '../engine';
import { lookup, type ValueTable } from '../lsm';
import { Posterior } from '../posterior';
import { harmonicChoice } from './harmonic';
import type { Bot } from './types';

export class HarmonicLsm implements Bot {
  private readonly posterior: Posterior;
  private readonly q = new Float64Array(4);

  constructor(
    g: Game,
    private readonly table: ValueTable,
  ) {
    if (table.cells !== g.cells || table.shortest !== g.shortest) {
      throw new RangeError('harmonic-lsm: the table was trained for a different grid');
    }
    this.posterior = new Posterior(g.w, g.h);
  }

  begin(): void {}

  decide(g: Game): number {
    this.posterior.childPosterior(g, this.q);
    const move = harmonicChoice(g, this.q);
    const child = g.childCell[move];
    if (child === g.exit) return move;
    const value = lookup(this.table, g.k + 1, this.q[move], g.dist[child], 0, g.multiplierBps);
    return value < g.refund[g.k] ? CASH_OUT : move;
  }
}
