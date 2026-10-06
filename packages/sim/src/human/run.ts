// `sim:human`: how people (models of people) fare at the maze game, and how close a rule a person
// could learn gets to the best AI.
//
// Everything is a function of the request: the same request gives the same result with any
// number of worker threads. The request carries the tuning tables and the certification's
// records (certify.json) for the comparison with value-lsm and naive-greedy; nothing of the
// certification is trained or written here.

import { tableHash, type TuningTable } from '@maze/shared';
import { ASSUMPTIONS } from '../assumptions';
import type { CellReport, TableCertification } from '../certify';
import { OUTCOME_CASH, OUTCOME_EXIT, type TierEconomics } from '../engine';
import { crossCheck, summarizeGames, type CrossCheck, type GameSummary, type Interval } from '../playstats';
import { Z_975 } from '../stats';
import { tierEconomicsOf } from '../tables';
import type { CueFit, ReachFit } from './calibrate';
import { MODEL_DEFAULTS, ROW_IDS, ROW_INFO, rowSpec, SESSION_ROWS, type ModelSpec, type RowId, type RowInfo, type SizeCalibration } from './catalog';
import { firstIndex, HUMAN_STREAM_LABEL, humanStreamBaseHex, humanStreamDisjoint, SEED_SPAN } from './feed';
import { CODE_OUTCOMES, type CalibrateResult, type PlayJob } from './jobs';
import { THOUGHTFUL_DEFAULTS } from './models';
import type { HumanExecutor } from './pool';
import { indifferenceChance, RISK_NEUTRAL, TK1992 } from './prospect';
import { moveParts, type PartScores } from './rules';
import { selectRule, type RuleSearch } from './search';
import {
  baselineRules,
  CHASE_RULES,
  joinSessions,
  QUIT_RULES,
  SESSION_STRIDE,
  SESSION_VARIANTS,
  SIZE_CHOICE,
  summarizeSessions,
  VARIANT_INFO,
  variantRules,
  type SessionColumns,
  type SessionSummary,
  type SessionVariant,
} from './sessions';

const BPS = 10_000;

/** Within the session range of a seed: learning careers first, bankroll sessions from here on. */
const SESSIONS_OFFSET = 2 ** 27;

/** Games per evaluation job, careers per learning job, sessions per session job. */
const PLAY_BLOCK = 25_000;
const CAREER_BLOCK = 50;
const SESSION_BLOCK = 25;

/** ASSUMPTION: the share of play by each kind of person, for the illustrative population figures. */
export const HUMAN_MIX: Partial<Record<RowId, number>> = { novice: 0.3, average: 0.4, thoughtful: 0.2, learning: 0.1 };

/** Edges of the learning curve's buckets, in games since the person started. */
const CURVE_EDGES = [0, 10, 25, 50, 100, 200, 300, 500, 1000, 2000, 5000];

export interface TableInput {
  /** Short Korean name of the table, e.g. "기본 표". */
  label: string;
  /** Path as the report shows it. */
  path: string;
  table: TuningTable;
  certification: TableCertification | null;
}

export interface HumanRequest {
  tables: TableInput[];
  /** Evaluation games per (row, tier). */
  games: number;
  /** Training games per move part and tier for the rule search. */
  trainGames: number;
  /** Learning careers per tier and their length in games. */
  careers: number;
  careerGames: number;
  /** Bankroll sessions per (row, tier), and per (row, table, session behaviour). */
  sessions: number;
  behaviourSessions: number;
  bankroll: number;
  gameCap: number;
  /** Training games of the cue fit and of the gut-feel calibration, per grid size. */
  fitGames: number;
  reachGames: number;
  seed: number;
  codeHash: string;
}

export interface CertifiedRef {
  bot: string;
  stream: string;
  games: number;
  rtp: number;
  se: number;
  ci95: [number, number];
  winRate: number;
}

export interface Comparison {
  /** This row's return minus the reference's; the interval adds both estimates' variances. */
  difference: number;
  halfWidth: number;
}

export interface CellHuman {
  row: RowId;
  games: number;
  rates: GameSummary['rates'];
  winRate: Interval;
  rtp: GameSummary['rtp'];
  houseHold: Interval;
  meanSteps: number;
  endStep: GameSummary['endStep'];
  longestLosingRun: number;
  vsValueLsm: Comparison | null;
  vsNaive: Comparison | null;
  /** Baseline bankroll sessions on this tier; null for rows without sessions. */
  sessions: SessionSummary | null;
}

