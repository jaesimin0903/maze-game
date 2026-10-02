// Game engine: the rules a simulated game follows and the statistics of a run.

import { describe, expect, it } from 'vitest';
import { fastRng, replayMoves, solve, type Dir } from '@maze/shared';
import { createBot, type Bot } from '../src/bots/index';
import {
  CASH_OUT,
  emptyStats,
  Game,
  markSolution,
  MazeFeed,
  mergeStats,
  OUTCOME_CASH,
  OUTCOME_EXIT,
  OUTCOME_LOSS,
  play,
  runGames,
  runPairs,
  SolutionScratch,
  closeStats,
  type MazeSource,
} from '../src/engine';
import { econFor } from './helpers';

/** Wraps a bot and records what it did. */
class Recorder implements Bot {
  moves: Dir[] = [];
  cashedAt: number | null = null;

  constructor(private readonly inner: Bot) {}

  begin(g: Game): void {
    this.moves = [];
    this.cashedAt = null;
    this.inner.begin(g);
  }

  decide(g: Game): number {
    const action = this.inner.decide(g);
    if (action === CASH_OUT) this.cashedAt = g.k;
    else this.moves.push(g.childDir[action] as Dir);
    return action;
  }
}

const SOURCE: MazeSource = { kind: 'rng', mode: 'fast', stream: 'E' };

describe('engine rules', () => {
  it('agrees with the shared replay rules on outcome, step count and payout for 3,000 random games', () => {
    // Establishes: a simulated game ends exactly as the server and the contract would settle it.
    for (const n of [5, 7]) {
      const econ = econFor(n, n, 31_000);
      const g = new Game(econ);
      const feed = new MazeFeed(SOURCE, n, n);
      for (const spec of [{ bot: 'nervous', epsilon: 0.1 }, { bot: 'random-walk-sampled' }, { bot: 'fixed-k-cashout', k: 3 }] as const) {
        const recorder = new Recorder(createBot(spec, g));
        for (let index = 0; index < 500; index++) {
          feed.load(index);
          play(g, recorder, feed.open, feed.rng);
          const replay = replayMoves({ w: n, h: n, open: feed.open }, recorder.moves, recorder.cashedAt ?? undefined);
          expect(replay.invalidAt).toBeNull();
          expect(replay.outcome).toBe(g.outcome);
          expect(replay.steps).toBe(g.k);
          const expected = g.outcome === OUTCOME_EXIT ? econ.multiplierBps : g.outcome === OUTCOME_CASH ? econ.refundBps[g.k] : 0;
          expect(g.payoutBps).toBe(expected);
          if (g.outcome === OUTCOME_LOSS) expect(g.nc).toBe(0);
        }
      }
    }
  });

  it('the start cell always offers exactly one move, and children never include the way back', () => {
    const g = new Game(econFor(7, 7, 60_000));
    const feed = new MazeFeed(SOURCE, 7, 7);
    const bot = createBot({ bot: 'random-walk-sampled' }, g);
    for (let index = 0; index < 300; index++) {
      feed.load(index);
      g.begin(feed.open, feed.rng);
      expect(g.nc).toBe(1);
      expect([1, 2]).toContain(g.startDir);
      while (g.nc > 0 && g.cell !== g.exit) {
        const previous = g.cell;
        g.advance(bot.decide(g));
        for (let i = 0; i < g.nc; i++) expect(g.childCell[i]).not.toBe(previous);
      }
    }
  });

  it('markSolution marks the unique path and returns the uniform-walk win probability', () => {
    const g = new Game(econFor(7, 7, 60_000));
    const scratch = new SolutionScratch(g.cells);
    const feed = new MazeFeed(SOURCE, 7, 7);
    for (let index = 0; index < 200; index++) {
      feed.load(index);
      const probability = markSolution(g, feed.open, scratch);
      const path = solve({ w: 7, h: 7, open: feed.open });
      const marked = Array.from(scratch.onPath).flatMap((flag, cell) => (flag === 1 ? [cell] : []));
      expect(marked).toEqual([...path].sort((a, b) => a - b));
      let expected = 1;
      for (const cell of path.slice(0, -1)) {
        const openings = [1, 2, 4, 8].filter((bit) => (feed.open[cell] & bit) !== 0).length;
        expected /= cell === 0 ? openings : openings - 1;
      }
      expect(probability).toBeCloseTo(expected, 12);
    }
  });
});

