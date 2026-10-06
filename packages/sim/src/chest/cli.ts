// `pnpm sim:chest`: treasure chests and points in simulation, run through tsx.
//
//   pnpm sim:chest [--tables <file>,<file>] [--players <id>,<id>] [--games <n>] [--sessions <n>]
//                  [--bankroll <bets>] [--game-cap <n>] [--check-games <n>] [--bet <wei>]
//                  [--seed <n>] [--workers <n>] [--out <dir>] [--quick]
//
// Without options it reports on the production table and the house-max table for every player
// type at the tables' minimum bet, with sizes that finish in a few minutes on four worker
// threads. The strongest strategy (value-lsm) is played with the value table its certification
// used, read from packages/sim/reports (nothing there is written). Output goes to
// `.data/sim-chest/<run>/` (git-ignored): chest.json with every number, chest.md with the tables.

import { existsSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { ATTACK_TABLES, certifiedTiers, type AttackTableName } from '../attack/context';
import { simPackageRoot } from '../codehash';
import type { ValueTable } from '../lsm';
import { productionTablePath, readTableFile, writeTextFile } from '../tables';
import { ChestWorkerPool, InlineChestExecutor, type ChestExecutor } from './pool';
import { formatSummary, renderMarkdown, type ChestRunInfo } from './report';
import { collectChestStats, PLAYER_IDS, type ChestRequest, type ChestTableInput, type PlayerId } from './run';

const REPOSITORY = resolve(simPackageRoot(), '..', '..');

const DEFAULTS = {
  games: 100_000,
  sessions: 200,
  bankroll: 50,
  gameCap: 2_000,
  checkGames: 200_000,
  fitGames: 2_000,
  reachGames: 20_000,
  seed: 0,
  workers: 4,
};

const QUICK = { games: 4_000, sessions: 20, checkGames: 10_000, fitGames: 300, reachGames: 2_000 };

const USAGE = `usage: pnpm sim:chest [options]
  --tables <file>,<file>   tuning tables (default: the production table and packages/sim/reports/tuning.house-max.json)
  --players <id>,<id>      player types (default: all of ${PLAYER_IDS.join(', ')})
  --games <n>              evaluation games per table, size and player (default ${DEFAULTS.games})
  --sessions <n>           bankroll sessions per table, size and player (default ${DEFAULTS.sessions})
  --bankroll <bets>        starting bankroll of a session (default ${DEFAULTS.bankroll})
  --game-cap <n>           most games of a session (default ${DEFAULTS.gameCap})
  --check-games <n>        paired games of the money-version multiplier check per size, 0 = none (default ${DEFAULTS.checkGames})
  --bet <wei>              the bet points are counted for (default: the first table's minimum bet)
  --seed <n>               moves every game range to fresh mazes (default ${DEFAULTS.seed})
  --workers <n>            worker threads, 0 = this thread only (default ${DEFAULTS.workers})
  --out <dir>              output directory (default .data/sim-chest/<run>/)
  --quick                  a small run to check that everything works`;

class UsageError extends Error {}

function parse(argv: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (!argument.startsWith('--')) throw new UsageError(`unexpected argument "${argument}"`);
    const name = argument.slice(2);
    if (name === 'quick' || name === 'help') options.set(name, 'true');
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

const two = (value: number): string => String(value).padStart(2, '0');

function stamp(now: Date): string {
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

/** The certified table a file is, if it is one, for its value tables. */
function certifiedName(file: string): AttackTableName | null {
  for (const name of Object.keys(ATTACK_TABLES) as AttackTableName[]) {
    if (resolve(ATTACK_TABLES[name]()) === resolve(file)) return name;
  }
  return null;
}

function labelOf(file: string): string {
  if (resolve(file) === resolve(productionTablePath())) return '기본 표';
  if (resolve(file) === resolve(ATTACK_TABLES['house-max']())) return '하우스 최대 표';
  return basename(file, '.json');
}

async function valueTablesOf(file: string, log: (line: string) => void): Promise<ValueTable[] | null> {
  const name = certifiedName(file);
  if (name === null) {
    log(`${relative(REPOSITORY, file)} is not a certified table; its AI rows are skipped`);
    return null;
  }
  try {
    return (await certifiedTiers(name)).map((tier) => tier.valueTable);
  } catch (error) {
    log(`the value-lsm tables of ${name} could not be read (${(error as Error).message}); its AI rows are skipped`);
    return null;
  }
}

async function main(argv: string[]): Promise<number> {
  const options = parse(argv);
  if (options.has('help')) {
    console.log(USAGE);
    return 0;
  }
  const log = (line: string): void => console.error(`sim:chest: ${line}`);
  const quick = options.has('quick');
  const base = quick ? { ...DEFAULTS, ...QUICK } : DEFAULTS;
  const files = (options.get('tables') ?? `${productionTablePath()},${ATTACK_TABLES['house-max']()}`)
    .split(',')
    .map((file) => resolve(file));
  for (const file of files) if (!existsSync(file)) throw new UsageError(`table file not found: ${file}`);
  const players = (options.get('players') ?? PLAYER_IDS.join(',')).split(',') as PlayerId[];
  for (const player of players) if (!PLAYER_IDS.includes(player)) throw new UsageError(`unknown player "${player}"`);

  const needsValue = players.includes('value-lsm') || players.includes('value-lookahead-all');
  const tables: ChestTableInput[] = [];
  for (const file of files) {
    tables.push({
      label: labelOf(file),
      path: relative(REPOSITORY, file),
      table: readTableFile(file),
      valueTables: needsValue ? await valueTablesOf(file, log) : null,
    });
  }
  const bet = options.get('bet') ?? tables[0].table.limits.minBetWei;
  if (!/^\d+$/.test(bet)) throw new UsageError('--bet must be a decimal number of wei');

  const request: ChestRequest = {
    tables,
    players,
    games: whole(options, 'games', base.games, 100),
    sessions: whole(options, 'sessions', base.sessions, 2),
    bankrollBets: whole(options, 'bankroll', base.bankroll, 1),
    gameCap: whole(options, 'game-cap', base.gameCap, 1),
    checkGames: whole(options, 'check-games', base.checkGames, 0),
    fitGames: base.fitGames,
    reachGames: base.reachGames,
    betWei: bet,
    seed: whole(options, 'seed', base.seed, 0),
  };
  const workers = whole(options, 'workers', base.workers, 0);
  const executor: ChestExecutor = workers === 0 ? new InlineChestExecutor() : new ChestWorkerPool(workers);
  const started = Date.now();
  let stats;
  try {
    stats = await collectChestStats(request, executor, log);
  } finally {
    await executor.close();
  }
  const now = new Date();
  const run: ChestRunInfo = {
    generatedAt: `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`,
    command: ['pnpm sim:chest', ...argv].join(' '),
    seconds: (Date.now() - started) / 1000,
    workers,
  };
  const name = `${stamp(now)}-seed${request.seed}${quick ? '-quick' : ''}`;
  let directory = options.has('out') ? resolve(options.get('out')!) : join(REPOSITORY, '.data', 'sim-chest', name);
  if (!options.has('out')) {
    for (let attempt = 2; existsSync(directory); attempt++) directory = join(REPOSITORY, '.data', 'sim-chest', `${name}-${attempt}`);
  }
  const json = join(directory, 'chest.json');
  const markdown = join(directory, 'chest.md');
  writeTextFile(json, `${JSON.stringify(stats, null, 1)}\n`);
  writeTextFile(markdown, renderMarkdown(stats, run));
  console.log(formatSummary(stats, run));
  console.log(`sim:chest RESULT exit=0 json=${json} md=${markdown}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`sim:chest: ${error.message}\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    }
  },
);
