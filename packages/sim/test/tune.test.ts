// The tuning procedure of plan §9.3 driven by a synthetic backend: every branch of the
// failure-precedence rule, without simulating a game.

import { describe, expect, it } from 'vitest';
import type { CurveParams } from '@maze/shared';
import { ASSUMPTIONS } from '../src/assumptions';
import type { CalibrationSpec } from '../src/calibrate';
import type { TierEngagement } from '../src/engagement';
import { BOT_VARIANTS, exactBranch, type ExactGateReport } from '../src/exact';
import { renderTuningReport, screenedLabel } from '../src/report';
import { Blocked } from '../src/runner';
import { scenarios, sensitivity } from '../src/sensitivity';
import { assembleTable, candidateCurves, CANDIDATE_NAMES, makeTier, refundTableFor } from '../src/tables';
import {
  adjacentSize,
  constraintStatus,
  deltaH,
  feasible,
  rankCandidates,
  tune,
  type CandidateRun,
  type Evaluation,
  type PointEstimate,
  type TierSummary,
  type TuneBackend,
  type TuneInput,
  type TuneResult,
} from '../src/tune';

const SIZES = [5, 7, 10];
const MULTIPLIER = [26_300, 67_000, 317_000];

/** What the synthetic world says about one tier of one spec. */
interface TierModel {
  naive: number;
  sloppy: number;
  best?: number;
  multiplierBps?: number;
  gate1Value?: number;
  pass?: boolean;
  adversaries?: { meanDiff: number; diffLcb: number }[];
  e1WinRate?: number;
}

type Model = (spec: CalibrationSpec, tier: number) => TierModel;

function summary(spec: CalibrationSpec, tier: number, model: TierModel): TierSummary {
  const n = spec.sizes[tier];
  const curve = spec.curves[tier];
  const refund = refundTableFor(n, curve);
  const screened = spec.screenLast && tier === spec.sizes.length - 1;
  const best = model.best ?? 0.957;
  const multiplierBps = model.multiplierBps ?? MULTIPLIER[tier];
  const gate1Value = model.gate1Value ?? best + 0.002;
  const adversaries = (model.adversaries ?? [{ meanDiff: -0.01, diffLcb: -0.02 }]).map((adversary, i) => ({
    name: i === 0 ? 'rollout(32)' : 'value-lookahead-all',
    rtp: best + adversary.meanDiff,
    ucb975: best + adversary.meanDiff + 0.004,
    meanDiff: adversary.meanDiff,
    diffLcb: adversary.diffLcb,
    halfWidthDiff: 0.004,
    pairs: 400_000,
    capped: false,
  }));
  const failedGates: string[] = [];
  if (gate1Value > 0.965) failedGates.push('fixed gate 1');
  if (model.pass === false) failedGates.push('synthetic failure');
  const engagement: TierEngagement = {
    n1PlayPremium: best - refund[0] / 10_000,
    e1WinRate: model.e1WinRate ?? [0.335, 0.132, 0.028][tier],
    e1Range: ASSUMPTIONS.e1WinRate[tier],
    e1InRange: true,
    e2NaiveRtp: model.naive,
    e2Pass: model.naive >= 0.85,
    e3EarlyQuitRate: 0,
    e4CashOutRate: 0.2,
    e6MeanSteps: 6,
    e7NearMissRate: 0.05,
    e8Multiplier: multiplierBps / 10_000,
    e8Min: ASSUMPTIONS.e8MultiplierMin[tier],
    e8Pass: multiplierBps / 10_000 >= ASSUMPTIONS.e8MultiplierMin[tier],
    e9Refund1Bps: refund[1],
    e9RefundAtShortestBps: refund[2 * (n - 1)],
    e9Pass: refund[1] >= 6000 && refund[2 * (n - 1)] >= 2000,
    e10SloppyRtp: model.sloppy,
    e10Pass: model.sloppy >= 0.5,
    e11SessionMedian: 300,
    e11Min: ASSUMPTIONS.e11MedianMin[tier],
    e11Pass: true,
    m1ContinuationMargin: 0.012,
    m1JunctionRate: 0.39,
  };
  return {
    tier,
    n,
    curve,
    multiplierBps,
    ceilingBps: spec.ceilingsBps[tier],
    games: 1_000_000,
    basis: screened ? 'screened' : 'certified',
    stream: screened ? 'A' : 'B',
    sampleGames: screened ? 125_000 : 1_000_000,
    population: {
      'naive-greedy': { rtp: model.naive, se: 0.0005 },
      'sloppy-greedy': { rtp: model.sloppy, se: 0.0005 },
      nervous: { rtp: 0.7, se: 0.0005 },
      'random-walk': { rtp: 0.2, se: 0.0005 },
      best: { rtp: best, se: 0.0005 },
    },
    bestBot: 'value-lsm',
    bestRtp: best,
    bestHalfWidth: screened ? 0.0083 : 0.003,
    bestUcb: best + 0.003,
    engagement,
    windowMissed: false,
    pass: screened ? null : failedGates.length === 0,
    failedGates,
    gate1Value: screened ? null : gate1Value,
    gate1Limit: 0.965,
    adversaries: screened ? [] : adversaries,
    winRates: { naive: 0.3, sloppy: 0.25, randomWalk: 0.08, nervous: 0.15 },
    nervousCashRate: [],
  };
}

