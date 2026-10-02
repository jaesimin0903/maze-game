// Value tables: binning, the fallback order, what a training pass records, and the harmonic-lsm
// backward induction.

import { describe, expect, it } from 'vitest';
import { createBot } from '../src/bots/index';
import { HarmonicPolicy } from '../src/bots/value-core';
import { Game, MazeFeed, runGames, SolutionScratch, type MazeSource } from '../src/engine';
import {
  EXPLORE_JUNCTIONS,
  finalizeRegionTable,
  finalizeTable,
  harmonicLsmTable,
  lookup,
  newAccumulator,
  qBinOf,
  ratioBinOf,
  recordTrajectories,
  shapeOf,
  tableIndex,
  trainGames,
  winAtDistanceOf,
  type PlanningPolicy,
} from '../src/lsm';
import { econFor } from './helpers';

const SOURCE: MazeSource = { kind: 'rng', mode: 'fast', stream: 'C' };

describe('bins', () => {
  it('posterior bins have width 0.05 and survive rounding at the edges', () => {
    expect(qBinOf(0, 20)).toBe(0);
    expect(qBinOf(0.049, 20)).toBe(0);
    expect(qBinOf(0.05, 20)).toBe(1);
    expect(qBinOf(0.5, 20)).toBe(10);
    expect(qBinOf(0.5 - 1e-13, 20)).toBe(10);
    expect(qBinOf(0.15 + 0.1, 20)).toBe(5);
    expect(qBinOf(1, 20)).toBe(19);
    expect(qBinOf(1 + 1e-12, 20)).toBe(19);
    expect(ratioBinOf(0.3, 1)).toBe(0);
    expect(ratioBinOf(0.5, 4)).toBe(2);
    expect(ratioBinOf(1, 4)).toBe(3);
  });
});

describe('table fallbacks (plan §3.3)', () => {
  const shape = shapeOf(4, 4);
  const d = 3;

  it('a cell with at least 200 games is its own mean; thinner cells pool over d, then over k ± 2, then q × M × S[d]', () => {
    const acc = newAccumulator(shape);
    const put = (k: number, qb: number, dist: number, games: number, mean: number): void => {
      acc.cnt[tableIndex(shape, k, qb, dist, 0)] = games;
      acc.sum[tableIndex(shape, k, qb, dist, 0)] = games * mean;
    };
    put(5, 10, d, 200, 7000); // enough on its own
    put(5, 11, d, 199, 9000); // one short …
    put(5, 11, d + 1, 1, 1000); // … but (k, qBin) pooled over d has 200
    put(8, 12, d, 50, 4000); // thin; (k, qBin) pooled has 50 …
    put(9, 12, d, 60, 5000);
    put(10, 12, d, 90, 6000); // … k ± 2 pooled has 200
    put(13, 3, d, 10, 2000); // nothing reaches 200
    const s = new Float64Array(shape.shortest + 1).fill(0.25);
    const table = finalizeTable(shape, acc, s, 1, 200);
    expect(table.values[tableIndex(shape, 5, 10, d, 0)]).toBe(7000);
    expect(table.values[tableIndex(shape, 5, 11, d, 0)]).toBeCloseTo((199 * 9000 + 1000) / 200, 9);
    expect(table.values[tableIndex(shape, 8, 12, d, 0)]).toBeCloseTo((50 * 4000 + 60 * 5000 + 90 * 6000) / 200, 9);
    // k = 11 sees k 9 .. 13 → 150 games: not enough.
    expect(Number.isNaN(table.values[tableIndex(shape, 11, 12, d, 0)])).toBe(true);
    expect(Number.isNaN(table.values[tableIndex(shape, 13, 3, d, 0)])).toBe(true);
    // Last resort at lookup time: q × M × S[d].
    expect(lookup(table, 13, 0.17, d, 0, 20_000)).toBeCloseTo(0.17 * 20_000 * 0.25, 9);
    expect(lookup(table, 5, 0.52, d, 0, 20_000)).toBe(7000);
  });

  it('the harmonic pass records wins and is scaled by the multiplier', () => {
    const acc = newAccumulator(shape);
    acc.cnt[tableIndex(shape, 2, 19, d, 0)] = 400;
    acc.sum[tableIndex(shape, 2, 19, d, 0)] = 100; // 100 wins in 400 games
    const table = finalizeTable(shape, acc, new Float64Array(shape.shortest + 1), 18_000, 200);
    expect(table.values[tableIndex(shape, 2, 19, d, 0)]).toBe(4500);
  });

  it('S[d] takes the nearest distance with enough visits and is 1 on the exit', () => {
    const cnt = Float64Array.from([0, 500, 10, 0, 300, 5, 0]);
    const win = Float64Array.from([0, 400, 9, 0, 60, 5, 0]);
    const s = winAtDistanceOf(cnt, win, 200);
    expect(Array.from(s)).toEqual([1, 0.8, 0.8, 0.2, 0.2, 0.2, 0.2]);
    // No distance has enough: the pooled rate.
    expect(winAtDistanceOf(Float64Array.from([0, 3, 1]), Float64Array.from([0, 1, 1]), 200)[1]).toBe(0.5);
  });

  it('the region table takes the nearest k with enough walks, the smaller k on a tie', () => {
    const cells = 9;
    const shortest = 4;
    const acc = { win: new Float64Array(cells * 5), cnt: new Float64Array(cells * 5) };
    const put = (k: number, dist: number, games: number, wins: number): void => {
      acc.cnt[k * 5 + dist] = games;
      acc.win[k * 5 + dist] = wins;
    };
    put(1, 2, 400, 100);
    put(5, 2, 400, 300);
    put(3, 2, 20, 20);
    const table = finalizeRegionTable(acc, cells, shortest, 200);
    expect(table.win[1 * 5 + 2]).toBe(0.25);
    expect(table.win[2 * 5 + 2]).toBe(0.25);
    expect(table.win[3 * 5 + 2]).toBe(0.25); // k = 1 and k = 5 are equally near: the smaller k
    expect(table.win[4 * 5 + 2]).toBe(0.75);
    expect(table.win[8 * 5 + 2]).toBe(0.75);
    expect(table.win[3 * 5 + 1]).toBe(0); // a distance that was never chosen
  });
});

