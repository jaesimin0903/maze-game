// `sim:bench` (plan §2.5, §9.3): measures, on this machine and with this code, how many games per
// second each kind of bot plays per worker thread and the standard deviation of a game's payout.
// The certification game count of a tier is derived from the measured standard deviation of the
// reference bot (value-lsm) and is never below the plan's minimum.

import { availableParallelism, loadavg } from 'node:os';
import type { CurveParams, TierConfig } from '@maze/shared';
import { VALUE_LSM_HYPER, ROLLOUT_SAMPLES } from './bots/index';
import { emptyStats, mergeStats, closeStats, type ChunkStats, type TierEconomics } from './engine';
import { byTier, resolveCertGames, type Profile } from './profile';
import { botLabel, rtpOf, tierRef, type BotDef, type Runner, type TierRef } from './runner';
import { DEFAULT_CEILING_BPS, readJsonFile, refundTableFor, writeJsonFile, type ReportPaths } from './tables';
import { multiplierForInSample } from './trajectory-cache';

export interface BenchBot {
  label: string;
  games: number;
  seconds: number;
  /** Games per second per worker thread, with every worker busy. */
  gamesPerSecondPerThread: number;
  gamesPerSecondTotal: number;
  /** Mean and standard deviation of the payout as a fraction of the bet; null for the training row. */
  rtp: number | null;
  sd: number | null;
}

export interface BenchTier {
  n: number;
  curve: CurveParams;
  /**
   * The multiplier the bots were timed at: a quick estimate of where the calibration will land
   * (harmonic-lsm's in-sample value on a small trajectory set equal to the ceiling minus the
   * target half-width). It is not a calibrated value. The table's provisional multipliers are
   * not used, because at a conservative multiplier value-lsm cashes out before the first move
   * and neither its speed nor its standard deviation would mean anything.
   */
  multiplierBps: number;
  bots: BenchBot[];
  /** Standard deviation of value-lsm's payout: the σ of the certification count. */
  referenceSd: number;
}

export interface BenchReport {
  schema: 1;
  profile: string;
  simCodeHash: string;
  generatedAt: string;
  cores: number;
  workers: number;
  /** 1, 5 and 15 minute load averages when the benchmark ended; other work on the machine lowers the throughput. */
  loadAverage: number[];
  tiers: BenchTier[];
}

function split(games: number, parts: number): [number, number][] {
  const per = Math.ceil(games / parts);
  return Array.from({ length: parts }, (_, i) => [i * per, (i + 1) * per] as [number, number]);
}

async function timeBot(runner: Runner, tier: TierRef, def: BotDef, games: number): Promise<BenchBot> {
  const spec = runner.resolve(def);
  const workers = runner.executor.size;
  const spans = split(games, workers);
  const started = performance.now();
  const parts = await Promise.all(
    spans.map(([from, to]) =>
      runner.executor.run({ kind: 'eval', econ: tier.econ, bot: spec, source: { kind: 'rng', mode: runner.rngMode, stream: 'E' }, from, to }),
    ),
  );
  const seconds = (performance.now() - started) / 1000;
  const stats: ChunkStats = emptyStats(tier.econ.w * tier.econ.h, parts[0].expected);
  for (const part of parts) mergeStats(stats, part);
  closeStats(stats, tier.econ);
  const estimate = rtpOf(stats);
  return {
    label: botLabel(def),
    games: stats.n,
    seconds,
    gamesPerSecondPerThread: stats.n / seconds / workers,
    gamesPerSecondTotal: stats.n / seconds,
    rtp: estimate.mean,
    sd: estimate.sd,
  };
}

/** Benchmarks one tier. Training tables for the value bots use `profile.benchTrainGames` games per pass. */
export async function benchTier(runner: Runner, tierIndex: number, n: number, curve: CurveParams): Promise<BenchTier> {
  const profile = runner.profile;
  const counts = profile.benchGames;
  const refundBps = refundTableFor(n, curve);
  const walks = await runner.trajectories(n, n, 'E', profile.benchTrainGames);
  const target = DEFAULT_CEILING_BPS / 10_000 - byTier(profile.targetHalfWidth, tierIndex);
  const multiplierBps = multiplierForInSample(walks.data, { w: n, h: n, refundBps }, target, profile.minSamples);
  const econ: TierEconomics = { w: n, h: n, multiplierBps, refundBps };
  const tier = tierRef(econ);
  const table = await runner.valueTableScratch(tier, VALUE_LSM_HYPER, 1, profile.benchTrainGames);
  const harmonicLsm = await runner.harmonicLsm(tier, profile.benchTrainGames);
  const plan: [BotDef, number][] = [
    [{ bot: 'immediate-cashout' }, counts.fast],
    [{ bot: 'naive-greedy' }, counts.fast],
    [{ bot: 'harmonic' }, counts.posterior],
    [{ bot: 'harmonic-lsm', table: harmonicLsm.key }, counts.posterior],
    [{ bot: 'value-table', table }, counts.posterior],
    [{ bot: 'value-lsm', table, hyper: VALUE_LSM_HYPER }, counts.lookahead],
    [{ bot: 'value-lookahead-all', table }, counts.lookaheadAll],
    [{ bot: 'rollout', samples: ROLLOUT_SAMPLES, table }, counts.rollout],
  ];
  const bots: BenchBot[] = [];
  for (const [def, games] of plan) bots.push(await timeBot(runner, tier, def, games));

  // One timed training pass of value-lsm's own policy (the unit the calibration repeats).
  const workers = runner.executor.size;
  const started = performance.now();
  await Promise.all(
    split(counts.lookahead, workers).map(([from, to]) =>
      runner.executor.run({
        kind: 'train',
        econ,
        policy: { kind: 'value', table: runner.loadTable(table), hyper: VALUE_LSM_HYPER },
        rBins: 1,
        source: { kind: 'rng', mode: runner.rngMode, stream: 'C' },
        from,
        to,
      }),
    ),
  );
  const seconds = (performance.now() - started) / 1000;
  const trained = Math.ceil(counts.lookahead / workers) * workers;
  bots.push({
    label: 'value-lsm training pass',
    games: trained,
    seconds,
    gamesPerSecondPerThread: trained / seconds / workers,
    gamesPerSecondTotal: trained / seconds,
    rtp: null,
    sd: null,
  });
  const reference = bots.find((bot) => bot.label === 'value-lsm');
  return { n, curve, multiplierBps, bots, referenceSd: reference?.sd ?? 0 };
}

