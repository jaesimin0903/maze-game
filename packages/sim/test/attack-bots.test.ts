// Attack-lane players: legality (they use only what the player has seen), the private
// randomness of the rollout player, and the CMA-ES search.

import { beforeAll, describe, expect, it } from 'vitest';
import { fastRng } from '@maze/shared';
import type { Bot } from '../src/bots/types';
import { VALUE_LSM_HYPER } from '../src/bots/value-core';
import { CASH_OUT, Game, MazeFeed, VISITED, type MazeSource } from '../src/engine';
import type { ValueTable } from '../src/lsm';
import { samplePosteriorMaze, WilsonScratch } from '../src/posterior';
import { tierRef } from '../src/runner';
import { bookOf, bookStates, runBookJob, type BookOptions } from '../src/attack/book';
import { RolloutBot } from '../src/attack/bots';
import { cmaes, symmetricEigen } from '../src/attack/cma';
import { attackBotLabel, createAttackBot, type AttackBotSpec } from '../src/attack/players';
import { econFor, temporaryDirectory, testRunner } from './helpers';

const SOURCE: MazeSource = { kind: 'rng', mode: 'fast', stream: 'E' };
const ECON5 = econFor(5, 5, 26_300);

/** A deliberately illegal player: it prefers the child whose own (unseen) walls have more openings. */
class Peeker implements Bot {
  begin(): void {}

  decide(g: Game): number {
    let best = 0;
    for (let i = 1; i < g.nc; i++) if (g.open[g.childCell[i]] > g.open[g.childCell[best]]) best = i;
    return best;
  }
}

/** Directions chosen (-1 = cash out) by `bot` on `open`, up to `limit` decisions. */
function decisions(g: Game, bot: Bot, open: Uint8Array, index: number, limit = Number.POSITIVE_INFINITY): number[] {
  const out: number[] = [];
  g.begin(open, fastRng(BigInt(index)));
  bot.begin(g);
  if (bot instanceof RolloutBot) bot.reseed(index);
  while (out.length < limit) {
    const action = bot.decide(g);
    out.push(action === CASH_OUT ? -1 : g.childDir[action]);
    if (action === CASH_OUT) break;
    g.advance(action);
    if (g.cell === g.exit || g.nc === 0) break;
  }
  return out;
}

async function smallTable(): Promise<ValueTable> {
  const runner = testRunner(temporaryDirectory(), { trainGames: [6000, 6000, 6000], minSamples: 30 });
  return runner.loadTable(await runner.valueTableScratch(tierRef(ECON5), VALUE_LSM_HYPER, 1, 6000));
}

