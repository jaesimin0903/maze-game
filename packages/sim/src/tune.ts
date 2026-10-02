// Tuning (plan §9.3): exactness gate → calibration → certification for each candidate curve,
// choice of the baseline, a bounded search for a better point, and the house-max alternative.
//
// `tune` is a deterministic program over a `TuneBackend`. The real backend simulates (and caches
// every unit, so the program can be rerun from the top after an interruption and reaches the
// same decisions); the tests drive the same program with synthetic results.
//
// One failure-precedence rule (plan §9.3):
//   1. a fixed failure (a certification gate, N1) first gets the repair the plan allows, once:
//      gate 1 on stream B → ceiling lowered by the excess and that tier recalibrated;
//      an adversary that beats value-lsm → lookahead at every decision and the candidate
//      recalibrated, and if it still wins, that tier's ceiling lowered by the mean difference.
//      A candidate that still fails is dropped; when all three are dropped: BLOCKED(economic).
//   2. assumption constraints never block: E9 is dropped, then E8, then one size change per tier
//      (at most two tiers), and finally the least-violating baseline is taken as it is.
//   3. a baseline that violates E2 or E10 takes the first search point that satisfies everything.
//   4. otherwise a point is adopted only if ΔH >= 0.2 points and its 95% lower bound is positive.
//   5. a search point is one tier's (a, φ).

import type { CurveParams, TuningTable } from '@maze/shared';
import { ADOPTION_THRESHOLD, type Assumptions } from './assumptions';
import type { CalibrationSpec } from './calibrate';
import { houseRevenue, type PopulationRtp, type TierEngagement } from './engagement';
import type { ExactGateReport } from './exact';
import { byTier } from './profile';
import { Blocked } from './runner';
import { Z_975 } from './stats';
import { DEFAULT_CEILING_BPS } from './tables';

export interface TierSummary {
  tier: number;
  n: number;
  curve: CurveParams;
  multiplierBps: number;
  ceilingBps: number;
  /** Certification games of the tier (`N`). */
  games: number;
  /** `certified`: stream B at the full `N`. `screened`: point estimates on the first part of stream A; no gate was judged. */
  basis: 'certified' | 'screened';
  stream: 'A' | 'B';
  sampleGames: number;
  population: PopulationRtp;
  bestBot: string;
  bestRtp: number;
  bestHalfWidth: number;
  bestUcb: number;
  engagement: TierEngagement;
  windowMissed: boolean;
  /** Every certification gate of the tier passed; null when the tier was only screened. */
  pass: boolean | null;
  failedGates: string[];
  /** Fixed gate 1 on stream B: the largest upper bound of the suite and its limit. */
  gate1Value: number | null;
  gate1Limit: number;
  adversaries: {
    name: string;
    rtp: number;
    ucb975: number;
    meanDiff: number;
    diffLcb: number;
    halfWidthDiff: number;
    pairs: number;
    capped: boolean;
  }[];
  /** What the coarse ranking of search points needs: curve-independent behaviour of the casual bots. */
  winRates: { naive: number; sloppy: number; randomWalk: number; nervous: number };
  nervousCashRate: number[];
}

/** Calibration and certification of one spec, as the tuning program sees it. */
export interface Evaluation {
  tablePath: string;
  tableHash: string;
  table: TuningTable;
  tiers: TierSummary[];
}

export interface PointEstimate {
  tier: number;
  aBps: number;
  phi: number;
  /** Coarse estimates from the trajectory cache; none of them is a certified number. */
  multiplierBps: number;
  deltaH: number;
  naiveRtp: number;
  sloppyRtp: number;
  refund1Bps: number;
  refundAtShortestBps: number;
}

