// Tuning table: loading, validation, and the one encoder shared by deployment and `tableHash`
// (plan §7.1, §7.2).

import { encodeAbiParameters, keccak256 } from 'viem';
import { mazeBetAbi } from './abi';
import { assertCurveParams, assertStrictlyDecreasing } from './economics';
import tuningJson from './tuning.json';
import { MAZE_VERSION, type CurveParams, type Hex, type TierConfig, type TuningTable } from './types';

const BPS = 10_000;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;

function fail(path: string, message: string): never {
  throw new TypeError(`tuning table: ${path} ${message}`);
}

function record(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`${path}.${key}`, 'is not a known field');
  }
  for (const key of required) {
    if (!(key in fields)) fail(`${path}.${key}`, 'is missing');
  }
  return fields;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(path, `must be an integer in ${min} .. ${max}`);
  }
  return value;
}

function stringOrNull(value: unknown, path: string): string | null {
  if (value !== null && typeof value !== 'string') fail(path, 'must be a string or null');
  return value;
}

function weiString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    fail(path, 'must be a decimal wei string');
  }
  return value;
}

function parseCalibration(value: unknown): TuningTable['calibration'] {
  const path = 'calibration';
  const c = record(value, path, [
    'calibrated',
    'ceilingBps',
    'gate1Bps',
    'gate2Bps',
    'certifyKey',
    'simCodeHash',
    'streams',
  ]);
  if (typeof c.calibrated !== 'boolean') fail(`${path}.calibrated`, 'must be a boolean');
  let streams: TuningTable['calibration']['streams'] = null;
  if (c.streams !== null) {
    const s = record(c.streams, `${path}.streams`, ['A', 'B', 'C', 'D']);
    for (const name of ['A', 'B', 'C', 'D']) {
      if (typeof s[name] !== 'string') fail(`${path}.streams.${name}`, 'must be a string');
    }
    streams = { A: s.A as string, B: s.B as string, C: s.C as string, D: s.D as string };
  }
  return {
    calibrated: c.calibrated,
    ceilingBps: integer(c.ceilingBps, `${path}.ceilingBps`, 1, BPS),
    gate1Bps: integer(c.gate1Bps, `${path}.gate1Bps`, 1, BPS),
    gate2Bps: integer(c.gate2Bps, `${path}.gate2Bps`, 1, BPS),
    certifyKey: stringOrNull(c.certifyKey, `${path}.certifyKey`),
    simCodeHash: stringOrNull(c.simCodeHash, `${path}.simCodeHash`),
    streams,
  };
}

function parseCurve(value: unknown, path: string): CurveParams {
  const c = record(value, path, ['family', 'e0Bps', 'aBps', 'phi']);
  const curve = { family: c.family, e0Bps: c.e0Bps, aBps: c.aBps, phi: c.phi } as CurveParams;
  try {
    assertCurveParams(curve);
  } catch (error) {
    fail(path, `is not a valid curve: ${(error as Error).message}`);
  }
  return curve;
}

function parseTier(value: unknown, index: number): TierConfig {
  const path = `tiers[${index}]`;
  const t = record(value, path, ['id', 'n', 'curve', 'multiplierBps', 'refundBps']);
  if (t.id !== index) fail(`${path}.id`, `must equal its position (${index})`);
  const n = integer(t.n, `${path}.n`, 2, 255);
  const curve = parseCurve(t.curve, `${path}.curve`);
  const multiplierBps = integer(t.multiplierBps, `${path}.multiplierBps`, BPS, UINT32_MAX);
  if (!Array.isArray(t.refundBps) || t.refundBps.length !== n * n) {
    fail(`${path}.refundBps`, `must be an array of n * n = ${n * n} entries`);
  }
  const refundBps = t.refundBps.map((entry: unknown, k: number) =>
    integer(entry, `${path}.refundBps[${k}]`, 0, UINT16_MAX),
  );
  if (refundBps[0] >= BPS) fail(`${path}.refundBps[0]`, `must be below ${BPS}`);
  try {
    assertStrictlyDecreasing(refundBps);
  } catch (error) {
    fail(`${path}.refundBps`, (error as Error).message);
  }
  return { id: index, n, curve, multiplierBps, refundBps };
}

/**
 * Validates an untrusted value (for example a parsed JSON file) and returns it as a fresh
 * `TuningTable` whose keys are in interface order. Throws `TypeError` naming the offending
 * field. The checks are integer-only and mirror the contract constructor: `refundBps` has
 * `n * n` strictly decreasing `uint16` entries starting below 10000, and `multiplierBps` is
 * at least 10000. Unknown fields are rejected.
 */