/** Moves to child 0 and would cash out at every position after `stopFrom` moves. */
class StubPolicy implements PlanningPolicy {
  move = 0;
  stop = false;
  readonly q = new Float64Array(4).fill(0.5);
  readonly rb = new Int32Array(4);

  constructor(private readonly stopFrom: number) {}

  plan(g: Game): void {
    this.stop = g.k >= this.stopFrom;
  }
}

describe('training pass', () => {
  const econ = econFor(5, 5, 26_300);
  const shape = shapeOf(5, 5);

  it('credits every recorded afterstate with the payout of following the policy, cash-outs included, and never cuts the walk', () => {
    // Establishes the recording rule by recomputing it from its definition for a stub policy.
    const g = new Game(econ);
    const acc = newAccumulator(shape);
    const games = 4000;
    trainGames(g, new StubPolicy(2), shape, SOURCE, 0, games, acc, econ.multiplierBps, null);

    const expected = newAccumulator(shape);
    const feed = new MazeFeed(SOURCE, 5, 5);
    let exploringGamesRecorded = 0;
    let exploringGamesSilent = 0;
    for (let index = 0; index < games; index++) {
      feed.load(index);
      const explore = feed.rng.nextBelow(2) === 1;
      const target = 1 + feed.rng.nextBelow(EXPLORE_JUNCTIONS);
      g.begin(feed.open, feed.rng);
      // The walk, with the exploratory deviation.
      const states: { k: number; child: number }[] = [];
      let junctions = 0;
      let deviatedAt = -1;
      let outcome = 0;
      for (;;) {
        let move = 0;
        if (g.nc >= 2) {
          junctions += 1;
          if (explore && junctions === target) {
            move = feed.rng.nextBelow(g.nc);
            deviatedAt = states.length;
          }
        }
        states.push({ k: g.k, child: g.childCell[move] });
        g.advance(move);
        if (g.cell === g.exit) {
          outcome = econ.multiplierBps;
          break;
        }
        if (g.nc === 0) break;
      }
      // Value of afterstate t by its definition: what the policy collects from there.
      const valueOf = (t: number): number => {
        if (t === states.length - 1) return outcome; // the move ended the game
        const next = states[t + 1].k;
        return next >= 2 ? econ.refundBps[next] : valueOf(t + 1); // the policy cashes out from k = 2 on
      };
      const from = explore ? (deviatedAt === -1 ? states.length : deviatedAt) : 0;
      if (explore && deviatedAt === -1) exploringGamesSilent += 1;
      if (explore && deviatedAt !== -1) exploringGamesRecorded += 1;
      for (let t = from; t < states.length; t++) {
        const index2 = tableIndex(shape, states[t].k + 1, qBinOf(0.5, 20), g.dist[states[t].child], 0);
        expected.sum[index2] += valueOf(t);
        expected.cnt[index2] += 1;
      }
    }
    expect(Array.from(acc.cnt)).toEqual(Array.from(expected.cnt));
    expect(Array.from(acc.sum)).toEqual(Array.from(expected.sum));
    // Both kinds of exploring game occur: those that deviate, and those that end first and record nothing.
    expect(exploringGamesRecorded).toBeGreaterThan(500);
    expect(exploringGamesSilent).toBeGreaterThan(500);
    // The walk is not cut at the cash-out: afterstates beyond k = 2 were visited.
    let deep = 0;
    for (let k = 5; k < shape.cells; k++) for (let i = 0; i < 20 * 9; i++) deep += acc.cnt[k * 20 * 9 + i];
    expect(deep).toBeGreaterThan(0);
  });

  it('greedy games of the harmonic pass give an unbiased first afterstate: its mean is harmonic\'s win rate', () => {
    // The first afterstate (k' = 1, q = 1, d = L − 1) is recorded by greedy games only. If
    // exploring games that end early were recorded too, losses would be over-represented and
    // this mean would fall below the true win rate.
    const g = new Game(econ);
    const acc = newAccumulator(shape);
    const games = 60_000;
    trainGames(g, new HarmonicPolicy(g, 1), shape, SOURCE, 0, games, acc, 1, new SolutionScratch(g.cells));
    const first = tableIndex(shape, 1, 19, shape.shortest - 1, 0);
    const winRate = runGames(g, createBot({ bot: 'harmonic' }, g), SOURCE, 0, games).wins / games;
    const recorded = acc.sum[first] / acc.cnt[first];
    expect(acc.cnt[first]).toBeGreaterThan(0.48 * games);
    expect(acc.cnt[first]).toBeLessThan(0.52 * games);
    expect(Math.abs(recorded - winRate)).toBeLessThan(0.008);
    // S[L] is the same quantity measured on the greedy games: every game stands on the start cell.
    expect(acc.cntAt[shape.shortest]).toBe(acc.cnt[first]);
    expect(acc.winAt[shape.shortest]).toBe(acc.sum[first]);
    expect(acc.winAt[0]).toBe(acc.cntAt[0]);
  });

  it('a pass over the same games is reproducible and splits exactly', () => {
    const g = new Game(econ);
    const whole = newAccumulator(shape);
    trainGames(g, new HarmonicPolicy(g, 1), shape, SOURCE, 0, 3000, whole, 1, new SolutionScratch(g.cells));
    const parts = newAccumulator(shape);
    trainGames(g, new HarmonicPolicy(g, 1), shape, SOURCE, 0, 1100, parts, 1, new SolutionScratch(g.cells));
    trainGames(g, new HarmonicPolicy(g, 1), shape, SOURCE, 1100, 3000, parts, 1, new SolutionScratch(g.cells));
    expect(Array.from(parts.sum)).toEqual(Array.from(whole.sum));
    expect(Array.from(parts.cnt)).toEqual(Array.from(whole.cnt));
    expect(Array.from(parts.winAt)).toEqual(Array.from(whole.winAt));
  });
});