export interface TuneBackend {
  profileName: string;
  simCodeHash: string;
  exactGate(curves: CurveParams[], variantLevel: number): Promise<ExactGateReport>;
  /** Calibrates the spec and certifies every tier that is not screened. */
  evaluate(spec: CalibrationSpec): Promise<Evaluation>;
  /** Coarse ranking of the 35 grid points of every tier against a finalized baseline. */
  rankPoints(baseline: CandidateRun): Promise<PointEstimate[]>;
  /** Copies a run's table to `tuning.candidate.json` or `tuning.house-max.json`, byte for byte. */
  publish(kind: 'candidate' | 'house-max', run: CandidateRun): void;
  /** Called after each stage with what has been decided so far (`outcome` is still `incomplete`). */
  progress(result: TuneResult): void;
  log(line: string): void;
}

/** The state of a candidate's bounded repairs. */
export interface RepairState {
  level: number;
  curves: CurveParams[];
  /** Ceiling after the exactness gate, before any per-tier repair. */
  baseCeilingBps: number;
  ceilingsBps: number[];
  gate1Lowered: number[];
  adversaryLowered: number[];
  notes: string[];
}

export interface CandidateRun {
  name: string;
  sizes: number[];
  /** `ok`: every judged gate passed. `failed`: a fixed failure survived its repair. `blocked`: exactness gate branch 3. */
  status: 'ok' | 'failed' | 'blocked';
  reason: string | null;
  exact: ExactGateReport | null;
  spec: CalibrationSpec | null;
  tablePath: string | null;
  tableHash: string | null;
  tiers: TierSummary[];
  /** ASSUMPTION-based house revenue per unit bet. */
  h: number | null;
  hSe: number | null;
  state: RepairState;
}

function curveId(curve: CurveParams): string {
  return `${curve.e0Bps}/${curve.aBps}/${curve.phi}`;
}

function distinct(curves: readonly CurveParams[]): CurveParams[] {
  const seen = new Set<string>();
  return curves.filter((curve) => (seen.has(curveId(curve)) ? false : (seen.add(curveId(curve)), true)));
}

const pct = (x: number): string => `${(100 * x).toFixed(3)}%`;

/**
 * Exactness gate with its failure branches, then calibration and certification with the
 * bounded repairs of rule 1. `initial` continues from the state another run of the same
 * candidate ended in (the screening run, when the last tier is finally calibrated at full `N`).
 */
