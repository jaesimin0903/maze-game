// Command line of the simulator.
//
//   node dist/cli.js <command> [options]
//
//   bench        [--table <file>]
//   exact        [--table <file>] [--variant 0..3]
//   calibrate    --curve <i | ii | iii | point:<tier>:<aBps>:<phi>> [--base <file>] [--sizes 5,7,10]
//                [--ceiling <bps>[,<bps>,<bps>]] [--variant 0..3] [--screen-last]
//   certify      [--table <file>] [--tiers 0,1,2] [--check]
//   tune         [--report-out <file>] [--sizes 5,7,10]
//   sensitivity
//
//   common: --profile production|smoke   --workers <n> (0 = no worker threads)
//           --rng fast|seed               --slice-minutes <m>   --reports <dir>
//
// Without `--table` every command uses packages/shared/src/tuning.json.
//
// Exit codes: 0 = finished and every gate passed
//             1 = finished and a gate failed (or the command could not run: bad arguments, an error)
//             2 = not finished: the work slice ran out, or `--check` found the cache incomplete;
//                 call the same command again
//             3 = BLOCKED (economic or run time); never a success

import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tableHash, type CurveParams, type TuningTable } from '@maze/shared';
import { ASSUMPTIONS } from './assumptions';
import { formatBench, runBench } from './bench';
import { CacheStore } from './cache';
import { calibrateCandidate, type CalibrationSpec } from './calibrate';
import { simulationBackend } from './campaign';
import { certifyTable, formatCertification, type CertifyFile } from './certify';
import { hashedFiles, simCodeHash, simPackageRoot } from './codehash';
import { BOT_VARIANTS, distinctCurves, exactGate, type ExactGateReport } from './exact';
import { InlineExecutor, simWorkers, WorkerPool, type Executor } from './pool';
import { PRODUCTION, SMOKE, type Profile } from './profile';
import { renderTuningReport } from './report';
import { Blocked, CacheMiss, Runner, SliceExpired } from './runner';
import { sensitivity } from './sensitivity';
import type { RngMode } from './streams';
import {
  CANDIDATE_NAMES,
  candidateCurves,
  DEFAULT_CEILING_BPS,
  DEFAULT_SIZES,
  productionTablePath,
  readJsonFile,
  readMeta,
  readTableFile,
  reportPaths,
  writeJsonFile,
  writeTextFile,
  type CandidateName,
  type ReportPaths,
} from './tables';
import { tune, type TuneResult } from './tune';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_INCOMPLETE = 2;
const EXIT_BLOCKED = 3;

const USAGE = `usage: cli.js <bench | exact | calibrate | certify | tune | sensitivity> [options]
  bench        [--table <file>]
  exact        [--table <file>] [--variant 0..3]
  calibrate    --curve <i|ii|iii|point:<tier>:<aBps>:<phi>> [--base <file>] [--sizes 5,7,10] [--ceiling <bps>[,..]] [--variant 0..3] [--screen-last]
  certify      [--table <file>] [--tiers 0,1,2] [--check]
  tune         [--report-out <file>] [--sizes 5,7,10]
  sensitivity
  common:      --profile production|smoke  --workers <n>  --rng fast|seed  --slice-minutes <m>  --reports <dir>
exit codes:    0 passed, 1 a gate failed or the command could not run, 2 not finished (call again), 3 BLOCKED`;

class UsageError extends Error {}

const FLAGS = new Set(['check', 'screen-last']);

function parseArguments(argv: string[]): { command: string; options: Map<string, string> } {
  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError('no command given');
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const argument = rest[i];
    if (!argument.startsWith('--')) throw new UsageError(`unexpected argument "${argument}"`);
    const equals = argument.indexOf('=');
    if (equals !== -1) {
      options.set(argument.slice(2, equals), argument.slice(equals + 1));
    } else if (FLAGS.has(argument.slice(2))) {
      options.set(argument.slice(2), 'true');
    } else {
      const value = rest[++i];
      if (value === undefined) throw new UsageError(`option ${argument} needs a value`);
      options.set(argument.slice(2), value);
    }
  }
  return { command, options };
}

function integerList(text: string, what: string): number[] {
  const values = text.split(',').map((part) => Number(part));
  if (values.some((value) => !Number.isInteger(value))) throw new UsageError(`${what} must be a comma-separated list of integers`);
  return values;
}

interface Context {
  options: Map<string, string>;
  profile: Profile;
  paths: ReportPaths;
  runner: Runner;
  log: (line: string) => void;
}

