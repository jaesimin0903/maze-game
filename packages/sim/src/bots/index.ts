// Bot registry and the certified suite (plan §3.3).

import type { Game } from '../engine';
import type { RegionTable, ValueTable } from '../lsm';
import { FixedKCashout } from './fixed-k-cashout';
import { Harmonic } from './harmonic';
import { HarmonicLsm } from './harmonic-lsm';
import { ImmediateCashout } from './immediate-cashout';
import { JunctionQuit } from './junction-quit';
import { NaiveGreedy } from './naive-greedy';
import { Nervous } from './nervous';
import { OneStepCashout } from './one-step-cashout';
import { OracleStop } from './oracle-stop';
import { ParamSearch } from './param-search';
import { RandomWalk, SampledRandomWalk } from './random-walk';
import { RegionHeuristic } from './region-heuristic';
import { Rollout } from './rollout';
import { SloppyGreedy } from './sloppy-greedy';
import { StartSelective } from './start-selective';
import type { Bot } from './types';
import type { ValueHyper } from './value-core';
import { valueLookaheadAllBot } from './value-lookahead-all';
import { valueLsmBot } from './value-lsm';
import { valueTableBot } from './value-table';

export type { Bot } from './types';
export { canonicalHyper, VALUE_LSM_HYPER, VALUE_LOOKAHEAD_ALL_HYPER, type ValueHyper } from './value-core';

/** Everything needed to build a bot: its name, its parameters and, for the learning bots, its table. */
export type BotSpec =
  | { bot: 'immediate-cashout' }
  | { bot: 'one-step-cashout' }
  | { bot: 'fixed-k-cashout'; k: number }
  | { bot: 'junction-quit'; j: number }
  | { bot: 'start-selective'; side: 'E' | 'S' }
  | { bot: 'random-walk' }
  | { bot: 'random-walk-sampled' }
  | { bot: 'naive-greedy' }
  | { bot: 'sloppy-greedy'; epsilon: number }
  | { bot: 'nervous'; epsilon: number }
  | { bot: 'region-heuristic'; table: RegionTable }
  | { bot: 'param-search'; theta: number[] }
  | { bot: 'harmonic' }
  | { bot: 'harmonic-lsm'; table: ValueTable }
  | { bot: 'value-table'; table: ValueTable }
  | { bot: 'value-lsm'; table: ValueTable; hyper: ValueHyper }
  | { bot: 'value-lookahead-all'; table: ValueTable }
  | { bot: 'rollout'; samples: number; table: ValueTable }
  | { bot: 'oracle-stop' };

export type BotName = BotSpec['bot'];

/** Builds a bot for games played on `g`. */
export function createBot(spec: BotSpec, g: Game): Bot {
  switch (spec.bot) {
    case 'immediate-cashout':
      return new ImmediateCashout();
    case 'one-step-cashout':
      return new OneStepCashout();
    case 'fixed-k-cashout':
      return new FixedKCashout(spec.k);
    case 'junction-quit':
      return new JunctionQuit(spec.j);
    case 'start-selective':
      return new StartSelective(spec.side);
    case 'random-walk':
      return new RandomWalk(g);
    case 'random-walk-sampled':
      return new SampledRandomWalk();
    case 'naive-greedy':
      return new NaiveGreedy();
    case 'sloppy-greedy':
      return new SloppyGreedy(spec.epsilon);
    case 'nervous':
      return new Nervous(spec.epsilon);
    case 'region-heuristic':
      return new RegionHeuristic(g, spec.table);
    case 'param-search':
      return new ParamSearch(g, spec.theta);
    case 'harmonic':
      return new Harmonic(g);
    case 'harmonic-lsm':
      return new HarmonicLsm(g, spec.table);
    case 'value-table':
      return valueTableBot(g, spec.table);
    case 'value-lsm':
      return valueLsmBot(g, spec.table, spec.hyper);
    case 'value-lookahead-all':
      return valueLookaheadAllBot(g, spec.table);
    case 'rollout':
      return new Rollout(g, spec.table, spec.samples);
    case 'oracle-stop':
      return new OracleStop(g);
  }
}

/** A bot of a suite without its trained table: name plus fixed parameters. */
export type SuiteMember =
  | { bot: 'immediate-cashout' }
  | { bot: 'one-step-cashout' }
  | { bot: 'fixed-k-cashout'; k: number }
  | { bot: 'junction-quit'; j: number }
  | { bot: 'start-selective'; side: 'E' | 'S' }
  | { bot: 'random-walk' }
  | { bot: 'naive-greedy' }
  | { bot: 'sloppy-greedy'; epsilon: number }
  | { bot: 'nervous'; epsilon: number }
  | { bot: 'region-heuristic' }
  | { bot: 'param-search' }
  | { bot: 'harmonic' }
  | { bot: 'harmonic-lsm' }
  | { bot: 'value-table' }
  | { bot: 'value-lsm' }
  | { bot: 'value-lookahead-all' }
  | { bot: 'rollout'; samples: number };

export const SLOPPY_EPSILON = 0.1;
export const ROLLOUT_SAMPLES = 32;

/**
 * CERTIFIED_SUITE of plan §3.3 for a grid whose shortest path has `shortest` moves: the bots
 * that calibration and fixed gate 1 cover.
 */
export function certifiedSuite(shortest: number): SuiteMember[] {
  const suite: SuiteMember[] = [{ bot: 'immediate-cashout' }, { bot: 'one-step-cashout' }];
  for (let k = 2; k <= shortest; k++) suite.push({ bot: 'fixed-k-cashout', k });
  for (let j = 1; j <= 3; j++) suite.push({ bot: 'junction-quit', j });
  suite.push(
    { bot: 'start-selective', side: 'E' },
    { bot: 'start-selective', side: 'S' },
    { bot: 'random-walk' },
    { bot: 'naive-greedy' },
    { bot: 'sloppy-greedy', epsilon: SLOPPY_EPSILON },
    { bot: 'nervous', epsilon: SLOPPY_EPSILON },
    { bot: 'region-heuristic' },
    { bot: 'param-search' },
    { bot: 'harmonic' },
    { bot: 'harmonic-lsm' },
    { bot: 'value-table' },
    { bot: 'value-lsm' },
  );
  return suite;
}

/** GATE2_ONLY of plan §3.3: too slow for a full cell; judged by a paired comparison on stream D. */
export const GATE2_ONLY: SuiteMember[] = [{ bot: 'rollout', samples: ROLLOUT_SAMPLES }, { bot: 'value-lookahead-all' }];

/** Display name with parameters, e.g. `fixed-k-cashout(3)`. */
export function memberLabel(member: SuiteMember): string {
  switch (member.bot) {
    case 'fixed-k-cashout':
      return `fixed-k-cashout(${member.k})`;
    case 'junction-quit':
      return `junction-quit(${member.j})`;
    case 'start-selective':
      return `start-selective(${member.side})`;
    case 'sloppy-greedy':
      return `sloppy-greedy(${member.epsilon.toFixed(2)})`;
    case 'nervous':
      return `nervous(${member.epsilon.toFixed(2)})`;
    case 'rollout':
      return `rollout(${member.samples})`;
    default:
      return member.bot;
  }
}