function passingExact(_curves: CurveParams[], level: number): ExactGateReport {
  const gaps = { '3x3': 0, '4x4': 0.0004, '5x4': 0.0014 };
  return {
    schema: 1,
    profile: 'production',
    simCodeHash: 'fake',
    variant: BOT_VARIANTS[level],
    targetBps: 9600,
    grids: [],
    gaps,
    ...exactBranch(gaps, level),
    symmetry: { pass: true, squareMaxDifference: 0, rectangleMinDifference: 0.01 },
  };
}

class FakeBackend implements TuneBackend {
  profileName = 'production';
  simCodeHash = 'fake';
  evaluations: CalibrationSpec[] = [];
  published: { kind: string; name: string }[] = [];
  exactCalls: { curves: CurveParams[]; level: number }[] = [];
  progressCalls = 0;

  constructor(
    private readonly model: Model,
    private readonly points: PointEstimate[] = [],
    private readonly exact: (curves: CurveParams[], level: number) => ExactGateReport = passingExact,
  ) {}

  log(): void {}

  exactGate(curves: CurveParams[], level: number): Promise<ExactGateReport> {
    this.exactCalls.push({ curves, level });
    return Promise.resolve(this.exact(curves, level));
  }

  evaluate(spec: CalibrationSpec): Promise<Evaluation> {
    this.evaluations.push({ ...spec, ceilingsBps: [...spec.ceilingsBps] });
    const tiers = spec.sizes.map((_, i) => summary(spec, i, this.model(spec, i)));
    const table = assembleTable(
      tiers.map((tier, i) => makeTier(i, tier.n, tier.curve, tier.multiplierBps)),
      { calibrated: false, ceilingBps: Math.max(...spec.ceilingsBps), simCodeHash: null, profileName: 'production' },
    );
    return Promise.resolve({ tablePath: `fake/${spec.name}.json`, tableHash: `hash-${spec.name}-${spec.screenLast}-${spec.ceilingsBps.join('-')}-${spec.variantLevel}`, table, tiers });
  }

  rankPoints(): Promise<PointEstimate[]> {
    return Promise.resolve(this.points);
  }

  publish(kind: 'candidate' | 'house-max', run: CandidateRun): void {
    this.published.push({ kind, name: run.name });
  }

  progress(): void {
    this.progressCalls += 1;
  }
}

const INPUT: TuneInput = {
  candidates: CANDIDATE_NAMES.map((name) => ({ name, curves: candidateCurves(name) })),
  sizes: SIZES,
  assumptions: ASSUMPTIONS,
};