function tableOption(context: Context): { path: string; table: TuningTable } {
  const path = resolve(context.options.get('table') ?? productionTablePath());
  if (!existsSync(path)) throw new UsageError(`table file not found: ${path}`);
  return { path, table: readTableFile(path) };
}

function variantOption(context: Context, fallback: number): number {
  const raw = context.options.get('variant');
  if (raw === undefined) return fallback;
  const level = Number(raw);
  if (!Number.isInteger(level) || level < 0 || level >= BOT_VARIANTS.length) throw new UsageError('--variant must be 0, 1, 2 or 3');
  return level;
}

async function commandBench(context: Context): Promise<number> {
  const { table } = tableOption(context);
  const report = await runBench(context.runner, context.paths, table.tiers);
  console.log(formatBench(report, context.profile));
  console.log(`sim:bench RESULT exit=0 file=${context.paths.benchJson}`);
  return EXIT_OK;
}

function formatExact(report: ExactGateReport): string {
  const pct = (x: number): string => `${(100 * x).toFixed(4)}%`;
  const lines = [`sim:exact  profile=${report.profile}  bot: ${report.variant.label}`];
  for (const grid of report.grids) {
    lines.push(
      `  e0 ${grid.curve.e0Bps} a ${grid.curve.aBps} phi ${grid.curve.phi}  ${grid.w}x${grid.h} (${grid.mazes} mazes)  multiplier ${(grid.multiplierBps / 10_000).toFixed(4)}  ` +
        `value-lsm ${pct(grid.botRtp)}  optimal ${pct(grid.optimalRtp)}  gap ${pct(grid.gap)}p  (optimal − bot ${pct(grid.gapToBot)}p)`,
    );
  }
  lines.push(`  largest gap per grid: ${Object.entries(report.gaps).map(([grid, gap]) => `${grid} ${pct(gap)}p`).join(', ')}; limit 0.5000%p`);
  lines.push(
    `  start symmetry (AC-X8): square grids differ by ${report.symmetry.squareMaxDifference.toExponential(2)}, 5x4 by ${report.symmetry.rectangleMinDifference.toExponential(2)}: ${report.symmetry.pass ? 'pass' : 'FAIL'}`,
  );
  return lines.join('\n');
}

async function commandExact(context: Context): Promise<number> {
  const { path, table } = tableOption(context);
  const hash = tableHash(table);
  const level = variantOption(context, readMeta(context.paths, hash)?.variantLevel ?? 0);
  const report = await exactGate(context.runner, distinctCurves(table), BOT_VARIANTS[level]);
  writeJsonFile(join(context.paths.exact, `${hash}.json`), { tablePath: path, tableHash: hash, ...report });
  console.log(formatExact(report));
  // Branch 2 counts as applied only when the table itself carries the lowered ceiling and the raised e0.
  const branchTwoApplied =
    report.branch === 'lower-ceiling' &&
    table.calibration.ceilingBps <= report.ceilingBps &&
    table.tiers.every((tier) => tier.curve.e0Bps >= report.e0Bps);
  let code = EXIT_FAIL;
  let verdict: string;
  if (!report.symmetry.pass) {
    verdict = 'FAIL: start-direction symmetry (AC-X8)';
  } else if (report.pass) {
    code = EXIT_OK;
    verdict = 'PASS';
  } else if (branchTwoApplied) {
    code = EXIT_OK;
    verdict = `PASS by failure branch 2: the table is calibrated to ceilingBps ${table.calibration.ceilingBps} <= ${report.ceilingBps} with e0 >= ${report.e0Bps} bps`;
  } else if (report.branch === 'improve-bot') {
    verdict = `FAIL: failure branch 1, try the next bot improvement (--variant ${level + 1})`;
  } else if (report.branch === 'lower-ceiling') {
    verdict = `FAIL: failure branch 2 applies: calibrate to ceilingBps ${report.ceilingBps} with e0Bps ${report.e0Bps}`;
  } else {
    code = EXIT_BLOCKED;
    verdict = 'BLOCKED(economic): failure branch 3, the gap exceeds 2.0 points or grows from 4x4 to 5x4';
  }
  console.log(`sim:exact RESULT exit=${code} ${verdict}`);
  return code;
}

