// nervous(ε) (plan §3.3): moves like sloppy-greedy(ε). Right after every move that leaves the
// game in progress (k >= 1) it cashes out with probability 1 / L, L = shortest path length.

import { CASH_OUT, type Game } from '../engine';
import { epsilonThreshold, sloppyMove } from './sloppy-greedy';
import type { Bot } from './types';

export class Nervous implements Bot {
  private readonly threshold: number;

  constructor(epsilon: number) {
    this.threshold = epsilonThreshold(epsilon);
  }

  begin(): void {}

  decide(g: Game): number {
    if (g.k >= 1 && g.rng.nextBelow(g.shortest) === 0) return CASH_OUT;
    return sloppyMove(g, this.threshold);
  }
}
