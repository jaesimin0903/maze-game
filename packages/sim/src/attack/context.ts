// What the attack lane reads from the certification and where it keeps its own results.
//
// The certified tuning tables and the value-lsm tables they were certified with are read from
// packages/sim/reports through a read-only runner: nothing there is written. Tables the attack
// trains itself (value-lsm at other multipliers, for the calibration of the exact gap trend)
// go to a separate cache under the git-ignored `.data/sim-attack/`.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tableHash, type TuningTable } from '@maze/shared';
import { VALUE_LSM_HYPER } from '../bots/index';
import { CacheStore } from '../cache';
import { simCodeHash, simPackageRoot } from '../codehash';
import type { TierEconomics } from '../engine';
import { BOT_VARIANTS } from '../exact';
import type { ValueTable } from '../lsm';
import { InlineExecutor, type Executor } from '../pool';
import { byTier, PRODUCTION } from '../profile';
import { Runner, tierRef } from '../runner';
import { productionTablePath, readMeta, readTableFile, reportPaths, tierEconomicsOf } from '../tables';

/** The two certified tables of the final report. */
export const ATTACK_TABLES = {
  production: () => productionTablePath(),
  'house-max': () => join(simPackageRoot(), 'reports', 'tuning.house-max.json'),
} as const;
export type AttackTableName = keyof typeof ATTACK_TABLES;

export function attackDataRoot(): string {
  return resolve(simPackageRoot(), '..', '..', '.data', 'sim-attack');
}

export interface CertifiedTier {
  table: AttackTableName;
  tierIndex: number;
  n: number;
  econ: TierEconomics;
  /** The value-lsm table the certification played this tier with. */
  valueTable: ValueTable;
}

/** A runner that only reads the certification's cache. */
export function certificationRunner(): Runner {
  return new Runner({
    executor: new InlineExecutor(),
    store: new CacheStore(reportPaths(PRODUCTION.name).cache),
    profile: PRODUCTION,
    codeHash: simCodeHash(),
    rngMode: 'fast',
    deadline: 0,
    readOnly: true,
  });
}

/** A runner that trains into the attack lane's own cache (`.data/sim-attack/cache` unless `directory` is given). */
export function attackRunner(executor: Executor, log: (line: string) => void, directory: string | null = null): Runner {
  return new Runner({
    executor,
    store: new CacheStore(directory ?? join(attackDataRoot(), 'cache')),
    profile: PRODUCTION,
    codeHash: simCodeHash(),
    rngMode: 'fast',
    deadline: Number.POSITIVE_INFINITY,
    log,
  });
}

export function readAttackTable(name: AttackTableName): { path: string; table: TuningTable; hash: string } {
  const path = ATTACK_TABLES[name]();
  if (!existsSync(path)) throw new Error(`attack: table file not found: ${path}`);
  const table = readTableFile(path);
  return { path, table, hash: tableHash(table) };
}

/** Every tier of a certified table with the value-lsm table it was certified with. */
export async function certifiedTiers(name: AttackTableName, runner: Runner = certificationRunner()): Promise<CertifiedTier[]> {
  const { table, hash } = readAttackTable(name);
  const variant = BOT_VARIANTS[readMeta(reportPaths(PRODUCTION.name), hash)?.variantLevel ?? 0];
  if (variant.hyper.lookahead !== VALUE_LSM_HYPER.lookahead || variant.hyper.threshold !== VALUE_LSM_HYPER.threshold || variant.rBins !== 1) {
    throw new Error(`attack: table ${name} was certified with bot variant ${variant.level}, not the production value-lsm`);
  }
  const out: CertifiedTier[] = [];
  for (let tierIndex = 0; tierIndex < table.tiers.length; tierIndex++) {
    const tier = table.tiers[tierIndex];
    const econ = tierEconomicsOf(tier);
    const key = await runner.valueTableScratch(tierRef(econ), variant.hyper, variant.rBins, byTier(runner.profile.trainGames, tierIndex));
    if (!runner.store.hasArtifact(key)) {
      throw new Error(`attack: the value-lsm table of ${name} tier ${tierIndex} (${tier.n}x${tier.n}) is not in the certification cache (${key})`);
    }
    out.push({ table: name, tierIndex, n: tier.n, econ, valueTable: runner.loadTable(key) });
  }
  return out;
}
