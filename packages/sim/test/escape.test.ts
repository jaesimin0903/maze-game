// `sim:escape` (packages/sim/src/escape): the exact random-walk product on hand-built mazes and
// against the engine, the Wilson interval against published values, the stopping rule, the
// generator census and the full enumeration, and determinism (same request → same numbers, with
// any number of jobs in flight). These modules are outside the simulator code hash.

import { fastRng, generateGridFromRng, isPerfect } from '@maze/shared';
import { describe, expect, it } from 'vitest';
import { certifiedTiers } from '../src/attack/context';
import { createBot } from '../src/bots/index';
import { hashedFiles, simPackageRoot } from '../src/codehash';
import { Game, markSolution, OUTCOME_CASH, OUTCOME_EXIT, OUTCOME_LOSS, play, SolutionScratch } from '../src/engine';
import { enumeratedGrid } from '../src/exact';
import { censusCheck, edgeKey, enumeratedIndex, fullExact, generatorWeights, SolutionWalker } from '../src/escape/exact';
import { census, CENSUS_SPAN, escapeGameSeed, escapeStreamDisjoint, noEconomics, playGames, playPaired, type GameColumns } from '../src/escape/jobs';
import { InlineEscapeExecutor } from '../src/escape/pool';
import { formatSummary, renderMarkdown } from '../src/escape/report';
import {
  addGames,
  collectEscapeStats,
  compare,
  emptyCounts,
  playCell,
  summarizeHistogram,
  validateRequest,
  wilsonInterval,
  type EscapeRequest,
} from '../src/escape/run';

const N = 1;
const E = 2;
const S = 4;
const W = 8;

/** Open-side masks of a `w × h` maze from its passages, each a pair of neighbouring cells. */
function mazeOf(w: number, h: number, passages: [number, number][]): Uint8Array {
  const open = new Uint8Array(w * h);
  for (const [a, b] of passages) {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    if (hi === lo + 1 && lo % w < w - 1) {
      open[lo] |= E;
      open[hi] |= W;
    } else if (hi === lo + w) {
      open[lo] |= S;
      open[hi] |= N;
    } else {
      throw new RangeError(`cells ${a} and ${b} are not neighbours`);
    }
  }
  if (!isPerfect({ w, h, open })) throw new RangeError('not a spanning tree');
  return open;
}

/*
 *   0 ─ 1 ─ 2      Path 0 → 1 → 2 → 5 → 8. Cell 1 offers E and S (W is the way back); every
 *       │   │      other path cell offers one move: P = 1/2.
 *   3 ─ 4   5
 *   │   │   │
 *   6   7   8
 */
const HALF = mazeOf(3, 3, [
  [0, 1],
  [1, 2],
  [1, 4],
  [2, 5],
  [3, 4],
  [3, 6],
  [4, 7],
  [5, 8],
]);

/*
 *   0 ─ 1   2      Path 0 → 1 → 4 → 7 → 8. Cell 4 offers W, E and S (N is the way back): P = 1/3.
 *       │   │
 *   3 ─ 4 ─ 5
 *   │   │
 *   6   7 ─ 8
 */
const THIRD = mazeOf(3, 3, [
  [0, 1],
  [1, 4],
  [3, 4],
  [4, 5],
  [4, 7],
  [3, 6],
  [2, 5],
  [7, 8],
]);

/*
 *    0 ─ 1 ─ 2 ─ 3      Path 0 → 1 → 2 → 6 → 10 → 14 → 15 (6 moves). Forward moves: cell 1 two
 *        │   │          (E, S), cell 2 two (E, S), cell 6 two (E, S), cell 10 three (W, E, S),
 *    4 ─ 5   6 ─ 7      cell 14 two (W, E): P = 1/2 · 1/2 · 1/2 · 1/3 · 1/2 = 1/48.
 *    │       │
 *    8   9 ─ 10─ 11
 *    │       │
 *   12   13─ 14─ 15
 */
const FORTY_EIGHTH = mazeOf(4, 4, [
  [0, 1],
  [1, 2],
  [2, 3],
  [1, 5],
  [2, 6],
  [4, 5],
  [6, 7],
  [4, 8],
  [6, 10],
  [9, 10],
  [10, 11],
  [8, 12],
  [10, 14],
  [13, 14],
  [14, 15],
]);

