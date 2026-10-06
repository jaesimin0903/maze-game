// `sim:attack`: how far can a player that thinks as hard as we can make it push the return?
//
// Phases (each writes its own JSON file into the output directory as soon as it finishes):
//   exact   5×5 tiers of the certified tables: the exact Bayes-optimal RTP, and the exact RTP of
//           value-lsm and of expectimax(1 .. 4), all by the information-state DP.
//   trend   the exact gap beyond 5×4: value-lsm calibrated to exactly 96.00% on each grid and
//           curve, then the exact optimum at that multiplier.
//   validate on the largest trend grids, the exact value of the search players at the calibrated
//           multiplier with the calibrated table: how much of the value-lsm → optimum gap each
//           one closes where the optimum is known (uses this run's trend, or --trend-from).
//   search  paired runs of the attack players against value-lsm on the same mazes (stream D from
//           index 2^38), for every tier of the chosen tables; deterministic players on 5×5 are
//           also evaluated exactly.
//   book    the opening book (rollouts over the early information states), then a paired run of
//           book + expectimax.
//   cma     CMA-ES over param(θ) on training mazes (stream C from index 2^37), then a paired run of
//           the best θ on the evaluation mazes.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildRefundTable, type CurveParams } from '@maze/shared';
import { VALUE_LOOKAHEAD_ALL_HYPER, VALUE_LSM_HYPER } from '../bots/index';
import type { CertifyFile } from '../certify';
import { simCodeHash } from '../codehash';
import type { TierEconomics } from '../engine';
import type { ValueTable } from '../lsm';
import { tierRef } from '../runner';
import { simWorkers } from '../pool';
import { byTier, PRODUCTION } from '../profile';
import { Z_975 } from '../stats';
import { readJsonFile, reportPaths } from '../tables';
import { bookOf, bookStates, type Book, type BookOptions, type BookResult } from './book';
import { PARAM_DIM } from './bots';
import { cmaes, type CmaResult } from './cma';
import { attackDataRoot, attackRunner, certifiedTiers, readAttackTable, type AttackTableName, type CertifiedTier } from './context';
import { calibrateTrend, type TrendResult, type TrendSpec } from './gap';
import type { InfoStateResult } from './infostate';
import { emptyPaired, EVAL_FIRST, EVAL_STREAM, mergePaired, summarisePaired, TRAIN_FIRST, TRAIN_STREAM, type PairedSummary } from './paired';
import { attackBotLabel, isDeterministic, type AttackBotSpec } from './players';
import { AttackPool, InlineAttackExecutor, type AttackExecutor } from './pool';

export const PHASES = ['exact', 'trend', 'validate', 'search', 'book', 'cma'] as const;
export type Phase = (typeof PHASES)[number];

/** The curves of the certified tables, by the size class that uses them. */
export const TREND_CURVES: Record<string, { label: string; curve: CurveParams }> = {
  sm: { label: 'production S/M (e0 5%, a 73%, phi 0.5)', curve: { family: 'two-stage-geometric', e0Bps: 500, aBps: 7300, phi: 0.5 } },
  l: { label: 'production L (e0 5%, a 73%, phi 0.3)', curve: { family: 'two-stage-geometric', e0Bps: 500, aBps: 7300, phi: 0.3 } },
  hm: { label: 'house-max (e0 5%, a 90%, phi 0.3)', curve: { family: 'two-stage-geometric', e0Bps: 500, aBps: 9000, phi: 0.3 } },
};

export interface AttackArguments {
  phases: Phase[];
  tables: AttackTableName[];
  /** Board sizes (n of n×n) to attack; null = every tier of the table. */
  sizes: number[] | null;
  trendGrids: [number, number][];
  trendCurves: string[];
  trendTrainGames: number;
  /** trend.json of an earlier run, for `validate` without `trend` in the same run. */
  trendFrom: string | null;
  /** Grids of the trend that `validate` evaluates, and the deterministic players it evaluates there. */
  validateGrids: [number, number][];
  validateStrategies: string[];
  maxStates: number;
  /** Paired games per board size (`"7"` → games); `default` for sizes not listed. */
  pairs: Record<string, number>;
  /** Players of the search phase (see `strategySpec`). */
  strategies: string[];
  /** Table of the challengers in search and validate. */
  tablePolicy: TablePolicy;
  book: Omit<BookOptions, 'seed'>;
  cma: { games: number; generations: number; lambda: number; sigma0: number };
  seed: number;
  workers: number;
  out: string | null;
  /** Cache of the tables the trend phase trains; null = `.data/sim-attack/cache`. */
  cache: string | null;
  command: string;
}

