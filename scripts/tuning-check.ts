// Checks that a tuning table may serve games (plan AC-T7, AC-R9, AC-T11).
//
//   pnpm tuning:check                    packages/shared/src/tuning.json and the deployed contract
//   pnpm tuning:check --table <file>     that file; the comparison with a deployment is left out
//   pnpm tuning:check --port <port>      which deployments/local-<port>.json to compare with
//                                        (default 8545, the dev:up Anvil port)
//
// Every check is reported; the command fails when any of them does.
//
//   1. table        the file is a valid TuningTable: known fields only, n * n refund entries per
//                   tier that decrease strictly, a multiplier of at least 1x, phi <= 0.70
//   2. formula      every tier's refundBps is what its curve parameters produce
//   3. calibrated   calibration.calibrated is true, with certifyKey, simCodeHash and streams
//   4. certified    packages/sim/reports/certify.json holds a complete, passing production
//                   record for this table's hash that carries the same certifyKey, simCodeHash
//                   and streams, and `pnpm sim:certify --table <file> --check` exits 0. That
//                   command recomputes every gate from the cached chunks and simulates
//                   nothing: it fails when a chunk is missing or when the table or the
//                   simulator code is no longer what the cache was computed for.
//   5. deployed     (without --table) the contract named in deployments/local-<port>.json
//                   answers tableHash() with the hash of this table
//
// Exit codes: 0 = every check passed, 1 = a check failed, 2 = bad arguments.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRefundTable,
  mazeBetAbi,
  parseTuning,
  tableHash,
  type Hex,
  type TuningTable,
} from '@maze/shared';
import { createPublicClient, http } from 'viem';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTION_TABLE = resolve(repoRoot, 'packages/shared/src/tuning.json');
const CERTIFY_JSON = resolve(repoRoot, 'packages/sim/reports/certify.json');
const DEV_ANVIL_PORT = '8545';

function usage(message: string): never {
  console.error(`tuning:check: ${message}`);
  console.error('usage: pnpm tuning:check [--table <file>] [--port <port>]');
  process.exit(2);
}

let tablePath = PRODUCTION_TABLE;
let explicitTable = false;
let port = DEV_ANVIL_PORT;
const args = process.argv.slice(2).filter((arg) => arg !== '--');
for (let i = 0; i < args.length; i++) {
  const value = args[i + 1];
  if (args[i] === '--table' && value !== undefined) {
    tablePath = resolve(value);
    explicitTable = true;
    i += 1;
  } else if (args[i] === '--port' && value !== undefined && /^\d+$/.test(value)) {
    port = value;
    i += 1;
  } else {
    usage(`unknown or incomplete argument "${args[i]}"`);
  }
}
const label = relative(repoRoot, tablePath).startsWith('..') ? tablePath : relative(repoRoot, tablePath);

