// Calibration and certification end to end on a tiny table (4×4 and 5×5, small game counts):
// the adoption rule, which stream each stage touches, and what certify.json records.
// The numbers themselves mean nothing at this size; the structure is what is checked.

import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseTuning, tableHash } from '@maze/shared';
import { certifiedSuite, memberLabel } from '../src/bots/index';
import { calibrateCandidate, type CalibrationSpec, type CandidateCalibration } from '../src/calibrate';
import { certifyTable, type CertifyFile, type TableCertification } from '../src/certify';
import type { Profile } from '../src/profile';
import { CacheMiss } from '../src/runner';
import { allStreamsDisjoint, streamIdentifiers } from '../src/streams';
import { certifyKeyOf, readMeta, readTableFile, reportPaths, WINDOW_BPS, type ReportPaths } from '../src/tables';
import { CURVE_II, temporaryDirectory, testRunner } from './helpers';

const TINY: Partial<Profile> = {
  certMinGames: [24_000, 24_000, 24_000],
  targetHalfWidth: [0.03, 0.03, 0.03],
  chunkGames: 10_000,
  trainGames: [10_000, 10_000, 10_000],
  minSamples: 50,
  trajectoryGames: [10_000, 10_000, 10_000],
  paramSearch: { initial: 8, range: 4, top: 2, perTop: 2, rounds: 1, sigma: 0.5, games: 1500 },
  pairPilot: 100,
  pairChunk: 100,
  pairFloor: [200, 200, 200],
  pairCap: 400,
  coarseDivisor: 4,
  screenDivisor: 2,
  sessions: 201,
  benchTrainGames: 5000,
  benchGames: { fast: 4000, posterior: 2000, lookahead: 2000, lookaheadAll: 400, rollout: 16 },
};

const SPEC: CalibrationSpec = {
  name: 'tiny',
  sizes: [4, 5],
  curves: [CURVE_II, CURVE_II],
  ceilingsBps: [9600, 9600],
  variantLevel: 0,
  screenLast: false,
};

interface CellFile {
  kind: string;
  stream: string;
  games: number;
  bot?: { bot: string };
}

function cellFiles(paths: ReportPaths): CellFile[] {
  return readdirSync(paths.cache)
    .map((name) => join(paths.cache, name, 'cell.json'))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, 'utf8')) as CellFile);
}