export async function evaluateCandidate(
  backend: TuneBackend,
  assumptions: Assumptions,
  name: string,
  sizes: number[],
  curves: CurveParams[],
  screenLast: boolean,
  initial?: RepairState,
): Promise<CandidateRun> {
  const state: RepairState = initial
    ? { ...initial, curves: [...initial.curves], ceilingsBps: [...initial.ceilingsBps], gate1Lowered: [...initial.gate1Lowered], adversaryLowered: [...initial.adversaryLowered], notes: [...initial.notes] }
    : { level: 0, curves: [...curves], baseCeilingBps: DEFAULT_CEILING_BPS, ceilingsBps: sizes.map(() => DEFAULT_CEILING_BPS), gate1Lowered: [], adversaryLowered: [], notes: [] };
  const run: CandidateRun = { name, sizes, status: 'failed', reason: null, exact: null, spec: null, tablePath: null, tableHash: null, tiers: [], h: null, hSe: null, state };
  const note = (text: string): void => {
    if (!state.notes.includes(text)) state.notes.push(text);
    backend.log(`[${name}] ${text}`);
  };

  // A. Exactness gate (plan §3.3) with failure branches 1 to 3, for the bot level in `state`.
  // Returns false when the candidate is blocked.
  const exactness = async (): Promise<boolean> => {
    for (let guard = 0; ; guard++) {
      const exact = await backend.exactGate(distinct(state.curves), state.level);
      run.exact = exact;
      if (!exact.symmetry.pass) {
        run.status = 'blocked';
        run.reason = `exact start-direction symmetry failed (square grids differ by ${exact.symmetry.squareMaxDifference}, 5x4 by ${exact.symmetry.rectangleMinDifference})`;
        return false;
      }
      if (exact.pass) return true;
      if (exact.branch === 'improve-bot') {
        state.level += 1;
        note(`exactness gap ${pct(exact.gapMax)} above 0.50 points: bot improvement level ${state.level}`);
        continue;
      }
      if (exact.branch === 'lower-ceiling' && guard < 8) {
        const needsE0 = state.curves.some((curve) => curve.e0Bps < exact.e0Bps);
        if (needsE0) {
          if (state.curves.some((curve) => curve.aBps >= 10_000 - exact.e0Bps)) {
            run.status = 'blocked';
            run.reason = `exactness branch 2 needs e0 = ${exact.e0Bps} bps, which leaves no room for aBps`;
            return false;
          }
          state.curves = state.curves.map((curve) => (curve.e0Bps < exact.e0Bps ? { ...curve, e0Bps: exact.e0Bps } : curve));
          note(`exactness branch 2: e0 raised to ${exact.e0Bps} bps so that the play premium stays positive (spec deviation)`);
          continue;
        }
        state.baseCeilingBps = Math.min(state.baseCeilingBps, exact.ceilingBps);
        state.ceilingsBps = state.ceilingsBps.map((ceiling) => Math.min(ceiling, exact.ceilingBps));
        note(`exactness branch 2: gap ${pct(exact.gapMax)}; calibration ceiling lowered to ${exact.ceilingBps} bps (spec deviation)`);
        return true;
      }
      run.status = 'blocked';
      run.reason = `exactness gate branch 3: gaps ${Object.entries(exact.gaps).map(([grid, gap]) => `${grid} ${pct(gap)}`).join(', ')}`;
      return false;
    }
  };
  if (!(await exactness())) return run;

  // B. Calibrate and certify, with each repair at most once.
  for (;;) {
    const spec: CalibrationSpec = { name, sizes, curves: state.curves, ceilingsBps: state.ceilingsBps, variantLevel: state.level, screenLast };
    run.spec = spec;
    let evaluation: Evaluation;
    try {
      evaluation = await backend.evaluate(spec);
    } catch (error) {
      if (error instanceof Blocked && error.kind === 'economic') {
        run.status = 'failed';
        run.reason = error.message;
        return run;
      }
      throw error;
    }
    run.tablePath = evaluation.tablePath;
    run.tableHash = evaluation.tableHash;
    run.tiers = evaluation.tiers;
    const certified = evaluation.tiers.filter((tier) => tier.basis === 'certified');

    const beaten = certified.filter((tier) => tier.adversaries.some((adversary) => adversary.diffLcb > 0));
    if (beaten.length > 0) {
      if (state.level === 0) {
        state.level = 1;
        note(`an adversary beats value-lsm on tier ${beaten.map((tier) => tier.tier).join(', ')}: lookahead at every decision absorbed into value-lsm, candidate recalibrated`);
        // The exactness gate is about the bot that calibrates: judge it again for the stronger bot.
        if (!(await exactness())) return run;
        continue;
      }
      const fresh = beaten.filter((tier) => !state.adversaryLowered.includes(tier.tier));
      if (fresh.length > 0) {
        for (const tier of fresh) {
          const gain = Math.max(...tier.adversaries.filter((adversary) => adversary.diffLcb > 0).map((adversary) => adversary.meanDiff));
          const step = Math.ceil(gain * 10_000);
          state.ceilingsBps[tier.tier] -= step;
          state.adversaryLowered.push(tier.tier);
          note(`tier ${tier.tier}: an adversary still beats value-lsm by ${pct(gain)}; ceiling lowered by ${step} bps to ${state.ceilingsBps[tier.tier]} bps and recalibrated once`);
        }
        continue;
      }
    }
    const overGate1 = certified.filter((tier) => tier.gate1Value !== null && tier.gate1Value > tier.gate1Limit && !state.gate1Lowered.includes(tier.tier));
    if (overGate1.length > 0) {
      for (const tier of overGate1) {
        const step = Math.ceil(((tier.gate1Value ?? 0) - tier.gate1Limit) * 10_000);
        state.ceilingsBps[tier.tier] -= step;
        state.gate1Lowered.push(tier.tier);
        note(`tier ${tier.tier}: fixed gate 1 exceeded on stream B (${pct(tier.gate1Value ?? 0)}); ceiling lowered by ${step} bps to ${state.ceilingsBps[tier.tier]} bps and recalibrated once`);
      }
      continue;
    }

    const failing = certified.filter((tier) => tier.pass === false);
    if (failing.length > 0) {
      run.status = 'failed';
      run.reason = failing.map((tier) => `tier ${tier.tier}: ${tier.failedGates.join(', ')}`).join('; ');
    } else {
      run.status = 'ok';
    }
    const revenue = houseRevenue(evaluation.tiers.map((tier) => tier.population), assumptions);
    run.h = revenue.h;
    run.hSe = revenue.se;
    return run;
  }
}