let failures = 0;
function report(name: string, problem: string | null): void {
  if (problem === null) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}: ${problem}`);
  }
}

function describe(error: unknown): string {
  const short = (error as { shortMessage?: unknown }).shortMessage;
  if (typeof short === 'string') return short;
  return error instanceof Error ? error.message : String(error);
}

// ----- 1. table -----

function readTable(): TuningTable | string {
  let text: string;
  try {
    text = readFileSync(tablePath, 'utf8');
  } catch (error) {
    return `cannot read ${label}: ${describe(error)}`;
  }
  try {
    return parseTuning(JSON.parse(text));
  } catch (error) {
    return describe(error);
  }
}

// ----- 2. formula -----

function formulaProblem(table: TuningTable): string | null {
  for (const tier of table.tiers) {
    let built: number[];
    try {
      built = buildRefundTable({
        cells: tier.n * tier.n,
        shortestPath: 2 * (tier.n - 1),
        curve: tier.curve,
      });
    } catch (error) {
      return `tier ${tier.id}: the curve builds no refund table: ${describe(error)}`;
    }
    const k = built.findIndex((value, index) => value !== tier.refundBps[index]);
    if (k !== -1) {
      return `tier ${tier.id}: refundBps[${k}] is ${tier.refundBps[k]}, the curve gives ${built[k]} (pnpm tuning:build --table ${label})`;
    }
  }
  return null;
}

// ----- 3. calibrated -----

function calibratedProblem(table: TuningTable): string | null {
  const c = table.calibration;
  if (table.fixture === true) return 'a fixture table is a test table, never a production table';
  if (!c.calibrated) return 'calibration.calibrated is false';
  if (c.certifyKey === null || c.simCodeHash === null || c.streams === null) {
    return 'calibration.certifyKey, simCodeHash and streams must all be set on a calibrated table';
  }
  return null;
}

// ----- 4. certified -----

interface CertifyRecord {
  certifyKey?: unknown;
  profile?: unknown;
  simCodeHash?: unknown;
  complete?: unknown;
  pass?: unknown;
}

interface CertifyFile {
  streams?: Record<string, unknown>;
  streamsDisjoint?: unknown;
  tables?: Record<string, CertifyRecord>;
}

function certifiedProblem(table: TuningTable, hash: Hex): string | null {
  const c = table.calibration;
  let file: CertifyFile;
  try {
    file = JSON.parse(readFileSync(CERTIFY_JSON, 'utf8')) as CertifyFile;
  } catch {
    return `${relative(repoRoot, CERTIFY_JSON)} is missing or unreadable (pnpm sim:certify --table ${label})`;
  }
  const record = file.tables?.[hash];
  if (record === undefined) return `certify.json has no record for tableHash ${hash}`;
  if (record.profile !== 'production') return `the certification record was made with profile "${String(record.profile)}"`;
  if (record.complete !== true) return 'the certification record does not cover every tier';
  if (record.pass !== true) return 'the certification record says a gate failed';
  if (record.certifyKey !== c.certifyKey) return 'calibration.certifyKey differs from the certification record';
  if (record.simCodeHash !== c.simCodeHash) return 'calibration.simCodeHash differs from the certification record';
  if (file.streamsDisjoint !== true) return 'certify.json does not state that the random streams are disjoint';
  for (const name of ['A', 'B', 'C', 'D'] as const) {
    if (file.streams?.[name] !== c.streams?.[name]) {
      return `calibration.streams.${name} differs from the stream certify.json was computed on`;
    }
  }

  // The cache itself: every chunk present for this table and this simulator code, gates passing.
  const run = spawnSync('pnpm', ['sim:certify', '--table', tablePath, '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) return `cannot run pnpm sim:certify: ${run.error.message}`;
  if (run.status !== 0) {
    const result = `${run.stdout}\n${run.stderr}`
      .split('\n')
      .filter((line) => /RESULT|ERROR/.test(line))
      .pop();
    const meaning = run.status === 2 ? 'the cache is incomplete for this table and code' : `exit code ${run.status}`;
    return `pnpm sim:certify --table ${label} --check: ${meaning}${result ? ` (${result.trim()})` : ''}`;
  }
  return null;
}

// ----- 5. deployed -----

async function deployedProblem(hash: Hex): Promise<string | null> {
  const file = resolve(repoRoot, `deployments/local-${port}.json`);
  const name = relative(repoRoot, file);
  if (!existsSync(file)) return `${name} does not exist (pnpm dev:up deploys the table and writes it)`;
  let deployment: { rpcUrl?: unknown; mazeBetAddress?: unknown };
  try {
    deployment = JSON.parse(readFileSync(file, 'utf8')) as typeof deployment;
  } catch (error) {
    return `cannot read ${name}: ${describe(error)}`;
  }
  const { rpcUrl, mazeBetAddress } = deployment;
  if (typeof rpcUrl !== 'string' || typeof mazeBetAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(mazeBetAddress)) {
    return `${name} has no rpcUrl or mazeBetAddress`;
  }
  let onchain: Hex;
  try {
    onchain = await createPublicClient({ transport: http(rpcUrl) }).readContract({
      address: mazeBetAddress as Hex,
      abi: mazeBetAbi,
      functionName: 'tableHash',
    });
  } catch (error) {
    return `cannot read tableHash() of ${mazeBetAddress} at ${rpcUrl}: ${describe(error)}`;
  }
  if (onchain.toLowerCase() !== hash.toLowerCase()) {
    return `the contract ${mazeBetAddress} at ${rpcUrl} has tableHash ${onchain}, the table hashes to ${hash}; redeploy (pnpm dev:down && pnpm dev:up)`;
  }
  return null;
}

// ----- run -----

console.log(`tuning:check ${label}`);
const table = readTable();
if (typeof table === 'string') {
  report('table', table);
  console.log('      the remaining checks need a valid table and were not run');
} else {
  const hash = tableHash(table);
  console.log(`      tableHash ${hash}`);
  report('table', null);
  report('formula', formulaProblem(table));
  const notCalibrated = calibratedProblem(table);
  report('calibrated', notCalibrated);
  report(
    'certified',
    notCalibrated === null ? certifiedProblem(table, hash) : 'a table that is not calibrated has no certification to check',
  );
  if (explicitTable) {
    console.log('SKIP  deployed: not compared for --table');
  } else {
    report('deployed', await deployedProblem(hash));
  }
}

if (failures > 0) {
  console.error(`tuning:check FAILED: ${failures} check(s) failed for ${label}.`);
  process.exit(1);
}
console.log(`tuning:check OK: ${label} may serve games.`);