export interface CurvePoint {
  /** Games `from + 1 .. to` of a career. */
  from: number;
  to: number;
  games: number;
  rtp: number;
  ci95: [number, number];
}

export interface TierHuman {
  tier: number;
  n: number;
  multiplier: number;
  shortestPath: number;
  /** Refund as a multiple of the bet after k moves, k = 0 .. 2 × shortest path. */
  refund: number[];
  certified: { valueLsm: CertifiedRef | null; naiveGreedy: CertifiedRef | null };
  cells: CellHuman[];
  rule: RuleSearch;
  /** The selected rule on evaluation games, against value-lsm and naive-greedy. */
  ruleGap: {
    rtp: number;
    halfWidth: number;
    toValueLsm: Comparison | null;
    /** Share of the distance from naive-greedy to value-lsm that the rule covers (certified references). */
    closedShare: number | null;
  };
  learningCurve: CurvePoint[];
  naiveCheck: CrossCheck | null;
  /** Felt chance of winning above which going on feels better than cashing out, at a few step counts. */
  breakEven: { k: number; refund: number; neutral: number; prospect: number }[];
}

export interface BehaviourRow {
  row: RowId;
  variant: SessionVariant;
  summary: SessionSummary;
}

export interface PopulationHuman {
  /** ASSUMPTIONS: the share of each kind of person and of each tier (assumptions.ts). */
  mix: Partial<Record<RowId, number>>;
  tierShare: number[];
  /** What the house keeps per bet, weighted by the tier shares. */
  houseTake: { humans: number; bestRule: number; valueLsm: number | null; immediateCashout: number };
  /** House take when a share of the play comes from people who use the best rule and the rest is the assumed mix. */
  learnedShare: { share: number; houseTake: number }[];
}

export interface TableHuman {
  label: string;
  path: string;
  tableHash: string;
  /** certify.json holds a passed, complete certification of this table by the current simulator code. */
  certified: boolean;
  tiers: TierHuman[];
  behaviour: BehaviourRow[];
  population: PopulationHuman;
}

export interface HumanStats {
  schema: 1;
  kind: 'sim-human';
  simCodeHash: string;
  options: Omit<HumanRequest, 'tables' | 'codeHash'>;
  stream: {
    label: string;
    base: string;
    /** The stream's seed interval meets none of the certification streams A..E. */
    disjoint: boolean;
    /** Game indexes used within every grid size. */
    ranges: { purpose: string; first: number; last: number }[];
  };
  rows: RowInfo[];
  variants: { id: SessionVariant; name: string; description: string }[];
  defaults: typeof MODEL_DEFAULTS & {
    prospect: typeof TK1992;
    sizeChoice: typeof SIZE_CHOICE;
    quit: typeof QUIT_RULES;
    chase: typeof CHASE_RULES;
    humanMix: typeof HUMAN_MIX;
  };
  calibration: { n: number; fit: CueFit; reach: ReachFit; reachIdeal: ReachFit }[];
  tables: TableHuman[];
}

export interface PhaseTiming {
  phase: string;
  jobs: number;
  seconds: number;
}

function rawCell(certification: TableCertification | null, tier: number, multiplierBps: number, bot: string): CellReport | null {
  const entry = certification?.tiers.find((candidate) => candidate.tier === tier && candidate.multiplierBps === multiplierBps);
  return entry?.cells.find((candidate) => candidate.bot === bot && candidate.stream === 'B') ?? null;
}

function certifiedCell(certification: TableCertification | null, tier: number, multiplierBps: number, bot: string): CertifiedRef | null {
  const cell = rawCell(certification, tier, multiplierBps, bot);
  if (cell === null) return null;
  return { bot: cell.bot, stream: cell.stream, games: cell.games, rtp: cell.rtp, se: cell.se, ci95: cell.ci95, winRate: cell.winRate };
}

function compare(summary: GameSummary, reference: CertifiedRef | null): Comparison | null {
  if (reference === null) return null;
  return { difference: summary.rtp.mean - reference.rtp, halfWidth: Z_975 * Math.hypot(summary.rtp.se, reference.se) };
}

function payoutOf(code: number, econ: TierEconomics): number {
  const outcome = code % CODE_OUTCOMES;
  const k = (code - outcome) / CODE_OUTCOMES;
  return outcome === OUTCOME_EXIT ? econ.multiplierBps / BPS : outcome === OUTCOME_CASH ? econ.refundBps[k] / BPS : 0;
}