export const ATTACK_DEFAULTS: AttackArguments = {
  phases: ['exact', 'trend', 'validate', 'search'],
  tables: ['production'],
  sizes: null,
  trendGrids: [[5, 5]],
  trendCurves: ['sm'],
  trendTrainGames: 1_000_000,
  trendFrom: null,
  validateGrids: [[5, 5]],
  validateStrategies: ['expectimax:1', 'expectimax:2'],
  maxStates: 80_000_000,
  pairs: { default: 20_000 },
  strategies: ['expectimax:2'],
  tablePolicy: 'lsm',
  book: { baseDepth: 2, maxK: 3, minProbability: 0.005, samples: 100_000, zOverride: 2 },
  cma: { games: 100_000, generations: 20, lambda: 10, sigma0: 1 },
  seed: 1,
  workers: simWorkers(),
  out: null,
  cache: null,
  command: 'pnpm sim:attack',
};

interface Output {
  directory: string;
  write(name: string, value: unknown): void;
}

function output(args: AttackArguments): Output {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const directory = args.out !== null ? resolve(args.out) : join(attackDataRoot(), stamp);
  mkdirSync(directory, { recursive: true });
  return {
    directory,
    write(name, value) {
      writeFileSync(join(directory, name), `${JSON.stringify(value, null, 1)}\n`);
    },
  };
}

const pct = (x: number, digits = 3): string => `${(100 * x).toFixed(digits)}%`;

function pairsFor(args: AttackArguments, n: number): number {
  return args.pairs[String(n)] ?? args.pairs.default;
}

/** The certified value-lsm cell of a tier (stream B), for the combined estimate RTP = certified + mean D. */
function certifiedValueLsm(table: AttackTableName, tierIndex: number): { rtp: number; se: number; games: number } | null {
  const { hash } = readAttackTable(table);
  const file = readJsonFile<CertifyFile>(reportPaths(PRODUCTION.name).certifyJson);
  const cell = file?.tables[hash]?.tiers[tierIndex]?.cells.find((c) => c.bot === 'value-lsm');
  return cell === undefined ? null : { rtp: cell.rtp, se: cell.se, games: cell.games };
}

export interface PairedRun {
  table: AttackTableName;
  n: number;
  challenger: string;
  summary: PairedSummary;
  /** value-lsm's certified RTP plus the paired difference, with the combined standard error. */
  combined: { rtp: number; se: number; ci: [number, number] } | null;
  /** Exact RTP of the challenger (5×5 only, deterministic players). */
  exact: number | null;
}

export async function pairedRun(pool: AttackExecutor, tier: CertifiedTier, challenger: AttackBotSpec, games: number): Promise<PairedSummary> {
  const jobs = Math.max(1, Math.min(4 * pool.size, Math.ceil(games / 500)));
  const size = Math.ceil(games / jobs);
  const parts = await Promise.all(
    Array.from({ length: jobs }, (_, j) =>
      pool.runAttack({
        kind: 'attack-pairs',
        econ: tier.econ,
        reference: { kind: 'value-lsm', table: tier.valueTable },
        challenger,
        stream: EVAL_STREAM,
        first: EVAL_FIRST,
        from: j * size,
        to: Math.min(games, (j + 1) * size),
      }),
    ),
  );
  const total = emptyPaired();
  for (const part of parts) mergePaired(total, part);
  return summarisePaired(total);
}

function combinedOf(table: AttackTableName, tierIndex: number, summary: PairedSummary): PairedRun['combined'] {
  const certified = certifiedValueLsm(table, tierIndex);
  if (certified === null) return null;
  const rtp = certified.rtp + summary.diff.mean;
  const se = Math.sqrt(certified.se ** 2 + summary.diff.se ** 2);
  return { rtp, se, ci: [rtp - Z_975 * se, rtp + Z_975 * se] };
}

/**
 * A player of the search phase by name: `expectimax:<d>`, `deep:<d>:<shallow>:<margin>` (selective
 * deepening, margin in bets) or `rollout:<base depth>`.
 */