export type Relaxable = 'E9' | 'E8';

export interface ConstraintStatus {
  e2: boolean;
  e10: boolean;
  e8: boolean;
  e9: boolean;
  /** Sum over tiers of the shortfalls of naive-greedy below the E2 floor and of sloppy-greedy below the E10 floor. */
  violation: number;
  /** Tiers that violate E2 or E10, worst first. */
  violatingTiers: number[];
}

export function constraintStatus(tiers: readonly TierSummary[], assumptions: Assumptions): ConstraintStatus {
  let e8 = true;
  let e9 = true;
  let violation = 0;
  const shortfalls: { tier: number; shortfall: number }[] = [];
  for (const tier of tiers) {
    const shortfall =
      Math.max(0, assumptions.e2NaiveRtpMin - tier.population['naive-greedy'].rtp) +
      Math.max(0, assumptions.e10SloppyRtpMin - tier.population['sloppy-greedy'].rtp);
    if (shortfall > 0) shortfalls.push({ tier: tier.tier, shortfall });
    violation += shortfall;
    if (tier.multiplierBps / 10_000 < byTier(assumptions.e8MultiplierMin, tier.tier)) e8 = false;
    if (
      tier.engagement.e9Refund1Bps < assumptions.e9Refund1MinBps ||
      tier.engagement.e9RefundAtShortestBps < assumptions.e9RefundAtShortestMinBps
    ) {
      e9 = false;
    }
  }
  const e2 = tiers.every((tier) => tier.population['naive-greedy'].rtp >= assumptions.e2NaiveRtpMin);
  const e10 = tiers.every((tier) => tier.population['sloppy-greedy'].rtp >= assumptions.e10SloppyRtpMin);
  shortfalls.sort((a, b) => b.shortfall - a.shortfall);
  return { e2, e10, e8, e9, violation, violatingTiers: shortfalls.map((entry) => entry.tier) };
}

export function feasible(status: ConstraintStatus, relaxed: readonly Relaxable[]): boolean {
  return status.e2 && status.e10 && (status.e8 || relaxed.includes('E8')) && (status.e9 || relaxed.includes('E9'));
}

export interface Selection {
  /** Candidate names from most to least preferred. */
  order: string[];
  relaxed: Relaxable[];
  /** False when no candidate satisfies E2 and E10 even with E9 and E8 dropped. */
  assumptionRangeMet: boolean;
  rows: { name: string; h: number; feasible: boolean; status: ConstraintStatus }[];
}

/**
 * Order of preference among candidates that passed their judged gates. The objective is `H`;
 * candidates within 0.2 points of the largest `H` are ordered by smallest e0, then largest aBps.
 * When nothing is feasible, E9 is dropped, then E8; after that the least-violating candidates
 * come first.
 */
