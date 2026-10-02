// Decision rule shared by value-table, value-lsm and value-lookahead-all (plan §3.3).
//
//   1. V_c = A[k+1][bin(q_c)][d_c] for every child c (M when c is the exit)
//   2. T = { c : q_c >= q_max - threshold }
//   3. no lookahead   → move = argmax_c V_c over all children; cash out when V_move < refund(k)
//   4. lookahead      → Q_c = sum over observation patterns m of c's unknown edges of P(m) · v(m)
//                         v(m) = M when the exit opens, 0 when nothing opens, otherwise
//                                max( refund(k+1), max over opened c' of A[k+2][bin(q_c')][d_c'] )
//                       move = argmax over T of Q_c; cash out when Q_move < refund(k)
//   5. ties (equal V or equal Q): larger q, then smaller d, then N, E, S, W
//
// value-table never looks ahead; value-lsm looks ahead when |T| >= 2; value-lookahead-all takes
// T = all children and looks ahead even with a single child.

import { CASH_OUT, type Game } from '../engine';
import { lookup, ratioBinOf, type PlanningPolicy, type ValueTable } from '../lsm';
import { Posterior } from '../posterior';
import { harmonicChoice, Q_TIE } from './harmonic';
import { Region } from './region';
import type { Bot } from './types';

export type LookaheadMode = 'none' | 'near-tie' | 'all';

export interface ValueHyper {
  lookahead: LookaheadMode;
  /** Width of the near-tie band below the largest posterior. */
  threshold: number;
}

/** The threshold only matters for the near-tie rule; elsewhere it is normalised to 0. */
export function canonicalHyper(hyper: ValueHyper): ValueHyper {
  return hyper.lookahead === 'near-tie' ? { lookahead: 'near-tie', threshold: hyper.threshold } : { lookahead: hyper.lookahead, threshold: 0 };
}

export const VALUE_TABLE_HYPER: ValueHyper = { lookahead: 'none', threshold: 0 };
/** Production setting of value-lsm: lookahead when two or more children are within 0.2 of the largest posterior. */
export const VALUE_LSM_HYPER: ValueHyper = { lookahead: 'near-tie', threshold: 0.2 };
export const VALUE_LOOKAHEAD_ALL_HYPER: ValueHyper = { lookahead: 'all', threshold: 0 };

/** Two values closer than this fraction of the multiplier are equal up to rounding. */
const VALUE_TIE = 1e-9;

export class ValuePolicy implements PlanningPolicy {
  move = 0;
  stop = false;
  /** V or Q of the chosen child, in bps. */
  value = 0;
  readonly q = new Float64Array(4);
  readonly rb = new Int32Array(4);
  private readonly v = new Float64Array(4);
  private readonly rbNext = new Int32Array(3);
  private readonly posterior: Posterior;
  private readonly region: Region | null;

  constructor(
    g: Game,
    private readonly table: ValueTable,
    private readonly hyper: ValueHyper,
  ) {
    if (table.cells !== g.cells || table.shortest !== g.shortest) {
      throw new RangeError('value policy: the table was trained for a different grid');
    }
    this.posterior = new Posterior(g.w, g.h);
    this.region = table.rBins > 1 ? new Region(g.cells) : null;
  }

