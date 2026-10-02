// `sim:exact --check` only reads, and the record a real run writes names its table by a
// repository-relative path.
//
// The command line is run as a process against a reports directory in a temporary folder.
// The exactness gate is not computed here: its per-grid results are seeded into that folder's
// cache under the keys the gate looks up, so the command finds them and does no work.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTuning, tableHash } from '@maze/shared';
import { describe, expect, it } from 'vitest';
import { cacheKey, CacheStore } from '../src/cache';
import { hashFiles, simCodeHash, simPackageRoot } from '../src/codehash';
import { BOT_VARIANTS, distinctCurves, EXACT_GRIDS, EXACT_TARGET_BPS, type GridGate } from '../src/exact';
import { SMOKE } from '../src/profile';
import { temporaryDirectory } from './helpers';

const repoRoot = resolve(simPackageRoot(), '..', '..');
const TABLE = 'packages/shared/test/fixtures/tuning.fixture.json';
const table = parseTuning(JSON.parse(readFileSync(join(repoRoot, TABLE), 'utf8')));
const hash = tableHash(table);

function runExact(reports: string, tablePath: string, ...flags: string[]): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(simPackageRoot(), 'src', 'cli.ts'), 'exact', '--profile', 'smoke', '--workers', '0', '--reports', reports, '--table', tablePath, ...flags],
    { cwd: simPackageRoot(), encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Gate results for every curve and grid of the table, stored where `exactGateGrid` looks for them. */
function seedGate(reports: string): void {
  const store = new CacheStore(join(reports, 'cache'));
  const variant = BOT_VARIANTS[0];
  const exactSource = hashFiles([join(simPackageRoot(), 'src', 'exact.ts')], simPackageRoot());
  for (const curve of distinctCurves(table)) {
    for (const [w, h] of EXACT_GRIDS) {
      const key = cacheKey('exact-gate', `${simCodeHash()}|${exactSource}`, {
        profile: SMOKE.name,
        curve,
        w,
        h,
        hyper: variant.hyper,
        rBins: variant.rBins,
        targetBps: EXACT_TARGET_BPS,
        trainGames: SMOKE.exactTrainGames,
        trainPasses: SMOKE.trainPasses,
        minSamples: SMOKE.minSamples,
      });
      const result: GridGate = {
        w,
        h,
        mazes: 1,
        curve,
        multiplierBps: 20_000,
        botRtp: 0.96,
        optimalRtp: 0.961,
        gap: 0.001,
        gapToBot: 0.001,
        optimalEast: 0.961,
        // Square grids are symmetric in the start direction; the rectangle is not.
        optimalSouth: w === h ? 0.961 : 0.95,
        trainGames: 1,
        evaluations: [],
      };
      store.writeArtifact(key, { meta: { kind: 'exact-gate', result }, arrays: {} });
    }
  }
}

/** Every file below `directory` with its size and modification time. */
function snapshot(directory: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else out.push(`${path.slice(directory.length)} ${stat.size} ${stat.mtimeMs}`);
    }
  };
  walk(directory);
  return out;
}

describe('sim:exact command line', () => {
  it('--check on an empty cache is INCOMPLETE (exit 2) and creates nothing', () => {
    const reports = join(temporaryDirectory(), 'reports');
    const run = runExact(reports, join(repoRoot, TABLE), '--check');
    expect(run.output).toMatch(/sim:exact RESULT exit=2 INCOMPLETE/);
    expect(run.status).toBe(2);
    expect(existsSync(reports)).toBe(false);
  });

  it('--check passes from the cache and writes no file; a run without it writes the record with a repository-relative table path', () => {
    const reports = join(temporaryDirectory(), 'reports');
    seedGate(reports);
    const record = join(reports, 'exact', `${hash}.json`);

    const before = snapshot(reports);
    const check = runExact(reports, join(repoRoot, TABLE), '--check');
    expect(check.output).toMatch(/sim:exact RESULT exit=0 PASS/);
    expect(check.status).toBe(0);
    expect(snapshot(reports)).toEqual(before);
    expect(existsSync(record)).toBe(false);

    const real = runExact(reports, join(repoRoot, TABLE));
    expect(real.output).toMatch(/sim:exact RESULT exit=0 PASS/);
    expect(real.status).toBe(0);
    const written = JSON.parse(readFileSync(record, 'utf8')) as { tablePath: string; tableHash: string; pass: boolean };
    expect(written.tablePath).toBe(TABLE);
    expect(written.tableHash).toBe(hash);
    expect(written.pass).toBe(true);
    expect(readFileSync(record, 'utf8')).not.toContain(repoRoot);

    // A later check, also of the same table at another path, leaves the record as it is.
    const after = snapshot(reports);
    const copy = join(temporaryDirectory(), 'copy.json');
    copyFileSync(join(repoRoot, TABLE), copy);
    expect(runExact(reports, join(repoRoot, TABLE), '--check').status).toBe(0);
    expect(runExact(reports, copy, '--check').status).toBe(0);
    expect(snapshot(reports)).toEqual(after);
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual(written);
  });
});
