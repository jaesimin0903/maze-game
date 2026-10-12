// Runtime configuration (plan §7.3, §7.6). Every chain setting the browser uses comes from
// `GET /api/config`; nothing chain-related is read from the build.

import type { ConfigResponse, TuningTable } from '@maze/shared';

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Rejects a response that cannot drive the client, naming the first field that is wrong. */
export function assertConfig(raw: unknown): ConfigResponse {
  const c = raw as Partial<ConfigResponse> | null;
  const bad = (field: string): never => {
    throw new TypeError(`/api/config: ${field} is missing or malformed`);
  };
  if (c === null || typeof c !== 'object') return bad('body');
  if (!Number.isInteger(c.chainId)) bad('chainId');
  if (typeof c.rpcUrl !== 'string' || c.rpcUrl === '') bad('rpcUrl');
  if (typeof c.contract !== 'string' || !HEX_ADDRESS.test(c.contract)) bad('contract');
  if (!Array.isArray(c.tiers) || c.tiers.length === 0) bad('tiers');
  for (const tier of c.tiers ?? []) {
    if (!Number.isInteger(tier?.n) || !Array.isArray(tier?.refundBps)) bad('tiers[].refundBps');
    if (tier.refundBps.length !== tier.n * tier.n) bad('tiers[].refundBps');
    if (!Number.isInteger(tier.multiplierBps)) bad('tiers[].multiplierBps');
  }
  if (typeof c.minBetWei !== 'string' || typeof c.maxBetWei !== 'string') bad('minBetWei');
  if (typeof c.devWallet !== 'boolean') bad('devWallet');
  if (typeof c.testHooks !== 'boolean') bad('testHooks');
  return c as ConfigResponse;
}

/**
 * The table the shared payout and verification functions take, built from the config.
 *
 * Those functions read `mazeVersion` and `tiers` only. The config does not carry the
 * calibration thresholds or the ticket lifetime, so they are left empty here; nothing in the
 * browser reads them.
 */
export function tableFromConfig(config: ConfigResponse): TuningTable {
  return {
    tableVersion: config.tableVersion,
    mazeVersion: config.mazeVersion,
    ...(config.fixture ? { fixture: true as const } : {}),
    calibration: {
      calibrated: config.calibrated,
      ceilingBps: 0,
      gate1Bps: 0,
      gate2Bps: 0,
      certifyKey: null,
      simCodeHash: null,
      streams: null,
    },
    tiers: config.tiers,
    limits: { minBetWei: config.minBetWei, maxBetWei: config.maxBetWei },
    timing: {
      ticketExpirySec: 0,
      idleTimeoutSec: config.idleTimeoutSec,
      maxGameSec: config.maxGameSec,
      settleWindowSec: config.settleWindowSec,
    },
  };
}

/** The difficulty names of the three standard tiers; any other table names its sizes by number. */
export function tierName(index: number, count: number): string {
  return count === 3 ? (['EASY', 'NORMAL', 'HARD'][index] ?? `SIZE ${index + 1}`) : `SIZE ${index + 1}`;
}

/** The difficulty colour of a tier, as a class suffix: green, orange, red (and red past the third). */
export function tierTone(index: number): 'easy' | 'norm' | 'hard' {
  return (['easy', 'norm', 'hard'] as const)[index] ?? 'hard';
}

/**
 * How often a player who always walks toward the exit escapes a maze of each size: the
 * naive-greedy row of docs/escape-report.md §3 (k = 3,000 escapes per size). Sizes the report does
 * not cover show no odds.
 */
export const ESCAPE_RATES: Readonly<Record<number, number>> = {
  5: 0.3318,
  7: 0.1316,
  9: 0.0452,
};

/**
 * The odds the LCD shows for a maze size, both approximate and both rounded to the nearest: "~33%"
 * (whole percents, one decimal below 10%) and "~1 IN 3". `null` for a size the report does not
 * cover.
 */
export function escapeOdds(n: number): { percent: string; oneIn: number } | null {
  const rate = ESCAPE_RATES[n];
  if (rate === undefined) return null;
  const percent = rate * 100;
  return {
    percent: `${percent < 10 ? Math.round(percent * 10) / 10 : Math.round(percent)}%`,
    oneIn: Math.round(1 / rate),
  };
}
