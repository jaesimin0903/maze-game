// Paired evaluation of an attack player against a reference player on the same mazes.
//
// Game `i` of a run is maze `first + i` of the stream. Both players play every maze; the
// difference D = challenger − reference is measured per maze, so the variance of the mean
// difference comes only from the mazes on which the two players act differently.
//
// Seed ranges of the attack lane (disjoint from everything the certification and sim:stats use):
//   evaluation   stream D, game indexes from 2^38   (the certification's pairs use D below 2^21)
//   training     stream C, game indexes from 2^37   (value tables train on C below 2^23)

import { Game, MazeFeed, OUTCOME_CASH, OUTCOME_EXIT, play, type TierEconomics } from '../engine';
import { estimate, scaleMoments, type Estimate } from '../stats';
import type { StreamName } from '../streams';
import { RolloutBot, type RolloutCounters } from './bots';
import { createAttackBot, type AttackBotSpec } from './players';

export const EVAL_STREAM: StreamName = 'D';
export const EVAL_FIRST = 2 ** 38;
export const TRAIN_STREAM: StreamName = 'C';
export const TRAIN_FIRST = 2 ** 37;

export interface PairedJob {
  kind: 'attack-pairs';
  econ: TierEconomics;
  reference: AttackBotSpec;
  challenger: AttackBotSpec;
  stream: StreamName;
  /** Games `from .. to - 1` play mazes `first + from .. first + to - 1`. */
  first: number;
  from: number;
  to: number;
}

/** Mergeable sums of a paired run. Payouts are in bps. */
export interface PairedStats {
  n: number;
  sumA: number;
  sumSqA: number;
  sumB: number;
  sumSqB: number;
  sumD: number;
  sumSqD: number;
  /** Exits reached by the reference (A) and the challenger (B). */
  winsA: number;
  winsB: number;
  /** Games cashed out before the first move. */
  cash0A: number;
  cash0B: number;
  /** Games on which the two payouts differ. */
  differ: number;
  stepsA: number;
  stepsB: number;
  /** Counters of a rollout challenger (zero otherwise). */
  rollout: RolloutCounters;
  seconds: number;
}

export function emptyPaired(): PairedStats {
  return {
    n: 0,
    sumA: 0,
    sumSqA: 0,
    sumB: 0,
    sumSqB: 0,
    sumD: 0,
    sumSqD: 0,
    winsA: 0,
    winsB: 0,
    cash0A: 0,
    cash0B: 0,
    differ: 0,
    stepsA: 0,
    stepsB: 0,
    rollout: { decisions: 0, contested: 0, samples: 0, changed: 0 },
    seconds: 0,
  };
}

export function mergePaired(into: PairedStats, from: PairedStats): void {
  into.n += from.n;
  into.sumA += from.sumA;
  into.sumSqA += from.sumSqA;
  into.sumB += from.sumB;
  into.sumSqB += from.sumSqB;
  into.sumD += from.sumD;
  into.sumSqD += from.sumSqD;
  into.winsA += from.winsA;
  into.winsB += from.winsB;
  into.cash0A += from.cash0A;
  into.cash0B += from.cash0B;
  into.differ += from.differ;
  into.stepsA += from.stepsA;
  into.stepsB += from.stepsB;
  into.rollout.decisions += from.rollout.decisions;
  into.rollout.contested += from.rollout.contested;
  into.rollout.samples += from.rollout.samples;
  into.rollout.changed += from.rollout.changed;
  into.seconds += from.seconds;
}

/** Plays games `from .. to - 1` of a paired job. */
export function runPaired(job: PairedJob): PairedStats {
  const started = Date.now();
  const g = new Game(job.econ);
  const reference = createAttackBot(job.reference, g);
  const challenger = createAttackBot(job.challenger, g);
  const feed = new MazeFeed({ kind: 'rng', mode: 'fast', stream: job.stream }, g.w, g.h);
  const stats = emptyPaired();
  for (let i = job.from; i < job.to; i++) {
    const index = job.first + i;
    feed.load(index);
    if (reference instanceof RolloutBot) reference.reseed(index);
    play(g, reference, feed.open, feed.rng);
    const a = g.payoutBps;
    stats.stepsA += g.k;
    if (g.outcome === OUTCOME_EXIT) stats.winsA += 1;
    if (g.outcome === OUTCOME_CASH && g.k === 0) stats.cash0A += 1;
    if (challenger instanceof RolloutBot) challenger.reseed(index);
    play(g, challenger, feed.open, feed.rng);
    const b = g.payoutBps;
    stats.stepsB += g.k;
    if (g.outcome === OUTCOME_EXIT) stats.winsB += 1;
    if (g.outcome === OUTCOME_CASH && g.k === 0) stats.cash0B += 1;
    const d = b - a;
    stats.n += 1;
    stats.sumA += a;
    stats.sumSqA += a * a;
    stats.sumB += b;
    stats.sumSqB += b * b;
    stats.sumD += d;
    stats.sumSqD += d * d;
    if (d !== 0) stats.differ += 1;
  }
  if (challenger instanceof RolloutBot) {
    const c = challenger.counters;
    stats.rollout = { decisions: c.decisions, contested: c.contested, samples: c.samples, changed: c.changed };
  }
  stats.seconds = (Date.now() - started) / 1000;
  return stats;
}

export interface PairedSummary {
  games: number;
  /** RTP of the reference, of the challenger, and the challenger minus the reference (fractions of the bet). */
  reference: Estimate;
  challenger: Estimate;
  diff: Estimate;
  winRateA: number;
  winRateB: number;
  cash0A: number;
  cash0B: number;
  differShare: number;
  seconds: number;
  rollout: RolloutCounters;
}

export function summarisePaired(s: PairedStats): PairedSummary {
  const scale = 1 / 10_000;
  return {
    games: s.n,
    reference: estimate(scaleMoments({ n: s.n, sum: s.sumA, sumSq: s.sumSqA }, scale)),
    challenger: estimate(scaleMoments({ n: s.n, sum: s.sumB, sumSq: s.sumSqB }, scale)),
    diff: estimate(scaleMoments({ n: s.n, sum: s.sumD, sumSq: s.sumSqD }, scale)),
    winRateA: s.winsA / s.n,
    winRateB: s.winsB / s.n,
    cash0A: s.cash0A / s.n,
    cash0B: s.cash0B / s.n,
    differShare: s.differ / s.n,
    seconds: s.seconds,
    rollout: s.rollout,
  };
}
