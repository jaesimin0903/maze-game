// value-lookahead-all (plan §3.3): value-lsm's table with the exact one-step lookahead applied
// to every child at every decision, including decisions with a single child. Used only for
// fixed gate 2 (paired against value-lsm on stream D).

import type { Game } from '../engine';
import type { ValueTable } from '../lsm';
import type { Bot } from './types';
import { VALUE_LOOKAHEAD_ALL_HYPER, ValueBot } from './value-core';

export function valueLookaheadAllBot(g: Game, table: ValueTable): Bot {
  return new ValueBot(g, table, VALUE_LOOKAHEAD_ALL_HYPER);
}