/** Return by games played so far in a career; `codes` holds whole careers of `career` games each, one after the other. */
export function learningCurve(codes: Uint16Array, career: number, econ: TierEconomics): CurvePoint[] {
  if (codes.length === 0 || codes.length % career !== 0) throw new RangeError('learningCurve: the codes must be whole careers');
  const edges = CURVE_EDGES.filter((edge) => edge < career).concat(career);
  const points: CurvePoint[] = [];
  for (let b = 0; b + 1 < edges.length; b++) {
    let n = 0;
    let sum = 0;
    let sumSq = 0;
    for (let start = 0; start < codes.length; start += career) {
      for (let j = edges[b]; j < edges[b + 1]; j++) {
        const payout = payoutOf(codes[start + j], econ);
        n += 1;
        sum += payout;
        sumSq += payout * payout;
      }
    }
    const mean = sum / n;
    const se = Math.sqrt(Math.max(0, (sumSq - n * mean * mean) / Math.max(1, n - 1)) / n);
    points.push({ from: edges[b], to: edges[b + 1], games: n, rtp: mean, ci95: [mean - Z_975 * se, mean + Z_975 * se] });
  }
  return points;
}

function split(total: number, block: number): [number, number][] {
  const out: [number, number][] = [];
  for (let at = 0; at < total; at += block) out.push([at, Math.min(total, at + block)]);
  return out;
}

