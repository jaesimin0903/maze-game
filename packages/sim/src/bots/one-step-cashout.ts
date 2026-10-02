// one-step-cashout (plan §3.3): make the one forced move, then cash out at k = 1.

import { CASH_OUT, type Game } from '../engine';
import type { Bot } from './types';

export class OneStepCashout implements Bot {
  begin(): void {}

  decide(g: Game): number {
    return g.k === 0 ? 0 : CASH_OUT;
  }
}