/** Candidate (i) pays casual players badly (E2 fails) and earns the house most; (ii) and (iii) satisfy E2. */
const baseModel: Model = (spec) => {
  if (spec.name.startsWith('i') && !spec.name.startsWith('ii')) return { naive: 0.78, sloppy: 0.6 };
  if (spec.name.startsWith('iii')) return { naive: 0.875, sloppy: 0.7 };
  return { naive: 0.88, sloppy: 0.7 };
};

function point(tier: number, aBps: number, phi: number, estimatedDelta: number, overrides: Partial<PointEstimate> = {}): PointEstimate {
  return { tier, aBps, phi, multiplierBps: MULTIPLIER[tier], deltaH: estimatedDelta, naiveRtp: 0.87, sloppyRtp: 0.7, refund1Bps: 7000, refundAtShortestBps: 3500, ...overrides };
}

describe('tune: baseline', () => {
  it('compares S and M at the full count and L screened, drops the candidate that violates E2, and reports "no improvement" when no point qualifies', async () => {
    const backend = new FakeBackend(baseModel);
    const result = await tune(backend, INPUT);
    expect(result.outcome).toBe('no-improvement');
    expect(result.blocked).toBeNull();
    expect(result.final?.name).toBe('ii');
    expect(result.selection?.order).toEqual(['ii', 'iii', 'i']);
    expect(result.relaxed).toEqual([]);
    expect(result.assumptionRangeMet).toBe(true);
    // The compared candidates have a screened last tier; the selected table does not.
    for (const run of result.candidates) expect(run.tiers.map((tier) => tier.basis)).toEqual(['certified', 'certified', 'screened']);
    expect(result.final?.tiers.every((tier) => tier.basis === 'certified')).toBe(true);
    expect(backend.evaluations.slice(0, 3).map((spec) => spec.screenLast)).toEqual([true, true, true]);
    expect(result.baselineAttempts).toEqual([{ name: 'ii', status: 'ok', reason: null }]);
    expect(backend.published[0]).toEqual({ kind: 'candidate', name: 'ii' });
  });

  it('AC-T11 the house-max table is the calibrated table with the largest H under fixed gates, N1 and E10 only; it is certified at the full count first', async () => {
    const backend = new FakeBackend(baseModel);
    const result = await tune(backend, INPUT);
    // (i) violates E2, which the house-max rule does not apply, and has the largest H.
    expect(result.houseMax?.same).toBe(false);
    expect(result.houseMax?.run?.name).toBe('i');
    expect(result.houseMax?.run?.tiers.every((tier) => tier.basis === 'certified')).toBe(true);
    expect(backend.published).toEqual([
      { kind: 'candidate', name: 'ii' },
      { kind: 'house-max', name: 'i' },
    ]);
  });

  it('the house-max table equals the selected table when nothing else earns more, or when the richer table violates E10', async () => {
    const same = await tune(new FakeBackend(() => ({ naive: 0.88, sloppy: 0.7 })), INPUT);
    expect(same.houseMax?.same).toBe(true);
    const e10 = await tune(
      new FakeBackend((spec) => (spec.name === 'i' ? { naive: 0.78, sloppy: 0.45 } : { naive: 0.88, sloppy: 0.7 })),
      INPUT,
    );
    expect(e10.houseMax?.same).toBe(true);
  });

  it('within 0.2 points of the largest H the smaller e0 wins, then the larger aBps', async () => {
    // (iii) has e0 20% and slightly more H; (ii) has e0 5%: (ii) is preferred.
    const close = await tune(
      new FakeBackend((spec) => (spec.name === 'iii' ? { naive: 0.874, sloppy: 0.7 } : spec.name === 'i' ? { naive: 0.5, sloppy: 0.4 } : { naive: 0.876, sloppy: 0.7 })),
      INPUT,
    );
    expect(close.selection?.order.slice(0, 2)).toEqual(['ii', 'iii']);
    // More than 0.2 points apart: H decides.
    const apart = await tune(
      new FakeBackend((spec) => (spec.name === 'iii' ? { naive: 0.86, sloppy: 0.7 } : spec.name === 'i' ? { naive: 0.5, sloppy: 0.4 } : { naive: 0.89, sloppy: 0.7 })),
      INPUT,
    );
    expect(apart.selection?.order[0]).toBe('iii');
  });

  it('relaxes E9 first and E8 second, never E2 or E10', async () => {
    // Low multipliers violate E8 everywhere; candidate (i) alone violates E9 (refund[L] = 2,699 >= 2,000 but refund[1] is fine; use sizes where E9 fails).
    const lowMultiplier = await tune(new FakeBackend(() => ({ naive: 0.88, sloppy: 0.7, multiplierBps: 15_000 })), INPUT);
    expect(lowMultiplier.relaxed).toEqual(['E9', 'E8']);
    expect(lowMultiplier.assumptionRangeMet).toBe(true);
    const status = constraintStatus(lowMultiplier.final!.tiers, ASSUMPTIONS);
    expect(status.e8).toBe(false);
    expect(feasible(status, [])).toBe(false);
    expect(feasible(status, ['E9', 'E8'])).toBe(true);
    expect(feasible({ ...status, e2: false }, ['E9', 'E8'])).toBe(false);
    expect(feasible({ ...status, e10: false }, ['E9', 'E8'])).toBe(false);
  });
});