function concatCodes(parts: Uint16Array[]): Uint16Array {
  const out = new Uint16Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function assertRequest(request: HumanRequest): void {
  const positive = ['games', 'trainGames', 'careers', 'careerGames', 'sessions', 'behaviourSessions', 'bankroll', 'gameCap', 'fitGames', 'reachGames'] as const;
  for (const name of positive) {
    const value = request[name];
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  if (request.games < 100) throw new RangeError('games must be at least 100');
  if (request.sessions < 2 || request.behaviourSessions < 2) throw new RangeError('at least two sessions are needed');
  if (request.gameCap > SESSION_STRIDE) throw new RangeError(`gameCap must be at most ${SESSION_STRIDE}`);
  if (request.careers * request.careerGames > SESSIONS_OFFSET) throw new RangeError('careers × careerGames is too large for the session range');
  if (Math.max(request.sessions, request.behaviourSessions) * SESSION_STRIDE > SEED_SPAN - SESSIONS_OFFSET) throw new RangeError('too many sessions for one seed');
  if (request.games > SEED_SPAN || request.trainGames + request.fitGames + request.reachGames > SEED_SPAN) throw new RangeError('too many games for one seed');
  if (request.tables.length === 0) throw new RangeError('at least one table is needed');
  firstIndex('eval', request.seed);
}

/** House take of the assumed mix of people, of the best rule and of value-lsm, weighted by the assumed tier shares. */
export function population(tiers: TierHuman[]): PopulationHuman {
  const shares = ASSUMPTIONS.tierShare.slice(0, tiers.length);
  const norm = shares.reduce((a, b) => a + b, 0);
  const weightOf = (t: number): number => shares[t] / norm;
  const entries = Object.entries(HUMAN_MIX) as [RowId, number][];
  const mixTotal = entries.reduce((total, [, share]) => total + share, 0);
  let humans = 0;
  let bestRule = 0;
  let valueLsm: number | null = 0;
  tiers.forEach((tier, t) => {
    const rtpOf = (row: RowId): number => tier.cells.find((cell) => cell.row === row)!.rtp.mean;
    let mixed = 0;
    for (const [row, share] of entries) mixed += (share / mixTotal) * (1 - rtpOf(row));
    humans += weightOf(t) * mixed;
    bestRule += weightOf(t) * (1 - rtpOf('best-rule'));
    if (valueLsm !== null) valueLsm = tier.certified.valueLsm === null ? null : valueLsm + weightOf(t) * (1 - tier.certified.valueLsm.rtp);
  });
  const immediate = tiers.reduce((total, tier, t) => total + weightOf(t) * (1 - tier.refund[0]), 0);
  return {
    mix: HUMAN_MIX,
    tierShare: shares.map((share) => share / norm),
    houseTake: { humans, bestRule, valueLsm, immediateCashout: immediate },
    learnedShare: Array.from({ length: 11 }, (_, i) => i / 10).map((share) => ({ share, houseTake: (1 - share) * humans + share * bestRule })),
  };
}

/** Runs the request. `log` hears about progress; it is not part of the result. */
export async function collectHumanStats(
  request: HumanRequest,
  executor: HumanExecutor,
  log: (line: string) => void = () => {},
): Promise<{ stats: HumanStats; timings: PhaseTiming[] }> {
  assertRequest(request);
  const timings: PhaseTiming[] = [];
  const trainFirst = firstIndex('train', request.seed);
  const evalFirst = firstIndex('eval', request.seed);
  const careerFirst = firstIndex('sessions', request.seed);
  const sessionFirst = careerFirst + SESSIONS_OFFSET;
  const fitFirst = trainFirst + request.trainGames;
  const reachFirst = fitFirst + request.fitGames;

  // Phase 1: the thoughtful player's calibration per grid size, and the rule search per tier.
  const sizes = [...new Set(request.tables.flatMap((input) => input.table.tiers.map((tier) => tier.n)))].sort((a, b) => a - b);
  let started = performance.now();
  const calibrations = new Map<number, CalibrateResult>();
  const searchScores = new Map<string, PartScores[]>();
  const phaseOne: Promise<void>[] = [];
  for (const n of sizes) {
    phaseOne.push(
      executor
        .run({ kind: 'calibrate', w: n, h: n, fitFirst, fitGames: request.fitGames, reachFirst, reachGames: request.reachGames, perception: THOUGHTFUL_DEFAULTS.perception })
        .then((result) => {
          calibrations.set(n, result as CalibrateResult);
          log(`calibrated the thoughtful player for ${n}x${n}`);
        }),
    );
  }
  request.tables.forEach((input, t) => {
    input.table.tiers.forEach((tier, i) => {
      const econ = tierEconomicsOf(tier);
      const scores: PartScores[] = [];
      searchScores.set(`${t}/${i}`, scores);
      moveParts().forEach((part, p) => {
        phaseOne.push(
          executor.run({ kind: 'search', econ, part, first: trainFirst, games: request.trainGames }).then((result) => {
            scores[p] = result as PartScores;
          }),
        );
      });
    });
  });
  await Promise.all(phaseOne);
  timings.push({ phase: 'calibration and rule search', jobs: phaseOne.length, seconds: (performance.now() - started) / 1000 });
  log(`rule search done (${phaseOne.length} jobs, ${((performance.now() - started) / 1000).toFixed(1)}s)`);

  // The selected rules and the model of every row, per tier.
  const searches = new Map<string, RuleSearch>();
  const specs = new Map<string, ModelSpec>();
  request.tables.forEach((input, t) => {
    input.table.tiers.forEach((tier, i) => {
      const econ = tierEconomicsOf(tier);
      const search = selectRule(searchScores.get(`${t}/${i}`)!, econ.refundBps, econ.w + econ.h - 2, request.trainGames);
      searches.set(`${t}/${i}`, search);
      const calibrated = calibrations.get(tier.n)!;
      const calibration: SizeCalibration = { cue: calibrated.fit.weights, reach: calibrated.reach.reach, reachIdeal: calibrated.reachIdeal.reach };
      for (const row of ROW_IDS) {
        specs.set(`${t}/${i}/${row}`, rowSpec(row, calibration, { best: search.best.params, oneStop: search.oneStop.params, noStop: search.noStop.params }));
      }
    });
  });

  // Phase 2: evaluation games, learning careers and bankroll sessions.
  started = performance.now();
  const phaseTwo: Promise<void>[] = [];
  const codes = new Map<string, Uint16Array[]>();
  const baseline = new Map<string, SessionColumns[]>();
  const behaviour = new Map<string, SessionColumns[]>();
  request.tables.forEach((input, t) => {
    const econs = input.table.tiers.map(tierEconomicsOf);
    input.table.tiers.forEach((tier, i) => {
      const econ = econs[i];
      for (const row of ROW_IDS) {
        const spec = specs.get(`${t}/${i}/${row}`)!;
        const parts: Uint16Array[] = [];
        codes.set(`${t}/${i}/${row}`, parts);
        const jobs: PlayJob[] =
          row === 'learning'
            ? split(request.careers, CAREER_BLOCK).map(([from, to]) => ({
                kind: 'play',
                econ,
                spec,
                noiseKey: `career/${row}/${tier.n}`,
                first: careerFirst + from * request.careerGames,
                games: (to - from) * request.careerGames,
                career: request.careerGames,
              }))
            : split(request.games, PLAY_BLOCK).map(([from, to]) => ({ kind: 'play', econ, spec, noiseKey: `eval/${row}/${tier.n}`, first: evalFirst + from, games: to - from, career: 0 }));
        jobs.forEach((job, j) => {
          phaseTwo.push(
            executor.run(job).then((result) => {
              parts[j] = result as Uint16Array;
            }),
          );
        });
        if (!SESSION_ROWS.includes(row)) continue;
        const sessionParts: SessionColumns[] = [];
        baseline.set(`${t}/${i}/${row}`, sessionParts);
        const tierSpecs = econs.map((_, k) => specs.get(`${t}/${k}/${row}`)!);
        const rules = baselineRules(request.bankroll, request.gameCap);
        split(request.sessions, SESSION_BLOCK).forEach(([from, to], j) => {
          phaseTwo.push(
            executor
              .run({ kind: 'sessions', job: { econs, specs: tierSpecs, fixedTier: i, rules, first: sessionFirst, from, to, noiseKey: `baseline/${row}/${tier.n}` } })
              .then((result) => {
                sessionParts[j] = result as SessionColumns;
              }),
          );
        });
      }
    });
    for (const row of SESSION_ROWS) {
      const tierSpecs = econs.map((_, k) => specs.get(`${t}/${k}/${row}`)!);
      for (const variant of SESSION_VARIANTS) {
        const sessionParts: SessionColumns[] = [];
        behaviour.set(`${t}/${row}/${variant}`, sessionParts);
        const rules = variantRules(variant, request.bankroll, request.gameCap);
        split(request.behaviourSessions, SESSION_BLOCK).forEach(([from, to], j) => {
          phaseTwo.push(
            executor
              .run({ kind: 'sessions', job: { econs, specs: tierSpecs, fixedTier: null, rules, first: sessionFirst, from, to, noiseKey: `behaviour/${variant}/${row}` } })
              .then((result) => {
                sessionParts[j] = result as SessionColumns;
              }),
          );
        });
      }
    }
  });
  let done = 0;
  const total = phaseTwo.length;
  const every = Math.max(1, Math.round(total / 10));
  await Promise.all(
    phaseTwo.map((promise) =>
      promise.then(() => {
        done += 1;
        if (done % every === 0 || done === total) log(`games and sessions: ${done}/${total} jobs (${((performance.now() - started) / 1000).toFixed(1)}s)`);
      }),
    ),
  );
  timings.push({ phase: 'evaluation games and sessions', jobs: total, seconds: (performance.now() - started) / 1000 });

  const tables: TableHuman[] = request.tables.map((input, t) => {
    const certification = input.certification !== null && input.certification.simCodeHash === request.codeHash ? input.certification : null;
    const tiers: TierHuman[] = input.table.tiers.map((tier, i) => {
      const econ = tierEconomicsOf(tier);
      const shortest = econ.w + econ.h - 2;
      const valueLsm = certifiedCell(certification, i, tier.multiplierBps, 'value-lsm');
      const naiveGreedy = certifiedCell(certification, i, tier.multiplierBps, 'naive-greedy');
      const summaries = new Map<RowId, GameSummary>();
      const cells: CellHuman[] = ROW_IDS.map((row) => {
        const summary = summarizeGames(concatCodes(codes.get(`${t}/${i}/${row}`)!), econ);
        summaries.set(row, summary);
        const sessionParts = baseline.get(`${t}/${i}/${row}`);
        return {
          row,
          games: summary.games,
          rates: summary.rates,
          winRate: summary.winRate,
          rtp: summary.rtp,
          houseHold: summary.houseHold,
          meanSteps: summary.meanSteps,
          endStep: summary.endStep,
          longestLosingRun: summary.streaks.longest,
          vsValueLsm: compare(summary, valueLsm),
          vsNaive: compare(summary, naiveGreedy),
          sessions: sessionParts === undefined ? null : summarizeSessions(joinSessions(sessionParts), baselineRules(request.bankroll, request.gameCap)),
        };
      });
      const ruleCell = cells.find((cell) => cell.row === 'best-rule')!;
      const naiveRaw = rawCell(certification, i, tier.multiplierBps, 'naive-greedy');
      const breakEvenSteps = [...new Set([1, Math.round(shortest / 2), shortest])];
      return {
        tier: i,
        n: tier.n,
        multiplier: tier.multiplierBps / BPS,
        shortestPath: shortest,
        refund: tier.refundBps.slice(0, 2 * shortest + 1).map((bps) => bps / BPS),
        certified: { valueLsm, naiveGreedy },
        cells,
        rule: searches.get(`${t}/${i}`)!,
        ruleGap: {
          rtp: ruleCell.rtp.mean,
          halfWidth: ruleCell.rtp.halfWidth,
          toValueLsm: ruleCell.vsValueLsm,
          closedShare:
            valueLsm !== null && naiveGreedy !== null && valueLsm.rtp > naiveGreedy.rtp ? (ruleCell.rtp.mean - naiveGreedy.rtp) / (valueLsm.rtp - naiveGreedy.rtp) : null,
        },
        learningCurve: learningCurve(concatCodes(codes.get(`${t}/${i}/learning`)!), request.careerGames, econ),
        naiveCheck: naiveRaw === null ? null : crossCheck('naive-greedy', summaries.get('naive-check')!, naiveRaw, econ),
        breakEven: breakEvenSteps.map((k) => {
          const refund = tier.refundBps[k] / BPS;
          const later = tier.refundBps[Math.min(tier.refundBps.length - 1, k + THOUGHTFUL_DEFAULTS.bailLag)] / BPS;
          const multiplier = tier.multiplierBps / BPS;
          return {
            k,
            refund,
            neutral: indifferenceChance(refund, multiplier, THOUGHTFUL_DEFAULTS.salvage, later, RISK_NEUTRAL),
            prospect: indifferenceChance(refund, multiplier, THOUGHTFUL_DEFAULTS.salvage, later, TK1992),
          };
        }),
      };
    });
    const behaviourRows: BehaviourRow[] = [];
    for (const row of SESSION_ROWS) {
      for (const variant of SESSION_VARIANTS) {
        const columns = joinSessions(behaviour.get(`${t}/${row}/${variant}`)!);
        behaviourRows.push({ row, variant, summary: summarizeSessions(columns, variantRules(variant, request.bankroll, request.gameCap)) });
      }
    }
    return {
      label: input.label,
      path: input.path,
      tableHash: tableHash(input.table),
      certified: certification !== null && certification.complete && certification.pass,
      tiers,
      behaviour: behaviourRows,
      population: population(tiers),
    };
  });

  const stats: HumanStats = {
    schema: 1,
    kind: 'sim-human',
    simCodeHash: request.codeHash,
    options: {
      games: request.games,
      trainGames: request.trainGames,
      careers: request.careers,
      careerGames: request.careerGames,
      sessions: request.sessions,
      behaviourSessions: request.behaviourSessions,
      bankroll: request.bankroll,
      gameCap: request.gameCap,
      fitGames: request.fitGames,
      reachGames: request.reachGames,
      seed: request.seed,
    },
    stream: {
      label: HUMAN_STREAM_LABEL,
      base: humanStreamBaseHex(),
      disjoint: humanStreamDisjoint(),
      ranges: [
        { purpose: 'rule search (training)', first: trainFirst, last: trainFirst + request.trainGames - 1 },
        { purpose: 'cue fit and gut-feel calibration (training)', first: fitFirst, last: reachFirst + request.reachGames - 1 },
        { purpose: 'evaluation', first: evalFirst, last: evalFirst + request.games - 1 },
        { purpose: 'learning careers', first: careerFirst, last: careerFirst + request.careers * request.careerGames - 1 },
        { purpose: 'bankroll sessions', first: sessionFirst, last: sessionFirst + Math.max(request.sessions, request.behaviourSessions) * SESSION_STRIDE - 1 },
      ],
    },
    rows: ROW_IDS.map((row) => ROW_INFO[row]),
    variants: SESSION_VARIANTS.map((id) => ({ id, ...VARIANT_INFO[id] })),
    defaults: { ...MODEL_DEFAULTS, prospect: TK1992, sizeChoice: SIZE_CHOICE, quit: QUIT_RULES, chase: CHASE_RULES, humanMix: HUMAN_MIX },
    calibration: sizes.map((n) => ({ n, ...calibrations.get(n)! })),
    tables,
  };
  return { stats, timings };
}
