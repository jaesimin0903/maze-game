// Rules a person could learn and apply in their head, and the scoring behind the search for
// the strongest one.
//
// A rule has a move part and a stop part:
//
//   move   step onto the exit when it is next to you. Otherwise, if `avoidWalled`, never enter a
//          branch that your path and the walls you have seen close off from the exit (cash out
//          when every branch is closed off). Among the remaining branches take
//            'exit'   the one toward the exit (the naive-greedy rule, its tie-break included),
//            'space'  the one with the most open space on its side, ties toward the exit,
//            'route'  the one with the shortest conceivable route to the exit, ties toward the exit.
//   stop   zero, one or two conditions; the player cashes out at the first fork (two or more
//          branches left) that meets any of them. A condition is met at a fork of its kind
//            'any'   every fork,
//            'even'  a fork where no branch is clearly better: every branch left steps toward
//                    the exit, or every one steps away,
//            'away'  a fork where every branch left steps away from the exit,
//          when the exit is still at least `minDistance` cells away and the player has made at
//          most `maxStep` moves, i.e. the refund on screen is still at least refund[maxStep].
//
// The move part does not depend on the stop part, so the search plays each move part once
// with no stop rule, records every fork it passed (moves so far, distance, kind) and the payout
// it reached, and then scores stop parts from those records. Because the step count grows along
// a game, a condition can only trigger at the first fork of its kind at distance >= D, so per
// game one number per (kind, D) decides every K at once; for two conditions the earlier of the
// two triggers decides.

import { naiveChoiceAmong } from '../bots/naive';
import { CASH_OUT, type Game } from '../engine';
import { Cues, WALLED } from './cues';
import { bitCount, exitChild, lastDirection, type HumanPolicy } from './models';

export const MOVE_CUES = ['exit', 'space', 'route'] as const;
export type MoveCue = (typeof MOVE_CUES)[number];

export const FORK_KINDS = ['any', 'even', 'away'] as const;
export type ForkKind = (typeof FORK_KINDS)[number];
const KIND_BIT: Record<ForkKind, number> = { any: 1, even: 2, away: 4 };

export interface StopCondition {
  forks: ForkKind;
  minDistance: number;
  /** At least 0. */
  maxStep: number;
}

export interface RuleParams {
  avoidWalled: boolean;
  move: MoveCue;
  /** At most two; empty never cashes out at a fork. */
  stops: StopCondition[];
}

export type MovePart = Pick<RuleParams, 'avoidWalled' | 'move'>;

/** The rule that is exactly naive-greedy. */
export const NAIVE_RULE: RuleParams = { avoidWalled: false, move: 'exit', stops: [] };

/** Forks a rule passed, in order, for scoring stop parts after the fact. `kinds` holds the bits of the kinds the fork is. */
export interface ForkLog {
  k: number[];
  d: number[];
  kinds: number[];
}

export class RulePlayer implements HumanPolicy {
  private readonly cues: Cues;
  /** When set, the stop part is ignored and every fork is logged here. */
  log: ForkLog | null = null;

  constructor(
    g: Game,
    readonly params: RuleParams,
  ) {
    if (params.stops.length > 2) throw new RangeError('a rule has at most two stop conditions');
    this.cues = new Cues(g.cells);
  }

  newPlayer(): void {}

  startGame(): void {}

  begin(): void {}

  endGame(): void {}

  decide(g: Game): number {
    const exit = exitChild(g);
    if (exit >= 0) return exit;
    const { params, cues } = this;
    if (params.avoidWalled || params.move !== 'exit') cues.compute(g, lastDirection(g));
    const allowed = params.avoidWalled ? cues.viableMask : (1 << g.nc) - 1;
    if (allowed === 0) return CASH_OUT;

    const branches = bitCount(allowed);
    if (branches >= 2) {
      const here = g.dist[g.cell];
      let towardCount = 0;
      for (let i = 0; i < g.nc; i++) if ((allowed >> i) & 1 && g.dist[g.childCell[i]] < here) towardCount += 1;
      const kinds = KIND_BIT.any | (towardCount === 0 || towardCount === branches ? KIND_BIT.even : 0) | (towardCount === 0 ? KIND_BIT.away : 0);
      if (this.log !== null) {
        this.log.k.push(g.k);
        this.log.d.push(here);
        this.log.kinds.push(kinds);
      } else {
        for (const stop of params.stops) if (kinds & KIND_BIT[stop.forks] && here >= stop.minDistance && g.k <= stop.maxStep) return CASH_OUT;
      }
    }
    return this.move(g, allowed);
  }