describe('tune: fixed failures (rule 1)', () => {
  it('a gate 1 excess on stream B lowers that tier\'s ceiling by the excess and recalibrates once', async () => {
    // Tier 1 of (ii) reads 96.62% at ceiling 9600 and passes once the ceiling is lower.
    const backend = new FakeBackend((spec, tier) =>
      spec.name === 'ii' && tier === 1 && spec.ceilingsBps[1] === 9600 ? { naive: 0.88, sloppy: 0.7, gate1Value: 0.9662 } : baseModel(spec, tier),
    );
    const result = await tune(backend, INPUT);
    expect(result.final?.name).toBe('ii');
    expect(result.final?.state.ceilingsBps).toEqual([9600, 9588, 9600]);
    expect(result.final?.state.gate1Lowered).toEqual([1]);
    expect(result.final?.state.notes.some((note) => note.includes('fixed gate 1'))).toBe(true);
  });

  it('a gate 1 failure that survives its one recalibration drops the candidate; the next candidate becomes the baseline', async () => {
    const backend = new FakeBackend((spec, tier) => (spec.name === 'ii' && tier === 0 ? { naive: 0.88, sloppy: 0.7, gate1Value: 0.97 } : baseModel(spec, tier)));
    const result = await tune(backend, INPUT);
    const ii = result.candidates.find((run) => run.name === 'ii')!;
    expect(ii.status).toBe('failed');
    expect(ii.reason).toContain('fixed gate 1');
    // Exactly two evaluations of (ii) in the comparison: the original and the one recalibration.
    expect(backend.evaluations.filter((spec) => spec.name === 'ii')).toHaveLength(2);
    expect(result.final?.name).toBe('iii');
  });

  it('an adversary that beats value-lsm is absorbed once (lookahead at every decision), then the ceiling is lowered once per tier', async () => {
    // rollout keeps beating value-lsm on tier 0 by 0.4 points whatever is done.
    const backend = new FakeBackend((spec, tier) =>
      spec.name === 'ii' && tier === 0 ? { naive: 0.88, sloppy: 0.7, adversaries: [{ meanDiff: 0.004, diffLcb: 0.001 }] } : baseModel(spec, tier),
    );
    const result = await tune(backend, INPUT);
    const ii = result.candidates.find((run) => run.name === 'ii')!;
    expect(ii.state.level).toBe(1);
    expect(ii.state.adversaryLowered).toEqual([0]);
    expect(ii.state.ceilingsBps[0]).toBe(9560);
    // Three evaluations in the comparison: as given, with lookahead absorbed, with the lowered ceiling. Then it stops.
    const comparison = backend.evaluations.filter((spec) => spec.name === 'ii' && spec.screenLast);
    expect(comparison.map((spec) => [spec.variantLevel, spec.ceilingsBps[0]])).toEqual([
      [0, 9600],
      [1, 9600],
      [1, 9560],
    ]);
    // Gate 2 is judged by the upper bound, which is fine here, so the candidate stands.
    expect(ii.status).toBe('ok');
    // The exactness gate was judged again for the absorbed bot.
    expect(backend.exactCalls.filter((call) => call.curves[0].aBps === 7300).map((call) => call.level).slice(0, 2)).toEqual([0, 1]);
    expect(ii.exact?.variant.level).toBe(1);
  });

  it('when a candidate fails at the full count the next one is tried, at most three', async () => {
    const backend = new FakeBackend((spec, tier) => (spec.name === 'ii' && !spec.screenLast && tier === 2 ? { naive: 0.88, sloppy: 0.7, pass: false } : baseModel(spec, tier)));
    const result = await tune(backend, INPUT);
    expect(result.baselineAttempts.map((attempt) => [attempt.name, attempt.status])).toEqual([
      ['ii', 'failed'],
      ['iii', 'ok'],
    ]);
    expect(result.final?.name).toBe('iii');
  });

  it('BLOCKED(economic) when every candidate fails; nothing is published', async () => {
    const backend = new FakeBackend(() => ({ naive: 0.88, sloppy: 0.7, pass: false }));
    const result = await tune(backend, INPUT);
    expect(result.outcome).toBe('blocked');
    expect(result.blocked?.kind).toBe('economic');
    expect(result.final).toBeNull();
    expect(backend.published).toEqual([]);
  });

  it('a calibration with no passing multiplier fails that candidate only; a run-time block stops everything', async () => {
    class Throwing extends FakeBackend {
      constructor(private readonly error: Error) {
        super(baseModel);
      }

      override evaluate(spec: CalibrationSpec): Promise<Evaluation> {
        return spec.name === 'ii' ? Promise.reject(this.error) : super.evaluate(spec);
      }
    }
    const economic = await tune(new Throwing(new Blocked('economic', 'no evaluated multiplier has U <= ceiling')), INPUT);
    expect(economic.candidates.find((run) => run.name === 'ii')?.status).toBe('failed');
    expect(economic.final?.name).toBe('iii');
    const runtime = await tune(new Throwing(new Blocked('runtime', 'cell has run for more than 6 hours')), INPUT);
    expect(runtime.outcome).toBe('blocked');
    expect(runtime.blocked?.kind).toBe('runtime');
  });
});

