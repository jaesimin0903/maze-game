// rollout(n) (plan §3.3): the expensive adversary of fixed gate 2.
//
// At every decision it draws `n` mazes from the exact posterior (conditional Wilson, seeded by
// a hash of the information state so that the bot is a deterministic function of what it has
// seen) and, for each child, averages the payout of "move to that child, then follow
// value-table" over those mazes. It cashes out when the best average is below refund(k).
// Ties: larger posterior, then smaller distance, then N, E, S, W.

import { fastRng } from '@maze/shared';
import { CASH_OUT, finish, Game, type TierEconomics } from '../engine';
import type { ValueTable } from '../lsm';
import { Posterior, samplePosteriorMaze, WilsonScratch } from '../posterior';
import { Q_TIE } from './harmonic';
import type { Bot } from './types';
import { VALUE_TABLE_HYPER, ValueBot } from './value-core';

/** 64-bit hash of what the player has seen: the visited cells in order and their walls. */
export function informationStateSeed(g: Game): bigint {
  let a = 0x811c9dc5 | 0;
  let b = 0x9e3779b9 | 0;
  for (let t = 0; t <= g.k; t++) {
    const cell = g.path[t];
    const word = (cell << 4) | g.open[cell];
    a = Math.imul(a ^ word, 0x01000193);
    b = Math.imul(b + word, 0x85ebca6b);
    b ^= b >>> 13;
  }
  return (BigInt(a >>> 0) << 32n) | BigInt(b >>> 0);
}

export class Rollout implements Bot {
  private readonly posterior: Posterior;
  private readonly q = new Float64Array(4);
  private readonly total = new Float64Array(4);
  private readonly inner: Game;
  private readonly innerBot: ValueBot;
  private readonly wilson: WilsonScratch;
  private readonly sampled: Uint8Array;

  constructor(
    g: Game,
    table: ValueTable,
    private readonly samples: number,
  ) {
    if (!Number.isInteger(samples) || samples < 1) throw new RangeError(`rollout: samples must be a positive integer, got ${samples}`);
    const econ: TierEconomics = { w: g.w, h: g.h, multiplierBps: g.multiplierBps, refundBps: Array.from(g.refund) };
    this.posterior = new Posterior(g.w, g.h);
    this.inner = new Game(econ);
    this.innerBot = new ValueBot(this.inner, table, VALUE_TABLE_HYPER);
    this.wilson = new WilsonScratch(g.cells);
    this.sampled = new Uint8Array(g.cells);
  }

  begin(): void {}

  decide(g: Game): number {
    const { q, total, inner, innerBot, sampled } = this;
    const nc = g.nc;
    this.posterior.childPosterior(g, q);
    const rng = fastRng(informationStateSeed(g));
    total.fill(0);
    for (let sample = 0; sample < this.samples; sample++) {
      samplePosteriorMaze(g, rng, this.wilson, sampled);
      for (let i = 0; i < nc; i++) {
        inner.copyFrom(g);
        inner.open = sampled;
        inner.advance(i);
        if (inner.cell === inner.exit) {
          total[i] += inner.multiplierBps;
        } else if (inner.nc > 0) {
          finish(inner, innerBot);
          total[i] += inner.payoutBps;
        }
      }
    }
    const tolerance = 1e-9 * g.multiplierBps * this.samples;
    let best = 0;
    for (let i = 1; i < nc; i++) {
      const dv = total[i] - total[best];
      if (dv > tolerance) best = i;
      else if (dv >= -tolerance) {
        const dq = q[i] - q[best];
        if (dq > Q_TIE || (dq >= -Q_TIE && g.dist[g.childCell[i]] < g.dist[g.childCell[best]])) best = i;
      }
    }
    return total[best] / this.samples < g.refund[g.k] ? CASH_OUT : best;
  }
}