export function strategySpec(name: string, table: ValueTable, n: number, seed: number): AttackBotSpec {
  const [kind, ...parameters] = name.split(':');
  if (kind === 'optimal' && parameters.length === 0) {
    if (n > 6) throw new Error(`strategy "optimal" is the exact DP, feasible up to 6x6 only, not ${n}x${n}`);
    return { kind: 'optimal' };
  }
  const numbers = parameters.map(Number);
  const depth = numbers[0] ?? 1;
  if (!Number.isInteger(depth) || depth < 0) throw new Error(`strategy "${name}": the depth must be a non-negative integer`);
  if (kind === 'expectimax' && numbers.length <= 1) return { kind: 'expectimax', table, depth };
  if (kind === 'deep' && numbers.length === 3 && Number.isInteger(numbers[1]) && numbers[1] < depth && numbers[2] >= 0) {
    return { kind: 'expectimax', table, depth, deepening: { shallow: numbers[1], margin: numbers[2] } };
  }
  // open:<depth>:<maxK>:<opening depth> — expectimax(depth), and expectimax(opening depth) at k <= maxK.
  if (kind === 'open' && numbers.length === 3 && Number.isInteger(numbers[1]) && numbers[1] >= 0 && Number.isInteger(numbers[2]) && numbers[2] > depth) {
    return { kind: 'expectimax', table, depth, opening: { maxK: numbers[1], depth: numbers[2] } };
  }
  if (kind === 'rollout' && numbers.length <= 1) {
    return { kind: 'rollout', table, options: { baseDepth: depth, margin: 0.02, batch: 256, maxSamples: 4096, seed } };
  }
  throw new Error(`unknown strategy "${name}" (optimal, expectimax:<d>, deep:<d>:<shallow>:<margin>, open:<d>:<maxK>:<opening depth> or rollout:<d>)`);
}

function logPaired(log: (line: string) => void, label: string, run: PairedRun): void {
  const s = run.summary;
  log(
    `${label}: ${s.games} pairs  value-lsm ${pct(s.reference.mean)}  ${run.challenger} ${pct(s.challenger.mean)} ± ${pct(s.challenger.halfWidth)}  ` +
      `D = ${pct(s.diff.mean, 4)} ± ${pct(s.diff.halfWidth, 4)}  (differs on ${pct(s.differShare, 1)} of mazes, ${s.seconds.toFixed(0)} thread-s)` +
      (run.combined !== null ? `  combined ${pct(run.combined.rtp)} [${pct(run.combined.ci[0])}, ${pct(run.combined.ci[1])}]` : '') +
      (run.exact !== null ? `  exact ${pct(run.exact, 4)}` : ''),
  );
}

async function selectedTiers(args: AttackArguments, table: AttackTableName): Promise<CertifiedTier[]> {
  const tiers = await certifiedTiers(table);
  return args.sizes === null ? tiers : tiers.filter((t) => args.sizes!.includes(t.n));
}

export interface ExactRow {
  table: AttackTableName;
  n: number;
  multiplierBps: number;
  player: string;
  result: InfoStateResult;
}

async function phaseExact(pool: AttackExecutor, args: AttackArguments, log: (line: string) => void): Promise<ExactRow[]> {
  const rows: ExactRow[] = [];
  for (const table of args.tables) {
    for (const tier of await certifiedTiers(table)) {
      if (tier.n > 5) continue;
      const players: (AttackBotSpec | null)[] = [null, { kind: 'value-lsm', table: tier.valueTable }];
      for (let depth = 1; depth <= 4; depth++) players.push({ kind: 'expectimax', table: tier.valueTable, depth });
      const results = await Promise.all(players.map((bot) => pool.runAttack({ kind: 'attack-dp', econ: tier.econ, bot, options: { maxStates: args.maxStates } })));
      results.forEach((result, i) => {
        const bot = players[i];
        const player = bot === null ? 'optimum' : attackBotLabel(bot);
        rows.push({ table, n: tier.n, multiplierBps: tier.econ.multiplierBps, player, result });
        log(`exact ${table} ${tier.n}x${tier.n} M=${tier.econ.multiplierBps}: ${player.padEnd(16)} ${pct(result.rtp, 5)}  win ${pct(result.winRate, 2)}  (${result.states} states, ${result.seconds.toFixed(1)}s)`);
      });
    }
  }
  return rows;
}

