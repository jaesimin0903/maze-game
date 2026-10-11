// `sim:escape`: how often a game reaches the exit, per maze size and per policy.
//
// A cell is one size played by one policy. Its games are maze 0, 1, 2, ... of the size on the
// escape stream (jobs.ts), played in that order until the `escapes`-th game that reaches the exit
// or until `maxGames` games, whichever comes first. Workers play the games in jobs, but the
// results are added one game at a time in game order and the count stops exactly at the
// stopping game, so a cell's numbers do not depend on the job sizes or on the number of workers.
//
// For the random walk every game also carries the exact probability that the walk escapes its
// maze (exact.ts). Their mean estimates the same escape probability with less variance, and the
// escapes counted on the same mazes must agree with it. On the sizes whose every maze can be
// enumerated (3×3 and 4×4) the escape probability of each policy without a cash-out is also
// computed exactly, after a census of the generator has confirmed the weights of the
// enumeration. Pairs of policies are compared game by game on the same mazes (`COMPARISONS`),
// so that a small difference between them gets an interval of its own. Everything is a function
// of the request.

import { OUTCOME_CASH, OUTCOME_EXIT, type TierEconomics } from '../engine';
import type { ValueTable } from '../lsm';
import { Z_975 } from '../stats';
import { enumeratedGrid } from '../exact';
import { censusCheck, fullExact, type CensusCheck, type ExactPolicy, type FullExact } from './exact';
import {
  CENSUS_OFFSET,
  CENSUS_SPAN,
  ESCAPE_STREAM_LABEL,
  escapeFirstIndex,
  escapeStreamBaseHex,
  escapeStreamDisjoint,
  type CensusCounts,
  type GameColumns,
  type PairedCounts,
  type PolicyId,
  type PolicySpec,
} from './jobs';
import type { EscapeExecutor } from './pool';

/** Sizes whose every maze is enumerated (`fullExact`). */
export const ENUMERABLE_SIZES: readonly number[] = [3, 4];
/** A check fails when an estimate is more than this many standard errors from what it must equal. */
export const AGREEMENT_Z = 4;

/** The largest job of a policy, in games: about a second of work on 9×9. */
const JOB_GAMES: Record<PolicyId, number> = { 'random-walk': 100_000, 'naive-greedy': 100_000, harmonic: 20_000, 'value-lsm': 10_000 };
/** Jobs start this small and double, so that a cell that stops early wastes little work. */
const FIRST_JOB_GAMES = 1_000;
/** Draws per census job. */
const CENSUS_JOB_DRAWS = 250_000;
/** Games per job of a paired comparison. */
const PAIRED_JOB_GAMES = 10_000;

/** Pairs `[a, b]` compared on the same mazes, as P(a exits) − P(b exits). */
export const COMPARISONS: readonly (readonly [PolicyId, PolicyId])[] = [
  ['harmonic', 'naive-greedy'],
  ['value-lsm', 'harmonic'],
];

export interface EscapeRequest {
  sizes: number[];
  policies: PolicyId[];
  /** Stop a cell at this many escapes … */
  escapes: number;
  /** … or after this many games. */
  maxGames: number;
  seed: number;
  /** value-lsm's certified tier per size; value-lsm does not play the other sizes. */
  tiers: Map<number, { econ: TierEconomics; table: ValueTable }>;
  /** Generator draws per enumerated maze in the census of the enumerable sizes (0 = no census). */
  censusPerMaze: number;
}

export interface Interval {
  lo: number;
  hi: number;
}

/** Wilson score interval of a binomial proportion (no continuity correction). */
export function wilsonInterval(successes: number, trials: number, z: number = Z_975): Interval {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || trials < 1 || successes < 0 || successes > trials) {
    throw new RangeError(`wilsonInterval: need 0 <= successes <= trials and trials >= 1, got ${successes} / ${trials}`);
  }
  const z2 = z * z;
  const centre = (successes + z2 / 2) / (trials + z2);
  const half = (z / (trials + z2)) * Math.sqrt((successes * (trials - successes)) / trials + z2 / 4);
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export interface HistogramSummary {
  mean: number;
  sd: number;
  min: number;
  p10: number;
  p50: number;
  p90: number;
  max: number;
}

