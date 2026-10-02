import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  buildRefundTable,
  constructorArgs,
  encodeTierInits,
  loadTuning,
  mazeBetAbi,
  parseTuning,
  serializeTuning,
  tableHash,
  type Hex,
  type TuningTable,
} from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const productionPath = resolve(here, '../src/tuning.json');
const fixturePath = resolve(here, 'fixtures/tuning.fixture.json');
const fixtureText = readFileSync(fixturePath, 'utf8');
const fixture = parseTuning(JSON.parse(fixtureText));

/** Runs the real `pnpm tuning:build` implementation. */
function runBuild(args: string[]): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve(repoRoot, 'scripts/tuning-build.ts'), ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** A copy of the fixture that is loose on purpose: the tests build malformed tables from it. */
type Draft = any;
function mutated(change: (draft: Draft) => void): unknown {
  const draft: Draft = JSON.parse(fixtureText);
  change(draft);
  return draft;
}

function withTempTable(text: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'maze-tuning-'));
  try {
    const path = join(dir, 'table.json');
    writeFileSync(path, text);
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, inner]) => [key, reversedKeys(inner)]),
    );
  }
  return value;
}

describe('loadTuning', () => {
  it('returns the production table, validated', () => {
    expect(loadTuning()).toEqual(JSON.parse(readFileSync(productionPath, 'utf8')));
    expect(loadTuning().fixture).toBeUndefined();
  });

  it('returns a fresh copy on every call', () => {
    const first = loadTuning();
    first.tiers[0].refundBps[0] = 1;
    first.tiers[0].multiplierBps = 1;
    expect(loadTuning().tiers[0].refundBps[0]).not.toBe(1);
    expect(loadTuning().tiers[0].multiplierBps).not.toBe(1);
  });
});

