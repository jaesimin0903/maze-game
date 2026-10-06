// `pnpm sim:human`: simulations of people playing the maze game, run through tsx.
//
//   pnpm sim:human [--tables <file>,<file>] [--games <n>] [--train-games <n>] [--careers <n>]
//                  [--career-games <n>] [--sessions <n>] [--behaviour-sessions <n>] [--bankroll <bets>]
//                  [--seed <n>] [--workers <n>] [--out <dir>] [--open] [--quick]
//
// Without options it reports on the production table and the house-max table with sizes that
// finish in a few minutes on three worker threads; larger numbers give tighter intervals.
// `--quick` is a small smoke run. Output goes to `.data/sim-human/<run>/` (git-ignored):
// human.json with every number, and report.html, a page that needs nothing else.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { tableHash } from '@maze/shared';
import type { CertifyFile } from '../certify';
import { simCodeHash, simPackageRoot } from '../codehash';
import { productionTablePath, readJsonFile, readTableFile, reportPaths, writeTextFile } from '../tables';
import { HumanWorkerPool, InlineHumanExecutor, type HumanExecutor } from './pool';
import { formatSummary, renderReport, type HumanRunInfo } from './report';
import { collectHumanStats, type HumanRequest, type TableInput } from './run';

const REPOSITORY = resolve(simPackageRoot(), '..', '..');
const HOUSE_MAX_TABLE = join(simPackageRoot(), 'reports', 'tuning.house-max.json');

const DEFAULTS = {
  games: 200_000,
  trainGames: 100_000,
  careers: 500,
  careerGames: 300,
  sessions: 300,
  behaviourSessions: 300,
  bankroll: 50,
  gameCap: 2_000,
  fitGames: 2_000,
  reachGames: 20_000,
  seed: 0,
  workers: 3,
};

const QUICK = { games: 5_000, trainGames: 5_000, careers: 20, careerGames: 100, sessions: 20, behaviourSessions: 20, fitGames: 300, reachGames: 2_000 };

const USAGE = `usage: pnpm sim:human [options]
  --tables <file>,<file>      tuning tables (default: the production table and packages/sim/reports/tuning.house-max.json)
  --games <n>                 evaluation games per model and size (default ${DEFAULTS.games})
  --train-games <n>           training games per rule move part and size (default ${DEFAULTS.trainGames})
  --careers <n>               learning players per size (default ${DEFAULTS.careers}), each playing
  --career-games <n>          this many games (default ${DEFAULTS.careerGames})
  --sessions <n>              bankroll sessions per model and size (default ${DEFAULTS.sessions})
  --behaviour-sessions <n>    sessions per model, table and session behaviour (default ${DEFAULTS.behaviourSessions})
  --bankroll <bets>           starting bankroll of a session (default ${DEFAULTS.bankroll})
  --seed <n>                  moves every game range to fresh mazes (default ${DEFAULTS.seed})
  --workers <n>               worker threads, 0 = this thread only (default ${DEFAULTS.workers})
  --out <dir>                 output directory (default .data/sim-human/<run>/)
  --open                      open the report in the browser
  --quick                     a small run to check that everything works`;

class UsageError extends Error {}

function parse(argv: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (!argument.startsWith('--')) throw new UsageError(`unexpected argument "${argument}"`);
    const name = argument.slice(2);
    if (name === 'open' || name === 'quick' || name === 'help') options.set(name, 'true');
    else {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`option ${argument} needs a value`);
      options.set(name, value);
    }
  }
  return options;
}

function whole(options: Map<string, string>, name: string, fallback: number, min: number): number {
  if (!options.has(name)) return fallback;
  const value = Number(options.get(name));
  if (!Number.isInteger(value) || value < min) throw new UsageError(`--${name} must be an integer of at least ${min}`);
  return value;
}

function tableLabel(file: string): string {
  if (resolve(file) === resolve(productionTablePath())) return '기본 표';
  if (resolve(file) === resolve(HOUSE_MAX_TABLE)) return '하우스 최대 표';
  return basename(file, '.json');
}

const two = (value: number): string => String(value).padStart(2, '0');

function stamp(now: Date): string {
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

function openInBrowser(file: string): void {
  const [program, parameters] =
    process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : ['xdg-open', [file]];
  const child = spawn(program, parameters, { detached: true, stdio: 'ignore' });
  child.on('error', (error) => console.error(`sim:human: could not open the report (${error.message}); open ${file} yourself`));
  child.unref();
}

async function main(argv: string[]): Promise<number> {
  const options = parse(argv);
  if (options.has('help')) {
    console.log(USAGE);
    return 0;
  }
  const quick = options.has('quick');
  const base = quick ? { ...DEFAULTS, ...QUICK } : DEFAULTS;
  const files = (options.get('tables') ?? `${productionTablePath()},${HOUSE_MAX_TABLE}`).split(',').map((file) => resolve(file));
  for (const file of files) if (!existsSync(file)) throw new UsageError(`table file not found: ${file}`);
  const certify = readJsonFile<CertifyFile>(reportPaths('production').certifyJson);
  const tables: TableInput[] = files.map((file) => {
    const table = readTableFile(file);
    return { label: tableLabel(file), path: relative(REPOSITORY, file), table, certification: certify?.tables[tableHash(table)] ?? null };
  });
  const request: HumanRequest = {
    tables,
    games: whole(options, 'games', base.games, 100),
    trainGames: whole(options, 'train-games', base.trainGames, 100),
    careers: whole(options, 'careers', base.careers, 1),
    careerGames: whole(options, 'career-games', base.careerGames, 10),
    sessions: whole(options, 'sessions', base.sessions, 2),
    behaviourSessions: whole(options, 'behaviour-sessions', base.behaviourSessions, 2),
    bankroll: whole(options, 'bankroll', base.bankroll, 1),
    gameCap: base.gameCap,
    fitGames: base.fitGames,
    reachGames: base.reachGames,
    seed: whole(options, 'seed', base.seed, 0),
    codeHash: simCodeHash(),
  };
  const workers = whole(options, 'workers', base.workers, 0);
  const executor: HumanExecutor = workers === 0 ? new InlineHumanExecutor() : new HumanWorkerPool(workers);
  const started = Date.now();
  let result;
  try {
    result = await collectHumanStats(request, executor, (line) => console.error(`sim:human: ${line}`));
  } finally {
    await executor.close();
  }
  const now = new Date();
  const run: HumanRunInfo = {
    generatedAt: `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`,
    command: ['pnpm sim:human', ...argv].join(' '),
    seconds: (Date.now() - started) / 1000,
    workers,
    timings: result.timings,
  };
  const name = `${stamp(now)}-seed${request.seed}${quick ? '-quick' : ''}`;
  let directory = options.has('out') ? resolve(options.get('out')!) : join(REPOSITORY, '.data', 'sim-human', name);
  if (!options.has('out')) for (let attempt = 2; existsSync(directory); attempt++) directory = join(REPOSITORY, '.data', 'sim-human', `${name}-${attempt}`);
  const json = join(directory, 'human.json');
  const html = join(directory, 'report.html');
  writeTextFile(json, `${JSON.stringify(result.stats)}\n`);
  writeTextFile(html, renderReport(result.stats, run));
  console.log(formatSummary(result.stats, run));
  console.log(`sim:human RESULT exit=0 json=${json} html=${html}`);
  if (options.has('open')) openInBrowser(html);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`sim:human: ${error.message}\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    }
  },
);
