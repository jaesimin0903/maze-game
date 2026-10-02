// region-heuristic (plan §3.3).
//
// Move: among the children whose unvisited region R_c contains the exit, naiveChoice. No such
// child → cash out. Cash-out rule: M × Ŵ[k][d(c*)] < refund(k), where Ŵ is the win rate this
// bot's walks had from the same (k, d) on stream C.

import { CASH_OUT, type Game } from '../engine';
import type { RegionTable } from '../lsm';
import { naiveChoiceAmong } from './naive';
import { Region } from './region';
import type { Bot } from './types';

/** The move rule: a child index, or -1 when no child's region contains the exit. */
export function regionMove(g: Game, region: Region): number {
  let allowed = 0;
  for (let i = 0; i < g.nc; i++) {
    region.fill(g, g.childCell[i]);
    if (region.hasExit) allowed |= 1 << i;
  }
  return allowed === 0 ? -1 : naiveChoiceAmong(g, allowed);
}

export class RegionHeuristic implements Bot {
  private readonly region: Region;

  constructor(
    g: Game,
    private readonly table: RegionTable,
  ) {
    if (table.cells !== g.cells || table.shortest !== g.shortest) {
      throw new RangeError('region-heuristic: the table was trained for a different grid');
    }
    this.region = new Region(g.cells);
  }

  begin(): void {}

  decide(g: Game): number {
    const move = regionMove(g, this.region);
    if (move < 0) return CASH_OUT;
    const child = g.childCell[move];
    // Stepping onto the exit wins outright.
    if (child === g.exit) return move;
    const winRate = this.table.win[g.k * (g.shortest + 1) + g.dist[child]];
    return g.multiplierBps * winRate < g.refund[g.k] ? CASH_OUT : move;
  }
}