async function phaseTrend(pool: AttackExecutor, args: AttackArguments, log: (line: string) => void): Promise<TrendResult[]> {
  const runner = attackRunner(pool, log, args.cache);
  const specs: TrendSpec[] = [];
  for (const [w, h] of args.trendGrids) {
    for (const id of args.trendCurves) {
      const curve = TREND_CURVES[id];
      if (curve === undefined) throw new Error(`unknown trend curve "${id}" (sm, l, hm)`);
      specs.push({ w, h, curve: curve.curve, curveLabel: curve.label, trainGames: args.trendTrainGames, maxStates: args.maxStates });
    }
  }
  return Promise.all(specs.map((spec) => calibrateTrend(pool, runner, spec, log)));
}

/**
 * How the challenger's value table is trained: `lsm` is the certified table (policy iteration with
 * value-lsm itself); `all` retrains it, in the attack cache, by policy iteration with the
 * look-ahead-all player, whose continuation values are closer to optimal play.
 */
export const TABLE_POLICIES = { lsm: VALUE_LSM_HYPER, all: VALUE_LOOKAHEAD_ALL_HYPER } as const;
export type TablePolicy = keyof typeof TABLE_POLICIES;

function tableTag(args: AttackArguments): string {
  return args.tablePolicy === 'lsm' ? '' : ' [table: look-ahead-all policy]';
}

/** The table the challengers of a certified tier play with. The reference always plays the certified table. */
async function tableFor(pool: AttackExecutor, args: AttackArguments, log: (line: string) => void, tier: CertifiedTier): Promise<ValueTable> {
  if (args.tablePolicy === 'lsm') return tier.valueTable;
  const runner = attackRunner(pool, log, args.cache);
  const key = await runner.valueTableScratch(tierRef(tier.econ), TABLE_POLICIES[args.tablePolicy], 1, byTier(PRODUCTION.trainGames, tier.tierIndex));
  return runner.loadTable(key);
}

export interface ValidateRow {
  w: number;
  h: number;
  curveLabel: string;
  multiplierBps: number;
  botRtp: number;
  optimalRtp: number;
  player: string;
  rtp: number;
  /** Share of the value-lsm → optimum gap the player closes: (player − value-lsm) / (optimum − value-lsm). */
  closed: number;
  states: number;
  seconds: number;
}

async function phaseValidate(pool: AttackExecutor, args: AttackArguments, log: (line: string) => void, trend: TrendResult[] | null): Promise<ValidateRow[]> {
  let rows = trend;
  if (rows === null) {
    if (args.trendFrom === null) throw new Error('phase validate needs the trend phase in the same run, or --trend-from <trend.json>');
    rows = (readJsonFile<{ result: TrendResult[] }>(resolve(args.trendFrom)) ?? { result: [] }).result;
  }
  const targets = rows.filter((r) => args.validateGrids.some(([w, h]) => r.w === w && r.h === h));
  if (targets.length === 0) throw new Error('phase validate: the trend has none of the --validate grids');
  const runner = attackRunner(pool, log, args.cache);
  const jobs: Promise<ValidateRow>[] = [];
  for (const target of targets) {
    const refundBps = buildRefundTable({ cells: target.w * target.h, shortestPath: target.w + target.h - 2, curve: target.curve });
    const econ: TierEconomics = { w: target.w, h: target.h, multiplierBps: target.multiplierBps, refundBps };
    // The calibrated table (every step of the calibration is in the attack cache, so this trains
    // nothing), or one trained at the same multiplier by the look-ahead-all policy.
    const table = runner.loadTable(await runner.valueTableScratch(tierRef(econ), TABLE_POLICIES[args.tablePolicy], 1, target.trainGames));
    for (const name of args.validateStrategies) {
      const spec = strategySpec(name, table, target.w, args.seed);
      if (!isDeterministic(spec) || spec.kind === 'optimal') throw new Error(`phase validate: ${name} cannot be evaluated exactly`);
      jobs.push(
        pool.runAttack({ kind: 'attack-dp', econ, bot: spec, options: { maxStates: args.maxStates, fullKey: spec.kind === 'param' } }).then((result) => {
          const row: ValidateRow = {
            w: target.w,
            h: target.h,
            curveLabel: target.curveLabel,
            multiplierBps: target.multiplierBps,
            botRtp: target.botRtp,
            optimalRtp: target.optimalRtp,
            player: attackBotLabel(spec) + tableTag(args),
            rtp: result.rtp,
            closed: (result.rtp - target.botRtp) / (target.optimalRtp - target.botRtp),
            states: result.states,
            seconds: result.seconds,
          };
          log(
            `validate ${target.w}x${target.h} ${target.curveLabel} M=${target.multiplierBps}: ${row.player} ${pct(row.rtp, 5)} ` +
              `(value-lsm ${pct(row.botRtp, 5)}, optimum ${pct(row.optimalRtp, 5)}; closes ${pct(row.closed, 1)} of the gap; ${result.states} states, ${result.seconds.toFixed(0)}s)`,
          );
          return row;
        }),
      );
    }
  }
  return Promise.all(jobs);
}

