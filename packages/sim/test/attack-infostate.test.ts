// The information-state DP of the attack lane against full maze enumeration.
//
// The optimum must equal `exactOptimal` (expectimax over every enumerated maze) on 3×3, 4×4 and
// 5×4, and the DP value of a fixed player must equal the mean payout of that player over every
// enumerated maze, each played once.

import { beforeAll, describe, expect, it } from 'vitest';
import { createBot } from '../src/bots/index';
import type { Bot } from '../src/bots/types';
import { VALUE_LSM_HYPER } from '../src/bots/value-core';
import { Game, play, type TierEconomics } from '../src/engine';
import { enumerateCorridorMazes, exactOptimal, exactRtp, type EnumeratedMazes } from '../src/exact';
import type { ValueTable } from '../src/lsm';
import { tierRef } from '../src/runner';
import { OptimalBot, solveInfoStates, StateLimit } from '../src/attack/infostate';
import { KeyTable } from '../src/attack/keytable';
import { createAttackBot, type AttackBotSpec } from '../src/attack/players';
import { CURVE_II, econFor, mazeAt, temporaryDirectory, testRunner } from './helpers';

const CURVE_L = { family: 'two-stage-geometric', e0Bps: 500, aBps: 7300, phi: 0.3 } as const;

/** Mean payout (fraction of the bet) of `bot` over every enumerated maze, each played once. */
function enumeratedMean(e: EnumeratedMazes, econ: TierEconomics, bot: Bot): number {
  const g = new Game(econ);
  const rng = { nextU32: () => 0, nextBelow: () => 0 };
  let sum = 0;
  for (let i = 0; i < e.count; i++) {
    play(g, bot, mazeAt(e, i), rng);
    sum += g.payoutBps;
  }
  return sum / e.count / 10_000;
}

describe('information-state DP: the optimum', () => {
  const cases: [number, number, number, typeof CURVE_II | typeof CURVE_L][] = [
    [3, 3, 11_939, CURVE_II],
    [4, 4, 17_206, CURVE_II],
    [4, 4, 17_678, CURVE_L],
    [5, 4, 20_915, CURVE_II],
    [5, 4, 21_326, CURVE_L],
  ];
  for (const [w, h, multiplierBps, curve] of cases) {
    it(`equals exactOptimal on every ${w}x${h} maze (phi ${curve.phi}, M ${multiplierBps})`, () => {
      const econ = econFor(w, h, multiplierBps, curve);
      const e = enumerateCorridorMazes(w, h);
      const reference = exactOptimal(e, econ);
      const dp = solveInfoStates(econ, null);
      expect(dp.rtp).toBeCloseTo(exactRtp(reference), 12);
      expect(dp.east).toBeCloseTo(reference.eastBps / reference.eastCount / 10_000, 12);
      expect(dp.south).toBeCloseTo(reference.southBps / reference.southCount / 10_000, 12);
      expect(dp.eastWeight).toBeCloseTo(reference.eastCount / reference.count, 12);
      // The states memoised are far fewer than the mazes.
      expect(dp.states).toBeLessThan(e.count);
    });
  }

  it('reproduces the exactness gate of the production table on 4x4 and 5x4 (packages/sim/reports/exact)', () => {
    // optimalRtp of the gate at its calibrated multipliers 17206 and 20915 bps (curve ii).
    expect(solveInfoStates(econFor(4, 4, 17_206), null).rtp).toBeCloseTo(0.96044283049, 10);
    expect(solveInfoStates(econFor(5, 4, 20_915), null).rtp).toBeCloseTo(0.9614438998, 9);
  });

  it('the mirror option gives the same value on square grids', () => {
    const econ = econFor(4, 4, 17_206);
    expect(solveInfoStates(econ, null, { mirror: true }).rtp).toBeCloseTo(solveInfoStates(econ, null).rtp, 14);
  });

  it('the optimal player, played on every 4x4 maze, earns exactly the DP value', () => {
    const econ = econFor(4, 4, 17_206);
    const e = enumerateCorridorMazes(4, 4);
    expect(enumeratedMean(e, econ, new OptimalBot(econ))).toBeCloseTo(solveInfoStates(econ, null).rtp, 12);
  });

  it('stops with StateLimit when the state budget is exceeded', () => {
    expect(() => solveInfoStates(econFor(5, 5, 26_088), null, { maxStates: 1000 })).toThrow(StateLimit);
  });
});

