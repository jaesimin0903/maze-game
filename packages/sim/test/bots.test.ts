// Bots of plan §3.3: move rules, tie-breaks, cash-out rules, and the property that makes a bot
// legal: its decisions depend on nothing but what the player has seen.

import { beforeAll, describe, expect, it } from 'vitest';
import { fastRng } from '@maze/shared';
import { certifiedSuite, createBot, GATE2_ONLY, memberLabel, type Bot, type BotSpec } from '../src/bots/index';
import { naiveChoice, naiveChoiceAmong } from '../src/bots/naive';
import { ParamSearch } from '../src/bots/param-search';
import { Region } from '../src/bots/region';
import { regionMove } from '../src/bots/region-heuristic';
import { informationStateSeed } from '../src/bots/rollout';
import { VALUE_LSM_HYPER } from '../src/bots/value-core';
import {
  CASH_OUT,
  finish,
  Game,
  MazeFeed,
  OUTCOME_CASH,
  OUTCOME_EXIT,
  OUTCOME_LOSS,
  play,
  runGames,
  type MazeSource,
} from '../src/engine';
import { enumerateCorridorMazes } from '../src/exact';
import { shapeOf, tableLength, type RegionTable, type ValueTable } from '../src/lsm';
import { samplePosteriorMaze, WilsonScratch } from '../src/posterior';
import { tierRef } from '../src/runner';
import { econFor, temporaryDirectory, testRunner } from './helpers';

const SOURCE: MazeSource = { kind: 'rng', mode: 'fast', stream: 'E' };
const ECON5 = econFor(5, 5, 26_300);

/** Puts `g` on `cell` with the given forward directions (N = 0, E = 1, S = 2, W = 3). */
function position(g: Game, cell: number, dirs: number[]): void {
  g.cell = cell;
  g.nc = dirs.length;
  dirs.forEach((dir, i) => {
    g.childDir[i] = dir;
    g.childCell[i] = g.nbr[cell * 4 + dir];
  });
}

function constantTable(value: number): ValueTable {
  const shape = shapeOf(5, 5);
  return { ...shape, values: new Float64Array(tableLength(shape)).fill(value), winAtDistance: new Float64Array(shape.shortest + 1).fill(1), binCentreFallback: false };
}

/** Decisions of a bot over one game: child directions, or -1 for a cash-out. */
function decisions(g: Game, bot: Bot, open: Uint8Array, seed: bigint, limit = Number.POSITIVE_INFINITY): number[] {
  const out: number[] = [];
  g.begin(open, fastRng(seed));
  bot.begin(g);
  while (out.length < limit) {
    const action = bot.decide(g);
    out.push(action === CASH_OUT ? -1 : g.childDir[action]);
    if (action === CASH_OUT) break;
    g.advance(action);
    if (g.cell === g.exit || g.nc === 0) break;
  }
  return out;
}

describe('naiveChoice', () => {
  const g = new Game(econFor(7, 7, 60_000));
  const at = (x: number, y: number): number => y * 7 + x;

  it('takes the only child, and otherwise the child nearest to the exit', () => {
    position(g, at(3, 3), [3]);
    expect(g.childDir[naiveChoice(g)]).toBe(3);
    position(g, at(3, 3), [0, 1]);
    expect(g.childDir[naiveChoice(g)]).toBe(1);
    position(g, at(3, 3), [2, 3]);
    expect(g.childDir[naiveChoice(g)]).toBe(2);
    position(g, at(3, 3), [0, 2, 3]);
    expect(g.childDir[naiveChoice(g)]).toBe(2);
  });

  it('between east and south prefers the longer remaining axis, and on a tie goes east when x + y is even', () => {
    position(g, at(1, 4), [1, 2]); // dx 5 > dy 2
    expect(g.childDir[naiveChoice(g)]).toBe(1);
    position(g, at(4, 1), [1, 2]); // dx 2 < dy 5
    expect(g.childDir[naiveChoice(g)]).toBe(2);
    position(g, at(2, 2), [1, 2]); // dx 4 = dy 4, x + y even
    expect(g.childDir[naiveChoice(g)]).toBe(1);
    position(g, at(3, 3), [0, 1, 2]); // tie, x + y even; north is farther and ignored
    expect(g.childDir[naiveChoice(g)]).toBe(1);
  });

  it('on an east/south tie with odd x + y goes south (rectangular grid)', () => {
    const r = new Game(econFor(5, 4, 20_000));
    position(r, 1 * 5 + 2, [1, 2]); // x 2, y 1: dx 2, dy 2, x + y odd
    expect(r.childDir[naiveChoice(r)]).toBe(2);
    position(r, 0 * 5 + 1, [1, 2]); // x 1, y 0: dx 3, dy 3, x + y odd
    expect(r.childDir[naiveChoice(r)]).toBe(2);
  });

  it('between north and west prefers north unless the vertical distance is larger', () => {
    position(g, at(1, 4), [0, 3]); // dx 5 >= dy 2
    expect(g.childDir[naiveChoice(g)]).toBe(0);
    position(g, at(3, 3), [0, 3]); // equal
    expect(g.childDir[naiveChoice(g)]).toBe(0);
    position(g, at(4, 1), [0, 3]); // dx 2 < dy 5
    expect(g.childDir[naiveChoice(g)]).toBe(3);
  });

  it('respects the allowed set', () => {
    position(g, at(1, 4), [0, 1, 2]);
    expect(g.childDir[naiveChoiceAmong(g, 0b001)]).toBe(0);
    expect(g.childDir[naiveChoiceAmong(g, 0b101)]).toBe(2);
    expect(g.childDir[naiveChoiceAmong(g, 0b111)]).toBe(1);
  });
});

