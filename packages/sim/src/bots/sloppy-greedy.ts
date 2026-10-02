// sloppy-greedy(ε) (plan §3.3): at a junction, with probability ε pick uniformly among the
// forward openings; otherwise naiveChoice. Never cashes out.

import type { Game } from '../engine';
import { naiveChoice } from './naive';
import type { Bot } from './types';

/** `nextU32() < epsilonThreshold(ε)` happens with probability ε (to within 2^-32). */
export function epsilonThreshold(epsilon: number): number {
  if (!(epsilon >= 0 && epsilon <= 1)) throw new RangeError(`epsilon must be inside [0, 1], got ${epsilon}`);
  return Math.floor(epsilon * 0x1_0000_0000);
}

/** The move rule shared by sloppy-greedy and nervous. */
export function sloppyMove(g: Game, threshold: number): number {
  if (g.nc === 1) return 0;
  if (g.rng.nextU32() < threshold) return g.rng.nextBelow(g.nc);
  return naiveChoice(g);
}

export class SloppyGreedy implements Bot {
  private readonly threshold: number;

  constructor(epsilon: number) {
    this.threshold = epsilonThreshold(epsilon);
  }

  begin(): void {}

  decide(g: Game): number {
    return sloppyMove(g, this.threshold);
  }
}
