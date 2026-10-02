// AC-X8 (Monte Carlo part): seeing which way the start cell opens gives harmonic no edge.
//
// The plan's sample sizes are S 2M / M 4M / L 8M. S runs here at its full size. M and L at full
// size take minutes even on eight threads, so here they run reduced, where equivalence within
// 3% cannot be concluded and only the weaker statement "no significant difference" is checked;
// the full-size test for every tier is made by `sim:certify` on the harmonic cell of stream B
// (3M / 5M / 11M games), which fails the certification when equivalence is not shown.

import { describe, expect, it } from 'vitest';
import { createBot } from '../src/bots/index';
import { Game, runGames } from '../src/engine';
import { normalQuantile, tostProportions } from '../src/stats';
import { econFor } from './helpers';

function harmonicByStart(n: number, games: number): { winsEast: number; east: number; winsSouth: number; south: number } {
  const g = new Game(econFor(n, n, 10_000));
  const stats = runGames(g, createBot({ bot: 'harmonic' }, g), { kind: 'rng', mode: 'fast', stream: 'E' }, 0, games);
  return { winsEast: stats.winsE, east: stats.startE, winsSouth: stats.wins - stats.winsE, south: stats.n - stats.startE };
}

describe('AC-X8 start-direction symmetry of harmonic', () => {
  it('AC-X8 5×5: win rates by start direction are equivalent within 3% of the pooled rate (TOST, α = 0.01, 2,000,000 games)', () => {
    const s = harmonicByStart(5, 2_000_000);
    const tost = tostProportions({ successes1: s.winsEast, n1: s.east, successes2: s.winsSouth, n2: s.south, relativeMargin: 0.03, alpha: 0.01 });
    expect(tost.equivalent).toBe(true);
    expect(Math.abs(tost.diff)).toBeLessThan(tost.margin);
    // The pooled rate is the reviewers' ≈ 33.5%.
    expect((s.winsEast + s.winsSouth) / 2_000_000).toBeGreaterThan(0.332);
    expect((s.winsEast + s.winsSouth) / 2_000_000).toBeLessThan(0.342);
  }, 600_000);

  for (const [n, games] of [
    [7, 600_000],
    [10, 300_000],
  ]) {
    it(`AC-X8 ${n}×${n} (reduced to ${games.toLocaleString('en-US')} games): no significant difference between the start directions`, () => {
      const s = harmonicByStart(n, games);
      const tost = tostProportions({ successes1: s.winsEast, n1: s.east, successes2: s.winsSouth, n2: s.south, relativeMargin: 0.03, alpha: 0.01 });
      // |difference| below the 99.9% two-sided normal bound of a true zero difference.
      expect(Math.abs(tost.diff)).toBeLessThan(normalQuantile(0.9995) * tost.se);
      expect(Math.abs(s.east / games - 0.5)).toBeLessThan(0.005);
    }, 600_000);
  }
});