  plan(g: Game): void {
    const { table, q, v, rb, region } = this;
    const nc = g.nc;
    const k = g.k;
    const m = g.multiplierBps;
    this.posterior.childPosterior(g, q);
    let qmax = 0;
    for (let i = 0; i < nc; i++) {
      const child = g.childCell[i];
      if (q[i] > qmax) qmax = q[i];
      if (region !== null) {
        region.fill(g, child);
        rb[i] = ratioBinOf(region.size / (g.cells - k - 1), table.rBins);
      }
      v[i] = child === g.exit ? m : lookup(table, k + 1, q[i], g.dist[child], rb[i], m);
    }

    const all = (1 << nc) - 1;
    let candidates = all;
    let look = this.hyper.lookahead === 'all';
    if (this.hyper.lookahead === 'near-tie') {
      const floor = qmax - this.hyper.threshold - Q_TIE;
      let near = 0;
      let count = 0;
      for (let i = 0; i < nc; i++) {
        if (q[i] >= floor) {
          near |= 1 << i;
          count += 1;
        }
      }
      if (count >= 2) {
        look = true;
        candidates = near;
      }
    }
    if (look) {
      for (let i = 0; i < nc; i++) if ((candidates >> i) & 1) v[i] = this.lookahead(g, i);
    }

    const tolerance = VALUE_TIE * m;
    let best = -1;
    for (let i = 0; i < nc; i++) {
      if (((candidates >> i) & 1) === 0) continue;
      if (best === -1) {
        best = i;
        continue;
      }
      const dv = v[i] - v[best];
      if (dv > tolerance) best = i;
      else if (dv >= -tolerance) {
        const dq = q[i] - q[best];
        if (dq > Q_TIE || (dq >= -Q_TIE && g.dist[g.childCell[i]] < g.dist[g.childCell[best]])) best = i;
      }
    }
    this.move = best;
    this.value = v[best];
    this.stop = v[best] < g.refund[k];
  }

  /** Exact one-step lookahead value `Q_c` of child `i`. Requires the factorisation of `plan`. */
  private lookahead(g: Game, i: number): number {
    const child = g.childCell[i];
    const m = g.multiplierBps;
    if (child === g.exit) return m;
    const post = this.posterior;
    const r = post.prepareChild(g, child);
    if (r === 0) return 0;
    const { table, region, rbNext } = this;
    const k2 = g.k + 2;
    if (region !== null) {
      for (let a = 0; a < r; a++) {
        region.fill(g, post.patternCell[a], child);
        rbNext[a] = ratioBinOf(region.size / (g.cells - k2), table.rBins);
      }
    }
    const refundNext = g.refund[g.k + 1];
    let total = 0;
    for (let mask = 1; mask < 1 << r; mask++) {
      const p = post.pattern(mask);
      if (p === 0) continue;
      let best = refundNext;
      for (let a = 0; a < r; a++) {
        if (((mask >> a) & 1) === 0) continue;
        const next = post.patternCell[a];
        const value = next === g.exit ? m : lookup(table, k2, post.patternQ[a], g.dist[next], rbNext[a], m);
        if (value > best) best = value;
      }
      total += p * best;
    }
    return total;
  }
}

/** The policy of training pass 0: harmonic moves, no cash-out. */
export class HarmonicPolicy implements PlanningPolicy {
  move = 0;
  readonly stop = false;
  readonly q = new Float64Array(4);
  readonly rb = new Int32Array(4);
  private readonly posterior: Posterior;
  private readonly region: Region | null;

  constructor(
    g: Game,
    private readonly rBins: number,
  ) {
    this.posterior = new Posterior(g.w, g.h);
    this.region = rBins > 1 ? new Region(g.cells) : null;
  }

  plan(g: Game): void {
    this.posterior.childPosterior(g, this.q);
    this.move = harmonicChoice(g, this.q);
    if (this.region !== null) {
      for (let i = 0; i < g.nc; i++) {
        this.region.fill(g, g.childCell[i]);
        this.rb[i] = ratioBinOf(this.region.size / (g.cells - g.k - 1), this.rBins);
      }
    }
  }
}

/** A value policy as a bot. */
export class ValueBot implements Bot {
  private readonly policy: ValuePolicy;

  constructor(g: Game, table: ValueTable, hyper: ValueHyper) {
    this.policy = new ValuePolicy(g, table, hyper);
  }

  begin(): void {}

  decide(g: Game): number {
    this.policy.plan(g);
    // M1 of plan §9.3: the bot's own estimate of continuing from a junction on the second cell.
    if (g.k === 1 && g.nc >= 2) g.m1Value = this.policy.value - g.refund[1];
    return this.policy.stop ? CASH_OUT : this.policy.move;
  }
}