describe('simple bots', () => {
  const g = new Game(ECON5);
  const feed = new MazeFeed(SOURCE, 5, 5);
  const each = (games: number, body: (index: number) => void): void => {
    for (let index = 0; index < games; index++) {
      feed.load(index);
      body(index);
    }
  };

  it('immediate-cashout and one-step-cashout stop at k = 0 and k = 1', () => {
    const immediate = runGames(g, createBot({ bot: 'immediate-cashout' }, g), SOURCE, 0, 2000);
    expect(immediate.cash[0]).toBe(2000);
    expect(immediate.sum).toBe(2000 * ECON5.refundBps[0]);
    const oneStep = runGames(g, createBot({ bot: 'one-step-cashout' }, g), SOURCE, 0, 2000);
    expect(oneStep.cash[1] + oneStep.losses).toBe(2000);
    expect(oneStep.wins).toBe(0);
    expect(oneStep.steps).toBe(2000);
  });

  it('fixed-k-cashout(k) follows naive-greedy for k moves and then cashes out', () => {
    const naive = createBot({ bot: 'naive-greedy' }, g);
    for (const k of [2, 5, 8]) {
      const bot = createBot({ bot: 'fixed-k-cashout', k }, g);
      each(400, (index) => {
        const mine = decisions(g, bot, feed.open, BigInt(index));
        const reference = decisions(g, naive, feed.open, BigInt(index), k);
        if (mine[mine.length - 1] === -1) {
          expect(mine.length).toBe(k + 1);
          expect(mine.slice(0, k)).toEqual(reference);
        } else {
          expect(mine).toEqual(reference.slice(0, mine.length));
        }
      });
    }
  });

  it('junction-quit(j) cashes out only at the first junction and only when it comes within j moves', () => {
    for (const j of [1, 2, 3]) {
      const bot = createBot({ bot: 'junction-quit', j }, g);
      each(600, () => {
        play(g, bot, feed.open, feed.rng);
        const cashedAt = g.outcome === OUTCOME_CASH ? g.k : -1;
        // Where is the first junction of the naive walk?
        g.begin(feed.open, feed.rng);
        let firstJunction = -1;
        while (g.cell !== g.exit && g.nc > 0) {
          if (g.nc >= 2) {
            firstJunction = g.k;
            break;
          }
          g.advance(0);
        }
        expect(cashedAt).toBe(firstJunction !== -1 && firstJunction <= j ? firstJunction : -1);
      });
    }
  });

  it('junction-quit(1) cashes out exactly when the second cell is a junction: about 39% at 5×5 and 38.5% at 7×7', () => {
    // Reviewer measurement: P(second cell is a junction) ≈ 39.1 / 38.5 / 38.3%.
    const rate5 = runGames(g, createBot({ bot: 'junction-quit', j: 1 }, g), SOURCE, 0, 40_000).cash[1] / 40_000;
    expect(rate5).toBeGreaterThan(0.381);
    expect(rate5).toBeLessThan(0.401);
    const g7 = new Game(econFor(7, 7, 67_000));
    const rate7 = runGames(g7, createBot({ bot: 'junction-quit', j: 1 }, g7), SOURCE, 0, 40_000).cash[1] / 40_000;
    expect(rate7).toBeGreaterThan(0.375);
    expect(rate7).toBeLessThan(0.395);
  });

  it('start-selective(s) cashes out at k = 0 on the other start direction and otherwise is naive-greedy', () => {
    const naive = createBot({ bot: 'naive-greedy' }, g);
    for (const side of ['E', 'S'] as const) {
      const bot = createBot({ bot: 'start-selective', side }, g);
      each(400, (index) => {
        const mine = decisions(g, bot, feed.open, BigInt(index));
        if ((feed.open[0] === 2) === (side === 'E')) expect(mine).toEqual(decisions(g, naive, feed.open, BigInt(index)));
        else expect(mine).toEqual([-1]);
      });
    }
  });

  it('random-walk is scored by the exact product of 1 / |C| and matches sampled walks', () => {
    // Establishes: the exact per-maze win probability is what a sampled walk converges to.
    const exact = runGames(g, createBot({ bot: 'random-walk' }, g), SOURCE, 0, 60_000);
    const sampled = runGames(g, createBot({ bot: 'random-walk-sampled' }, g), SOURCE, 0, 60_000);
    expect(exact.expected).toBe(true);
    expect(sampled.expected).toBe(false);
    const p = sampled.wins / sampled.n;
    expect(Math.abs(exact.wins / exact.n - p)).toBeLessThan(4 * Math.sqrt((p * (1 - p)) / sampled.n));
    expect(exact.sum).toBeCloseTo(exact.wins * ECON5.multiplierBps, 3);
    // The conditional expectation has a smaller variance than the sampled payout.
    expect(exact.sumSq).toBeLessThan(sampled.sumSq);
  });

  it('random-walk on all 112 mazes of 3×3 equals the enumeration of every walk', () => {
    const e = enumerateCorridorMazes(3, 3);
    const g3 = new Game(econFor(3, 3, 20_000));
    const stats = runGames(g3, createBot({ bot: 'random-walk' }, g3), { kind: 'enum', stream: 'B', mazes: e.mazes, count: e.count }, 0, e.count);
    // Probability of winning by recursion over every branch of every maze.
    const rng = fastRng(1n);
    const walk = (open: Uint8Array, choices: number[]): number => {
      g3.begin(open, rng);
      for (const choice of choices) g3.advance(choice);
      if (g3.cell === g3.exit) return 1;
      if (g3.nc === 0) return 0;
      const branches = g3.nc;
      let total = 0;
      for (let i = 0; i < branches; i++) total += walk(open, [...choices, i]) / branches;
      return total;
    };
    let expected = 0;
    for (let i = 0; i < e.count; i++) expected += walk(e.mazes.subarray(i * 9, i * 9 + 9), []);
    expect(stats.wins).toBeCloseTo(expected, 9);
  });

  it('sloppy-greedy deviates from naiveChoice at about ε of the junctions; nervous quits with probability 1 / L per move', () => {
    const sloppy = createBot({ bot: 'sloppy-greedy', epsilon: 0.1 }, g);
    let junctions = 0;
    let deviations = 0;
    each(6000, () => {
      g.begin(feed.open, feed.rng);
      while (g.cell !== g.exit && g.nc > 0) {
        const greedy = naiveChoice(g);
        const action = sloppy.decide(g);
        if (g.nc >= 2) {
          junctions += 1;
          if (action !== greedy) deviations += 1;
        }
        g.advance(action);
      }
    });
    // A random pick lands on the naive child a share of the time, so the visible rate is below ε.
    expect(deviations / junctions).toBeGreaterThan(0.03);
    expect(deviations / junctions).toBeLessThan(0.1);

    const nervous = runGames(g, createBot({ bot: 'nervous', epsilon: 0.1 }, g), SOURCE, 0, 40_000);
    expect(nervous.cash[0]).toBe(0);
    // Of the games still in progress after one move, 1 / L = 1/8 cash out right there.
    const afterOne = runGames(g, createBot({ bot: 'one-step-cashout' }, g), SOURCE, 0, 40_000).cash[1];
    expect(nervous.cash[1] / afterOne).toBeGreaterThan(0.115);
    expect(nervous.cash[1] / afterOne).toBeLessThan(0.135);
  });

  it('win rates without cash-out match the reviewers\' measurements', () => {
    // ≈ 33.5% (5×5) and 13.7% / 13.2% (7×7) for harmonic / naive-greedy.
    const harmonic5 = runGames(g, createBot({ bot: 'harmonic' }, g), SOURCE, 0, 60_000);
    const naive5 = runGames(g, createBot({ bot: 'naive-greedy' }, g), SOURCE, 0, 60_000);
    expect(harmonic5.wins / 60_000).toBeGreaterThan(0.327);
    expect(harmonic5.wins / 60_000).toBeLessThan(0.347);
    expect(naive5.wins / 60_000).toBeGreaterThan(0.325);
    expect(naive5.wins / 60_000).toBeLessThan(0.345);
    const g7 = new Game(econFor(7, 7, 67_000));
    const harmonic7 = runGames(g7, createBot({ bot: 'harmonic' }, g7), SOURCE, 0, 60_000);
    const naive7 = runGames(g7, createBot({ bot: 'naive-greedy' }, g7), SOURCE, 0, 60_000);
    expect(harmonic7.wins / 60_000).toBeGreaterThan(0.13);
    expect(harmonic7.wins / 60_000).toBeLessThan(0.144);
    expect(naive7.wins / 60_000).toBeGreaterThan(0.125);
    expect(naive7.wins / 60_000).toBeLessThan(0.139);
    expect(harmonic5.losses + harmonic5.wins).toBe(60_000);
  });
});