describe('tune: exactness gate branches', () => {
  it('branch 1 raises the bot level until the gate passes', async () => {
    const backend = new FakeBackend(baseModel, [], (curves, level) => {
      const gaps = level === 0 ? { '3x3': 0, '4x4': 0.004, '5x4': 0.009 } : { '3x3': 0, '4x4': 0, '5x4': 0.0005 };
      return { ...passingExact(curves, level), gaps, ...exactBranch(gaps, level) };
    });
    const result = await tune(backend, INPUT);
    expect(result.final?.state.level).toBe(1);
    expect(backend.evaluations.every((spec) => spec.variantLevel === 1)).toBe(true);
  });

  it('branch 2 lowers the ceiling to min(9600, 9650 − gap) and raises e0 so that N1 holds', async () => {
    const backend = new FakeBackend(baseModel, [], (curves, level) => {
      const gaps = { '3x3': 0, '4x4': 0.01, '5x4': 0.012 };
      return { ...passingExact(curves, level), gaps, ...exactBranch(gaps, level) };
    });
    const result = await tune(backend, INPUT);
    const ii = result.candidates.find((run) => run.name === 'ii')!;
    expect(ii.state.level).toBe(3);
    expect(ii.state.ceilingsBps).toEqual([9530, 9530, 9530]);
    expect(ii.state.curves.every((curve) => curve.e0Bps === 570)).toBe(true);
    // Candidate (iii) already has e0 = 2000: only its ceiling moves.
    const iii = result.candidates.find((run) => run.name === 'iii')!;
    expect(iii.state.curves.every((curve) => curve.e0Bps === 2000)).toBe(true);
    expect(iii.state.ceilingsBps).toEqual([9530, 9530, 9530]);
  });

  it('branch 3 blocks the candidate without calibrating it', async () => {
    const backend = new FakeBackend(baseModel, [], (curves, level) => {
      const gaps = curves[0].aBps === 7300 ? { '3x3': 0.0127, '4x4': 0.0051, '5x4': 0.009 } : { '3x3': 0, '4x4': 0, '5x4': 0 };
      return { ...passingExact(curves, level), gaps, ...exactBranch(gaps, level) };
    });
    const result = await tune(backend, INPUT);
    const ii = result.candidates.find((run) => run.name === 'ii')!;
    expect(ii.status).toBe('blocked');
    expect(ii.reason).toContain('branch 3');
    expect(backend.evaluations.some((spec) => spec.name === 'ii')).toBe(false);
    expect(result.final?.name).toBe('iii');
  });
});