function calibrationSpec(context: Context): CalibrationSpec {
  const curve = context.options.get('curve');
  if (curve === undefined) throw new UsageError('calibrate needs --curve <i | ii | iii | point:<tier>:<aBps>:<phi>>');
  const screenLast = context.options.has('screen-last');
  const ceilingFor = (count: number, fallback: number[]): number[] => {
    const raw = context.options.get('ceiling');
    if (raw === undefined) return fallback;
    const values = integerList(raw, '--ceiling');
    if (values.length === 1) return new Array<number>(count).fill(values[0]);
    if (values.length !== count) throw new UsageError(`--ceiling needs 1 or ${count} values`);
    return values;
  };
  if ((CANDIDATE_NAMES as readonly string[]).includes(curve)) {
    const sizes = context.options.has('sizes') ? integerList(context.options.get('sizes')!, '--sizes') : DEFAULT_SIZES;
    const curves = candidateCurves(curve as CandidateName);
    if (sizes.length !== curves.length) throw new UsageError(`--sizes needs ${curves.length} values`);
    return {
      name: curve,
      sizes,
      curves,
      ceilingsBps: ceilingFor(sizes.length, sizes.map(() => DEFAULT_CEILING_BPS)),
      variantLevel: variantOption(context, 0),
      screenLast,
    };
  }
  const match = /^point:(\d+):(\d+):(0?\.\d+)$/.exec(curve);
  if (match === null) throw new UsageError(`--curve "${curve}" is not i, ii, iii or point:<tier>:<aBps>:<phi>`);
  const basePath = resolve(context.options.get('base') ?? context.paths.candidateTable);
  if (!existsSync(basePath)) throw new UsageError(`base table not found: ${basePath} (give --base <file>)`);
  const base = readTableFile(basePath);
  const meta = readMeta(context.paths, tableHash(base));
  const tier = Number(match[1]);
  if (tier >= base.tiers.length) throw new UsageError(`the base table has no tier ${tier}`);
  const curves: CurveParams[] = base.tiers.map((entry, i) => (i === tier ? { ...entry.curve, aBps: Number(match[2]), phi: Number(match[3]) } : entry.curve));
  return {
    name: `point-${tier}-${match[2]}-${Math.round(Number(match[3]) * 100)}`,
    sizes: base.tiers.map((entry) => entry.n),
    curves,
    ceilingsBps: ceilingFor(base.tiers.length, meta?.tiers.map((entry) => entry.ceilingBps) ?? base.tiers.map(() => base.calibration.ceilingBps)),
    variantLevel: variantOption(context, meta?.variantLevel ?? 0),
    screenLast,
  };
}

async function commandCalibrate(context: Context): Promise<number> {
  const calibration = await calibrateCandidate(context.runner, context.paths, calibrationSpec(context));
  for (const tier of calibration.meta.tiers) {
    const last = tier.evaluations[tier.evaluations.length - 1];
    console.log(
      `tier ${tier.tier}: ${tier.n}x${tier.n}  multiplier ${(tier.multiplierBps / 10_000).toFixed(4)}  N=${tier.games}  ceiling ${tier.ceilingBps} bps  ` +
        (tier.screened
          ? `screened on the first ${tier.coarseGames} games of stream A (point estimate only; no gate judged, not deployable)`
          : `U=${(100 * last.u).toFixed(3)}% (${last.best}) after ${tier.evaluations.length} full evaluation(s)${tier.windowMissed ? '  window missed' : ''}`),
    );
  }
  console.log(`sim:calibrate RESULT exit=0 table=${calibration.tablePath} calibrated=${calibration.table.calibration.calibrated} tableHash=${calibration.meta.tableHash}`);
  return EXIT_OK;
}

async function commandCertify(context: Context): Promise<number> {
  const { path, table } = tableOption(context);
  const meta = readMeta(context.paths, tableHash(table));
  const tiers = context.options.has('tiers') ? integerList(context.options.get('tiers')!, '--tiers') : undefined;
  if (tiers?.some((tier) => tier < 0 || tier >= table.tiers.length)) throw new UsageError('--tiers names a tier the table does not have');
  const certification = await certifyTable(context.runner, context.paths, path, table, meta, tiers);
  console.log(formatCertification(certification));
  const code = certification.pass ? EXIT_OK : EXIT_FAIL;
  console.log(
    `sim:certify RESULT exit=${code} pass=${certification.pass} complete=${certification.complete} newUnits=${context.runner.newUnits} file=${context.paths.certifyJson}`,
  );
  return code;
}

function certificationOf(context: Context, hash: string | null): CertifyFile['tables'][string] | null {
  if (hash === null) return null;
  return readJsonFile<CertifyFile>(context.paths.certifyJson)?.tables[hash] ?? null;
}