async function phaseSearch(pool: AttackExecutor, args: AttackArguments, log: (line: string) => void): Promise<PairedRun[]> {
  const runs: PairedRun[] = [];
  for (const table of args.tables) {
    for (const tier of await selectedTiers(args, table)) {
      const challengerTable = await tableFor(pool, args, log, tier);
      for (const name of args.strategies) {
        const spec = strategySpec(name, challengerTable, tier.n, args.seed);
        const summary = await pairedRun(pool, tier, spec, pairsFor(args, tier.n));
        let exact: number | null = null;
        if (tier.n <= 5 && isDeterministic(spec)) {
          exact = (await pool.runAttack({ kind: 'attack-dp', econ: tier.econ, bot: spec, options: { maxStates: args.maxStates } })).rtp;
        }
        const label = attackBotLabel(spec) + (spec.kind === 'optimal' ? '' : tableTag(args));
        const run: PairedRun = { table, n: tier.n, challenger: label, summary, combined: combinedOf(table, tier.tierIndex, summary), exact };
        runs.push(run);
        logPaired(log, `search ${table} ${tier.n}x${tier.n}`, run);
      }
    }
  }
  return runs;
}

export interface BookRun {
  table: AttackTableName;
  n: number;
  states: number;
  overrides: number;
  samples: number;
  seconds: number;
  book: Book;
  run: PairedRun;
}

async function phaseBook(pool: AttackExecutor, args: AttackArguments, log: (line: string) => void): Promise<BookRun[]> {
  const out: BookRun[] = [];
  for (const table of args.tables) {
    for (const tier of await selectedTiers(args, table)) {
      const started = Date.now();
      const options: BookOptions = { ...args.book, seed: args.seed };
      const states = bookStates(tier.econ, options.maxK, options.minProbability);
      log(`book ${table} ${tier.n}x${tier.n}: ${states.length} states, ${options.samples} samples each, base expectimax(${options.baseDepth})`);
      const results: BookResult[] = await Promise.all(
        states.map((state) =>
          pool.runAttack({ kind: 'attack-book', econ: tier.econ, table: tier.valueTable, baseDepth: options.baseDepth, samples: options.samples, seed: options.seed, state }),
        ),
      );
      const book = bookOf(options, results);
      const seconds = (Date.now() - started) / 1000;
      const overrides = Object.keys(book.overrides).length;
      log(`book ${table} ${tier.n}x${tier.n}: ${overrides} overrides after ${seconds.toFixed(0)}s`);
      for (const s of results) {
        if (book.overrides[s.key] === undefined) continue;
        log(`  k=${s.k} p=${s.probability.toFixed(4)} base ${s.baseAction} → ${s.bestAction}: lead ${(s.lead / 100).toFixed(3)}% of the bet ± ${(s.leadSe / 100).toFixed(3)}`);
      }
      const spec: AttackBotSpec = { kind: 'book', table: tier.valueTable, book: { options, overrides: book.overrides } };
      const summary = await pairedRun(pool, tier, spec, pairsFor(args, tier.n));
      let exact: number | null = null;
      if (tier.n <= 5) exact = (await pool.runAttack({ kind: 'attack-dp', econ: tier.econ, bot: spec, options: { maxStates: args.maxStates } })).rtp;
      const run: PairedRun = { table, n: tier.n, challenger: attackBotLabel(spec), summary, combined: combinedOf(table, tier.tierIndex, summary), exact };
      logPaired(log, `book ${table} ${tier.n}x${tier.n}`, run);
      out.push({ table, n: tier.n, states: states.length, overrides, samples: states.length * options.samples, seconds, book, run });
    }
  }
  return out;
}

export interface CmaRun {
  table: AttackTableName;
  n: number;
  trainGames: number;
  result: CmaResult;
  run: PairedRun;
}

