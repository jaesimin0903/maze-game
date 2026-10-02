// junction-quit(j) (plan §3.3): walk by naiveChoice. If the first junction (two or more forward
// openings) is met after at most `j` moves, cash out there; otherwise play to the end.

import { CASH_OUT, type Game } from '../engine';
import { naiveChoice } from './naive';
import type { Bot } from './types';

export class JunctionQuit implements Bot {
  private seenJunction = false;

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`junction-quit: j must be a positive integer, got ${limit}`);
  }

  begin(): void {
    this.seenJunction = false;
  }

  decide(g: Game): number {
    if (!this.seenJunction && g.nc >= 2) {
      this.seenJunction = true;
      if (g.k <= this.limit) return CASH_OUT;
    }
    return naiveChoice(g);
  }
}