describe('calibrate → certify on a tiny table', () => {
  const directory = temporaryDirectory();
  const paths = reportPaths('production', directory);
  let calibration: CandidateCalibration;
  let streamsAfterCalibration: Set<string>;
  let certification: TableCertification;

  beforeAll(async () => {
    const runner = testRunner(directory, TINY);
    calibration = await calibrateCandidate(runner, paths, SPEC);
    streamsAfterCalibration = new Set(cellFiles(paths).map((cell) => `${cell.kind}:${cell.stream}`));
    certification = await certifyTable(runner, paths, calibration.tablePath, calibration.table, calibration.meta);
  }, 900_000);

  it('AC-R6 adopts the largest evaluated multiplier whose retrained U is within the ceiling, stepping down by (U − ceiling) / slope + 10 bps', () => {
    for (const tier of calibration.meta.tiers) {
      expect(tier.screened).toBe(false);
      expect(tier.evaluations.length).toBeGreaterThanOrEqual(1);
      expect(tier.evaluations.length).toBeLessThanOrEqual(6);
      const last = tier.evaluations[tier.evaluations.length - 1];
      expect(last.pass).toBe(true);
      expect(last.u).toBeLessThanOrEqual(tier.ceilingBps / 10_000);
      expect(tier.multiplierBps).toBe(last.multiplierBps);
      expect(tier.windowMissed).toBe(last.u < tier.ceilingBps / 10_000 - WINDOW_BPS / 10_000);
      // Every earlier evaluation failed at a larger multiplier, and each step is the plan's formula.
      for (let i = 0; i + 1 < tier.evaluations.length; i++) {
        const now = tier.evaluations[i];
        expect(now.pass).toBe(false);
        expect(now.u).toBeGreaterThan(tier.ceilingBps / 10_000);
        const step = Math.ceil(((now.u - tier.ceilingBps / 10_000) / now.slope) * 10_000) + 10;
        expect(tier.evaluations[i + 1].multiplierBps).toBe(now.multiplierBps - step);
      }
      // The coarse stage bracketed the target within 1% of the multiplier.
      expect(tier.coarse.length).toBeGreaterThanOrEqual(2);
      expect(tier.contenders).toContain('value-lsm');
      expect(tier.theta).toHaveLength(6);
      expect(tier.games).toBe(24_000);
    }
  });

  it('AC-T3 calibration plays its games on stream A only; certification on B and D; training on C', () => {
    // Establishes: the multiplier is never fitted to the games that certify it.
    expect(streamsAfterCalibration).toEqual(new Set(['eval:A']));
    const cells = cellFiles(paths);
    const streams = new Set(cells.map((cell) => `${cell.kind}:${cell.stream}`));
    expect(streams).toEqual(new Set(['eval:A', 'eval:B', 'pair:D']));
    // Training artifacts name stream C (value passes, region table, harmonic-lsm trajectories) or E (trajectory cache).
    const artifacts = readdirSync(join(paths.cache, 'artifacts'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(paths.cache, 'artifacts', name), 'utf8')) as { meta: { kind: string; stream?: string } });
    const trajectoryStreams = new Set(artifacts.filter((artifact) => artifact.meta.kind === 'trajectories').map((artifact) => artifact.meta.stream));
    expect(trajectoryStreams).toEqual(new Set(['C', 'E']));
    expect(allStreamsDisjoint()).toBe(true);
  });

  it('writes a complete table that parseTuning accepts, with its metadata keyed by tableHash', () => {
    const raw = JSON.parse(readFileSync(calibration.tablePath, 'utf8')) as unknown;
    const table = parseTuning(raw);
    expect(table).toEqual(readTableFile(calibration.tablePath));
    expect(table.tiers.map((tier) => tier.n)).toEqual([4, 5]);
    expect(table.tiers.map((tier) => tier.multiplierBps)).toEqual(calibration.meta.tiers.map((tier) => tier.multiplierBps));
    expect(table.calibration.calibrated).toBe(true);
    expect(table.calibration.ceilingBps).toBe(9600);
    expect(table.calibration.gate1Bps).toBe(9650);
    expect(table.calibration.gate2Bps).toBe(9900);
    expect(table.calibration.simCodeHash).toBe('test-code-hash');
    const { A, B, C, D } = streamIdentifiers();
    expect(table.calibration.streams).toEqual({ A, B, C, D });
    expect(table.calibration.certifyKey).toBe(certifyKeyOf(tableHash(table), 'test-code-hash', 'production'));
    expect(readMeta(paths, tableHash(table))).toEqual(calibration.meta);
  });

  it('AC-T3 AC-T4 certify.json holds every suite bot per tier with RTP, sd, se, interval, games, stream, tableHash and code hash', () => {
    const file = JSON.parse(readFileSync(paths.certifyJson, 'utf8')) as CertifyFile;
    expect(file.schema).toBe(1);
    expect(file.simCodeHash).toBe('test-code-hash');
    expect(file.streams).toEqual(streamIdentifiers());
    expect(file.streamsDisjoint).toBe(true);
    const entry = file.tables[calibration.meta.tableHash];
    expect(entry.tableHash).toBe(calibration.meta.tableHash);
    expect(entry.certifyKey).toBe(calibration.table.calibration.certifyKey);
    expect(entry.complete).toBe(true);
    for (const tier of entry.tiers) {
      const shortest = 2 * (tier.n - 1);
      expect(tier.cells.map((cell) => cell.bot)).toEqual(certifiedSuite(shortest).map(memberLabel));
      for (const cell of tier.cells) {
        expect(cell.stream).toBe('B');
        expect(cell.games).toBe(24_000);
        expect(cell.ci95[0]).toBeCloseTo(cell.rtp - 1.959964 * cell.se, 6);
        expect(cell.ucb975).toBeCloseTo(cell.rtp + 1.959964 * cell.se, 6);
        expect(cell.se).toBeCloseTo(cell.sd / Math.sqrt(cell.games), 12);
        expect(cell.key).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(tier.pairs.map((pair) => pair.adversary)).toEqual(['rollout(32)', 'value-lookahead-all']);
      for (const pair of tier.pairs) {
        expect(pair.stream).toBe('D');
        expect(pair.pilotPairs).toBe(100);
        expect(pair.pairs).toBeGreaterThanOrEqual(200);
        expect(pair.pairs).toBeLessThanOrEqual(400);
        const reference = tier.cells.find((cell) => cell.bot === 'value-lsm')!;
        expect(pair.rtp).toBeCloseTo(reference.rtp + pair.meanDiff, 12);
        expect(pair.se).toBeCloseTo(Math.sqrt(reference.se ** 2 + pair.seDiff ** 2), 12);
      }
    }
  });

  it('AC-R6 AC-R7 AC-R8 the gates are judged from measured bounds, and the calibration claim is recomputed from stream A', () => {
    for (const tier of certification.tiers) {
      const meta = calibration.meta.tiers[tier.tier];
      const worst = Math.max(...tier.cells.map((cell) => cell.ucb975));
      expect(tier.gates.gate1.value).toBe(worst);
      expect(tier.gates.gate1.pass).toBe(worst <= 0.965);
      expect(tier.gates.gate2.value).toBe(Math.max(worst, ...tier.pairs.map((pair) => pair.ucb975)));
      expect(tier.gates.gate2.pass).toBe(tier.gates.gate2.value <= 0.99);
      expect(tier.calibration.status).toBe('ok');
      expect(tier.calibration.u).toBe(meta.evaluations[meta.evaluations.length - 1].u);
      expect(tier.calibration.pass).toBe(true);
      expect(tier.calibration.contenders.every((cell) => cell.stream === 'A')).toBe(true);
      // The [94%, 96%] range is read on the calibration sample: below U, hence below the ceiling.
      const calibrated = meta.evaluations[meta.evaluations.length - 1].bestRtp;
      expect(tier.gates.bestPoint.value).toBe(calibrated);
      expect(tier.gates.bestPoint.value!).toBeLessThanOrEqual(tier.calibration.u!);
      expect(tier.gates.bestPoint.pass).toBe(calibrated >= 0.94 && calibrated <= 0.96);
      expect(tier.gates.playPremium.pass).toBe(tier.best.rtp - 0.95 > 0);
      // 24,000 games are far below the 2M / 4M the symmetry test needs: it must not pass.
      expect(tier.gates.startSymmetry.sufficientSample).toBe(false);
      expect(tier.gates.startSymmetry.pass).toBe(false);
      expect(tier.pass).toBe(false);
    }
    expect(certification.pass).toBe(false);
  });

  it('AC-T9 a read-only check reproduces the certification from the cache and computes nothing; other code finds nothing', async () => {
    const checker = testRunner(directory, TINY, { readOnly: true });
    const again = await certifyTable(checker, paths, calibration.tablePath, calibration.table, calibration.meta);
    expect(checker.newUnits).toBe(0);
    expect({ ...again, generatedAt: '' }).toEqual({ ...certification, generatedAt: '' });
    // The check needs the chunk files and the metadata only: with the (untracked) trained tables gone it still succeeds.
    renameSync(join(paths.cache, 'artifacts'), join(paths.cache, 'artifacts-away'));
    try {
      const bare = testRunner(directory, TINY, { readOnly: true });
      const withoutTables = await certifyTable(bare, paths, calibration.tablePath, calibration.table, calibration.meta);
      expect({ ...withoutTables, generatedAt: '' }).toEqual({ ...certification, generatedAt: '' });
    } finally {
      renameSync(join(paths.cache, 'artifacts-away'), join(paths.cache, 'artifacts'));
    }
    const otherCode = testRunner(directory, TINY, { readOnly: true, codeHash: 'changed-code' });
    await expect(certifyTable(otherCode, paths, calibration.tablePath, calibration.table, calibration.meta)).rejects.toBeInstanceOf(CacheMiss);
  });

  it('a table without a calibration record cannot pass: the calibration claim is "missing"', async () => {
    const runner = testRunner(directory, TINY);
    const uncalibrated = await certifyTable(runner, paths, calibration.tablePath, calibration.table, null, [0]);
    expect(uncalibrated.complete).toBe(false);
    expect(uncalibrated.tiers[0].calibration.status).toBe('missing');
    expect(uncalibrated.tiers[0].calibration.pass).toBe(false);
    expect(uncalibrated.pass).toBe(false);
    // The partial run did not replace the complete record.
    const file = JSON.parse(readFileSync(paths.certifyJson, 'utf8')) as CertifyFile;
    expect(file.tables[calibration.meta.tableHash].complete).toBe(true);
  }, 300_000);

  it('screening the last tier stops after the reduced-sample stage and leaves the table uncalibrated', async () => {
    const runner = testRunner(directory, TINY);
    const screened = await calibrateCandidate(runner, paths, { ...SPEC, name: 'tiny-screened', screenLast: true });
    expect(screened.meta.tiers.map((tier) => tier.screened)).toEqual([false, true]);
    expect(screened.meta.tiers[1].evaluations).toEqual([]);
    expect(screened.table.calibration.calibrated).toBe(false);
    expect(screened.table.calibration.certifyKey).toBeNull();
    // The first tier was not computed again: same multiplier as before.
    expect(screened.meta.tiers[0].multiplierBps).toBe(calibration.meta.tiers[0].multiplierBps);
    expect(screened.tiers[1].coarseCells.map((cell) => cell.stream)).toEqual(screened.tiers[1].coarseCells.map(() => 'A'));
    expect(screened.tiers[1].coarseCells[0].games).toBe(12_000);
  }, 300_000);
});
