// Paired evaluation of the attack lane: both players on the same mazes, sums that match
// separate plays, and seed ranges disjoint from everything else.

import { beforeAll, describe, expect, it } from 'vitest';
import { VALUE_LSM_HYPER } from '../src/bots/value-core';
import { Game, MazeFeed, play } from '../src/engine';
import type { ValueTable } from '../src/lsm';
import { STATS_STREAM } from '../src/playstats';
import { tierRef } from '../src/runner';
import { gameSeed, ownerOfSeed, streamsAreDisjoint } from '../src/streams';
import { emptyPaired, EVAL_FIRST, EVAL_STREAM, mergePaired, runPaired, summarisePaired, TRAIN_FIRST, TRAIN_STREAM } from '../src/attack/paired';
import { createAttackBot, type AttackBotSpec } from '../src/attack/players';
import { econFor, temporaryDirectory, testRunner } from './helpers';

const ECON4 = econFor(4, 4, 17_206);

describe('paired evaluation', () => {
  let table: ValueTable;

  beforeAll(async () => {
    const runner = testRunner(temporaryDirectory(), { trainGames: [6000, 6000, 6000], minSamples: 30 });
    table = runner.loadTable(await runner.valueTableScratch(tierRef(ECON4), VALUE_LSM_HYPER, 1, 6000));
  });

  it('a player paired with itself differs on no maze', () => {
    const spec: AttackBotSpec = { kind: 'value-lsm', table };
    const s = runPaired({ kind: 'attack-pairs', econ: ECON4, reference: spec, challenger: spec, stream: EVAL_STREAM, first: EVAL_FIRST, from: 0, to: 2000 });
    expect(s.n).toBe(2000);
    expect(s.sumD).toBe(0);
    expect(s.sumSqD).toBe(0);
    expect(s.differ).toBe(0);
    expect(s.sumA).toBe(s.sumB);
    expect(summarisePaired(s).diff.halfWidth).toBe(0);
  });

  it('equals the two players played separately on the same mazes, and splits merge exactly', () => {
    const reference: AttackBotSpec = { kind: 'value-lsm', table };
    const challenger: AttackBotSpec = { kind: 'expectimax', table, depth: 2 };
    const job = { kind: 'attack-pairs' as const, econ: ECON4, reference, challenger, stream: EVAL_STREAM, first: EVAL_FIRST };
    const whole = runPaired({ ...job, from: 0, to: 3000 });
    const merged = emptyPaired();
    for (const [from, to] of [
      [0, 1000],
      [1000, 2500],
      [2500, 3000],
    ]) {
      mergePaired(merged, runPaired({ ...job, from, to }));
    }
    for (const field of ['n', 'sumA', 'sumB', 'sumD', 'sumSqD', 'winsA', 'winsB', 'differ'] as const) expect(merged[field], field).toBe(whole[field]);

    const g = new Game(ECON4);
    const a = createAttackBot(reference, g);
    const b = createAttackBot(challenger, g);
    const feed = new MazeFeed({ kind: 'rng', mode: 'fast', stream: EVAL_STREAM }, 4, 4);
    let sumA = 0;
    let sumB = 0;
    let sumSqD = 0;
    for (let i = 0; i < 3000; i++) {
      feed.load(EVAL_FIRST + i);
      play(g, a, feed.open, feed.rng);
      const pa = g.payoutBps;
      play(g, b, feed.open, feed.rng);
      const pb = g.payoutBps;
      sumA += pa;
      sumB += pb;
      sumSqD += (pb - pa) ** 2;
    }
    expect(whole.sumA).toBe(sumA);
    expect(whole.sumB).toBe(sumB);
    expect(whole.sumD).toBe(sumB - sumA);
    expect(whole.sumSqD).toBe(sumSqD);
    const summary = summarisePaired(whole);
    expect(summary.diff.mean).toBeCloseTo(summary.challenger.mean - summary.reference.mean, 12);
    // Pairing removes the variance the two players share: D varies less than either payout.
    expect(summary.diff.sd).toBeLessThan(summary.reference.sd);
  });

  it('uses seed ranges no other part of the simulator uses', () => {
    // Evaluation: stream D from 2^38 (the certification's pairs use D from 0). Training: stream C from 2^37.
    expect(EVAL_STREAM).toBe('D');
    expect(TRAIN_STREAM).toBe('C');
    expect(EVAL_FIRST).toBeGreaterThanOrEqual(2 ** 38);
    expect(TRAIN_FIRST).toBeGreaterThanOrEqual(2 ** 37);
    expect(ownerOfSeed(gameSeed(EVAL_STREAM, 9, 9, EVAL_FIRST))).toBe('D');
    expect(ownerOfSeed(gameSeed(TRAIN_STREAM, 9, 9, TRAIN_FIRST))).toBe('C');
    // sim:stats plays stream B from 2^32; a different stream is disjoint as a whole.
    expect(streamsAreDisjoint(EVAL_STREAM, STATS_STREAM)).toBe(true);
    expect(streamsAreDisjoint(TRAIN_STREAM, STATS_STREAM)).toBe(true);
  });
});
