// value-lsm (plan §3.3): the calibration reference bot. Afterstate table plus an exact one-step
// lookahead over the children whose posterior is within the threshold of the largest one.
//
// `hyper` defaults to the production setting (lookahead on near-ties, threshold 0.2). The
// exactness-gate failure branch may replace it: improvement (a) looks ahead at every decision,
// improvement (b) widens the threshold to 0.4.

import type { Game } from '../engine';
import type { ValueTable } from '../lsm';
import type { Bot } from './types';
import { VALUE_LSM_HYPER, ValueBot, type ValueHyper } from './value-core';

export function valueLsmBot(g: Game, table: ValueTable, hyper: ValueHyper = VALUE_LSM_HYPER): Bot {
  return new ValueBot(g, table, hyper);
}