describe('tune: search points (rules 3 to 5)', () => {
  const better: Model = (spec, tier) => {
    // Lowering a on tier 0 to 7000 takes 2 points of RTP from naive-greedy there.
    if (spec.name.startsWith('point-0-7000')) return tier === 0 ? { naive: 0.86, sloppy: 0.68 } : { naive: 0.88, sloppy: 0.7 };
    if (spec.name.startsWith('point-0-7600')) return tier === 0 ? { naive: 0.8795, sloppy: 0.7 } : { naive: 0.88, sloppy: 0.7 };
    return baseModel(spec, tier);
  };

  it('AC-T6 adopts the first point whose ΔH is at least 0.2 points with a positive lower bound: "improved"', async () => {
    const backend = new FakeBackend(better, [point(0, 7600, 0.5, 0.0021), point(0, 7000, 0.5, 0.004), point(1, 7000, 0.5, 0.0001)]);
    const result = await tune(backend, INPUT);
    // Tried in order of the coarse estimate; the point below the threshold is never calibrated.
    expect(result.points.map((entry) => entry.name)).toEqual(['point-0-7000-50']);
    expect(result.points[0].status).toBe('adopted');
    expect(result.points[0].deltaH).toBeGreaterThanOrEqual(0.002);
    expect(result.points[0].deltaHLcb).toBeGreaterThan(0);
    expect(result.outcome).toBe('improved');
    expect(result.final?.name).toBe('point-0-7000-50');
    expect(backend.published[0]).toEqual({ kind: 'candidate', name: 'point-0-7000-50' });
    expect(backend.evaluations.some((spec) => spec.name === 'point-1-7000-50')).toBe(false);
  });

  it('AC-T6 a point whose measured ΔH misses the rule is rejected, at most three are tried, and the result is "no improvement"', async () => {
    const backend = new FakeBackend(better, [
      point(0, 7600, 0.5, 0.009),
      point(0, 7600, 0.4, 0.008),
      point(0, 7600, 0.6, 0.007),
      point(0, 7600, 0.3, 0.006),
      point(0, 7000, 0.5, 0.005),
    ]);
    const result = await tune(backend, INPUT);
    expect(result.points).toHaveLength(3);
    expect(result.points.every((entry) => entry.status === 'rejected')).toBe(true);
    expect(result.outcome).toBe('no-improvement');
    expect(result.final?.name).toBe('ii');
  });

  it('a baseline that violates E2 takes the first point that satisfies every constraint, whatever its H', async () => {
    // Every candidate fails E2 on tier 2; the least-violating one becomes the baseline.
    const model: Model = (spec, tier) => {
      if (spec.name.startsWith('point-2-8000')) return { naive: 0.86, sloppy: 0.7 };
      if (tier === 2) return { naive: spec.name === 'ii' ? 0.84 : 0.8, sloppy: 0.7, e1WinRate: 0.07 };
      return { naive: 0.88, sloppy: 0.7 };
    };
    const backend = new FakeBackend(model, [point(2, 8000, 0.5, -0.003), point(0, 7000, 0.5, 0.01)]);
    const result = await tune(backend, INPUT);
    expect(result.assumptionRangeMet).toBe(false);
    expect(result.baseline?.name).toBe('ii');
    expect(result.pointMode).toBe('repair');
    // Only points of the violating tier are candidates; the tier 0 point with the large ΔH is not tried.
    expect(result.points.map((entry) => [entry.name, entry.status])).toEqual([['point-2-8000-50', 'adopted']]);
    expect(result.outcome).toBe('improved');
  });

  it('ΔH and its lower bound involve the changed tier only', () => {
    const spec: CalibrationSpec = { name: 'x', sizes: SIZES, curves: candidateCurves('ii'), ceilingsBps: [9600, 9600, 9600], variantLevel: 0, screenLast: false };
    const base = summary(spec, 0, { naive: 0.88, sloppy: 0.7 });
    const changed = summary(spec, 0, { naive: 0.86, sloppy: 0.7 });
    const change = deltaH(base, changed, ASSUMPTIONS);
    expect(change.delta).toBeCloseTo(0.5 * 0.35 * 0.02, 12);
    expect(change.lcb).toBeLessThan(change.delta);
    expect(change.lcb).toBeGreaterThan(0);
  });
});