describe('harmonic-lsm backward induction', () => {
  it('the in-sample value of the table is exactly what the harmonic-lsm bot earns on the same games', () => {
    // Establishes: the induction's cash-out decisions are the ones the bot makes at run time
    // (same bins, same fallbacks), so its in-sample value is the bot's mean payout on those games.
    for (const [n, multiplierBps, games] of [
      [5, 26_300, 30_000],
      [7, 67_000, 12_000],
    ]) {
      const econ = econFor(n, n, multiplierBps);
      const g = new Game(econ);
      const trajectories = recordTrajectories(g, SOURCE, 0, games);
      const { table, inSampleBps } = harmonicLsmTable(trajectories, econ, 200);
      const played = runGames(g, createBot({ bot: 'harmonic-lsm', table }, g), SOURCE, 0, games);
      expect(played.sum / games).toBeCloseTo(inSampleBps, 6);
      // It is a real stopping rule: better than never stopping, and it does stop.
      const harmonic = runGames(g, createBot({ bot: 'harmonic' }, g), SOURCE, 0, games);
      expect(played.sum).toBeGreaterThan(harmonic.sum);
      expect(played.cash.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    }
  });

  it('recorded trajectories are harmonic\'s walks', () => {
    const econ = econFor(5, 5, 26_300);
    const g = new Game(econ);
    const games = 5000;
    const t = recordTrajectories(g, SOURCE, 0, games);
    const harmonic = runGames(g, createBot({ bot: 'harmonic' }, g), SOURCE, 0, games);
    expect(t.games).toBe(games);
    expect(t.win.reduce((a, b) => a + b, 0)).toBe(harmonic.wins);
    expect(t.len.reduce((a, b) => a + b, 0)).toBe(harmonic.steps);
    expect(t.steps.length).toBe(harmonic.steps);
    for (let i = 0; i < games; i++) {
      expect(t.onPath[i]).toBeLessThanOrEqual(t.len[i]);
      // A won game never left the solution path.
      if (t.win[i] === 1) expect(t.onPath[i]).toBe(t.len[i]);
    }
    // The first move is forced: posterior 1 (bin 19) and distance L − 1.
    expect(t.steps[0]).toBe(19 * 256 + 7);
  });
});