/** Summary of a distribution over `0 .. hist.length - 1` given by counts or probabilities. */
export function summarizeHistogram(hist: readonly number[]): HistogramSummary | null {
  let total = 0;
  let sum = 0;
  let sumSq = 0;
  let min = -1;
  let max = -1;
  for (let value = 0; value < hist.length; value++) {
    if (hist[value] <= 0) continue;
    total += hist[value];
    sum += hist[value] * value;
    sumSq += hist[value] * value * value;
    if (min === -1) min = value;
    max = value;
  }
  if (total === 0) return null;
  const quantile = (q: number): number => {
    let seen = 0;
    for (let value = 0; value < hist.length; value++) {
      seen += Math.max(0, hist[value]);
      if (seen >= q * total) return value;
    }
    return max;
  };
  const mean = sum / total;
  return { mean, sd: Math.sqrt(Math.max(0, sumSq / total - mean * mean)), min, p10: quantile(0.1), p50: quantile(0.5), p90: quantile(0.9), max };
}

/** Sums over the games of a cell. */
export interface CellCounts {
  games: number;
  exits: number;
  cashOuts: number;
  deadEnds: number;
  /** Moves made, over all games / over the games that reached the exit / that cashed out. */
  steps: number;
  exitSteps: number;
  cashSteps: number;
  /** Games by the number of moves on their maze's start-to-exit path, all games and escapes only. */
  pathHist: number[];
  exitPathHist: number[];
  /** Random walk: Σ p and Σ p² of the exact per-maze escape probabilities, added in game order. */
  sumP: number;
  sumP2: number;
}

export function emptyCounts(cells: number): CellCounts {
  return {
    games: 0,
    exits: 0,
    cashOuts: 0,
    deadEnds: 0,
    steps: 0,
    exitSteps: 0,
    cashSteps: 0,
    pathHist: new Array<number>(cells).fill(0),
    exitPathHist: new Array<number>(cells).fill(0),
    sumP: 0,
    sumP2: 0,
  };
}

/**
 * Adds the games of `columns` to `counts` in order, up to and including the game that brings the
 * escapes to `target`. Returns true once the target is reached.
 */
export function addGames(counts: CellCounts, columns: GameColumns, target: number): boolean {
  const exact = columns.exactP.length > 0;
  for (let i = 0; i < columns.outcome.length && counts.exits < target; i++) {
    const outcome = columns.outcome[i];
    const steps = columns.steps[i];
    const path = columns.pathLength[i];
    counts.games += 1;
    counts.steps += steps;
    counts.pathHist[path] += 1;
    if (outcome === OUTCOME_EXIT) {
      counts.exits += 1;
      counts.exitSteps += steps;
      counts.exitPathHist[path] += 1;
    } else if (outcome === OUTCOME_CASH) {
      counts.cashOuts += 1;
      counts.cashSteps += steps;
    } else {
      counts.deadEnds += 1;
    }
    if (exact) {
      const p = columns.exactP[i];
      counts.sumP += p;
      counts.sumP2 += p * p;
    }
  }
  return counts.exits >= target;
}

/** The random walk's exact per-maze probabilities averaged over the cell's mazes. */
export interface ExactAverage {
  mean: number;
  /** Standard deviation of the per-maze probability across mazes. */
  sd: number;
  ci95: Interval;
  /**
   * (escapes − Σ p) / √Σ p(1 − p): the escapes counted against what the exact probabilities of
   * the same mazes predict. Standard normal when the engine's walk is the walk the product describes.
   */
  z: number;
  agrees: boolean;
  /** Whether the exact average lies inside the Monte Carlo interval. */
  insideWilson: boolean;
}

/** An estimate against the exact value over all mazes. */
export interface AgainstExact {
  value: number;
  /** (estimate − value) / standard error of the estimate. */
  z: number;
  agrees: boolean;
  /** Whether the exact value lies inside the estimate's 95% interval. */
  insideInterval: boolean;
}