describe('tune: size change (rule 2)', () => {
  it('when no candidate satisfies E2 even without E9 and E8, the worst tier tries the adjacent size once', async () => {
    // Tier 1 at size 7 pays naive-greedy 80%; at size 6 it pays 86%.
    const model: Model = (spec, tier) => (tier === 1 && spec.sizes[1] === 7 ? { naive: spec.name.startsWith('ii') ? 0.8 : 0.75, sloppy: 0.7 } : { naive: 0.86, sloppy: 0.7 });
    const backend = new FakeBackend(model);
    const result = await tune(backend, INPUT);
    expect(result.sizeChanges).toHaveLength(1);
    expect(result.sizeChanges[0]).toMatchObject({ candidate: 'ii', tier: 1, from: 7, to: 6, adopted: true });
    expect(result.final?.name).toBe('ii-n5-6-10');
    expect(result.final?.sizes).toEqual([5, 6, 10]);
    expect(result.assumptionRangeMet).toBe(true);
  });

  it('a size change that does not shrink the shortfall is rejected and the least-violating baseline is kept', async () => {
    const model: Model = (spec, tier) => (tier === 1 ? { naive: spec.name.startsWith('ii') ? 0.8 : 0.75, sloppy: 0.7 } : { naive: 0.86, sloppy: 0.7 });
    const result = await tune(new FakeBackend(model), INPUT);
    expect(result.sizeChanges).toHaveLength(1);
    expect(result.sizeChanges[0].adopted).toBe(false);
    expect(result.assumptionRangeMet).toBe(false);
    expect(result.final?.name).toBe('ii');
  });

  it('the adjacent size is one smaller unless naive-greedy wins too often, and never a size already in use', () => {
    const spec: CalibrationSpec = { name: 'x', sizes: SIZES, curves: candidateCurves('ii'), ceilingsBps: [9600, 9600, 9600], variantLevel: 0, screenLast: false };
    expect(adjacentSize(summary(spec, 1, { naive: 0.8, sloppy: 0.7 }), SIZES)).toBe(6);
    expect(adjacentSize(summary(spec, 1, { naive: 0.8, sloppy: 0.7, e1WinRate: 0.3 }), SIZES)).toBe(8);
    expect(adjacentSize(summary(spec, 1, { naive: 0.8, sloppy: 0.7 }), [6, 7, 10])).toBeNull();
    expect(adjacentSize(summary({ ...spec, sizes: [3, 7, 10] }, 0, { naive: 0.8, sloppy: 0.7 }), [3, 7, 10])).toBeNull();
  });
});

