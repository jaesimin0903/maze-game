// Makes a calibrated tuning table the production table (plan §8.5 step 5.1, §9.3).
//
//   pnpm tuning:apply <file> [--dry-run]
//
// The file is copied to packages/shared/src/tuning.json byte for byte, so its `tableHash` and
// the certification cache keyed by that hash stay valid. This command is the only writer of
// tuning.json. `--dry-run` checks the file and writes nothing.
//
// A file is refused unless it
//   - is a complete, valid TuningTable (`parseTuning`: known fields only, strictly decreasing
//     refund tables, phi <= 0.70);
//   - is exactly what `pnpm tuning:build --table <file>` produces from its curve parameters
//     (refund tables match the formula, canonical formatting);
//   - is not a fixture table;
//   - is calibrated: `calibration.calibrated` is true and certifyKey, simCodeHash and streams
//     are set.
// Whether the certification behind it is valid is the business of `pnpm tuning:check`, which
// must be run afterwards together with a redeployment: a new table means a new contract.
//
// Exit codes: 0 = applied, already applied, or the dry run found nothing wrong,
// 1 = the file was refused or could not be written, 2 = bad arguments.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildRefundTable,
  parseTuning,
  serializeTuning,
  tableHash,
  type Hex,
  type TuningTable,
} from '@maze/shared';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCTION_TABLE = resolve(repoRoot, 'packages/shared/src/tuning.json');

export class Refused extends Error {}

/** The table in `bytes`, or `Refused` with the reason it may not become the production table. */
export function checkCandidate(bytes: Buffer): TuningTable {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Refused('the file is not valid UTF-8');
  let table: TuningTable;
  let built: string;
  try {
    const raw = JSON.parse(text) as unknown;
    table = parseTuning(raw);
    const tiers = table.tiers.map((tier) => ({
      ...tier,
      refundBps: buildRefundTable({
        cells: tier.n * tier.n,
        shortestPath: 2 * (tier.n - 1),
        curve: tier.curve,
      }),
    }));
    built = serializeTuning({ ...table, tiers });
  } catch (error) {
    throw new Refused(`not a valid tuning table: ${(error as Error).message}`);
  }
  if (built !== text) {
    throw new Refused(
      'the file is not what its curve parameters build (refund tables or formatting differ); run "pnpm tuning:build --table <file>" on it',
    );
  }
  if (table.fixture === true) throw new Refused('a fixture table is a test table and cannot become the production table');
  const c = table.calibration;
  if (!c.calibrated) throw new Refused('calibration.calibrated is false: only a calibrated table is applied');
  if (c.certifyKey === null || c.simCodeHash === null || c.streams === null) {
    throw new Refused('calibration.certifyKey, simCodeHash and streams must all be set');
  }
  return table;
}

export interface ApplyResult {
  tableHash: Hex;
  bytes: number;
  /** False when the target already held exactly these bytes, or on a dry run. */
  written: boolean;
}

/** Copies `sourcePath` over `targetPath` unchanged, after `checkCandidate` accepted it. */
export function applyTuning(sourcePath: string, targetPath: string, dryRun = false): ApplyResult {
  let bytes: Buffer;
  try {
    bytes = readFileSync(sourcePath);
  } catch (error) {
    throw new Refused(`cannot read the file: ${(error as Error).message}`);
  }
  const table = checkCandidate(bytes);
  const result = { tableHash: tableHash(table), bytes: bytes.length };

  let current: Buffer | null = null;
  try {
    current = readFileSync(targetPath);
  } catch {
    // No target yet: it is created below.
  }
  if (dryRun || current?.equals(bytes) === true) return { ...result, written: false };

  // Written under a temporary name first, so an interrupted run leaves the old table intact.
  const temporary = `${targetPath}.tmp-${process.pid}`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, targetPath);
  if (!readFileSync(targetPath).equals(bytes)) {
    throw new Error(`${targetPath} does not hold the bytes that were written`);
  }
  return { ...result, written: true };
}

function main(): void {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const dryRun = args.includes('--dry-run');
  const files = args.filter((arg) => arg !== '--dry-run');
  if (files.length !== 1 || files[0].startsWith('--')) {
    console.error('usage: pnpm tuning:apply <file> [--dry-run]');
    process.exit(2);
  }
  const sourcePath = resolve(files[0]);
  const source = relative(repoRoot, sourcePath).startsWith('..') ? sourcePath : relative(repoRoot, sourcePath);
  const target = relative(repoRoot, PRODUCTION_TABLE);

  let result: ApplyResult;
  try {
    result = applyTuning(sourcePath, PRODUCTION_TABLE, dryRun);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`tuning:apply ${error instanceof Refused ? 'REFUSED' : 'FAILED'}: ${source}: ${reason}`);
    process.exit(1);
  }
  if (dryRun) {
    console.log(`tuning:apply dry run OK: ${source} (${result.bytes} bytes, tableHash ${result.tableHash}) would replace ${target}.`);
    return;
  }
  console.log(
    result.written
      ? `tuning:apply: copied ${source} to ${target} (${result.bytes} bytes, tableHash ${result.tableHash}).`
      : `tuning:apply: ${target} already holds ${source} (tableHash ${result.tableHash}); nothing written.`,
  );
  console.log('Next: pnpm dev:down && pnpm dev:up (a new table means a new contract), then pnpm tuning:check.');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
