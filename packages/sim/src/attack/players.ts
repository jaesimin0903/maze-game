// Descriptions of the attack-lane players (plain data, so they can be sent to worker threads)
// and the factory that builds them.

import type { Bot } from '../bots/types';
import { valueLsmBot } from '../bots/value-lsm';
import type { Game } from '../engine';
import type { ValueTable } from '../lsm';
import { BookBot, type Book } from './book';
import { BookKeyer } from './book';
import { ExpectimaxBot, ParamBot, RolloutBot, type Deepening, type Opening, type RolloutOptions } from './bots';
import { OptimalBot } from './infostate';

export type AttackBotSpec =
  | { kind: 'value-lsm'; table: ValueTable }
  /** The exact Bayes-optimal player (the information-state DP, solved lazily); small grids only. */
  | { kind: 'optimal' }
  | { kind: 'expectimax'; table: ValueTable; depth: number; deepening?: Deepening; opening?: Opening }
  | { kind: 'rollout'; table: ValueTable; options: RolloutOptions }
  | { kind: 'param'; table: ValueTable; theta: number[] }
  | { kind: 'book'; table: ValueTable; book: Pick<Book, 'options' | 'overrides'> };

export function attackBotLabel(spec: AttackBotSpec): string {
  switch (spec.kind) {
    case 'value-lsm':
      return 'value-lsm';
    case 'optimal':
      return 'exact optimum';
    case 'expectimax': {
      let label =
        spec.deepening === undefined
          ? `expectimax(${spec.depth})`
          : `expectimax(${spec.depth} where contested within ${spec.deepening.margin} bets, else ${spec.deepening.shallow})`;
      if (spec.opening !== undefined) label += ` with expectimax(${spec.opening.depth}) at k<=${spec.opening.maxK}`;
      return label;
    }
    case 'rollout':
      return `rollout(base expectimax(${spec.options.baseDepth}), margin ${spec.options.margin}, ${spec.options.batch}..${spec.options.maxSamples} samples)`;
    case 'param':
      return `param(${spec.theta.map((x) => x.toFixed(3)).join(', ')})`;
    case 'book': {
      const o = spec.book.options;
      return `book(k<=${o.maxK}, ${o.samples} samples, ${Object.keys(spec.book.overrides).length} overrides) + expectimax(${o.baseDepth})`;
    }
  }
}

/** True when the player is a deterministic function of the information state (the exact DP can evaluate it). */
export function isDeterministic(spec: AttackBotSpec): boolean {
  return spec.kind !== 'rollout';
}

export function createAttackBot(spec: AttackBotSpec, g: Game): Bot {
  switch (spec.kind) {
    case 'value-lsm':
      return valueLsmBot(g, spec.table);
    case 'optimal':
      return new OptimalBot({ w: g.w, h: g.h, multiplierBps: g.multiplierBps, refundBps: Array.from(g.refund) });
    case 'expectimax': {
      if (spec.opening === undefined) return new ExpectimaxBot(g, spec.table, spec.depth, spec.deepening ?? null);
      const keyer = new BookKeyer({ w: g.w, h: g.h, multiplierBps: g.multiplierBps, refundBps: Array.from(g.refund) });
      return new ExpectimaxBot(g, spec.table, spec.depth, spec.deepening ?? null, spec.opening, (position) => keyer.keyOf(position));
    }
    case 'rollout':
      return new RolloutBot(g, spec.table, spec.options);
    case 'param':
      return new ParamBot(g, spec.table, spec.theta);
    case 'book':
      return new BookBot(g, spec.table, spec.book);
  }
}