describe('the exact random-walk product', () => {
  it('is the product of 1 / (forward moves) along the path of hand-built mazes', () => {
    const walker3 = new SolutionWalker(3, 3);
    expect(walker3.walk(HALF)).toBe(1 / 2);
    expect(walker3.length).toBe(4);
    expect(walker3.walk(THIRD)).toBeCloseTo(1 / 3, 15);
    expect(walker3.length).toBe(4);
    // 2×2 has two corridor mazes and neither has a choice on its path.
    const walker2 = new SolutionWalker(2, 2);
    expect(walker2.walk(mazeOf(2, 2, [[0, 1], [1, 3], [2, 3]]))).toBe(1);
    expect(walker2.walk(mazeOf(2, 2, [[0, 2], [2, 3], [1, 3]]))).toBe(1);
    expect(walker2.length).toBe(2);
  });

  it('counts a cell with three forward moves on a longer path', () => {
    const walker = new SolutionWalker(4, 4);
    expect(walker.walk(FORTY_EIGHTH)).toBeCloseTo(1 / 48, 15);
    expect(walker.length).toBe(6);
  });

  it('agrees with the engine on generated mazes of every size', () => {
    for (const n of [3, 4, 5, 7, 9]) {
      const g = new Game(noEconomics(n));
      const scratch = new SolutionScratch(n * n);
      const walker = new SolutionWalker(n, n);
      for (let i = 0; i < 300; i++) {
        const open = generateGridFromRng(fastRng(escapeGameSeed(n, i)), n, n).open;
        expect(walker.walk(open)).toBeCloseTo(markSolution(g, open, scratch), 14);
        let onPath = 0;
        for (const mark of scratch.onPath) onPath += mark;
        expect(walker.length).toBe(onPath - 1);
      }
    }
  });

  it('is what the sampled walk of the engine does on a hand-built maze', () => {
    const g = new Game(noEconomics(3));
    const bot = createBot({ bot: 'random-walk-sampled' }, g);
    const games = 30_000;
    let exits = 0;
    for (let i = 0; i < games; i++) {
      play(g, bot, THIRD, fastRng(BigInt(i) + 77n));
      if (g.outcome === OUTCOME_EXIT) exits += 1;
      else expect(g.outcome).toBe(OUTCOME_LOSS);
    }
    const se = Math.sqrt(((1 / 3) * (2 / 3)) / games);
    expect(Math.abs(exits / games - 1 / 3)).toBeLessThan(4 * se);
  });
});

describe('the Wilson interval', () => {
  // Newcombe (1998), Statistics in Medicine 17, 857–872, Table I, method 3 (score, no correction).
  it.each([
    [81, 263, 0.2553, 0.3662],
    [15, 148, 0.0624, 0.1605],
    [0, 20, 0, 0.1611],
    [1, 29, 0.0061, 0.1718],
  ])('%i / %i is [%f, %f]', (x, n, lo, hi) => {
    const ci = wilsonInterval(x, n);
    expect(ci.lo).toBeCloseTo(lo, 4);
    expect(ci.hi).toBeCloseTo(hi, 4);
  });

  it('is symmetric, reaches 1 at n / n and rejects impossible counts', () => {
    const a = wilsonInterval(30, 100);
    const b = wilsonInterval(70, 100);
    expect(a.lo).toBeCloseTo(1 - b.hi, 12);
    expect(a.hi).toBeCloseTo(1 - b.lo, 12);
    expect(wilsonInterval(20, 20).hi).toBe(1);
    expect(() => wilsonInterval(5, 4)).toThrow(RangeError);
    expect(() => wilsonInterval(0, 0)).toThrow(RangeError);
  });
});

function columns(outcomes: number[], exactP: number[] = []): GameColumns {
  return {
    outcome: Uint8Array.from(outcomes),
    steps: Uint16Array.from(outcomes.map((_, i) => i + 1)),
    pathLength: Uint16Array.from(outcomes.map(() => 4)),
    exactP: Float64Array.from(exactP),
  };
}