describe('ranking, sensitivity and report', () => {
  let result: TuneResult;

  it('rankCandidates ignores candidates that failed their gates', async () => {
    result = await tune(new FakeBackend(baseModel), INPUT);
    const failed: CandidateRun = { ...result.candidates[1], name: 'broken', status: 'failed' };
    expect(rankCandidates([...result.candidates, failed], ASSUMPTIONS).order).not.toContain('broken');
  });

  it('AC-T5 the sensitivity table varies each assumption and shows where the choice changes', () => {
    const analysis = sensitivity(result);
    expect(scenarios(ASSUMPTIONS)).toHaveLength(1 + 5 * 2 + 3 + 3 * 2);
    expect(analysis.rows).toHaveLength(20);
    expect(analysis.baseSelected).toBe('ii');
    for (const scenario of scenarios(ASSUMPTIONS)) {
      expect(Object.values(scenario.assumptions.population).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      expect(scenario.assumptions.tierShare.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
    // With the E2 floor at 80% nothing changes here (candidate (i) pays 78%); at 85% and 90% see the rows.
    const floor90 = analysis.rows.find((row) => row.scenario === 'E2 floor 90%')!;
    expect(floor90.assumptionRangeMet).toBe(false);
    const floor85 = analysis.rows.find((row) => row.scenario === 'E2 floor 85%')!;
    expect(floor85.selected).toBe('ii');
    expect(floor85.changesSelection).toBe(false);
  });

  it('AC-T5 AC-T6 the report carries the labels the plan requires', () => {
    const text = renderTuningReport({
      result,
      sensitivity: sensitivity(result),
      finalCertification: null,
      houseMaxCertification: null,
      candidateTablePath: 'packages/sim/reports/tuning.candidate.json',
      houseMaxTablePath: 'packages/sim/reports/tuning.house-max.json',
    });
    expect(text).toContain('**튜닝 결과: 개선 없음**');
    expect(text).toContain('캐주얼 환수율 하한(E2)이 하우스 수익의 상한을 정한다');
    expect(text).toContain('가정');
    expect(text).toContain('L: 축소 표본 ±0.83%p, 고정 게이트 미판정, 적용 불가');
    // Redeploy first: `tuning:check` compares the table with the deployed contract and stops the chain otherwise.
    expect(text).toContain('pnpm tuning:apply packages/sim/reports/tuning.house-max.json && pnpm dev:down && pnpm dev:up && pnpm tuning:check');
    expect(text).not.toMatch(/tuning:apply \S+ && pnpm tuning:check/);
    expect(text).toContain('민감도 분석 (가정)');
    expect(screenedLabel(result.candidates[0].tiers[2])).toBe('L: 축소 표본 ±0.83%p, 고정 게이트 미판정, 적용 불가');
    const improved = renderTuningReport({
      result: { ...result, outcome: 'improved' },
      sensitivity: null,
      finalCertification: null,
      houseMaxCertification: null,
      candidateTablePath: 'a',
      houseMaxTablePath: 'b',
    });
    expect(improved).toContain('**튜닝 결과: 개선됨**');
    expect(improved).not.toContain('개선 없음');
    // The phrases `tune` records in English are shown in Korean.
    expect(text).toContain('| 기본 가정 |');
    expect(text).toContain('| 집단 가중치: 최고 봇 +50% |');
    expect(text).toContain('| 크기 이용 비중: L -50% |');
    expect(text).not.toContain('base assumptions');
    expect(text).not.toContain('population weight of');
  });
});
