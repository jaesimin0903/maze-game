// param-search(θ) (plan §3.3).
//
// Move: among the children whose unvisited region R_c contains the exit, the largest score
//   -θ1 · d(c) / L + θ2 · |R_c| / |U|        (ties: naiveChoice among the tied children)
// No such child → cash out. Cash-out rule:
//   ŵ = sigmoid(θ3 + θ4 · d / L + θ5 · k / L + θ6 · |R_c*| / |U|),   M × ŵ < refund(k)
// with d the distance of the chosen child, L the shortest path length and U the unvisited cells.

import { CASH_OUT, type Game } from '../engine';
import { naiveChoiceAmong } from './naive';
import { Region } from './region';
import type { Bot } from './types';

export const THETA_LENGTH = 6;
const SCORE_TIE = 1e-12;

export class ParamSearch implements Bot {
  private readonly region: Region;
  private readonly ratio = new Float64Array(4);

  constructor(
    g: Game,
    private readonly theta: readonly number[],
  ) {
    if (theta.length !== THETA_LENGTH || theta.some((value) => !Number.isFinite(value))) {
      throw new RangeError('param-search: θ must be six finite numbers');
    }
    this.region = new Region(g.cells);
  }

  begin(): void {}

  decide(g: Game): number {
    const { theta, region, ratio } = this;
    const unvisited = g.cells - g.k - 1;
    const scale = g.shortest;
    let tied = 0;
    let tiedCount = 0;
    let bestScore = 0;
    for (let i = 0; i < g.nc; i++) {
      const child = g.childCell[i];
      region.fill(g, child);
      if (!region.hasExit) continue;
      ratio[i] = region.size / unvisited;
      const score = (-theta[0] * g.dist[child]) / scale + theta[1] * ratio[i];
      if (tiedCount === 0 || score > bestScore + SCORE_TIE) {
        tied = 1 << i;
        tiedCount = 1;
        bestScore = score;
      } else if (score >= bestScore - SCORE_TIE) {
        tied |= 1 << i;
        tiedCount += 1;
      }
    }
    if (tiedCount === 0) return CASH_OUT;
    const move = naiveChoiceAmong(g, tied);
    const d = g.dist[g.childCell[move]];
    const z = theta[2] + (theta[3] * d) / scale + (theta[4] * g.k) / scale + theta[5] * ratio[move];
    const winRate = 1 / (1 + Math.exp(-z));
    return g.multiplierBps * winRate < g.refund[g.k] ? CASH_OUT : move;
  }
}
