// start-selective(s) (plan §3.3): cash out at k = 0 unless the start cell opens toward `s`
// (east or south); otherwise play naive-greedy.

import { CASH_OUT, type Game } from '../engine';
import { naiveChoice } from './naive';
import type { Bot } from './types';

export class StartSelective implements Bot {
  private readonly dir: number;

  constructor(side: 'E' | 'S') {
    this.dir = side === 'E' ? 1 : 2;
  }

  begin(): void {}

  decide(g: Game): number {
    if (g.k === 0 && g.childDir[0] !== this.dir) return CASH_OUT;
    return naiveChoice(g);
  }
}