/** The benchmark on disk if it was made by this code and profile; otherwise null. */
export function readBench(runner: Runner, paths: ReportPaths): BenchReport | null {
  const report = readJsonFile<BenchReport>(paths.benchJson);
  if (report === null || report.schema !== 1) return null;
  if (report.simCodeHash !== runner.codeHash || report.profile !== runner.profile.name) return null;
  return report;
}

function header(runner: Runner): Omit<BenchReport, 'tiers'> {
  return {
    schema: 1,
    profile: runner.profile.name,
    simCodeHash: runner.codeHash,
    generatedAt: new Date().toISOString(),
    cores: availableParallelism(),
    workers: runner.executor.size,
    loadAverage: loadavg(),
  };
}

/** Benchmarks every tier of a table and writes `bench.json`. */
export async function runBench(runner: Runner, paths: ReportPaths, tiers: readonly TierConfig[]): Promise<BenchReport> {
  const measured: BenchTier[] = [];
  for (let i = 0; i < tiers.length; i++) measured.push(await benchTier(runner, i, tiers[i].n, tiers[i].curve));
  const report: BenchReport = { ...header(runner), tiers: measured };
  writeJsonFile(paths.benchJson, report);
  return report;
}

function sameCurve(a: CurveParams, b: CurveParams): boolean {
  return a.family === b.family && a.e0Bps === b.e0Bps && a.aBps === b.aBps && a.phi === b.phi;
}

/**
 * The measured standard deviation of the reference bot on an `n × n` grid under a curve. A
 * combination that the benchmark on disk does not cover, or a benchmark made by other code, is
 * measured now and recorded, so a game count is always derived from a measurement of the
 * current code.
 */
export async function referenceSd(runner: Runner, paths: ReportPaths, tierIndex: number, n: number, curve: CurveParams): Promise<number> {
  const current = readBench(runner, paths);
  const known = current?.tiers.find((tier) => tier.n === n && sameCurve(tier.curve, curve));
  if (known !== undefined) return known.referenceSd;
  runner.checkpoint(`benchmark of the ${n}x${n} grid`);
  const measured = await benchTier(runner, tierIndex, n, curve);
  const report: BenchReport = { ...header(runner), tiers: [...(current?.tiers ?? []), measured] };
  writeJsonFile(paths.benchJson, report);
  return measured.referenceSd;
}

/** Certification games of a tier from the measured standard deviation. Never below the plan's minimum. */
export function certGamesFromSd(profile: Profile, tierIndex: number, sd: number): number {
  return resolveCertGames(profile, tierIndex, sd);
}

/** One line per bot for the console. */
export function formatBench(report: BenchReport, profile: Profile): string {
  const lines: string[] = [];
  lines.push(`sim:bench  profile=${report.profile}  cores=${report.cores}  workers=${report.workers}  load=${report.loadAverage.map((x) => x.toFixed(1)).join('/')}`);
  report.tiers.forEach((tier, index) => {
    const games = certGamesFromSd(profile, index, tier.referenceSd);
    lines.push(
      `tier ${index}: ${tier.n}x${tier.n} e0 ${tier.curve.e0Bps} a ${tier.curve.aBps} phi ${tier.curve.phi} at an estimated working multiplier of ${(tier.multiplierBps / 10_000).toFixed(2)}x  sigma(value-lsm)=${tier.referenceSd.toFixed(4)}  ` +
        `target half-width=${(100 * byTier(profile.targetHalfWidth, index)).toFixed(2)}%p  certification N=${games} (plan minimum ${byTier(profile.certMinGames, index)})`,
    );
    for (const bot of tier.bots) {
      lines.push(
        `  ${bot.label.padEnd(26)} ${bot.gamesPerSecondPerThread.toFixed(0).padStart(9)} games/s/thread  ` +
          (bot.sd === null ? '' : `sigma=${bot.sd.toFixed(4)}  rtp=${(100 * (bot.rtp ?? 0)).toFixed(2)}%  `) +
          `(${bot.games} games in ${bot.seconds.toFixed(1)}s)`,
      );
    }
  });
  return lines.join('\n');
}
