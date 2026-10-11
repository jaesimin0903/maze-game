// `pnpm sim:escape`: the chance that a game reaches the exit, per maze size and per policy, run
// through tsx.
//
//   pnpm sim:escape [--sizes <n>,<n>] [--policies <id>,<id>] [--escapes <k>] [--max-games <n>]
//                   [--census <draws per maze>] [--seed <n>] [--workers <n>] [--out <dir>]
//
// Without options every policy plays 3×3, 4×4, 5×5, 7×7 and 9×9 until 1,000 escapes per cell
// (value-lsm only on the certified sizes 5, 7 and 9, with the value table its certification used,
// read from packages/sim/reports; nothing there is written). Output goes to
// `.data/sim-escape/<run>/` (git-ignored): escape.json with every number, escape.md with the
// tables. The command exits 1 when a self-check fails.

import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { certifiedTiers } from '../attack/context';
import { simPackageRoot } from '../codehash';
import type { TierEconomics } from '../engine';
import type { ValueTable } from '../lsm';
import { writeTextFile } from '../tables';
import { CENSUS_OFFSET, ESCAPE_SEED_LIMIT, POLICY_IDS, type PolicyId } from './jobs';
import { EscapeWorkerPool, InlineEscapeExecutor, type EscapeExecutor } from './pool';
import { formatSummary, renderMarkdown, type EscapeRunInfo } from './report';
import { collectEscapeStats, validateRequest, type EscapeRequest } from './run';

const REPOSITORY = resolve(simPackageRoot(), '..', '..');

const DEFAULTS = {
  sizes: [3, 4, 5, 7, 9],
  escapes: 1_000,
  maxGames: 50_000_000,
  census: 100,
  seed: 0,
  /** At most half the cores, and no more than four. */
  workers: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
};

const USAGE = `usage: pnpm sim:escape [options]
  --sizes <n>,<n>        square grid sizes (default ${DEFAULTS.sizes.join(',')})
  --policies <id>,<id>   policies (default all of ${POLICY_IDS.join(', ')}); value-lsm plays only the certified sizes
  --escapes <k>          stop a cell at its k-th escape (default ${DEFAULTS.escapes})
  --max-games <n>        … or after n games (default ${DEFAULTS.maxGames})
  --census <n>           generator draws per maze in the census of 3x3 and 4x4, 0 = none (default ${DEFAULTS.census})
  --seed <n>             moves every cell to fresh mazes, 0 .. ${ESCAPE_SEED_LIMIT - 1} (default ${DEFAULTS.seed})
  --workers <n>          worker threads, 0 = this thread only (default ${DEFAULTS.workers}: half the cores, at most 4)
  --out <dir>            output directory (default .data/sim-escape/<run>/)`;

class UsageError extends Error {}

function parse(argv: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--') continue;
    if (!argument.startsWith('--')) throw new UsageError(`unexpected argument "${argument}"`);
    const name = argument.slice(2);
    if (name === 'help') options.set(name, 'true');
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

async function main(argv: string[]): Promise<number> {
  const options = parse(argv);
  if (options.has('help')) {
    console.log(USAGE);
    return 0;
  }
  const log = (line: string): void => console.error(`sim:escape: ${line}`);
  const sizes = options.has('sizes') ? options.get('sizes')!.split(',').map(Number) : DEFAULTS.sizes;
  for (const n of sizes) if (!Number.isInteger(n) || n < 2 || n > 15) throw new UsageError(`sizes must be integers in 2 .. 15, got ${n}`);
  const policies = (options.get('policies') ?? POLICY_IDS.join(',')).split(',') as PolicyId[];
  for (const policy of policies) if (!POLICY_IDS.includes(policy)) throw new UsageError(`unknown policy "${policy}"`);

  const tiers = new Map<number, { econ: TierEconomics; table: ValueTable }>();
  if (policies.includes('value-lsm')) {
    try {
      for (const tier of await certifiedTiers('production')) tiers.set(tier.n, { econ: tier.econ, table: tier.valueTable });
    } catch (error) {
      throw new Error(
        `the value-lsm tables of the production table could not be read (${(error as Error).message}); run without value-lsm: --policies ${POLICY_IDS.filter((p) => p !== 'value-lsm').join(',')}`,
      );
    }
  }

  const request: EscapeRequest = {
    sizes,
    policies,
    escapes: whole(options, 'escapes', DEFAULTS.escapes, 1),
    maxGames: whole(options, 'max-games', DEFAULTS.maxGames, 1),
    seed: whole(options, 'seed', DEFAULTS.seed, 0),
    tiers,
    censusPerMaze: whole(options, 'census', DEFAULTS.census, 0),
  };
  if (request.seed >= ESCAPE_SEED_LIMIT) throw new UsageError(`--seed must be below ${ESCAPE_SEED_LIMIT}`);
  if (request.maxGames > CENSUS_OFFSET) throw new UsageError(`--max-games must be at most ${CENSUS_OFFSET}`);
  try {
    validateRequest(request);
  } catch (error) {
    throw new UsageError(`--census ${request.censusPerMaze}: ${(error as Error).message}`);
  }
  const workers = whole(options, 'workers', DEFAULTS.workers, 0);
  const executor: EscapeExecutor = workers === 0 ? new InlineEscapeExecutor() : new EscapeWorkerPool(workers);
  const started = Date.now();
  let stats;
  try {
    stats = await collectEscapeStats(request, executor, log);
  } finally {
    await executor.close();
  }
  const now = new Date();
  const run: EscapeRunInfo = {
    generatedAt: `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`,
    command: ['pnpm sim:escape', ...argv.filter((a) => a !== '--')].join(' '),
    seconds: (Date.now() - started) / 1000,
    workers,
  };
  const name = `${stamp(now)}-k${request.escapes}-seed${request.seed}`;
  let directory = options.has('out') ? resolve(options.get('out')!) : join(REPOSITORY, '.data', 'sim-escape', name);
  if (!options.has('out')) {
    for (let attempt = 2; existsSync(directory); attempt++) directory = join(REPOSITORY, '.data', 'sim-escape', `${name}-${attempt}`);
  }
  const json = join(directory, 'escape.json');
  const markdown = join(directory, 'escape.md');
  writeTextFile(json, `${JSON.stringify({ run, ...stats }, null, 1)}\n`);
  writeTextFile(markdown, renderMarkdown(stats, run));
  console.log(formatSummary(stats, run));
  const failed = stats.checks.some((c) => !c.pass);
  console.log(`sim:escape RESULT exit=${failed ? 1 : 0} json=${json} md=${markdown}`);
  return failed ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`sim:escape: ${error.message}\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    }
  },
);
