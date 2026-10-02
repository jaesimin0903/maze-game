// naive-greedy (plan §3.3): naiveChoice at every cell, never cashes out.

import type { Game } from '../engine';
import { naiveChoice } from './naive';
import type { Bot } from './types';

export class NaiveGreedy implements Bot {
  begin(): void {}

  decide(g: Game): number {
    return naiveChoice(g);
  }
}
