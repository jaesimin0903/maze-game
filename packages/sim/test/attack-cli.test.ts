// `sim:attack` as a process: a tiny trend run end to end, and argument checking.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simPackageRoot } from '../src/codehash';
import type { TrendResult } from '../src/attack/gap';
import { temporaryDirectory } from './helpers';

function runAttack(...flags: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(simPackageRoot(), 'src', 'cli.ts'), 'attack', '--workers', '0', ...flags], {
    cwd: simPackageRoot(),
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('sim:attack', () => {
  it('calibrates value-lsm to 96.00% on 3x3 and finds no gap to the optimum there', () => {
    const out = temporaryDirectory();
    const cache = temporaryDirectory();
    const { status, output } = runAttack('--phases', 'trend', '--trend', '3x3', '--trend-curves', 'sm', '--trend-train-games', '20000', '--out', out, '--cache', cache);
    expect(output).toContain('sim:attack RESULT exit=0');
    expect(status).toBe(0);
    expect(existsSync(join(out, 'run.json'))).toBe(true);
    const trend = JSON.parse(readFileSync(join(out, 'trend.json'), 'utf8')) as { result: TrendResult[] };
    expect(trend.result).toHaveLength(1);
    const [row] = trend.result;
    expect([row.w, row.h]).toEqual([3, 3]);
    expect(row.botRtp).toBeLessThanOrEqual(0.96);
    expect(row.botRtp).toBeGreaterThan(0.955);
    // On 3×3 value-lsm is (nearly) optimal: the exactness gate measured no gap there.
    expect(Math.abs(row.optimalRtp - row.botRtp)).toBeLessThan(0.001);
  }, 600_000);

  it('rejects unknown phases, tables and malformed pairs', () => {
    for (const flags of [
      ['--phases', 'nope'],
      ['--tables', 'other'],
      ['--pairs', '7=lots'],
      ['--trend', '5by5'],
    ]) {
      const { status, output } = runAttack(...flags);
      expect(status, flags.join(' ')).toBe(1);
      expect(output).toContain('usage:');
    }
  });
});