export function rankCandidates(runs: readonly CandidateRun[], assumptions: Assumptions): Selection {
  const rows = runs
    .filter((run) => run.status === 'ok')
    .map((run) => ({
      run,
      h: houseRevenue(run.tiers.map((tier) => tier.population), assumptions).h,
      status: constraintStatus(run.tiers, assumptions),
    }));
  let relaxed: Relaxable[] = [];
  for (const attempt of [[], ['E9'], ['E9', 'E8']] as Relaxable[][]) {
    relaxed = attempt;
    if (rows.some((row) => feasible(row.status, attempt))) break;
  }
  const meanA = (run: CandidateRun): number => run.state.curves.reduce((total, curve) => total + curve.aBps, 0) / run.state.curves.length;
  const maxE0 = (run: CandidateRun): number => Math.max(...run.state.curves.map((curve) => curve.e0Bps));
  const preferred = rows.filter((row) => feasible(row.status, relaxed));
  const ordered: typeof rows = [];
  const remaining = [...preferred];
  while (remaining.length > 0) {
    const top = Math.max(...remaining.map((row) => row.h));
    const tied = remaining.filter((row) => row.h >= top - ADOPTION_THRESHOLD);
    tied.sort((a, b) => maxE0(a.run) - maxE0(b.run) || meanA(b.run) - meanA(a.run) || b.h - a.h);
    ordered.push(tied[0]);
    remaining.splice(remaining.indexOf(tied[0]), 1);
  }
  const rest = rows.filter((row) => !preferred.includes(row)).sort((a, b) => a.status.violation - b.status.violation || b.h - a.h);
  return {
    order: [...ordered, ...rest].map((row) => row.run.name),
    relaxed,
    assumptionRangeMet: preferred.length > 0,
    rows: rows.map((row) => ({ name: row.run.name, h: row.h, feasible: feasible(row.status, relaxed), status: row.status })),
  };
}

/**
 * The adjacent size to try for a tier that violates E2 or E10: one smaller when naive-greedy
 * wins too rarely (or the win frequency is in range), one larger when it wins too often. Null
 * when that size is below 3 or already used by another tier.
 */
export function adjacentSize(tier: TierSummary, sizes: readonly number[]): number | null {
  const next = tier.engagement.e1WinRate > tier.engagement.e1Range[1] ? tier.n + 1 : tier.n - 1;
  return next < 3 || sizes.includes(next) ? null : next;
}

export interface PointOutcome {
  estimate: PointEstimate;
  name: string;
  status: 'adopted' | 'rejected';
  reason: string;
  deltaH: number | null;
  deltaHLcb: number | null;
  /** What the point's own tier measured once calibrated and certified; null when it failed before that. */
  certified: { level: number; multiplierBps: number; bestRtp: number; naiveRtp: number; sloppyRtp: number; windowMissed: boolean } | null;
}

/** ΔH of a point against the baseline (positive = more house revenue) and its 95% lower bound. Only the point's tier differs. */
export function deltaH(baseline: TierSummary, point: TierSummary, assumptions: Assumptions): { delta: number; lcb: number } {
  const share = byTier(assumptions.tierShare, baseline.tier);
  let delta = 0;
  let variance = 0;
  for (const member of Object.keys(assumptions.population) as (keyof PopulationRtp)[]) {
    const weight = assumptions.population[member];
    delta += share * weight * (baseline.population[member].rtp - point.population[member].rtp);
    variance += (share * weight) ** 2 * (baseline.population[member].se ** 2 + point.population[member].se ** 2);
  }
  return { delta, lcb: delta - Z_975 * Math.sqrt(variance) };
}