describe('engine statistics', () => {
  it('a run split at any point merges to exactly the unsplit run', () => {
    // Establishes: results do not depend on how games are divided between workers or chunks.
    const econ = econFor(5, 5, 26_000);
    const g = new Game(econ);
    const whole = runGames(g, createBot({ bot: 'nervous', epsilon: 0.1 }, g), SOURCE, 0, 4000);
    for (const cut of [1, 1234, 3999]) {
      const merged = emptyStats(g.cells);
      mergeStats(merged, runGames(g, createBot({ bot: 'nervous', epsilon: 0.1 }, g), SOURCE, 0, cut));
      mergeStats(merged, runGames(g, createBot({ bot: 'nervous', epsilon: 0.1 }, g), SOURCE, cut, 4000));
      closeStats(merged, econ);
      expect(merged).toEqual(whole);
    }
  });

  it('sum and sum of squares follow from the exact counts', () => {
    const econ = econFor(5, 5, 26_000);
    const g = new Game(econ);
    const stats = runGames(g, createBot({ bot: 'nervous', epsilon: 0.1 }, g), SOURCE, 0, 5000);
    expect(stats.n).toBe(5000);
    expect(stats.wins + stats.losses + stats.cash.reduce((a, b) => a + b, 0)).toBe(5000);
    let sum = stats.wins * econ.multiplierBps;
    let sumSq = stats.wins * econ.multiplierBps ** 2;
    stats.cash.forEach((count, k) => {
      sum += count * econ.refundBps[k];
      sumSq += count * econ.refundBps[k] ** 2;
    });
    expect(stats.sum).toBe(sum);
    expect(stats.sumSq).toBe(sumSq);
    expect(stats.startE).toBeGreaterThan(2300);
    expect(stats.startE).toBeLessThan(2700);
  });

  it('a paired run plays both bots on the same mazes', () => {
    // Establishes: D = A − B is a difference on identical mazes (zero for identical bots), and
    // each side equals the bot's own unpaired run.
    const econ = econFor(5, 5, 26_000);
    const g = new Game(econ);
    const same = runPairs(g, createBot({ bot: 'harmonic' }, g), createBot({ bot: 'harmonic' }, g), SOURCE, 0, 1500);
    expect(same.n).toBe(1500);
    expect(same.sumD).toBe(0);
    expect(same.sumSqD).toBe(0);
    const pair = runPairs(g, createBot({ bot: 'harmonic' }, g), createBot({ bot: 'naive-greedy' }, g), SOURCE, 0, 1500);
    expect(pair.a).toEqual(runGames(g, createBot({ bot: 'harmonic' }, g), SOURCE, 0, 1500));
    expect(pair.b).toEqual(runGames(g, createBot({ bot: 'naive-greedy' }, g), SOURCE, 0, 1500));
    expect(pair.sumD).toBe(pair.a.sum - pair.b.sum);
  });

  it('an enumerated source plays maze i mod count', () => {
    const econ = econFor(3, 3, 20_000);
    const g = new Game(econ);
    const feed = new MazeFeed({ kind: 'rng', mode: 'fast', stream: 'E' }, 3, 3);
    const mazes = new Uint8Array(4 * 9);
    for (let i = 0; i < 4; i++) {
      feed.load(i);
      mazes.set(feed.open, i * 9);
    }
    const source: MazeSource = { kind: 'enum', stream: 'B', mazes, count: 4 };
    const once = runGames(g, createBot({ bot: 'naive-greedy' }, g), source, 0, 4);
    const thrice = runGames(g, createBot({ bot: 'naive-greedy' }, g), source, 0, 12);
    expect(thrice.wins).toBe(3 * once.wins);
    expect(thrice.sum).toBe(3 * once.sum);
  });

  it('fastRng streams feed the shared generator directly', () => {
    // A perfect maze has cells − 1 passages: the feed hands out real mazes.
    const feed = new MazeFeed(SOURCE, 10, 10);
    feed.load(0);
    const passages = Array.from(feed.open).reduce((total, mask) => total + [1, 2, 4, 8].filter((bit) => (mask & bit) !== 0).length, 0);
    expect(passages).toBe(2 * 99);
    expect(fastRng(1n).nextBelow(4)).toBeLessThan(4);
  });
});