export function parseTuning(raw: unknown): TuningTable {
  const root = record(
    raw,
    'table',
    ['tableVersion', 'mazeVersion', 'calibration', 'tiers', 'limits', 'timing'],
    ['fixture'],
  );
  const tableVersion = integer(root.tableVersion, 'tableVersion', 0, UINT32_MAX);
  const mazeVersion = integer(root.mazeVersion, 'mazeVersion', 0, UINT16_MAX);
  if (mazeVersion !== MAZE_VERSION) {
    fail('mazeVersion', `must be ${MAZE_VERSION}, the only maze algorithm implemented here`);
  }
  if ('fixture' in root && root.fixture !== true) fail('fixture', 'must be true when present');
  const calibration = parseCalibration(root.calibration);

  if (!Array.isArray(root.tiers) || root.tiers.length < 1 || root.tiers.length > 255) {
    fail('tiers', 'must be an array of 1 .. 255 tiers');
  }
  const tiers = root.tiers.map(parseTier);

  const l = record(root.limits, 'limits', ['minBetWei', 'maxBetWei']);
  const limits = {
    minBetWei: weiString(l.minBetWei, 'limits.minBetWei'),
    maxBetWei: weiString(l.maxBetWei, 'limits.maxBetWei'),
  };
  if (BigInt(limits.minBetWei) <= 0n) fail('limits.minBetWei', 'must be positive');
  if (BigInt(limits.maxBetWei) < BigInt(limits.minBetWei)) {
    fail('limits.maxBetWei', 'must not be below limits.minBetWei');
  }

  const g = record(root.timing, 'timing', [
    'ticketExpirySec',
    'idleTimeoutSec',
    'maxGameSec',
    'settleWindowSec',
  ]);
  const timing = {
    ticketExpirySec: integer(g.ticketExpirySec, 'timing.ticketExpirySec', 1, UINT32_MAX),
    idleTimeoutSec: integer(g.idleTimeoutSec, 'timing.idleTimeoutSec', 1, UINT32_MAX),
    maxGameSec: integer(g.maxGameSec, 'timing.maxGameSec', 1, UINT32_MAX),
    settleWindowSec: integer(g.settleWindowSec, 'timing.settleWindowSec', 1, UINT32_MAX),
  };
  if (timing.maxGameSec >= timing.settleWindowSec) {
    // A forced settlement must always come before the reclaim deadline.
    fail('timing.maxGameSec', 'must be below timing.settleWindowSec');
  }

  return {
    tableVersion,
    mazeVersion,
    ...(root.fixture === true ? { fixture: true as const } : {}),
    calibration,
    tiers,
    limits,
    timing,
  };
}

/** The canonical file form of a table: two-space JSON, keys in interface order, one trailing newline. */
export function serializeTuning(t: TuningTable): string {
  return `${JSON.stringify(parseTuning(t), null, 2)}\n`;
}

/** The production table (`tuning.json`), validated. Test tables are injected by the server container. */
export function loadTuning(): TuningTable {
  return parseTuning(tuningJson);
}

export interface TierInit {
  n: number;
  multiplierBps: number;
  refundBps: readonly number[];
}

/** The contract's `TierInit[]` constructor argument. */
export function encodeTierInits(t: TuningTable): readonly TierInit[] {
  return t.tiers.map(({ n, multiplierBps, refundBps }) => ({
    n,
    multiplierBps,
    refundBps: [...refundBps],
  }));
}

type TableArgs = readonly [
  tableVersion: number,
  mazeVersion: number,
  tiers: readonly TierInit[],
  minBet: bigint,
  maxBet: bigint,
  settleWindow: bigint,
];

export type MazeBetConstructorArgs = readonly [owner: Hex, serverSigner: Hex, ...table: TableArgs];

function tableArgs(t: TuningTable): TableArgs {
  return [
    t.tableVersion,
    t.mazeVersion,
    encodeTierInits(t),
    BigInt(t.limits.minBetWei),
    BigInt(t.limits.maxBetWei),
    BigInt(t.timing.settleWindowSec),
  ];
}

/**
 * Arguments of the `MazeBet` constructor in ABI order. Deployment and `tableHash` both go
 * through `tableArgs`, so the deployed table and its hash cannot drift apart.
 */
export function constructorArgs(t: TuningTable, owner: Hex, signer: Hex): MazeBetConstructorArgs {
  return [owner, signer, ...tableArgs(t)];
}

const constructorInputs = mazeBetAbi.find(
  (item): item is Extract<(typeof mazeBetAbi)[number], { type: 'constructor' }> =>
    item.type === 'constructor',
)!.inputs;

/**
 * `keccak256(abi.encode(uint32 tableVersion, uint16 mazeVersion, TierInit[] tiers, uint256 minBet,
 * uint256 maxBet, uint64 settleWindow))`, the value the contract stores as `tableHash()`.
 */
export function tableHash(t: TuningTable): Hex {
  return keccak256(encodeAbiParameters(constructorInputs.slice(2), tableArgs(t)));
}