export interface TuneResult {
  schema: 1;
  profile: string;
  simCodeHash: string;
  generatedAt: string;
  /** ASSUMPTIONS: population mix, tier shares and engagement ranges used for every choice below. */
  assumptions: Assumptions;
  /** The three candidates as compared: S and M certified, L screened. */
  candidates: CandidateRun[];
  selection: Selection | null;
  relaxed: Relaxable[];
  assumptionRangeMet: boolean;
  sizeChanges: { candidate: string; tier: number; from: number; to: number; adopted: boolean; reason: string }[];
  /** Candidates tried as the baseline at the full `N`, in order. */
  baselineAttempts: { name: string; status: string; reason: string | null }[];
  baseline: CandidateRun | null;
  pointMode: 'improve' | 'repair' | null;
  points: PointOutcome[];
  /**
   * `improved`: a search point replaced the baseline. `no-improvement`: the baseline stands (a
   * valid result). `incomplete`: the procedure has not finished yet. `blocked`: see `blocked`.
   */
  outcome: 'improved' | 'no-improvement' | 'incomplete' | 'blocked';
  final: CandidateRun | null;
  houseMax: { same: boolean; run: CandidateRun | null; tried: { name: string; status: string; reason: string | null }[] } | null;
  blocked: { kind: 'economic' | 'runtime'; message: string } | null;
}

export interface TuneInput {
  candidates: { name: string; curves: CurveParams[] }[];
  sizes: number[];
  assumptions: Assumptions;
}

function withTier<T>(values: readonly T[], index: number, value: T): T[] {
  return values.map((entry, i) => (i === index ? value : entry));
}

/**
 * The tuning procedure of plan §9.3, steps 1 to 9. A BLOCKED condition ends the procedure and is
 * returned in `blocked` together with everything decided up to that point.
 */
export async function tune(backend: TuneBackend, input: TuneInput): Promise<TuneResult> {
  const result: TuneResult = {
    schema: 1,
    profile: backend.profileName,
    simCodeHash: backend.simCodeHash,
    generatedAt: new Date().toISOString(),
    assumptions: input.assumptions,
    candidates: [],
    selection: null,
    relaxed: [],
    assumptionRangeMet: true,
    sizeChanges: [],
    baselineAttempts: [],
    baseline: null,
    pointMode: null,
    points: [],
    outcome: 'incomplete',
    final: null,
    houseMax: null,
    blocked: null,
  };
  try {
    await runTune(backend, input, result);
  } catch (error) {
    if (!(error instanceof Blocked)) throw error;
    result.outcome = 'blocked';
    result.blocked = { kind: error.kind, message: error.message };
  }
  return result;
}