  private move(g: Game, allowed: number): number {
    const { params, cues } = this;
    if (params.move === 'exit' || bitCount(allowed) === 1) return naiveChoiceAmong(g, allowed);
    if (params.move === 'space') cues.fillSpace(g);
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    let tied = 0;
    for (let i = 0; i < g.nc; i++) {
      if (((allowed >> i) & 1) === 0) continue;
      const score = params.move === 'space' ? cues.space[i] : cues.route[i] === WALLED ? Number.NEGATIVE_INFINITY : -cues.route[i];
      if (score > bestScore) {
        bestScore = score;
        best = i;
        tied = 1 << i;
      } else if (score === bestScore) {
        tied |= 1 << i;
      }
    }
    return bitCount(tied) > 1 ? naiveChoiceAmong(g, tied) : best;
  }
}

/** Every move part the search tries. */
export function moveParts(): MovePart[] {
  return [false, true].flatMap((avoidWalled) => MOVE_CUES.map((move) => ({ avoidWalled, move })));
}

/** One move part played without a stop rule: the natural payout of each game and the forks it passed. */
export interface MoveRecords {
  games: number;
  /** Payout in bps of game `i` when no fork stop triggers. */
  natural: Int32Array;
  /** Forks of game `i` are entries `start[i] .. start[i + 1] - 1`. */
  start: Int32Array;
  k: Uint8Array;
  d: Uint8Array;
  kinds: Uint8Array;
}

/** Sums of payouts in bps over the training games of one stop part. */
export interface StopScore {
  stops: StopCondition[];
  n: number;
  sum: number;
  sumSq: number;
}

/** No qualifying fork. */
const NONE = 255;

/**
 * `first[(c × (D_max + 1) + D) × games + g]`: the step count at the first fork of kind `c` at
 * distance >= D of game `g`, or NONE.
 */
export function firstForks(records: MoveRecords, shortest: number): Uint8Array {
  const { games } = records;
  const rows = shortest + 1;
  const first = new Uint8Array(FORK_KINDS.length * rows * games).fill(NONE);
  FORK_KINDS.forEach((kind, c) => {
    const bit = KIND_BIT[kind];
    for (let game = 0; game < games; game++) {
      let reached = -1;
      for (let j = records.start[game]; j < records.start[game + 1] && reached < shortest; j++) {
        if ((records.kinds[j] & bit) === 0) continue;
        const d = Math.min(shortest, records.d[j]);
        for (let D = reached + 1; D <= d; D++) first[(c * rows + D) * games + game] = records.k[j];
        if (d > reached) reached = d;
      }
    }
  });
  return first;
}

function checkRecords(records: MoveRecords, refundBps: readonly number[]): void {
  if (refundBps.length >= NONE) throw new RangeError('rule scoring supports grids of fewer than 255 cells');
  if (records.start.length !== records.games + 1 || records.natural.length !== records.games) throw new RangeError('rule scoring: malformed records');
}