async function phaseCma(pool: AttackExecutor, args: AttackArguments, log: (line: string) => void): Promise<CmaRun[]> {
  const out: CmaRun[] = [];
  for (const table of args.tables) {
    for (const tier of await selectedTiers(args, table)) {
      const games = args.cma.games;
      const jobs = Math.max(1, 2 * pool.size);
      const size = Math.ceil(games / jobs);
      let generation = 0;
      const fitness = async (thetas: number[][]): Promise<number[]> => {
        const parts = await Promise.all(
          Array.from({ length: jobs }, (_, j) =>
            pool.runAttack({
              kind: 'attack-fitness',
              econ: tier.econ,
              table: tier.valueTable,
              thetas,
              stream: TRAIN_STREAM,
              first: TRAIN_FIRST,
              from: j * size,
              to: Math.min(games, (j + 1) * size),
            }),
          ),
        );
        const sums = new Array<number>(thetas.length).fill(0);
        let n = 0;
        for (const part of parts) {
          n += part.games;
          for (let i = 0; i < sums.length; i++) sums[i] += part.sums[i];
        }
        const means = sums.map((s) => s / n / 10_000);
        log(`cma ${table} ${tier.n}x${tier.n} generation ${generation++}: best ${pct(Math.max(...means), 4)} mean-point ${pct(means[0], 4)}`);
        return means;
      };
      const result = await cmaes(fitness, { dim: PARAM_DIM, lambda: args.cma.lambda, sigma0: args.cma.sigma0, generations: args.cma.generations, seed: args.seed });
      log(`cma ${table} ${tier.n}x${tier.n}: θ* = [${result.best.map((x) => x.toFixed(3)).join(', ')}] training ${pct(result.bestFitness, 4)} vs θ=0 ${pct(result.originFitness, 4)}`);
      const spec: AttackBotSpec = { kind: 'param', table: tier.valueTable, theta: result.best };
      const summary = await pairedRun(pool, tier, spec, pairsFor(args, tier.n));
      let exact: number | null = null;
      // The region feature is not a function of the compressed key: evaluate on whole information states.
      if (tier.n <= 5) exact = (await pool.runAttack({ kind: 'attack-dp', econ: tier.econ, bot: spec, options: { maxStates: args.maxStates, fullKey: true } })).rtp;
      const run: PairedRun = { table, n: tier.n, challenger: attackBotLabel(spec), summary, combined: combinedOf(table, tier.tierIndex, summary), exact };
      logPaired(log, `cma ${table} ${tier.n}x${tier.n}`, run);
      out.push({ table, n: tier.n, trainGames: games, result, run });
    }
  }
  return out;
}

/** Runs the requested phases. `pool` is for tests; by default the command starts its own threads. */
export async function runAttack(args: AttackArguments, log: (line: string) => void, pool?: AttackExecutor): Promise<{ directory: string; seconds: number }> {
  const started = Date.now();
  const out = output(args);
  const executor = pool ?? (args.workers === 0 ? new InlineAttackExecutor() : new AttackPool(args.workers, new URL('./attack/worker.js', import.meta.url)));
  out.write('run.json', {
    command: args.command,
    arguments: args,
    simCodeHash: simCodeHash(),
    startedAt: new Date(started).toISOString(),
    streams: { evaluation: `${EVAL_STREAM} from game index ${EVAL_FIRST}`, training: `${TRAIN_STREAM} from game index ${TRAIN_FIRST}` },
  });
  let trend: TrendResult[] | null = null;
  try {
    for (const phase of args.phases) {
      const phaseStarted = Date.now();
      log(`phase ${phase} started`);
      let result: unknown;
      if (phase === 'exact') result = await phaseExact(executor, args, log);
      else if (phase === 'trend') result = trend = await phaseTrend(executor, args, log);
      else if (phase === 'validate') result = await phaseValidate(executor, args, log, trend);
      else if (phase === 'search') result = await phaseSearch(executor, args, log);
      else if (phase === 'book') result = await phaseBook(executor, args, log);
      else result = await phaseCma(executor, args, log);
      const seconds = (Date.now() - phaseStarted) / 1000;
      out.write(`${phase}.json`, { phase, seconds, result });
      log(`phase ${phase} finished in ${seconds.toFixed(0)}s → ${join(out.directory, `${phase}.json`)}`);
    }
  } finally {
    if (pool === undefined) await executor.close();
  }
  return { directory: out.directory, seconds: (Date.now() - started) / 1000 };
}