function reportPath(context: Context): string {
  return context.options.get('report-out') ? resolve(context.options.get('report-out')!) : context.paths.tuningReport;
}

function writeReport(context: Context, result: TuneResult, secondsThisCall: number): void {
  const analysis = result.candidates.length > 0 ? sensitivity(result) : null;
  if (analysis !== null) writeJsonFile(context.paths.sensitivityJson, analysis);
  const repoRoot = resolve(simPackageRoot(), '..', '..');
  const shown = (path: string): string => (path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path);
  const times = context.runner.store.campaignTimes();
  const text = renderTuningReport({
    result,
    sensitivity: analysis,
    finalCertification: certificationOf(context, result.final?.tableHash ?? null),
    houseMaxCertification: certificationOf(context, result.houseMax?.run?.tableHash ?? null),
    candidateTablePath: shown(context.paths.candidateTable),
    houseMaxTablePath: shown(context.paths.houseMaxTable),
    games: context.runner.store.gamesByKind(),
    // The ledger gets this call's seconds when the command ends; add them here.
    stageSeconds: { ...times, tune: (times.tune ?? 0) + secondsThisCall },
    trainPasses: context.profile.trainPasses,
  });
  writeTextFile(reportPath(context), text);
}

async function commandTune(context: Context): Promise<number> {
  const { runner, paths, profile } = context;
  const started = Date.now();
  const spent = runner.store.campaignSeconds('tune');
  if (spent > profile.campaignHours * 3600) {
    // Plan §8.2: over the run-time budget the partial results are reported and the run is BLOCKED(economic).
    const partial = readJsonFile<TuneResult>(paths.tuneJson);
    const message = `the tuning campaign has run for ${(spent / 3600).toFixed(1)} hours, over its ${profile.campaignHours} hour budget; game counts are not reduced`;
    if (partial !== null) {
      const blocked: TuneResult = { ...partial, outcome: 'blocked', blocked: { kind: 'economic', message } };
      writeJsonFile(paths.tuneJson, blocked);
      writeReport(context, blocked, 0);
    }
    console.log(`tune RESULT exit=${EXIT_BLOCKED} BLOCKED(economic): ${message}`);
    return EXIT_BLOCKED;
  }
  try {
    const backend = simulationBackend(runner, paths, context.log);
    const sizes = context.options.has('sizes') ? integerList(context.options.get('sizes')!, '--sizes') : DEFAULT_SIZES;
    if (sizes.length !== DEFAULT_SIZES.length) throw new UsageError(`--sizes needs ${DEFAULT_SIZES.length} values`);
    const result = await tune(backend, {
      candidates: CANDIDATE_NAMES.map((name) => ({ name, curves: candidateCurves(name) })),
      sizes,
      assumptions: ASSUMPTIONS,
    });
    writeJsonFile(paths.tuneJson, result);
    writeReport(context, result, (Date.now() - started) / 1000);
    if (result.blocked !== null) {
      console.log(`tune RESULT exit=${EXIT_BLOCKED} BLOCKED(${result.blocked.kind}): ${result.blocked.message}`);
      return EXIT_BLOCKED;
    }
    console.log(
      `tune RESULT exit=0 outcome=${result.outcome} table=${paths.candidateTable} final=${result.final?.name} ` +
        `houseMax=${result.houseMax?.same === false ? paths.houseMaxTable : 'same as the selected table'} report=${reportPath(context)}`,
    );
    return EXIT_OK;
  } finally {
    runner.store.addCampaignSeconds('tune', (Date.now() - started) / 1000);
  }
}

function commandSensitivity(context: Context): number {
  const result = readJsonFile<TuneResult>(context.paths.tuneJson);
  if (result === null || result.candidates.length === 0) {
    console.error(`sim:sensitivity: ${context.paths.tuneJson} has no compared candidates; run tune first`);
    return EXIT_FAIL;
  }
  const analysis = sensitivity(result);
  writeJsonFile(context.paths.sensitivityJson, analysis);
  console.log(`sim:sensitivity  ASSUMPTIONS varied one at a time; base selection: ${analysis.baseSelected}`);
  for (const row of analysis.rows) {
    console.log(
      `  ${row.scenario.padEnd(44)} selected ${String(row.selected).padEnd(12)} H ${row.selectedH === null ? '-' : (100 * row.selectedH).toFixed(3)}%` +
        `${row.changesSelection ? '  (selection changes)' : ''}${row.assumptionRangeMet ? '' : '  (assumption range not met)'}`,
    );
  }
  console.log(`sim:sensitivity RESULT exit=0 file=${context.paths.sensitivityJson}`);
  return EXIT_OK;
}