describe('the stopping rule', () => {
  it('counts games up to and including the k-th escape, across jobs', () => {
    const counts = emptyCounts(9);
    const X = OUTCOME_EXIT;
    const L = OUTCOME_LOSS;
    expect(addGames(counts, columns([L, X, L], [0.1, 0.9, 0.2]), 3)).toBe(false);
    expect(counts).toMatchObject({ games: 3, exits: 1, deadEnds: 2 });
    expect(addGames(counts, columns([L, X, X, L, X], [0.3, 0.4, 0.5, 0.6, 0.7]), 3)).toBe(true);
    // The third escape is the third game of the second job; the two games after it are not counted.
    expect(counts).toMatchObject({ games: 6, exits: 3, deadEnds: 3, cashOuts: 0 });
    expect(counts.sumP).toBeCloseTo(0.1 + 0.9 + 0.2 + 0.3 + 0.4 + 0.5, 12);
    expect(counts.exitSteps).toBe(2 + 2 + 3);
    expect(addGames(counts, columns([X]), 3)).toBe(true);
    expect(counts.games).toBe(6);
  });

  it('stops a cell on its k-th escape, and at the game cap when that comes first', async () => {
    const request: EscapeRequest = { sizes: [5], policies: ['random-walk'], escapes: 25, maxGames: 1_000_000, seed: 0, tiers: new Map(), censusPerMaze: 0 };
    const counts = await playCell(5, { policy: 'random-walk' }, request, new InlineEscapeExecutor(2));
    expect(counts.exits).toBe(25);
    const replay = playGames({ kind: 'games', n: 5, policy: { policy: 'random-walk' }, first: 0, games: counts.games });
    expect(replay.outcome[counts.games - 1]).toBe(OUTCOME_EXIT);
    expect(replay.outcome.filter((o) => o === OUTCOME_EXIT).length).toBe(25);

    const capped = await playCell(9, { policy: 'random-walk' }, { ...request, escapes: 1_000, maxGames: 3_500 }, new InlineEscapeExecutor(2));
    expect(capped.games).toBe(3_500);
    expect(capped.exits).toBeLessThan(1_000);
  });
});

describe('the generator and the full enumeration', () => {
  it('draws every corridor maze of 3x3 with the weight the enumeration gives it', () => {
    const e = enumeratedGrid(3, 3);
    const { east, south } = generatorWeights(e);
    expect([e.count, east, south]).toEqual([112, 56, 56]);
    const result = census({ kind: 'census', n: 3, first: 0, games: 112 * 200 });
    expect(result.unknown).toBe(0);
    expect(censusCheck(3, result.counts, result.unknown).pass).toBe(true);
    // The census notices a generator that favours one start direction by 10%.
    const skewed = Float64Array.from(result.counts, (count, i) => ((e.mazes[i * 9] & E) !== 0 ? count * 1.1 : count * 0.9));
    expect(censusCheck(3, skewed, 0).pass).toBe(false);
  });

  it('notices a few 4x4 mazes that never come out, which the chi-square alone lets through', () => {
    const e = enumeratedGrid(4, 4);
    const perfect = new Float64Array(e.count).fill(100);
    const clean = censusCheck(4, perfect, 0);
    expect(clean).toMatchObject({ zeroCells: 0, minCount: 100, pass: true });
    expect(clean.expectedZeroCells).toBeLessThan(1e-30);
    // Three mazes are never drawn and their draws go to three others: χ² barely moves.
    const missing = Float64Array.from(perfect);
    for (const i of [7, 20_000, 59_999]) missing[i] = 0;
    for (const i of [8, 20_001, 60_000]) missing[i] = 200;
    const check = censusCheck(4, missing, 0);
    expect(check.z).toBeLessThan(4);
    expect(check.zeroCells).toBe(3);
    expect(check.maxResidual).toBeCloseTo(10, 6);
    expect(check.pass).toBe(false);
  });

  it('indexes every enumerated 4x4 maze by its edges', () => {
    const e = enumeratedGrid(4, 4);
    const index = enumeratedIndex(4);
    expect(index.size).toBe(e.count);
    expect(index.get(edgeKey(e.mazes.subarray(16 * 123, 16 * 124), 4, 4))).toBe(123);
    expect(index.has(edgeKey(FORTY_EIGHTH, 4, 4))).toBe(true);
  });

  it('weights the exact values as the generator does and matches the engine maze by maze', () => {
    const exact = fullExact(3);
    expect(exact.uniform).toBe(true);
    const e = enumeratedGrid(3, 3);
    const g = new Game(noEconomics(3));
    const scratch = new SolutionScratch(9);
    const naive = createBot({ bot: 'naive-greedy' }, g);
    let rw = 0;
    let wins = 0;
    for (let i = 0; i < e.count; i++) {
      const open = e.mazes.subarray(i * 9, (i + 1) * 9);
      rw += markSolution(g, open, scratch);
      play(g, naive, open, fastRng(0n));
      if (g.outcome === OUTCOME_EXIT) wins += 1;
    }
    expect(exact.escape['random-walk']).toBeCloseTo(rw / e.count, 14);
    expect(exact.escape['naive-greedy']).toBeCloseTo(wins / e.count, 14);
    expect(exact.pathLength.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 14);
    expect(summarizeHistogram(exact.pathLength)!.min).toBe(4);
    // No policy escapes more often than the expectimax optimum: 82 of the 112 mazes.
    expect(exact.optimal).toBeCloseTo(82 / 112, 14);
    for (const p of Object.values(exact.escape)) expect(p).toBeLessThanOrEqual(exact.optimal + 1e-12);
  });
});