async function runTune(backend: TuneBackend, input: TuneInput, result: TuneResult): Promise<void> {
  const { assumptions, sizes } = input;
  // Steps 1 and 2: every candidate through the exactness gate, calibration and certification.
  // The last tier is only screened here (plan: the full N of L is spent on the selected table).
  const pool: CandidateRun[] = [];
  for (const candidate of input.candidates) {
    pool.push(await evaluateCandidate(backend, assumptions, candidate.name, sizes, candidate.curves, sizes.length > 1));
  }
  result.candidates = pool;
  backend.progress(result);

  // Step 3: the baseline. Rule 2 handles assumption constraints; rule 1 handles fixed failures.
  let selection = rankCandidates(pool, assumptions);
  if (selection.order.length > 0 && !selection.assumptionRangeMet) {
    // Step 7 / rule 2: one size change per tier, at most two tiers, on the least-violating candidate.
    const origin = pool.find((run) => run.name === selection.order[0])!;
    let current = origin;
    let changed = 0;
    for (const tierIndex of constraintStatus(origin.tiers, assumptions).violatingTiers) {
      if (changed === 2) break;
      const size = adjacentSize(current.tiers[tierIndex], current.sizes);
      if (size === null) {
        result.sizeChanges.push({ candidate: origin.name, tier: tierIndex, from: current.sizes[tierIndex], to: current.sizes[tierIndex], adopted: false, reason: 'no adjacent size is available' });
        continue;
      }
      changed += 1;
      const newSizes = withTier(current.sizes, tierIndex, size);
      const trial = await evaluateCandidate(
        backend,
        assumptions,
        `${origin.name}-n${newSizes.join('-')}`,
        newSizes,
        input.candidates.find((candidate) => candidate.name === origin.name)!.curves,
        newSizes.length > 1,
      );
      const before = constraintStatus(current.tiers, assumptions).violation;
      const after = trial.status === 'ok' ? constraintStatus(trial.tiers, assumptions).violation : Number.POSITIVE_INFINITY;
      const adopted = after < before;
      result.sizeChanges.push({
        candidate: origin.name,
        tier: tierIndex,
        from: current.sizes[tierIndex],
        to: size,
        adopted,
        reason: adopted ? `E2/E10 shortfall ${pct(before)} → ${pct(after)} (spec deviation: tier size changed)` : trial.status === 'ok' ? `shortfall did not shrink (${pct(before)} → ${pct(after)})` : `the resized candidate failed: ${trial.reason}`,
      });
      if (adopted) {
        pool.push(trial);
        current = trial;
      }
    }
    selection = rankCandidates(pool, assumptions);
  }
  result.selection = selection;
  result.relaxed = selection.relaxed;
  result.assumptionRangeMet = selection.assumptionRangeMet;

  // The selected candidate's last tier at the full N; on a fixed failure the next candidate (at most three).
  let baseline: CandidateRun | null = null;
  for (const name of selection.order.slice(0, 3)) {
    const screened = pool.find((run) => run.name === name)!;
    const full = await evaluateCandidate(backend, assumptions, name, screened.sizes, screened.state.curves, false, screened.state);
    result.baselineAttempts.push({ name, status: full.status, reason: full.reason });
    if (full.status === 'ok') {
      baseline = full;
      break;
    }
  }
  if (baseline === null) {
    const reasons = [
      ...pool.filter((run) => run.status !== 'ok').map((run) => `${run.name}: ${run.reason}`),
      ...result.baselineAttempts.filter((attempt) => attempt.status !== 'ok').map((attempt) => `${attempt.name} at the full game count: ${attempt.reason}`),
    ];
    throw new Blocked('economic', `no candidate passed the fixed gates at the full game count (${reasons.join(' | ')})`);
  }
  result.baseline = baseline;
  backend.progress(result);
  let final = baseline;

  // Steps 4 to 6: at most three search points.
  const baselineStatus = constraintStatus(baseline.tiers, assumptions);
  const repair = !baselineStatus.e2 || !baselineStatus.e10;
  result.pointMode = repair ? 'repair' : 'improve';
  const estimates = await backend.rankPoints(baseline);
  const coarseOk = (estimate: PointEstimate): boolean =>
    estimate.naiveRtp >= assumptions.e2NaiveRtpMin &&
    estimate.sloppyRtp >= assumptions.e10SloppyRtpMin &&
    (selection.relaxed.includes('E8') || estimate.multiplierBps / 10_000 >= byTier(assumptions.e8MultiplierMin, estimate.tier)) &&
    (selection.relaxed.includes('E9') ||
      (estimate.refund1Bps >= assumptions.e9Refund1MinBps && estimate.refundAtShortestBps >= assumptions.e9RefundAtShortestMinBps));
  let shortlist: PointEstimate[];
  if (repair) {
    shortlist = estimates.filter((estimate) => baselineStatus.violatingTiers.includes(estimate.tier) && coarseOk(estimate));
  } else {
    // A point whose coarse estimate is below the adoption threshold cannot be adopted; it is not calibrated.
    shortlist = [];
    for (let tier = 0; tier < sizes.length; tier++) {
      shortlist.push(
        ...estimates
          .filter((estimate) => estimate.tier === tier && estimate.deltaH >= ADOPTION_THRESHOLD && coarseOk(estimate))
          .sort((a, b) => b.deltaH - a.deltaH)
          .slice(0, 3),
      );
    }
  }
  shortlist = shortlist.sort((a, b) => b.deltaH - a.deltaH).slice(0, 3);
  const pointRuns: CandidateRun[] = [];
  for (const estimate of shortlist) {
    const name = `point-${estimate.tier}-${estimate.aBps}-${Math.round(estimate.phi * 100)}`;
    const curves = withTier(baseline.state.curves, estimate.tier, { ...baseline.state.curves[estimate.tier], aBps: estimate.aBps, phi: estimate.phi });
    // The point's tier starts with its repairs unused; the other tiers keep the baseline's state.
    const run = await evaluateCandidate(backend, assumptions, name, baseline.sizes, curves, false, {
      ...baseline.state,
      curves,
      ceilingsBps: withTier(baseline.state.ceilingsBps, estimate.tier, baseline.state.baseCeilingBps),
      gate1Lowered: baseline.state.gate1Lowered.filter((tier) => tier !== estimate.tier),
      adversaryLowered: baseline.state.adversaryLowered.filter((tier) => tier !== estimate.tier),
      notes: [],
    });
    pointRuns.push(run);
    if (run.status !== 'ok') {
      result.points.push({ estimate, name, status: 'rejected', reason: `fixed failure: ${run.reason}`, deltaH: null, deltaHLcb: null, certified: null });
      continue;
    }
    const measured = run.tiers[estimate.tier];
    const certified = {
      level: run.state.level,
      multiplierBps: measured.multiplierBps,
      bestRtp: measured.bestRtp,
      naiveRtp: measured.population['naive-greedy'].rtp,
      sloppyRtp: measured.population['sloppy-greedy'].rtp,
      windowMissed: measured.windowMissed,
    };
    const change = deltaH(baseline.tiers[estimate.tier], run.tiers[estimate.tier], assumptions);
    const ok = feasible(constraintStatus(run.tiers, assumptions), selection.relaxed);
    let reason: string;
    let adopt: boolean;
    if (!ok) {
      adopt = false;
      reason = 'an assumption constraint (E2, E10, E8 or E9) is violated';
    } else if (repair) {
      adopt = true;
      reason = 'first point that satisfies every constraint (the baseline violates E2 or E10)';
    } else {
      adopt = change.delta >= ADOPTION_THRESHOLD && change.lcb > 0;
      reason = adopt ? 'ΔH is at least 0.2 points and its lower bound is positive' : `ΔH ${pct(change.delta)} (lower bound ${pct(change.lcb)}) does not meet the adoption rule`;
    }
    result.points.push({ estimate, name, status: adopt ? 'adopted' : 'rejected', reason, deltaH: change.delta, deltaHLcb: change.lcb, certified });
    if (adopt) {
      final = run;
      break;
    }
  }
  result.outcome = final === baseline ? 'no-improvement' : 'improved';
  result.final = final;
  backend.publish('candidate', final);

  // Step 9: the house-max table: among the calibrated tables, the largest H under the fixed
  // gates, N1 and E10 only (E2, E8 and E9 not applied). No separate search.
  const e10Ok = (run: CandidateRun): boolean => run.tiers.every((tier) => tier.population['sloppy-greedy'].rtp >= assumptions.e10SloppyRtpMin);
  const alternatives = [...pool.filter((run) => run.name !== baseline.name), baseline, ...pointRuns]
    .filter((run) => run.status === 'ok' && run.name !== final.name && e10Ok(run) && (run.h ?? 0) > (final.h ?? 0))
    .sort((a, b) => (b.h ?? 0) - (a.h ?? 0));
  const tried: { name: string; status: string; reason: string | null }[] = [];
  let houseMax: CandidateRun | null = null;
  for (const alternative of alternatives) {
    const full = alternative.tiers.every((tier) => tier.basis === 'certified')
      ? alternative
      : await evaluateCandidate(backend, assumptions, alternative.name, alternative.sizes, alternative.state.curves, false, alternative.state);
    const better = full.status === 'ok' && e10Ok(full) && (full.h ?? 0) > (final.h ?? 0);
    tried.push({ name: full.name, status: better ? 'selected' : full.status === 'ok' ? 'not better at the full game count' : full.status, reason: full.reason });
    if (better) {
      houseMax = full;
      break;
    }
  }
  result.houseMax = { same: houseMax === null, run: houseMax, tried };
  if (houseMax !== null) backend.publish('house-max', houseMax);
}