/**
 * The code hash is computed from the sources, but what runs is the bundle. A bundle older than
 * a hashed source file would compute with old code under the new hash, so it is refused. The
 * pnpm scripts rebuild before every run.
 */
function assertFreshBuild(): void {
  const bundle = fileURLToPath(import.meta.url);
  if (basename(bundle) !== 'cli.js' || basename(dirname(bundle)) !== 'dist') return;
  const built = Math.min(statSync(bundle).mtimeMs, statSync(join(dirname(bundle), 'worker.js')).mtimeMs);
  for (const file of hashedFiles(simPackageRoot())) {
    if (statSync(file).mtimeMs > built) {
      throw new UsageError(`the build in dist/ is older than ${file}; run the command through its pnpm script, which rebuilds first`);
    }
  }
}

async function main(argv: string[]): Promise<number> {
  let executor: Executor | null = null;
  let label = 'sim';
  try {
    const { command, options } = parseArguments(argv);
    label = command === 'tune' ? 'tune' : `sim:${command}`;
    const profileName = options.get('profile') ?? 'production';
    if (profileName !== 'production' && profileName !== 'smoke') throw new UsageError('--profile must be production or smoke');
    const profile = profileName === 'smoke' ? SMOKE : PRODUCTION;
    const rngMode = (options.get('rng') ?? 'fast') as RngMode;
    if (rngMode !== 'fast' && rngMode !== 'seed') throw new UsageError('--rng must be fast or seed');
    const sliceMinutes = Number(options.get('slice-minutes') ?? profile.sliceMinutes);
    if (!(sliceMinutes >= 0)) throw new UsageError('--slice-minutes must be a non-negative number');
    const workers = options.has('workers') ? Number(options.get('workers')) : simWorkers();
    if (!Number.isInteger(workers) || workers < 0) throw new UsageError('--workers must be a non-negative integer');
    const paths = reportPaths(profile.name, options.get('reports') ? resolve(options.get('reports')!) : undefined);
    const log = (line: string): void => console.error(`[${new Date().toISOString()}] ${line}`);

    if (command === 'sensitivity') {
      const runner = new Runner({ executor: new InlineExecutor(), store: new CacheStore(paths.cache), profile, codeHash: simCodeHash(), rngMode, deadline: 0, readOnly: true });
      return commandSensitivity({ options, profile, paths, runner, log });
    }
    const commands: Record<string, (context: Context) => Promise<number>> = {
      bench: commandBench,
      exact: commandExact,
      calibrate: commandCalibrate,
      certify: commandCertify,
      tune: commandTune,
    };
    const run = commands[command];
    if (run === undefined) throw new UsageError(`unknown command "${command}"`);
    assertFreshBuild();

    const readOnly = options.has('check');
    // The built worker sits next to the built CLI.
    executor = workers === 0 || readOnly ? new InlineExecutor() : new WorkerPool(workers, new URL('./worker.js', import.meta.url));
    const runner = new Runner({
      executor,
      store: new CacheStore(paths.cache),
      profile,
      codeHash: simCodeHash(),
      rngMode,
      deadline: Date.now() + sliceMinutes * 60_000,
      readOnly,
      log,
    });
    try {
      return await run({ options, profile, paths, runner, log });
    } catch (error) {
      if (error instanceof SliceExpired) {
        console.log(`${label} RESULT exit=${EXIT_INCOMPLETE} INCOMPLETE: the ${sliceMinutes} minute work slice is used up; newUnits=${runner.newUnits}; call the command again`);
        return EXIT_INCOMPLETE;
      }
      if (error instanceof CacheMiss) {
        console.log(`${label} RESULT exit=${EXIT_INCOMPLETE} INCOMPLETE: ${error.message}; the cache does not hold a complete result for this table and code`);
        return EXIT_INCOMPLETE;
      }
      if (error instanceof Blocked) {
        console.log(`${label} RESULT exit=${EXIT_BLOCKED} BLOCKED(${error.kind}): ${error.message}`);
        return EXIT_BLOCKED;
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${label}: ${error.message}\n${USAGE}`);
    } else {
      console.error(`${label}: ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    return EXIT_FAIL;
  } finally {
    if (executor !== null) await executor.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
