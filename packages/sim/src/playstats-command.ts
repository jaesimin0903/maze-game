// The `sim:stats` command: loads what a request needs, plays the games and writes the result.
//
// It reads the certification's files (tables, trained value tables, certify.json) and never
// writes to them: nothing is trained and no cache entry is created. Output goes to its own
// directory, `.data/sim-stats/<run>/` unless `--out` names another.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tableHash } from '@maze/shared';
import { CacheStore } from './cache';
import type { CertifyFile } from './certify';
import { simCodeHash, simPackageRoot } from './codehash';
import { BOT_VARIANTS } from './exact';
import {
  collectPlayStats,
  recordInline,
  type CellTiming,
  type PlayerId,
  type PlayStats,
  type Recorder,
  type StatsTableInput,
  type ValueLsmTable,
} from './playstats';
import { formatSummary, renderReport, type RunInfo } from './playstats-report';
import { InlineExecutor, WorkerPool } from './pool';
import { byTier, type Profile } from './profile';
import { Runner, tierRef } from './runner';
import type { RngMode } from './streams';
import { readJsonFile, readMeta, readTableFile, tierEconomicsOf, writeTextFile, type ReportPaths } from './tables';
import type { Job } from './worker';

export interface StatsArguments {
  /** The table to report on and, optionally, a second one to compare it with. `label` is the path as the report shows it. */
  tables: { role: 'main' | 'compare'; file: string; label: string }[];
  tiers: number[] | null;
  players: PlayerId[];
  games: number;
  seed: number;
  sessions: number;
  bankroll: number;
  /** Output directory; null for a new directory under `.data/sim-stats/`. */
  out: string | null;
  open: boolean;
  /** The command line as typed, for the header of the report. */
  command: string;
}

export interface StatsEnvironment {
  profile: Profile;
  paths: ReportPaths;
  /** Worker threads; 0 plays every game on the calling thread. */
  workers: number;
  rngMode: RngMode;
  log: (line: string) => void;
}

async function loadTable(runner: Runner, paths: ReportPaths, source: StatsArguments['tables'][number], withValueLsm: boolean): Promise<StatsTableInput> {
  const table = readTableFile(source.file);
  const hash = tableHash(table);
  const valueLsm: (ValueLsmTable | null)[] = [];
  if (withValueLsm) {
    // The table value-lsm played with when this tuning table was certified: same variant, same training games.
    const variant = BOT_VARIANTS[readMeta(paths, hash)?.variantLevel ?? 0];
    for (let tier = 0; tier < table.tiers.length; tier++) {
      const games = byTier(runner.profile.trainGames, tier);
      const key = await runner.valueTableScratch(tierRef(tierEconomicsOf(table.tiers[tier])), variant.hyper, variant.rBins, games);
      valueLsm.push(runner.store.hasArtifact(key) ? { table: runner.loadTable(key), hyper: variant.hyper } : null);
    }
  }
  const certification = readJsonFile<CertifyFile>(paths.certifyJson)?.tables[hash] ?? null;
  return { role: source.role, path: source.label, table, valueLsm, certification };
}

const two = (value: number): string => String(value).padStart(2, '0');

function localDate(now: Date): string {
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

function localTime(now: Date): string {
  return `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
}

/** A directory under the repository's git-ignored `.data/` that does not exist yet. */
function newOutputDirectory(args: StatsArguments, now: Date): string {
  const root = resolve(simPackageRoot(), '..', '..', '.data', 'sim-stats');
  const stamp = `${localDate(now).replace(/-/g, '')}-${localTime(now).replace(/:/g, '')}`;
  const name = `${stamp}-${basename(args.tables[0].file, '.json')}-${args.games}g-seed${args.seed}`;
  let directory = join(root, name);
  for (let attempt = 2; existsSync(directory); attempt++) directory = join(root, `${name}-${attempt}`);
  return directory;
}

function openInBrowser(file: string): void {
  const [program, parameters] =
    process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : ['xdg-open', [file]];
  const child = spawn(program, parameters, { detached: true, stdio: 'ignore' });
  child.on('error', (error) => console.error(`sim:stats: could not open the report (${error.message}); open ${file} yourself`));
  child.unref();
}

/** Runs the command and returns the files it wrote. */
export async function runStats(args: StatsArguments, env: StatsEnvironment): Promise<{ stats: PlayStats; json: string; html: string }> {
  const started = Date.now();
  const codeHash = simCodeHash();
  const runner = new Runner({
    executor: new InlineExecutor(),
    store: new CacheStore(env.paths.cache),
    profile: env.profile,
    codeHash,
    rngMode: env.rngMode,
    deadline: 0,
    readOnly: true,
  });
  const tables: StatsTableInput[] = [];
  for (const source of args.tables) tables.push(await loadTable(runner, env.paths, source, args.players.includes('value-lsm')));

  // The built worker sits next to the built CLI. The pool only carries messages; its signature
  // names the simulator's own jobs, hence the casts.
  const pool = env.workers === 0 ? null : new WorkerPool(env.workers, new URL('./playstats-worker.js', import.meta.url));
  const record: Recorder = pool === null ? recordInline : (job) => pool.run(job as unknown as Job) as unknown as Promise<Uint16Array>;
  const timings: CellTiming[] = [];
  let stats: PlayStats;
  try {
    stats = await collectPlayStats(
      { tables, tiers: args.tiers, players: args.players, games: args.games, seed: args.seed, sessions: args.sessions, bankroll: args.bankroll, rngMode: env.rngMode, codeHash },
      record,
      (timing) => {
        timings.push(timing);
        env.log(`${timing.role} table ${timing.n}x${timing.n} ${timing.player}: ${timing.games} games in ${timing.seconds.toFixed(1)}s`);
      },
    );
  } finally {
    await pool?.close();
  }

  const now = new Date();
  const run: RunInfo = {
    generatedAt: `${localDate(now)} ${localTime(now)}`,
    command: args.command,
    seconds: (Date.now() - started) / 1000,
    workers: env.workers,
    timings,
  };
  const directory = args.out === null ? newOutputDirectory(args, now) : resolve(args.out);
  const json = join(directory, 'stats.json');
  const html = join(directory, 'report.html');
  writeTextFile(json, `${JSON.stringify(stats)}\n`);
  writeTextFile(html, renderReport(stats, run));
  console.log(formatSummary(stats, run));
  if (args.open) openInBrowser(html);
  return { stats, json, html };
}
