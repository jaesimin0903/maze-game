// immediate-cashout (plan §3.3): cash out before the first move.

import { CASH_OUT } from '../engine';
import type { Bot } from './types';

export class ImmediateCashout implements Bot {
  begin(): void {}

  decide(): number {
    return CASH_OUT;
  }
}