describe('cells and determinism', () => {
  const request: EscapeRequest = {
    sizes: [3, 5],
    policies: ['random-walk', 'naive-greedy', 'harmonic'],
    escapes: 60,
    maxGames: 1_000_000,
    seed: 0,
    tiers: new Map(),
    censusPerMaze: 3,
  };

  it('gives the same numbers for the same request, whatever the number of jobs in flight', async () => {
    const one = await collectEscapeStats(request, new InlineEscapeExecutor(1), () => {});
    const again = await collectEscapeStats(request, new InlineEscapeExecutor(1), () => {});
    const wide = await collectEscapeStats(request, new InlineEscapeExecutor(5), () => {});
    expect(again).toEqual(one);
    expect(wide).toEqual(one);
    expect(one.cells.map((cell) => cell.escapes)).toEqual([60, 60, 60, 60, 60, 60]);
    expect(one.checks.every((check) => check.pass)).toBe(true);
    // A different seed plays different mazes.
    const moved = await collectEscapeStats({ ...request, seed: 1 }, new InlineEscapeExecutor(1), () => {});
    expect(moved.cells.map((cell) => cell.games)).not.toEqual(one.cells.map((cell) => cell.games));
  });

  it('never cashes out without economics and splits every game into exit, cash-out or dead end', async () => {
    const stats = await collectEscapeStats({ ...request, censusPerMaze: 0 }, new InlineEscapeExecutor(1), () => {});
    for (const cell of stats.cells) {
      expect(cell.counts.cashOuts).toBe(0);
      expect(cell.counts.exits + cell.counts.cashOuts + cell.counts.deadEnds).toBe(cell.games);
      expect(cell.meanStepsToExit).toBeCloseTo(summarizeHistogram(cell.counts.exitPathHist)!.mean, 12);
    }
    const run = { generatedAt: 'now', command: 'test', seconds: 1, workers: 1 };
    expect(renderMarkdown(stats, run)).toContain('| 크기 | 정책 | 판 수 | 탈출 | p̂ [95% CI] |');
    expect(formatSummary(stats, run)).toContain('checks: ');
  });

  it('plays value-lsm on a certified tier with its cash-outs, and skips the sizes without one', async () => {
    const tiers = new Map((await certifiedTiers('production')).map((tier) => [tier.n, { econ: tier.econ, table: tier.valueTable }]));
    const stats = await collectEscapeStats(
      { ...request, policies: ['value-lsm'], escapes: 200, censusPerMaze: 0, tiers },
      new InlineEscapeExecutor(1),
      () => {},
    );
    expect(stats.skipped.map((s) => s.n)).toEqual([3]);
    const [cell] = stats.cells;
    expect(cell.n).toBe(5);
    expect(cell.counts.cashOuts).toBeGreaterThan(0);
    expect(cell.rates.exit + cell.rates.cashOut + cell.rates.deadEnd).toBeCloseTo(1, 12);
    const replay = playGames({ kind: 'games', n: 5, policy: { policy: 'value-lsm', ...tiers.get(5)! }, first: 0, games: cell.games });
    expect(replay.outcome.filter((o) => o === OUTCOME_CASH).length).toBe(cell.counts.cashOuts);
  });
});