describe('information-state DP: exact value of a fixed player', () => {
  const econ = econFor(4, 4, 17_206);
  const e = enumerateCorridorMazes(4, 4);
  let table: ValueTable;

  beforeAll(async () => {
    const runner = testRunner(temporaryDirectory(), { trainPasses: 2, minSamples: 30 });
    table = runner.loadTable(await runner.valueTableScratch(tierRef(econ), VALUE_LSM_HYPER, 1, e.count, e));
  });

  it('equals the mean over every 4x4 maze for value-lsm and expectimax(0..3), with the compressed and the full key', () => {
    const specs: AttackBotSpec[] = [
      { kind: 'value-lsm', table },
      { kind: 'expectimax', table, depth: 0 },
      { kind: 'expectimax', table, depth: 1 },
      { kind: 'expectimax', table, depth: 2 },
      { kind: 'expectimax', table, depth: 3 },
      { kind: 'expectimax', table, depth: 3, deepening: { shallow: 1, margin: 0.05 } },
      { kind: 'expectimax', table, depth: 1, opening: { maxK: 3, depth: 4 } },
    ];
    for (const spec of specs) {
      const mean = enumeratedMean(e, econ, createAttackBot(spec, new Game(econ)));
      const compressed = solveInfoStates(econ, createAttackBot(spec, new Game(econ)));
      const full = solveInfoStates(econ, createAttackBot(spec, new Game(econ)), { fullKey: true });
      expect(compressed.rtp, spec.kind).toBeCloseTo(mean, 12);
      expect(full.rtp, spec.kind).toBeCloseTo(mean, 12);
      expect(compressed.states).toBeLessThanOrEqual(full.states);
    }
  });

  it('with the full key, equals the mean for players that use more than the posterior (param, naive, fixed-k, start-selective)', () => {
    const attack: AttackBotSpec = { kind: 'param', table, theta: [3, -2, 1, 0.5, -1, 2] };
    expect(solveInfoStates(econ, createAttackBot(attack, new Game(econ)), { fullKey: true }).rtp).toBeCloseTo(
      enumeratedMean(e, econ, createAttackBot(attack, new Game(econ))),
      12,
    );
    // Stateless players only: a player that remembers something between decisions (junction-quit)
    // is not a function of the information state, and the DP cannot evaluate it.
    const certified = [
      { bot: 'harmonic' } as const,
      { bot: 'naive-greedy' } as const,
      { bot: 'fixed-k-cashout', k: 3 } as const,
      { bot: 'start-selective', side: 'S' } as const,
    ];
    for (const spec of certified) {
      expect(solveInfoStates(econ, createBot(spec, new Game(econ)), { fullKey: true }).rtp, spec.bot).toBeCloseTo(
        enumeratedMean(e, econ, createBot(spec, new Game(econ))),
        12,
      );
    }
  });

  it('the compressed key agrees with the full key for value-lsm and expectimax(2) on 5x5', async () => {
    const econ5 = econFor(5, 5, 26_088);
    const runner = testRunner(temporaryDirectory(), { trainPasses: 1, minSamples: 30 });
    const table5 = runner.loadTable(await runner.valueTableScratch(tierRef(econ5), VALUE_LSM_HYPER, 1, 20_000));
    for (const spec of [{ kind: 'value-lsm', table: table5 } as const, { kind: 'expectimax', table: table5, depth: 2 } as const]) {
      const compressed = solveInfoStates(econ5, createAttackBot(spec, new Game(econ5)));
      const full = solveInfoStates(econ5, createAttackBot(spec, new Game(econ5)), { fullKey: true });
      expect(compressed.rtp, spec.kind).toBeCloseTo(full.rtp, 12);
    }
  });

  it('no player beats the optimum', () => {
    const optimum = solveInfoStates(econ, null).rtp;
    for (const depth of [0, 1, 2, 3]) {
      expect(solveInfoStates(econ, createAttackBot({ kind: 'expectimax', table, depth }, new Game(econ))).rtp).toBeLessThanOrEqual(optimum + 1e-12);
    }
  });
});

describe('KeyTable', () => {
  it('stores and finds the same entries as a Map, across growth', () => {
    const table = new KeyTable(3, 16);
    const reference = new Map<string, [number, number]>();
    let x = 12345;
    const next = (): number => {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      return x;
    };
    const key = new Uint32Array(3);
    for (let i = 0; i < 5000; i++) {
      key[0] = (next() % 7) + 1;
      key[1] = next() % 50;
      key[2] = next() % 3;
      const value: [number, number] = [next() / 7, i];
      table.set(key, value[0], value[1]);
      reference.set(Array.from(key).join(','), value);
    }
    expect(table.size).toBe(reference.size);
    for (const [id, value] of reference) {
      key.set(id.split(',').map(Number));
      expect(table.get(key)).toBe(value[0]);
      expect(table.found2).toBe(value[1]);
    }
    key.set([9, 0, 0]);
    expect(Number.isNaN(table.get(key))).toBe(true);
  });
});