describe('attack players are legal: decisions depend only on what was seen', () => {
  let players: { label: string; bot: Bot; legal: boolean }[] = [];

  beforeAll(async () => {
    const table = await smallTable();
    const options: BookOptions = { baseDepth: 1, maxK: 2, minProbability: 0.02, samples: 40, zOverride: 0, seed: 3 };
    const states = bookStates(ECON5, options.maxK, options.minProbability);
    const results = states.map((state) => runBookJob({ kind: 'attack-book', econ: ECON5, table, baseDepth: 1, samples: 40, seed: 3, state }));
    const book = bookOf(options, results);
    // The book must override somewhere, or the book player would only repeat expectimax(1).
    expect(Object.keys(book.overrides).length).toBeGreaterThan(0);
    const g = new Game(ECON5);
    const specs: AttackBotSpec[] = [
      { kind: 'expectimax', table, depth: 0 },
      { kind: 'expectimax', table, depth: 1 },
      { kind: 'expectimax', table, depth: 2 },
      { kind: 'expectimax', table, depth: 3 },
      { kind: 'expectimax', table, depth: 3, deepening: { shallow: 1, margin: 0.05 } },
      { kind: 'expectimax', table, depth: 1, opening: { maxK: 2, depth: 4 } },
      { kind: 'param', table, theta: [3, -2, 1, 0.5, -1, 2] },
      { kind: 'book', table, book: { options, overrides: book.overrides } },
      { kind: 'rollout', table, options: { baseDepth: 1, margin: 0.5, batch: 4, maxSamples: 12, seed: 9 } },
    ];
    players = [
      ...specs.map((spec) => ({ label: attackBotLabel(spec), bot: createAttackBot(spec, g), legal: true })),
      { label: 'peeker', bot: new Peeker(), legal: false },
    ];
  }, 300_000);

  it('repeats every decision when the unseen part of the maze is redrawn from the posterior, or filled with garbage', () => {
    const g = new Game(ECON5);
    const feed = new MazeFeed(SOURCE, 5, 5);
    const scratch = new WilsonScratch(g.cells);
    const redrawn = new Uint8Array(g.cells);
    const chooser = fastRng(77n);
    for (const { label, bot, legal } of players) {
      let mismatches = 0;
      for (let index = 0; index < 120; index++) {
        feed.load(index);
        const original = feed.open.slice();
        const first = decisions(g, bot, original, index);
        const step = chooser.nextBelow(first.length);
        g.begin(original, fastRng(1n));
        for (let t = 0; t < step; t++) g.advance(Array.from(g.childDir.subarray(0, g.nc)).indexOf(first[t]));
        // (a) A maze from the exact posterior: the same observations so far, another future.
        samplePosteriorMaze(g, chooser, scratch, redrawn);
        // (b) Garbage: every unvisited cell gets arbitrary walls (not even a maze).
        const garbage = original.slice();
        for (let cell = 0; cell < g.cells; cell++) if (g.status[cell] !== VISITED) garbage[cell] = chooser.nextBelow(16);
        const prefix = first.slice(0, step + 1).join(',');
        if (decisions(g, bot, redrawn, index, step + 1).join(',') !== prefix) mismatches += 1;
        if (decisions(g, bot, garbage, index, step + 1).join(',') !== prefix) mismatches += 1;
      }
      if (legal) expect(mismatches, label).toBe(0);
      else expect(mismatches, label).toBeGreaterThan(0);
    }
  }, 600_000);
});

describe('rollout player', () => {
  it('draws from its own generator only: the same game index repeats the game, and the game generator is never touched', async () => {
    const table = await smallTable();
    const g = new Game(ECON5);
    const bot = createAttackBot({ kind: 'rollout', table, options: { baseDepth: 1, margin: 0.5, batch: 4, maxSamples: 12, seed: 5 } }, g) as RolloutBot;
    const feed = new MazeFeed(SOURCE, 5, 5);
    for (let index = 0; index < 60; index++) {
      feed.load(index);
      const open = feed.open.slice();
      let drawn = 0;
      const counting = fastRng(BigInt(index));
      const guard = {
        nextU32: (): number => {
          drawn += 1;
          return counting.nextU32();
        },
        nextBelow: (m: number): number => {
          drawn += 1;
          return counting.nextBelow(m);
        },
      };
      g.begin(open, guard);
      bot.reseed(index);
      const once: number[] = [];
      for (;;) {
        const action = bot.decide(g);
        once.push(action === CASH_OUT ? -1 : g.childDir[action]);
        if (action === CASH_OUT) break;
        g.advance(action);
        if (g.cell === g.exit || g.nc === 0) break;
      }
      expect(drawn).toBe(0);
      expect(decisions(g, bot, open, index)).toEqual(once);
    }
    expect(bot.counters.contested).toBeGreaterThan(0);
    expect(bot.counters.samples).toBeGreaterThan(0);
  }, 300_000);
});

describe('CMA-ES', () => {
  it('decomposes a symmetric matrix', () => {
    const c = [
      [4, 1, 0.5],
      [1, 3, -0.2],
      [0.5, -0.2, 2],
    ];
    const { values, vectors } = symmetricEigen(c);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += vectors[i][k] * values[k] * vectors[j][k];
        expect(sum).toBeCloseTo(c[i][j], 10);
      }
    }
  });

  it('finds the maximum of a shifted quadratic and never reports less than its start', async () => {
    const target = [1.5, -2, 0.5, 3];
    const f = (x: number[]): number => -x.reduce((s, xi, i) => s + (i + 1) * (xi - target[i]) ** 2, 0);
    const result = await cmaes(async (xs) => xs.map(f), { dim: 4, lambda: 10, sigma0: 1, generations: 60, seed: 11 });
    expect(result.originFitness).toBe(f([0, 0, 0, 0]));
    expect(result.bestFitness).toBeGreaterThanOrEqual(result.originFitness);
    result.best.forEach((x, i) => expect(x).toBeCloseTo(target[i], 2));
  });
});
