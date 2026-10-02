// value-table (plan §3.3): value-lsm without the lookahead. It always moves and cashes out on
// the table values of the children (rule 3 of `value-core`).

import type { Game } from '../engine';
import type { ValueTable } from '../lsm';
import type { Bot } from './types';
import { VALUE_TABLE_HYPER, ValueBot } from './value-core';

export function valueTableBot(g: Game, table: ValueTable): Bot {
  return new ValueBot(g, table, VALUE_TABLE_HYPER);
}
