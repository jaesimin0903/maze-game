// Candidate tables, their files and the metadata the simulator keeps about them.
//
// A table file is always a complete `TuningTable` written by `serializeTuning` (no extra fields,
// or `parseTuning` would reject it). Everything else the simulator needs to remember about a
// table (which bot variant calibrated it, the fixed θ of param-search, the game counts, the
// calibration evaluations) lives in a sidecar keyed by the table's `tableHash`, so it is found
// again after the table has been copied byte for byte to another path.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  buildRefundTable,
  loadTuning,
  parseTuning,
  serializeTuning,
  tableHash,
  type CurveParams,
  type TierConfig,
  type TuningTable,
} from '@maze/shared';
import { sha256Hex } from './cache';
import { simPackageRoot } from './codehash';
import type { TierEconomics } from './engine';
import { streamIdentifiers } from './streams';

/** Fixed gates of plan §3.6. They are never relaxed. */
export const DEFAULT_CEILING_BPS = 9600;
export const GATE1_BPS = 9650;
export const GATE2_BPS = 9900;
/** A calibrated multiplier whose bound is more than this below the ceiling "missed the window". */
export const WINDOW_BPS = 10;
/** The best bot's point estimate must lie in this range (AC-R6). */
export const BEST_POINT_RANGE: [number, number] = [0.94, 0.96];

export const DEFAULT_SIZES = [5, 7, 10];

export type CandidateName = 'i' | 'ii' | 'iii';
export const CANDIDATE_NAMES: readonly CandidateName[] = ['i', 'ii', 'iii'];

/** The three curve candidates of plan §1.3(a): (e0, a per tier, φ). */
export const CANDIDATE_CURVES: Record<CandidateName, { e0Bps: number; aBps: number[]; phi: number }> = {
  i: { e0Bps: 500, aBps: [9000, 9000, 9000], phi: 0.3 },
  ii: { e0Bps: 500, aBps: [7300, 7300, 7300], phi: 0.5 },
  iii: { e0Bps: 2000, aBps: [7340, 7550, 7700], phi: 0.5 },
};

/** Search grid of plan §3.1: 7 × 5 = 35 points per tier. */
export const SEARCH_A_BPS = [9000, 8500, 8000, 7600, 7300, 7000, 6500];
export const SEARCH_PHI = [0.3, 0.4, 0.5, 0.6, 0.7];

export function candidateCurves(name: CandidateName): CurveParams[] {
  const { e0Bps, aBps, phi } = CANDIDATE_CURVES[name];
  return aBps.map((a) => ({ family: 'two-stage-geometric' as const, e0Bps, aBps: a, phi }));
}

export function refundTableFor(n: number, curve: CurveParams): number[] {
  return buildRefundTable({ cells: n * n, shortestPath: 2 * (n - 1), curve });
}

export function makeTier(id: number, n: number, curve: CurveParams, multiplierBps: number): TierConfig {
  return { id, n, curve, multiplierBps, refundBps: refundTableFor(n, curve) };
}

export function tierEconomicsOf(tier: TierConfig): TierEconomics {
  return { w: tier.n, h: tier.n, multiplierBps: tier.multiplierBps, refundBps: tier.refundBps };
}

/** Identifier of "the certification of this table by this simulator code". */
export function certifyKeyOf(hash: string, simCodeHash: string, profileName: string): string {
  return sha256Hex(`${hash}|${simCodeHash}|${profileName}`);
}

/**
 * A complete table from tiers. Versions, limits and timing are those of the production table;
 * only tiers and the calibration block differ between candidates.
 */
export function assembleTable(
  tiers: TierConfig[],
  calibration: { calibrated: boolean; ceilingBps: number; simCodeHash: string | null; profileName: string },
): TuningTable {
  const base = loadTuning();
  const draft: TuningTable = {
    tableVersion: base.tableVersion,
    mazeVersion: base.mazeVersion,
    calibration: {
      calibrated: false,
      ceilingBps: calibration.ceilingBps,
      gate1Bps: GATE1_BPS,
      gate2Bps: GATE2_BPS,
      certifyKey: null,
      simCodeHash: null,
      streams: null,
    },
    tiers,
    limits: base.limits,
    timing: base.timing,
  };
  if (!calibration.calibrated || calibration.simCodeHash === null) return parseTuning(draft);
  const { A, B, C, D } = streamIdentifiers();
  return parseTuning({
    ...draft,
    calibration: {
      ...draft.calibration,
      calibrated: true,
      certifyKey: certifyKeyOf(tableHash(draft), calibration.simCodeHash, calibration.profileName),
      simCodeHash: calibration.simCodeHash,
      streams: { A, B, C, D },
    },
  });
}

