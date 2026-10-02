// Rebuilds the refund tables of a tuning table from its curve parameters (plan §3.1).
//
//   pnpm tuning:build [--table <file>] [--check]
//
// Every tier's `refundBps` is recomputed from `(n, curve)`, the whole table is validated, and
// the file is written in canonical form (two-space JSON, keys in interface order, one trailing
// newline). A file that is already up to date is not touched. Without `--table` the target is
// packages/shared/src/tuning.json. `--check` writes nothing and reports whether the file is
// what a build would produce.
//
// Exit codes: 0 = up to date or rewritten, 1 = `--check` found a difference,
// 2 = bad arguments, or the file is unreadable or not a buildable table.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRefundTable, parseTuning, serializeTuning, type CurveParams } from '@maze/shared';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(code: number, message: string): never {
  console.error(`tuning:build: ${message}`);
  process.exit(code);
}

let tablePath = resolve(repoRoot, 'packages/shared/src/tuning.json');
let check = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--check') {
    check = true;
  } else if (args[i] === '--table' && args[i + 1] !== undefined) {
    tablePath = resolve(args[++i]);
  } else {
    fail(2, `unknown argument "${args[i]}". Usage: pnpm tuning:build [--table <file>] [--check]`);
  }
}
const label = relative(repoRoot, tablePath);

let current: string;
let built: string;
try {
  current = readFileSync(tablePath, 'utf8');
  const raw = JSON.parse(current) as { tiers?: unknown };
  if (!Array.isArray(raw.tiers)) throw new TypeError('the table has no "tiers" array');
  const tiers = (raw.tiers as { n: number; curve: CurveParams }[]).map((tier) => ({
    ...tier,
    refundBps: buildRefundTable({
      cells: tier.n * tier.n,
      shortestPath: 2 * (tier.n - 1),
      curve: tier.curve,
    }),
  }));
  built = serializeTuning(parseTuning({ ...raw, tiers }));
} catch (error) {
  fail(2, `cannot build ${label}: ${(error as Error).message}`);
}

if (built === current) {
  console.log(`tuning:build OK: ${label} is up to date.`);
} else if (check) {
  fail(1, `${label} differs from the table built from its curve parameters.`);
} else {
  writeFileSync(tablePath, built);
  console.log(`tuning:build: rewrote ${label}.`);
}