describe('region and value bots', () => {
  const g = new Game(ECON5);
  const feed = new MazeFeed(SOURCE, 5, 5);

  it('region-heuristic never moves to a child whose unvisited region excludes the exit, and cashes out when there is none', () => {
    const region = new Region(g.cells);
    const table: RegionTable = { cells: 25, shortest: 8, win: new Float64Array(25 * 9).fill(1) };
    const bot = createBot({ bot: 'region-heuristic', table }, g);
    let cashOuts = 0;
    for (let index = 0; index < 1500; index++) {
      feed.load(index);
      g.begin(feed.open, feed.rng);
      while (g.cell !== g.exit && g.nc > 0) {
        const action = bot.decide(g);
        const expected = regionMove(g, region);
        if (action === CASH_OUT) {
          expect(expected).toBe(-1);
          cashOuts += 1;
          break;
        }
        expect(action).toBe(expected);
        region.fill(g, g.childCell[action]);
        expect(region.hasExit).toBe(true);
        g.advance(action);
      }
    }
    expect(cashOuts).toBeGreaterThan(0);
  });

  it('region-heuristic cashes out when M × Ŵ[k][d] < refund(k)', () => {
    const never: RegionTable = { cells: 25, shortest: 8, win: new Float64Array(25 * 9).fill(0) };
    const stats = runGames(g, createBot({ bot: 'region-heuristic', table: never }, g), SOURCE, 0, 500);
    expect(stats.cash[0]).toBe(500);
  });

  it('param-search: a certain win estimate never cashes out, a hopeless one cashes out at once, and θ1 > 0 moves like the region rule', () => {
    const region = new Region(g.cells);
    const confident = new ParamSearch(g, [1, 0, 40, 0, 0, 0]);
    for (let index = 0; index < 600; index++) {
      feed.load(index);
      g.begin(feed.open, feed.rng);
      while (g.cell !== g.exit && g.nc > 0) {
        const expected = regionMove(g, region);
        const action = confident.decide(g);
        expect(action).toBe(expected === -1 ? CASH_OUT : expected);
        if (action === CASH_OUT) break;
        g.advance(action);
      }
    }
    const hopeless = runGames(g, new ParamSearch(g, [1, 0, -40, 0, 0, 0]), SOURCE, 0, 300);
    expect(hopeless.cash[0]).toBe(300);
    expect(() => new ParamSearch(g, [1, 2, 3])).toThrow(RangeError);
  });

  it('a value bot with a flat table that always favours playing moves exactly like harmonic (ties: larger q, smaller d, N E S W)', () => {
    // Establishes: tie-break rule 5 and that the exit child is worth M. Every afterstate is worth
    // M, so all children tie on value (the exit child included) and the posterior decides.
    const flat = constantTable(ECON5.multiplierBps);
    const harmonic = createBot({ bot: 'harmonic' }, g);
    const bot = createBot({ bot: 'value-table', table: flat }, g);
    for (let index = 0; index < 500; index++) {
      feed.load(index);
      expect(decisions(g, bot, feed.open, 1n)).toEqual(decisions(g, harmonic, feed.open, 1n));
    }
  });

  it('the lookahead prices dead ends: with every afterstate worth M, Q_c = M × P(c is not a dead end) <= V_c', () => {
    // Establishes rule 4 on a table where the answer is known in closed form.
    const flat = constantTable(ECON5.multiplierBps);
    const all = runGames(g, createBot({ bot: 'value-lookahead-all', table: flat }, g), SOURCE, 0, 3000);
    const none = runGames(g, createBot({ bot: 'value-table', table: flat }, g), SOURCE, 0, 3000);
    // value-table never cashes out on this table; the lookahead bot does, exactly where a dead end is likely enough.
    expect(none.cash.reduce((a, b) => a + b, 0)).toBe(0);
    expect(all.cash.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(all.losses).toBeLessThan(none.losses);
  });

  it('a value bot cashes out exactly when the value of its move is below refund(k)', () => {
    // Refunds of the 5×5 curve: 9,500 / 7,300 / 6,694 / 6,138 / 5,629 / …
    expect(ECON5.refundBps.slice(0, 5)).toEqual([9500, 7300, 6694, 6138, 5629]);
    // A flat 6,000 is below refund(0): cash out before the first move.
    expect(runGames(g, createBot({ bot: 'value-table', table: constantTable(6000) }, g), SOURCE, 0, 300).cash[0]).toBe(300);
    // Afterstates up to k' = 3 are worth a lot, later ones 5,700: at k = 3 the move is worth
    // 5,700 < refund(3) = 6,138, so every game still in progress there cashes out, and nowhere else.
    const shape = shapeOf(5, 5);
    const perK = shape.qBins * (shape.shortest + 1);
    const stepped = constantTable(1_000_000);
    stepped.values.fill(5700, 4 * perK);
    const stopped = runGames(g, createBot({ bot: 'value-table', table: stepped }, g), SOURCE, 0, 2000);
    expect(stopped.cash[3]).toBeGreaterThan(1000);
    expect(stopped.cash.reduce((a, b) => a + b, 0)).toBe(stopped.cash[3]);
    expect(stopped.wins).toBe(0);
    // 6,200 is not below refund(3) nor any later refund: the bot never cashes out.
    stepped.values.fill(6200, 4 * perK);
    const played = runGames(g, createBot({ bot: 'value-table', table: stepped }, g), SOURCE, 0, 2000);
    expect(played.cash.reduce((a, b) => a + b, 0)).toBe(0);
    expect(played.wins).toBeGreaterThan(0);
  });

  it('rollout is a deterministic function of the information state', () => {
    const table = constantTable(20_000);
    const a = createBot({ bot: 'rollout', samples: 8, table }, g);
    const b = createBot({ bot: 'rollout', samples: 8, table }, g);
    const seeds = new Set<bigint>();
    for (let index = 0; index < 40; index++) {
      feed.load(index);
      expect(decisions(g, a, feed.open, 1n)).toEqual(decisions(g, b, feed.open, 99n));
      g.begin(feed.open, feed.rng);
      seeds.add(informationStateSeed(g));
      while (g.cell !== g.exit && g.nc > 0) {
        g.advance(0);
        seeds.add(informationStateSeed(g));
      }
    }
    // Different observation histories seed different sample sets.
    expect(seeds.size).toBeGreaterThan(100);
  });
});

describe('legality: decisions depend only on what was seen', () => {
  let specs: { label: string; spec: BotSpec; legal: boolean }[] = [];

  beforeAll(async () => {
    // Small trained tables are enough: the property is about information, not strength.
    const runner = testRunner(temporaryDirectory(), { trainGames: [6000, 6000, 6000], minSamples: 30 });
    const tier = tierRef(ECON5);
    const valueTable = runner.loadTable(await runner.valueTableScratch(tier, VALUE_LSM_HYPER, 1, 6000));
    const harmonicLsm = runner.loadTable((await runner.harmonicLsm(tier, 6000)).key);
    const region = runner.loadRegion(await runner.regionTable(5, 5, 6000));
    specs = [
      ...certifiedSuite(8).map((member): { label: string; spec: BotSpec; legal: boolean } => {
        const label = memberLabel(member);
        switch (member.bot) {
          case 'region-heuristic':
            return { label, spec: { bot: member.bot, table: region }, legal: true };
          case 'param-search':
            return { label, spec: { bot: member.bot, theta: [0.7, 0.4, 0.2, -0.5, -0.3, 0.9] }, legal: true };
          case 'harmonic-lsm':
            return { label, spec: { bot: member.bot, table: harmonicLsm }, legal: true };
          case 'value-table':
            return { label, spec: { bot: member.bot, table: valueTable }, legal: true };
          case 'value-lsm':
            return { label, spec: { bot: member.bot, table: valueTable, hyper: VALUE_LSM_HYPER }, legal: true };
          case 'value-lookahead-all':
          case 'rollout':
            throw new RangeError('not a member of the certified suite');
          case 'random-walk':
            return { label, spec: { bot: 'random-walk-sampled' }, legal: true };
          default:
            return { label, spec: member, legal: true };
        }
      }),
      { label: 'value-lookahead-all', spec: { bot: 'value-lookahead-all', table: valueTable }, legal: true },
      { label: 'rollout(32)', spec: { bot: 'rollout', samples: 4, table: valueTable }, legal: true },
      { label: 'oracle-stop', spec: { bot: 'oracle-stop' }, legal: false },
    ];
  }, 120_000);

  it('every legal bot repeats its decisions when the unseen part of the maze is redrawn; oracle-stop does not', () => {
    // Establishes non-interference for the bots: replay the game on a maze drawn from the exact
    // posterior at a random step. The observations up to that step are identical, so the
    // decisions up to and including that step must be too. The oracle (negative control) reads
    // the hidden maze and must be caught.
    const g = new Game(ECON5);
    const feed = new MazeFeed(SOURCE, 5, 5);
    const scratch = new WilsonScratch(g.cells);
    const redrawn = new Uint8Array(g.cells);
    const chooser = fastRng(77n);
    for (const { label, spec, legal } of specs) {
      const bot = createBot(spec, g);
      let mismatches = 0;
      let checked = 0;
      for (let index = 0; index < 150; index++) {
        feed.load(index);
        const original = feed.open.slice();
        const first = decisions(g, bot, original, BigInt(index));
        const step = chooser.nextBelow(first.length);
        // Walk to that step and redraw everything not yet seen.
        g.begin(original, fastRng(1n));
        for (let t = 0; t < step; t++) g.advance(Array.from(g.childDir.subarray(0, g.nc)).indexOf(first[t]));
        samplePosteriorMaze(g, chooser, scratch, redrawn);
        const second = decisions(g, bot, redrawn, BigInt(index), step + 1);
        checked += 1;
        if (second.join(',') !== first.slice(0, step + 1).join(',')) mismatches += 1;
      }
      expect(checked).toBe(150);
      if (legal) expect(mismatches, label).toBe(0);
      else expect(mismatches, label).toBeGreaterThan(0);
    }
  }, 300_000);
});

describe('suite membership', () => {
  it('CERTIFIED_SUITE and GATE2_ONLY are the lists of plan §3.3', () => {
    expect(certifiedSuite(8).map(memberLabel)).toEqual([
      'immediate-cashout',
      'one-step-cashout',
      'fixed-k-cashout(2)',
      'fixed-k-cashout(3)',
      'fixed-k-cashout(4)',
      'fixed-k-cashout(5)',
      'fixed-k-cashout(6)',
      'fixed-k-cashout(7)',
      'fixed-k-cashout(8)',
      'junction-quit(1)',
      'junction-quit(2)',
      'junction-quit(3)',
      'start-selective(E)',
      'start-selective(S)',
      'random-walk',
      'naive-greedy',
      'sloppy-greedy(0.10)',
      'nervous(0.10)',
      'region-heuristic',
      'param-search',
      'harmonic',
      'harmonic-lsm',
      'value-table',
      'value-lsm',
    ]);
    expect(certifiedSuite(18)).toHaveLength(34);
    expect(GATE2_ONLY.map(memberLabel)).toEqual(['rollout(32)', 'value-lookahead-all']);
    const everything = [...certifiedSuite(18), ...GATE2_ONLY].map(memberLabel);
    expect(everything).not.toContain('oracle-stop');
    expect(everything).not.toContain('exact-optimal');
  });

  it('a finished game has one of the three outcomes', () => {
    const g = new Game(ECON5);
    const feed = new MazeFeed(SOURCE, 5, 5);
    const bot = createBot({ bot: 'nervous', epsilon: 0.1 }, g);
    for (let index = 0; index < 200; index++) {
      feed.load(index);
      g.begin(feed.open, feed.rng);
      bot.begin(g);
      finish(g, bot);
      expect([OUTCOME_EXIT, OUTCOME_CASH, OUTCOME_LOSS]).toContain(g.outcome);
    }
  });
});