export interface CellResult {
  n: number;
  policy: PolicyId;
  games: number;
  escapes: number;
  /** False when the cell stopped at `maxGames` before reaching the target. */
  reachedTarget: boolean;
  pHat: number;
  wilson95: Interval;
  rates: { exit: number; cashOut: number; deadEnd: number };
  /** Exit share of the games that did not cash out. */
  exitGivenNoCashOut: number | null;
  meanSteps: number;
  /** Moves of the games that reached the exit (always their maze's path length). */
  meanStepsToExit: number | null;
  meanCashOutStep: number | null;
  pathLength: HistogramSummary;
  exactAverage: ExactAverage | null;
  /** On an enumerable size: p̂ against the exact value, and for the random walk the exact average too. */
  fullExact: { pHat: AgainstExact; exactAverage: AgainstExact | null } | null;
  counts: CellCounts;
}

export interface SkippedCell {
  n: number;
  policy: PolicyId;
  reason: string;
}

export interface SizeExact {
  exact: FullExact;
  census: CensusCheck | null;
  /** True when the exact values were used: the census passed or was not asked for. */
  used: boolean;
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** Two policies on the same mazes. */
export interface Comparison {
  n: number;
  a: PolicyId;
  b: PolicyId;
  /** Mazes 0 .. games − 1 of the size: every maze that either cell played. */
  games: number;
  /** `table[x][y]`: games in which a ended with outcome x and b with outcome y (exit, cash-out, dead end). */
  table: number[][];
  exitA: number;
  exitB: number;
  /** P(a exits) − P(b exits), the mean of the per-game differences, with its 95% interval. */
  diff: number;
  ci95: Interval;
  /** False when the interval contains 0: no difference shown. */
  shown: boolean;
  /**
   * When a cashes out: how often, how often b reached the exit in the games a cashed out, and the
   * exit loss that cashing out of as many games chosen at random would cost (rate × b's exit rate).
   */
  cashOut: { rate: number; bExitWhenCashed: number; bExitWhenCashed95: Interval; proportionalLoss: number } | null;
}

export interface EscapeStats {
  schema: 1;
  request: { sizes: number[]; policies: PolicyId[]; escapes: number; maxGames: number; seed: number; censusPerMaze: number };
  stream: { label: string; base: string; firstIndex: number; disjoint: boolean };
  /** value-lsm's multiplier per size. */
  tiers: { n: number; multiplierBps: number }[];
  cells: CellResult[];
  skipped: SkippedCell[];
  exact: SizeExact[];
  comparisons: Comparison[];
  checks: Check[];
}

/**
 * Throws when the request would reuse game numbers: a cell's games must stay below the census,
 * and a census must stay below the next seed's games.
 */
export function validateRequest(request: EscapeRequest): void {
  if (request.maxGames > CENSUS_OFFSET) throw new RangeError(`maxGames must be at most ${CENSUS_OFFSET}`);
  if (request.censusPerMaze === 0) return;
  for (const n of request.sizes) {
    if (!ENUMERABLE_SIZES.includes(n)) continue;
    const draws = enumeratedGrid(n, n).count * request.censusPerMaze;
    if (draws > CENSUS_SPAN) {
      throw new RangeError(`the ${n}x${n} census would make ${draws} draws, more than the ${CENSUS_SPAN} it has before the next seed's games`);
    }
  }
}

/** The comparison of a and b from their table of paired outcomes. */
export function compare(n: number, a: PolicyId, b: PolicyId, flat: readonly number[]): Comparison {
  const table = [0, 1, 2].map((x) => [0, 1, 2].map((y) => flat[3 * x + y]));
  const games = flat.reduce((sum, count) => sum + count, 0);
  const rowA = table[OUTCOME_EXIT].reduce((sum, count) => sum + count, 0);
  const columnB = table.reduce((sum, row) => sum + row[OUTCOME_EXIT], 0);
  // Per game, D = [a exits] − [b exits] is +1, −1 or 0.
  const onlyA = rowA - table[OUTCOME_EXIT][OUTCOME_EXIT];
  const onlyB = columnB - table[OUTCOME_EXIT][OUTCOME_EXIT];
  const diff = (onlyA - onlyB) / games;
  const variance = games > 1 ? Math.max(0, ((onlyA + onlyB) / games - diff * diff) * (games / (games - 1))) : 0;
  const half = Z_975 * Math.sqrt(variance / games);
  const ci95 = { lo: diff - half, hi: diff + half };
  const exitB = columnB / games;
  const cashed = table[OUTCOME_CASH].reduce((sum, count) => sum + count, 0);
  return {
    n,
    a,
    b,
    games,
    table,
    exitA: rowA / games,
    exitB,
    diff,
    ci95,
    shown: ci95.lo > 0 || ci95.hi < 0,
    cashOut:
      cashed === 0
        ? null
        : {
            rate: cashed / games,
            bExitWhenCashed: table[OUTCOME_CASH][OUTCOME_EXIT] / cashed,
            bExitWhenCashed95: wilsonInterval(table[OUTCOME_CASH][OUTCOME_EXIT], cashed),
            proportionalLoss: (cashed / games) * exitB,
          },
  };
}

function againstExact(estimate: number, se: number, value: number, interval: Interval): AgainstExact {
  const z = se > 0 ? (estimate - value) / se : estimate === value ? 0 : Number.POSITIVE_INFINITY;
  return { value, z, agrees: Math.abs(z) <= AGREEMENT_Z, insideInterval: interval.lo <= value && value <= interval.hi };
}

export function summarizeCell(n: number, policy: PolicyId, counts: CellCounts, target: number, exact: FullExact | null): CellResult {
  const { games, exits } = counts;
  if (games === 0) throw new RangeError(`${n}x${n} ${policy}: no games were played`);
  const pHat = exits / games;
  const wilson95 = wilsonInterval(exits, games);
  let exactAverage: ExactAverage | null = null;
  if (policy === 'random-walk') {
    const mean = counts.sumP / games;
    const sd = games > 1 ? Math.sqrt(Math.max(0, (counts.sumP2 - games * mean * mean) / (games - 1))) : 0;
    const half = (Z_975 * sd) / Math.sqrt(games);
    const spread = counts.sumP - counts.sumP2;
    const z = spread > 0 ? (exits - counts.sumP) / Math.sqrt(spread) : 0;
    exactAverage = {
      mean,
      sd,
      ci95: { lo: mean - half, hi: mean + half },
      z,
      agrees: Math.abs(z) <= AGREEMENT_Z,
      insideWilson: wilson95.lo <= mean && mean <= wilson95.hi,
    };
  }
  let againstAll: CellResult['fullExact'] = null;
  if (exact !== null && policy !== 'value-lsm') {
    const value = exact.escape[policy as ExactPolicy];
    againstAll = {
      pHat: againstExact(pHat, Math.sqrt((value * (1 - value)) / games), value, wilson95),
      exactAverage: exactAverage === null ? null : againstExact(exactAverage.mean, exactAverage.sd / Math.sqrt(games), value, exactAverage.ci95),
    };
  }
  const played = games - counts.cashOuts;
  return {
    n,
    policy,
    games,
    escapes: exits,
    reachedTarget: exits >= target,
    pHat,
    wilson95,
    rates: { exit: pHat, cashOut: counts.cashOuts / games, deadEnd: counts.deadEnds / games },
    exitGivenNoCashOut: played > 0 ? exits / played : null,
    meanSteps: counts.steps / games,
    meanStepsToExit: exits > 0 ? counts.exitSteps / exits : null,
    meanCashOutStep: counts.cashOuts > 0 ? counts.cashSteps / counts.cashOuts : null,
    pathLength: summarizeHistogram(counts.pathHist)!,
    exactAverage,
    fullExact: againstAll,
    counts,
  };
}

/** Plays one cell: games in order until `request.escapes` escapes or `request.maxGames` games. */
export async function playCell(n: number, spec: PolicySpec, request: EscapeRequest, executor: EscapeExecutor): Promise<CellCounts> {
  const first = escapeFirstIndex(request.seed);
  const counts = emptyCounts(n * n);
  const window = executor.size + 1;
  const pending: Promise<GameColumns>[] = [];
  let next = 0;
  let size = FIRST_JOB_GAMES;
  try {
    for (;;) {
      while (pending.length < window && next < request.maxGames) {
        const games = Math.min(size, request.maxGames - next);
        pending.push(executor.run({ kind: 'games', n, policy: spec, first: first + next, games }) as Promise<GameColumns>);
        next += games;
        size = Math.min(size * 2, JOB_GAMES[spec.policy]);
      }
      const head = pending.shift();
      if (head === undefined) break;
      if (addGames(counts, await head, request.escapes)) break;
    }
  } finally {
    // Jobs past the stopping game are not needed; let them finish so the next cell starts on idle workers.
    await Promise.allSettled(pending);
  }
  return counts;
}

async function runCensus(n: number, draws: number, request: EscapeRequest, executor: EscapeExecutor): Promise<CensusCheck> {
  const first = escapeFirstIndex(request.seed) + CENSUS_OFFSET;
  const jobs: Promise<CensusCounts>[] = [];
  for (let at = 0; at < draws; at += CENSUS_JOB_DRAWS) {
    jobs.push(executor.run({ kind: 'census', n, first: first + at, games: Math.min(CENSUS_JOB_DRAWS, draws - at) }) as Promise<CensusCounts>);
  }
  const parts = await Promise.all(jobs);
  const counts = new Float64Array(parts[0].counts.length);
  let unknown = 0;
  for (const part of parts) {
    for (let i = 0; i < counts.length; i++) counts[i] += part.counts[i];
    unknown += part.unknown;
  }
  return censusCheck(n, counts, unknown);
}

/** Plays a and b on mazes 0 .. games − 1 and adds up their paired outcomes. */
async function playPairs(n: number, a: PolicySpec, b: PolicySpec, games: number, request: EscapeRequest, executor: EscapeExecutor): Promise<number[]> {
  const first = escapeFirstIndex(request.seed);
  const jobs: Promise<PairedCounts>[] = [];
  for (let at = 0; at < games; at += PAIRED_JOB_GAMES) {
    jobs.push(executor.run({ kind: 'paired', n, a, b, first: first + at, games: Math.min(PAIRED_JOB_GAMES, games - at) }) as Promise<PairedCounts>);
  }
  const table = new Array<number>(9).fill(0);
  for (const part of await Promise.all(jobs)) for (let i = 0; i < 9; i++) table[i] += part.table[i];
  return table;
}

const pct = (value: number, digits = 2): string => `${(value * 100).toFixed(digits)}%`;

/** Every cell of the request, the exact values of the enumerable sizes, and the self-checks. */
export async function collectEscapeStats(request: EscapeRequest, executor: EscapeExecutor, log: (line: string) => void): Promise<EscapeStats> {
  validateRequest(request);
  const stats: EscapeStats = {
    schema: 1,
    request: {
      sizes: request.sizes,
      policies: request.policies,
      escapes: request.escapes,
      maxGames: request.maxGames,
      seed: request.seed,
      censusPerMaze: request.censusPerMaze,
    },
    stream: { label: ESCAPE_STREAM_LABEL, base: escapeStreamBaseHex(), firstIndex: escapeFirstIndex(request.seed), disjoint: escapeStreamDisjoint() },
    tiers: [...request.tiers.entries()].map(([n, tier]) => ({ n, multiplierBps: tier.econ.multiplierBps })).sort((a, b) => a.n - b.n),
    cells: [],
    skipped: [],
    exact: [],
    comparisons: [],
    checks: [],
  };
  const check = (name: string, pass: boolean, detail: string): void => {
    stats.checks.push({ name, pass, detail });
    if (!pass) log(`CHECK FAILED ${name}: ${detail}`);
  };
  check('stream', stats.stream.disjoint, `${ESCAPE_STREAM_LABEL} (${stats.stream.base}) meets none of the streams A..E, human and chest`);

  for (const n of request.sizes) {
    let exact: FullExact | null = null;
    if (ENUMERABLE_SIZES.includes(n)) {
      const started = Date.now();
      const all = fullExact(n);
      const census = request.censusPerMaze > 0 ? await runCensus(n, all.mazes * request.censusPerMaze, request, executor) : null;
      const used = census === null || census.pass;
      stats.exact.push({ exact: all, census, used });
      if (census !== null) {
        check(
          `census ${n}x${n}`,
          census.pass,
          `${census.draws} draws over ${all.mazes} mazes (T_E ${all.eastMazes}, T_S ${all.southMazes}): chi-square ${census.chiSquare.toFixed(1)} on ${census.df} df, z ${census.z.toFixed(2)}, ${census.unknown} unknown`,
        );
      }
      if (used) exact = all;
      log(
        `${n}x${n}: every maze (${all.mazes}) enumerated in ${((Date.now() - started) / 1000).toFixed(1)} s${census === null ? '' : `, census z ${census.z.toFixed(2)}`}${used ? '' : ', exact values NOT used'}`,
      );
    }
    const played = new Map<PolicyId, { spec: PolicySpec; games: number }>();
    for (const policy of request.policies) {
      let spec: PolicySpec;
      if (policy === 'value-lsm') {
        const tier = request.tiers.get(n);
        if (tier === undefined) {
          stats.skipped.push({ n, policy, reason: 'no certified tier of this size: value-lsm needs its multiplier, refund curve and value table' });
          continue;
        }
        spec = { policy, econ: tier.econ, table: tier.table };
      } else {
        spec = { policy };
      }
      const started = Date.now();
      const counts = await playCell(n, spec, request, executor);
      const cell = summarizeCell(n, policy, counts, request.escapes, exact);
      stats.cells.push(cell);
      played.set(policy, { spec, games: cell.games });
      log(
        `${n}x${n} ${policy}: ${cell.escapes} escapes in ${cell.games} games, p ${pct(cell.pHat, 3)} [${pct(cell.wilson95.lo, 3)}, ${pct(cell.wilson95.hi, 3)}]${cell.reachedTarget ? '' : ' (stopped at the game cap)'} (${((Date.now() - started) / 1000).toFixed(1)} s)`,
      );
      if (cell.exactAverage !== null) {
        check(
          `random-walk ${n}x${n}: escapes vs exact probabilities`,
          cell.exactAverage.agrees,
          `${cell.escapes} escapes vs Σp ${counts.sumP.toFixed(1)} on the same ${cell.games} mazes, z ${cell.exactAverage.z.toFixed(2)} (limit ±${AGREEMENT_Z})`,
        );
      }
      if (cell.fullExact !== null) {
        check(
          `${policy} ${n}x${n}: p̂ vs exact`,
          cell.fullExact.pHat.agrees,
          `p̂ ${pct(cell.pHat, 3)} vs exact ${pct(cell.fullExact.pHat.value, 3)}, z ${cell.fullExact.pHat.z.toFixed(2)} (limit ±${AGREEMENT_Z})`,
        );
        const average = cell.fullExact.exactAverage;
        if (average !== null) {
          check(
            `${policy} ${n}x${n}: exact average vs exact`,
            average.agrees,
            `exact average ${pct(cell.exactAverage!.mean, 3)} vs exact ${pct(average.value, 3)}, z ${average.z.toFixed(2)} (limit ±${AGREEMENT_Z})`,
          );
        }
      }
    }
    for (const [a, b] of COMPARISONS) {
      const cellA = played.get(a);
      const cellB = played.get(b);
      if (cellA === undefined || cellB === undefined) continue;
      const started = Date.now();
      const comparison = compare(n, a, b, await playPairs(n, cellA.spec, cellB.spec, Math.max(cellA.games, cellB.games), request, executor));
      stats.comparisons.push(comparison);
      log(
        `${n}x${n} ${a} - ${b}: ${pct(comparison.diff, 3)} [${pct(comparison.ci95.lo, 3)}, ${pct(comparison.ci95.hi, 3)}] on ${comparison.games} paired mazes (${((Date.now() - started) / 1000).toFixed(1)} s)`,
      );
      if (exact !== null && a !== 'value-lsm' && b !== 'value-lsm') {
        const value = exact.escape[a as ExactPolicy] - exact.escape[b as ExactPolicy];
        const se = (comparison.ci95.hi - comparison.ci95.lo) / (2 * Z_975);
        const z = se > 0 ? (comparison.diff - value) / se : comparison.diff === value ? 0 : Number.POSITIVE_INFINITY;
        check(
          `${a} - ${b} ${n}x${n}: paired difference vs exact`,
          Math.abs(z) <= AGREEMENT_Z,
          `paired ${pct(comparison.diff, 3)} vs exact ${pct(value, 3)}, z ${z.toFixed(2)} (limit ±${AGREEMENT_Z})`,
        );
      }
    }
  }
  return stats;
}
