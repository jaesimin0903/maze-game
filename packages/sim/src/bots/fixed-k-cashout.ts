// fixed-k-cashout(k) (plan §3.3): walk by naiveChoice and cash out after `k` moves.

import { CASH_OUT, type Game } from '../engine';
import { naiveChoice } from './naive';
import type { Bot } from './types';

export class FixedKCashout implements Bot {
  constructor(private readonly steps: number) {
    if (!Number.isInteger(steps) || steps < 0) throw new RangeError(`fixed-k-cashout: k must be a non-negative integer, got ${steps}`);
  }

  begin(): void {}

  decide(g: Game): number {
    return g.k >= this.steps ? CASH_OUT : naiveChoice(g);
  }
}