/** Every rule with no or one stop condition: kinds × D in 0 .. shortest × K in 0 .. cells - 1, and the rule with no stop. */
export function scoreSingles(records: MoveRecords, refundBps: readonly number[], shortest: number, first: Uint8Array): StopScore[] {
  checkRecords(records, refundBps);
  const { games, natural } = records;
  const cells = refundBps.length;
  const rows = shortest + 1;
  let natSum = 0;
  let natSq = 0;
  for (let g = 0; g < games; g++) {
    natSum += natural[g];
    natSq += natural[g] * natural[g];
  }
  const out: StopScore[] = [{ stops: [], n: games, sum: natSum, sumSq: natSq }];
  const count = new Float64Array(cells);
  const sum = new Float64Array(cells);
  const sq = new Float64Array(cells);
  FORK_KINDS.forEach((forks, c) => {
    for (let D = 0; D <= shortest; D++) {
      count.fill(0);
      sum.fill(0);
      sq.fill(0);
      const base = (c * rows + D) * games;
      for (let g = 0; g < games; g++) {
        const k = first[base + g];
        if (k === NONE) continue;
        count[k] += 1;
        sum[k] += natural[g];
        sq[k] += natural[g] * natural[g];
      }
      let stopSum = 0;
      let stopSq = 0;
      let restSum = natSum;
      let restSq = natSq;
      for (let K = 0; K < cells; K++) {
        const refund = refundBps[K];
        stopSum += count[K] * refund;
        stopSq += count[K] * refund * refund;
        restSum -= sum[K];
        restSq -= sq[K];
        out.push({ stops: [{ forks, minDistance: D, maxStep: K }], n: games, sum: stopSum + restSum, sumSq: stopSq + restSq });
      }
    }
  });
  return out;
}

/** The best second condition to join `fixed` (scored exactly over every kind, D and K). */
export function bestPartner(records: MoveRecords, refundBps: readonly number[], shortest: number, first: Uint8Array, fixed: StopCondition): StopScore {
  checkRecords(records, refundBps);
  const { games, natural } = records;
  const cells = refundBps.length;
  const rows = shortest + 1;
  const fixedBase = (FORK_KINDS.indexOf(fixed.forks) * rows + fixed.minDistance) * games;
  const stopA = new Uint8Array(games);
  let baseSum = 0;
  let baseSq = 0;
  for (let g = 0; g < games; g++) {
    const k = first[fixedBase + g];
    stopA[g] = k !== NONE && k <= fixed.maxStep ? k : NONE;
    const payout = stopA[g] === NONE ? natural[g] : refundBps[stopA[g]];
    baseSum += payout;
    baseSq += payout * payout;
  }
  const delta = new Float64Array(cells);
  const deltaSq = new Float64Array(cells);
  let best: StopScore = { stops: [fixed], n: games, sum: baseSum, sumSq: baseSq };
  FORK_KINDS.forEach((forks, c) => {
    for (let D = 0; D <= shortest; D++) {
      delta.fill(0);
      deltaSq.fill(0);
      const base = (c * rows + D) * games;
      for (let g = 0; g < games; g++) {
        const b = first[base + g];
        if (b === NONE || b >= stopA[g]) continue;
        // From K = b on, this game stops at b instead of where the fixed condition left it.
        const before = stopA[g] === NONE ? natural[g] : refundBps[stopA[g]];
        const after = refundBps[b];
        delta[b] += after - before;
        deltaSq[b] += after * after - before * before;
      }
      let sum = baseSum;
      let sq = baseSq;
      for (let K = 0; K < cells; K++) {
        sum += delta[K];
        sq += deltaSq[K];
        if (sum > best.sum) best = { stops: [fixed, { forks, minDistance: D, maxStep: K }], n: games, sum, sumSq: sq };
      }
    }
  });
  return best;
}

/** What the search keeps of one move part: every single-condition rule and the best two-condition rule found from the best single one. */
export interface PartScores {
  singles: StopScore[];
  pair: StopScore;
}

/**
 * Coordinate search for two conditions: the best partner of the best single condition, then
 * the best partner of that partner; the better of the two pairs is kept.
 */
export function scoreMovePart(records: MoveRecords, refundBps: readonly number[], shortest: number): PartScores {
  const first = firstForks(records, shortest);
  const singles = scoreSingles(records, refundBps, shortest, first);
  let bestSingle = singles[0];
  for (const score of singles) if (score.sum > bestSingle.sum) bestSingle = score;
  if (bestSingle.stops.length === 0) return { singles, pair: bestSingle };
  const pair = bestPartner(records, refundBps, shortest, first, bestSingle.stops[0]);
  if (pair.stops.length < 2) return { singles, pair };
  const refined = bestPartner(records, refundBps, shortest, first, pair.stops[1]);
  return { singles, pair: refined.sum > pair.sum ? refined : pair };
}