export function readTableFile(path: string): TuningTable {
  return parseTuning(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

export function writeTableFile(path: string, table: TuningTable): void {
  writeAtomic(path, serializeTuning(table));
}

export function writeJsonFile(path: string, value: unknown): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeTextFile(path: string, text: string): void {
  writeAtomic(path, text);
}

/** Where the commands read and write. The smoke profile is kept apart from production results. */
export interface ReportPaths {
  root: string;
  cache: string;
  candidates: string;
  meta: string;
  exact: string;
  benchJson: string;
  certifyJson: string;
  candidateTable: string;
  houseMaxTable: string;
  tuneJson: string;
  sensitivityJson: string;
  tuningReport: string;
}

export function reportPaths(profileName: string, root?: string): ReportPaths {
  const base = root ?? join(simPackageRoot(), 'reports', ...(profileName === 'production' ? [] : [profileName]));
  return {
    root: base,
    cache: join(base, 'cache'),
    candidates: join(base, 'candidates'),
    meta: join(base, 'meta'),
    exact: join(base, 'exact'),
    benchJson: join(base, 'bench.json'),
    certifyJson: join(base, 'certify.json'),
    candidateTable: join(base, 'tuning.candidate.json'),
    houseMaxTable: join(base, 'tuning.house-max.json'),
    tuneJson: join(base, 'tune-result.json'),
    sensitivityJson: join(base, 'sensitivity.json'),
    tuningReport: join(base, 'tuning-report.md'),
  };
}

/** `packages/shared/src/tuning.json`: the table every command uses when `--table` is absent. */
export function productionTablePath(): string {
  return resolve(simPackageRoot(), '..', 'shared', 'src', 'tuning.json');
}

/** One full-`N` evaluation of a calibration on stream A. */
export interface FullEvaluation {
  multiplierBps: number;
  /** Largest 97.5% upper confidence bound over the contenders. */
  u: number;
  /** The bot that attains it, its point estimate and its win rate (the slope dU/dM). */
  best: string;
  bestRtp: number;
  slope: number;
  pass: boolean;
}

export interface TierMeta {
  tier: number;
  n: number;
  curve: CurveParams;
  multiplierBps: number;
  ceilingBps: number;
  /** Certification games per cell of this tier. */
  games: number;
  /** True when the multiplier comes from the reduced-sample screening and no full-`N` evaluation was made. */
  screened: boolean;
  coarseGames: number;
  /** θ of param-search, fixed at the multiplier where the coarse bisection ended. */
  theta: number[];
  thetaMultiplierBps: number;
  initialMultiplierBps: number;
  coarse: { multiplierBps: number; point: number; target: number }[];
  /** Labels of the bots that were within 2 percentage points of the leader in the coarse stage. */
  contenders: string[];
  evaluations: FullEvaluation[];
  /** `U < ceiling - 0.1 percentage points` at the adopted multiplier. */
  windowMissed: boolean;
  /** Steps at which `U` moved by more than the slope predicts (policy discontinuities). */
  discontinuities: { fromBps: number; toBps: number; predicted: number; observed: number }[];
}

export interface TableMeta {
  schema: 1;
  tableHash: string;
  name: string;
  profile: string;
  simCodeHash: string;
  /** Index into `BOT_VARIANTS`: which value-lsm calibrated the table. */
  variantLevel: number;
  tiers: TierMeta[];
}

export function metaPath(paths: ReportPaths, hash: string): string {
  return join(paths.meta, `${hash}.json`);
}

export function readMeta(paths: ReportPaths, hash: string): TableMeta | null {
  const meta = readJsonFile<TableMeta>(metaPath(paths, hash));
  return meta !== null && meta.schema === 1 && meta.tableHash === hash ? meta : null;
}

export function writeMeta(paths: ReportPaths, meta: TableMeta): void {
  writeJsonFile(metaPath(paths, meta.tableHash), meta);
}