describe.each([
  ['src/tuning.json', productionPath],
  ['test/fixtures/tuning.fixture.json', fixturePath],
])('%s', (_label, path) => {
  const text = readFileSync(path, 'utf8');
  const table = parseTuning(JSON.parse(text));

  it('is in canonical form: serializeTuning reproduces the file byte for byte', () => {
    expect(serializeTuning(table)).toBe(text);
  });

  it('tuning:build reproduces the file byte for byte from (n, curve)', () => {
    const rebuilt: TuningTable = {
      ...table,
      tiers: table.tiers.map((tier) => ({
        ...tier,
        refundBps: buildRefundTable({
          cells: tier.n * tier.n,
          shortestPath: 2 * (tier.n - 1),
          curve: tier.curve,
        }),
      })),
    };
    rebuilt.tiers.forEach((tier, index) => expect(tier.refundBps).toEqual(table.tiers[index].refundBps));
    expect(serializeTuning(rebuilt)).toBe(text);
  });

  it('the tuning:build script accepts the file unchanged', () => {
    const result = runBuild(['--check', '--table', path]);
    expect(result.output).toMatch(/up to date/);
    expect(result.status).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('AC-R9 every tier is strictly decreasing with n² entries, phi <= 0.70 and a multiplier of at least 1×', () => {
    for (const tier of table.tiers) {
      expect(tier.refundBps).toHaveLength(tier.n * tier.n);
      for (let k = 1; k < tier.refundBps.length; k++) {
        expect(tier.refundBps[k]).toBeLessThan(tier.refundBps[k - 1]);
      }
      expect(tier.refundBps[0]).toBeLessThan(10000);
      expect(tier.curve.phi).toBeLessThanOrEqual(0.7);
      expect(tier.multiplierBps).toBeGreaterThanOrEqual(10000);
    }
  });
});

describe('tuning:build script', () => {
  it('reports a stale table with --check and rewrites it without', () => {
    const stale = mutated((draft) => {
      draft.tiers[1].refundBps[3] -= 1;
    });
    // Different formatting and key order as well: the build writes the canonical form.
    withTempTable(JSON.stringify(reversedKeys(stale)), (path) => {
      const before = readFileSync(path, 'utf8');
      const check = runBuild(['--check', '--table', path]);
      expect(check.status).toBe(1);
      expect(readFileSync(path, 'utf8')).toBe(before);

      const build = runBuild(['--table', path]);
      expect(build.status).toBe(0);
      expect(readFileSync(path, 'utf8')).toBe(fixtureText);

      expect(runBuild(['--check', '--table', path]).status).toBe(0);
    });
  });

  it('AC-R9 refuses a table that cannot be built and leaves the file alone', () => {
    const cases: [RegExp, (draft: Draft) => void][] = [
      [/phi/, (draft) => (draft.tiers[0].curve.phi = 0.75)],
      [/phi/, (draft) => (draft.tiers[2].curve.phi = 0.25)],
      [/aBps/, (draft) => (draft.tiers[0].curve.aBps = 9500)],
      [/multiplierBps/, (draft) => (draft.tiers[0].multiplierBps = 9999)],
    ];
    for (const [message, change] of cases) {
      const text = JSON.stringify(mutated(change));
      withTempTable(text, (path) => {
        const result = runBuild(['--table', path]);
        expect(result.status).toBe(2);
        expect(result.output).toMatch(message);
        expect(readFileSync(path, 'utf8')).toBe(text);
      });
    }
  });

  it('exits 2 on bad arguments or an unreadable file', () => {
    expect(runBuild(['--nope']).status).toBe(2);
    expect(runBuild(['--table']).status).toBe(2);
    expect(runBuild(['--check', '--table', join(tmpdir(), 'maze-no-such-table.json')]).status).toBe(2);
  });
});

describe('parseTuning', () => {
  it('returns a deep copy with the keys in interface order, whatever the input order', () => {
    const parsed = parseTuning(reversedKeys(JSON.parse(fixtureText)));
    expect(parsed).toEqual(fixture);
    expect(JSON.stringify(parsed, null, 2) + '\n').toBe(fixtureText);

    const source = JSON.parse(fixtureText) as TuningTable;
    const copy = parseTuning(source);
    copy.tiers[0].refundBps[5] = 0;
    copy.calibration.calibrated = true;
    expect(source.tiers[0].refundBps[5]).toBe(5161);
    expect(source.calibration.calibrated).toBe(false);
  });

  it('accepts a calibrated table with its stream identifiers', () => {
    const calibrated = mutated((draft) => {
      delete draft.fixture;
      draft.calibration = {
        calibrated: true,
        ceilingBps: 9550,
        gate1Bps: 9650,
        gate2Bps: 9900,
        certifyKey: 'key',
        simCodeHash: 'hash',
        streams: { A: 'a', B: 'b', C: 'c', D: 'd' },
      };
    });
    const parsed = parseTuning(calibrated);
    expect(parsed.calibration.streams).toEqual({ A: 'a', B: 'b', C: 'c', D: 'd' });
    expect('fixture' in parsed).toBe(false);
    expect(parseTuning(JSON.parse(serializeTuning(parsed)))).toEqual(parsed);
  });

  it.each<[string, RegExp, (draft: Draft) => void]>([
    ['AC-R9 two equal neighbours in a refund table', /strictly decreasing/, (d) => (d.tiers[0].refundBps[4] = d.tiers[0].refundBps[3])],
    ['AC-R9 a refund table that goes up', /strictly decreasing/, (d) => (d.tiers[2].refundBps[99] = 200)],
    ['AC-R9 phi above 0.70', /tiers\[1\]\.curve.*phi/, (d) => (d.tiers[1].curve.phi = 0.71)],
    ['phi below 0.30', /phi/, (d) => (d.tiers[1].curve.phi = 0.29)],
    ['aBps not below 10000 - e0Bps', /aBps/, (d) => (d.tiers[0].curve.aBps = 9500)],
    ['an unknown curve family', /family/, (d) => (d.tiers[0].curve.family = 'linear')],
    ['a refund table shorter than n²', /n \* n = 25/, (d) => d.tiers[0].refundBps.pop()],
    ['a refund table longer than n²', /n \* n = 49/, (d) => d.tiers[1].refundBps.push(1)],
    ['refundBps[0] of 10000', /refundBps\[0\]/, (d) => (d.tiers[0].refundBps[0] = 10000)],
    ['a fractional refund entry', /refundBps\[2\]/, (d) => (d.tiers[0].refundBps[2] = 6694.5)],
    ['a negative refund entry', /refundBps\[24\]/, (d) => (d.tiers[0].refundBps[24] = -1)],
    ['a refund entry that is not uint16', /refundBps\[0\]/, (d) => (d.tiers[0].refundBps[0] = 70000)],
    ['a multiplier below 1×', /multiplierBps/, (d) => (d.tiers[0].multiplierBps = 9999)],
    ['a tier id that is not its position', /tiers\[1\]\.id/, (d) => (d.tiers[1].id = 2)],
    ['a size of 1', /tiers\[0\]\.n/, (d) => (d.tiers[0].n = 1)],
    ['no tiers', /tiers/, (d) => (d.tiers = [])],
    ['an unknown top-level field', /table\.notes/, (d) => (d.notes = 'x')],
    ['an unknown tier field', /tiers\[0\]\.extra/, (d) => (d.tiers[0].extra = 1)],
    ['an unknown calibration field', /calibration\.extra/, (d) => (d.calibration.extra = 1)],
    ['a missing field', /timing\.maxGameSec is missing/, (d) => delete d.timing.maxGameSec],
    ['fixture: false', /fixture/, (d) => (d.fixture = false)],
    ['another maze version', /mazeVersion/, (d) => (d.mazeVersion = 2)],
    ['a table version that is not uint32', /tableVersion/, (d) => (d.tableVersion = 2 ** 32)],
    ['calibrated that is not a boolean', /calibrated/, (d) => (d.calibration.calibrated = 'yes')],
    ['incomplete stream identifiers', /streams\.D/, (d) => (d.calibration.streams = { A: 'a', B: 'b', C: 'c' })],
    ['a ceiling outside 1 .. 10000', /ceilingBps/, (d) => (d.calibration.ceilingBps = 10001)],
    ['a bet limit that is not a decimal string', /minBetWei/, (d) => (d.limits.minBetWei = '1e15')],
    ['a numeric bet limit', /maxBetWei/, (d) => (d.limits.maxBetWei = 100)],
    ['a zero minimum bet', /minBetWei/, (d) => (d.limits.minBetWei = '0')],
    ['a maximum bet below the minimum', /maxBetWei/, (d) => (d.limits.maxBetWei = '999999999999999')],
    ['a game limit that reaches the settle window', /maxGameSec/, (d) => (d.timing.maxGameSec = 1800)],
    ['a zero idle timeout', /idleTimeoutSec/, (d) => (d.timing.idleTimeoutSec = 0)],
  ])('rejects %s', (_name, message, change) => {
    expect(() => parseTuning(mutated(change))).toThrow(message);
    expect(() => parseTuning(mutated(change))).toThrow(TypeError);
  });

  it('rejects values that are not a table at all', () => {
    for (const bad of [null, undefined, 'table', 7, [], [fixture]]) {
      expect(() => parseTuning(bad)).toThrow(TypeError);
    }
  });
});

describe('contract encoding', () => {
  const owner: Hex = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const signer: Hex = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const tableTypes = parseAbiParameters(
    'uint32 tableVersion, uint16 mazeVersion, (uint8 n, uint32 multiplierBps, uint16[] refundBps)[] tiers, uint256 minBet, uint256 maxBet, uint64 settleWindow',
  );

  const small: TuningTable = {
    tableVersion: 7,
    mazeVersion: 1,
    calibration: {
      calibrated: false,
      ceilingBps: 9600,
      gate1Bps: 9650,
      gate2Bps: 9900,
      certifyKey: null,
      simCodeHash: null,
      streams: null,
    },
    tiers: [
      {
        id: 0,
        n: 2,
        curve: { family: 'two-stage-geometric', e0Bps: 500, aBps: 7300, phi: 0.5 },
        multiplierBps: 15000,
        refundBps: [9500, 7300, 5000, 2500],
      },
      {
        id: 1,
        n: 3,
        curve: { family: 'two-stage-geometric', e0Bps: 1000, aBps: 8000, phi: 0.5 },
        multiplierBps: 30000,
        refundBps: [9000, 8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000],
      },
    ],
    limits: { minBetWei: '1000', maxBetWei: '2000' },
    timing: { ticketExpirySec: 120, idleTimeoutSec: 120, maxGameSec: 900, settleWindowSec: 1800 },
  };

  it('encodeTierInits gives the contract TierInit[] in tier order', () => {
    const inits = encodeTierInits(fixture);
    expect(inits).toEqual(
      fixture.tiers.map((tier) => ({
        n: tier.n,
        multiplierBps: tier.multiplierBps,
        refundBps: tier.refundBps,
      })),
    );
    expect(inits[0].refundBps).not.toBe(fixture.tiers[0].refundBps);
  });

  it('constructorArgs follows the ABI constructor, argument by argument', () => {
    const ctor = mazeBetAbi.find((item) => item.type === 'constructor');
    if (ctor?.type !== 'constructor') throw new Error('the ABI has no constructor');
    expect(ctor.inputs.map((input) => input.name)).toEqual([
      'owner_',
      'serverSigner_',
      'tableVersion_',
      'mazeVersion_',
      'tiers_',
      'minBet_',
      'maxBet_',
      'settleWindow_',
    ]);
    const args = constructorArgs(fixture, owner, signer);
    expect(args).toEqual([
      owner,
      signer,
      1,
      1,
      encodeTierInits(fixture),
      1_000_000_000_000_000n,
      100_000_000_000_000_000n,
      1800n,
    ]);
    // The typed ABI accepts the tuple as it is, and its tail is exactly what tableHash hashes.
    const encoded = encodeAbiParameters(ctor.inputs, args);
    expect(encoded.length).toBeGreaterThan(2);
    expect(keccak256(encodeAbiParameters(ctor.inputs.slice(2), args.slice(2)))).toBe(tableHash(fixture));
  });

  it('AC-T7 tableHash = keccak256(abi.encode(uint32, uint16, TierInit[], uint256, uint256, uint64))', () => {
    for (const table of [fixture, loadTuning(), small]) {
      const expected = keccak256(
        encodeAbiParameters(tableTypes, [
          table.tableVersion,
          table.mazeVersion,
          table.tiers.map((tier) => ({
            n: tier.n,
            multiplierBps: tier.multiplierBps,
            refundBps: tier.refundBps,
          })),
          BigInt(table.limits.minBetWei),
          BigInt(table.limits.maxBetWei),
          BigInt(table.timing.settleWindowSec),
        ]),
      );
      expect(tableHash(table)).toBe(expected);
    }
  });

  it('AC-T7 tableHash known answer from another ABI encoder (Foundry cast)', () => {
    // cast abi-encode "f(uint32,uint16,(uint8,uint32,uint16[])[],uint256,uint256,uint64)" 7 1 \
    //   "[(2,15000,[9500,7300,5000,2500]),(3,30000,[9000,8000,7000,6000,5000,4000,3000,2000,1000])]" \
    //   1000 2000 1800 | cast keccak
    expect(tableHash(small)).toBe('0x5e1b6eda1fa5bc5ac9f48d6d6251a1537cba9749c27b5eedbc40f806e6bed1fc');
    // The same cross-check for the frozen fixture table.
    expect(tableHash(fixture)).toBe('0x6a714957b91aaee3c5b572cdbaefcb26fd19189e41bf1439c9d08e5730a2a45b');
  });

  it('tableHash covers exactly what the contract stores: every table input and nothing else', () => {
    const base = tableHash(small);
    const tier0 = small.tiers[0];
    const changed: TuningTable[] = [
      { ...small, tableVersion: 8 },
      { ...small, mazeVersion: 2 },
      { ...small, tiers: [{ ...tier0, multiplierBps: 15001 }, small.tiers[1]] },
      { ...small, tiers: [{ ...tier0, refundBps: [9500, 7300, 5000, 2499] }, small.tiers[1]] },
      { ...small, tiers: [small.tiers[1], tier0] },
      { ...small, tiers: [tier0] },
      { ...small, limits: { ...small.limits, minBetWei: '1001' } },
      { ...small, limits: { ...small.limits, maxBetWei: '2001' } },
      { ...small, timing: { ...small.timing, settleWindowSec: 1801 } },
    ];
    const hashes = changed.map(tableHash);
    expect(new Set([base, ...hashes]).size).toBe(changed.length + 1);

    const same: TuningTable[] = [
      { ...small, fixture: true },
      { ...small, calibration: { ...small.calibration, calibrated: true, certifyKey: 'k' } },
      { ...small, tiers: [{ ...tier0, id: 5, curve: { ...tier0.curve, phi: 0.6 } }, small.tiers[1]] },
      { ...small, timing: { ...small.timing, idleTimeoutSec: 6, maxGameSec: 30, ticketExpirySec: 1 } },
    ];
    for (const table of same) expect(tableHash(table)).toBe(base);
  });
});