describe('paired comparisons', () => {
  it('plays both policies on each maze exactly as their own cells do', () => {
    const games = 3_000;
    const paired = playPaired({ kind: 'paired', n: 5, a: { policy: 'harmonic' }, b: { policy: 'random-walk' }, first: 0, games });
    const harmonic = playGames({ kind: 'games', n: 5, policy: { policy: 'harmonic' }, first: 0, games });
    const walk = playGames({ kind: 'games', n: 5, policy: { policy: 'random-walk' }, first: 0, games });
    const expected = new Array<number>(9).fill(0);
    for (let i = 0; i < games; i++) expected[3 * harmonic.outcome[i] + walk.outcome[i]] += 1;
    expect(paired.table).toEqual(expected);
  });

  it('turns a table of paired outcomes into a difference with its interval', () => {
    // a exits alone in 30 games, b alone in 10, both in 50, neither in 910 (of which a cashed out of 100).
    const flat = [50, 0, 30, 0, 0, 100, 10, 0, 810];
    const c = compare(5, 'value-lsm', 'harmonic', flat);
    expect(c.games).toBe(1_000);
    expect(c.exitA).toBeCloseTo(0.08, 12);
    expect(c.exitB).toBeCloseTo(0.06, 12);
    expect(c.diff).toBeCloseTo(0.02, 12);
    const se = Math.sqrt(((40 / 1000 - 0.02 ** 2) * (1000 / 999)) / 1000);
    expect(c.ci95.hi - c.diff).toBeCloseTo(1.959963984540054 * se, 12);
    expect(c.shown).toBe(true);
    expect(c.cashOut).toMatchObject({ rate: 0.1, bExitWhenCashed: 0 });
    expect(c.cashOut!.proportionalLoss).toBeCloseTo(0.1 * 0.06, 12);
    // The same table with the discordant games balanced shows no difference.
    expect(compare(5, 'harmonic', 'naive-greedy', [50, 0, 20, 0, 0, 0, 20, 0, 910]).shown).toBe(false);
  });

  it('compares harmonic with naive-greedy on every size and finds the exact difference on 3x3', async () => {
    const stats = await collectEscapeStats(
      { sizes: [3, 4], policies: ['naive-greedy', 'harmonic'], escapes: 100, maxGames: 1_000_000, seed: 0, tiers: new Map(), censusPerMaze: 0 },
      new InlineEscapeExecutor(1),
      () => {},
    );
    expect(stats.comparisons.map((c) => [c.n, c.a, c.b])).toEqual([
      [3, 'harmonic', 'naive-greedy'],
      [4, 'harmonic', 'naive-greedy'],
    ]);
    // On 3×3 the two play every maze alike.
    expect(stats.comparisons[0].diff).toBe(0);
    expect(stats.comparisons[0].games).toBe(Math.max(...stats.cells.filter((cell) => cell.n === 3).map((cell) => cell.games)));
    expect(stats.checks.every((check) => check.pass)).toBe(true);
  });
});

describe('request limits', () => {
  const request: EscapeRequest = { sizes: [3], policies: ['naive-greedy'], escapes: 10, maxGames: 1_000, seed: 0, tiers: new Map(), censusPerMaze: 0 };

  it('refuses a census that would reach the next seed, before playing anything', async () => {
    const limit = Math.floor(CENSUS_SPAN / 112);
    expect(() => validateRequest({ ...request, censusPerMaze: limit })).not.toThrow();
    expect(() => validateRequest({ ...request, censusPerMaze: limit + 1 })).toThrow(RangeError);
    // 4×4 has 60,032 mazes, so its limit is far lower.
    expect(() => validateRequest({ ...request, sizes: [4], censusPerMaze: Math.floor(CENSUS_SPAN / 60_032) + 1 })).toThrow(RangeError);
    // Sizes that are not enumerated have no census.
    expect(() => validateRequest({ ...request, sizes: [5], censusPerMaze: limit + 1 })).not.toThrow();
    const untouched = {
      size: 1,
      run: () => {
        throw new Error('nothing may run');
      },
      close: () => Promise.resolve(),
    };
    await expect(collectEscapeStats({ ...request, censusPerMaze: limit + 1 }, untouched, () => {})).rejects.toThrow(RangeError);
  });

  it('refuses cells whose games would reach the census', () => {
    expect(() => validateRequest({ ...request, maxGames: 2 ** 31 })).not.toThrow();
    expect(() => validateRequest({ ...request, maxGames: 2 ** 31 + 1 })).toThrow(RangeError);
  });
});

describe('isolation', () => {
  it('plays on a stream of its own, outside the simulator code hash', () => {
    expect(escapeStreamDisjoint()).toBe(true);
    expect(hashedFiles(simPackageRoot()).some((path) => path.includes('/escape/'))).toBe(false);
  });
});
