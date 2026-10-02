// `sim:stats`: statistics of individual games.
//
// The aggregation is checked against hand-computed sequences and against its own invariants on
// real games; the reuse of the engine is checked against the certification, exactly (a cached
// chunk is replayed game for game) and statistically (an independent sample agrees with
// certify.json); the report is checked to be one file that needs nothing else.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tableHash } from '@maze/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ChunkRecord } from '../src/cache';
import type { CertifyFile, TableCertification } from '../src/certify';
import { simCodeHash, simPackageRoot } from '../src/codehash';
import { OUTCOME_CASH, OUTCOME_EXIT, OUTCOME_LOSS, type ChunkStats, type TierEconomics } from '../src/engine';
import {
  collectPlayStats,
  crossCheck,
  mixGames,
  playerBot,
  recordInline,
  simulateSessions,
  STATS_FIRST_GAME,
  STATS_SEED_SPAN,
  summarizeGames,
  type CellStats,
  type PlayerId,
  type PlayStats,
  type Recorder,
  type StatsRequest,
} from '../src/playstats';
import { CODE_OUTCOMES, recordGames } from '../src/playstats-record';
import { renderReport, type RunInfo } from '../src/playstats-report';
import { Z_975 } from '../src/stats';
import { productionTablePath, readJsonFile, readTableFile, reportPaths, tierEconomicsOf } from '../src/tables';
import { temporaryDirectory } from './helpers';

const table = readTableFile(productionTablePath());
const certification: TableCertification = readJsonFile<CertifyFile>(reportPaths('production').certifyJson)!.tables[tableHash(table)];
const RUN: RunInfo = { generatedAt: '2026-01-02 03:04:05', command: 'pnpm sim:stats', seconds: 1, workers: 0, timings: [] };

function request(overrides: Partial<StatsRequest> = {}): StatsRequest {
  return {
    tables: [{ role: 'main', path: 'packages/shared/src/tuning.json', table, valueLsm: [], certification }],
    tiers: [0],
    players: ['random-walk', 'naive-greedy', 'sloppy-greedy', 'nervous'],
    games: 3_000,
    seed: 1,
    sessions: 300,
    bankroll: 50,
    rngMode: 'fast',
    codeHash: simCodeHash(),
    ...overrides,
  };
}

const code = (moves: number, outcome: number): number => moves * CODE_OUTCOMES + outcome;
const total = (values: number[]): number => values.reduce((a, b) => a + b, 0);

describe('summarizeGames: a hand-computed sequence', () => {
  // A 2x2 grid that pays 3.0 at the exit and refunds 0.5 after one move.
  const econ: TierEconomics = { w: 2, h: 2, multiplierBps: 30_000, refundBps: [9_500, 5_000, 2_000, 1_000] };
  // 3 exits, 47 dead ends, 1 cash-out, 1 exit, 48 dead ends: 100 games.
  const codes = Uint16Array.from([
    ...new Array<number>(3).fill(code(2, OUTCOME_EXIT)),
    ...new Array<number>(47).fill(code(1, OUTCOME_LOSS)),
    code(1, OUTCOME_CASH),
    code(2, OUTCOME_EXIT),
    ...new Array<number>(48).fill(code(1, OUTCOME_LOSS)),
  ]);
  const summary = summarizeGames(codes, econ);

  it('counts outcomes, ending steps and payouts', () => {
    expect(summary.games).toBe(100);
    expect(summary.outcomes).toEqual({ exit: 4, deadEnd: 95, cashOut: 1 });
    expect(summary.rates).toEqual({ exit: 0.04, deadEnd: 0.95, cashOut: 0.01 });
    expect(summary.endStep).toEqual({ exit: [0, 0, 4], deadEnd: [0, 95, 0], cashOut: [0, 1, 0] });
    expect(summary.payouts).toEqual([
      { kind: 'dead-end', multiple: 0, step: null, games: 95, share: 0.95 },
      { kind: 'cash-out', multiple: 0.5, step: 1, games: 1, share: 0.01 },
      { kind: 'exit', multiple: 3, step: null, games: 4, share: 0.04 },
    ]);
    expect(summary.meanSteps).toBeCloseTo((4 * 2 + 96 * 1) / 100, 12);
  });

  it('returns total payout over total stake, with the sample deviation of one game', () => {
    // Payouts: 4 × 3.0 + 1 × 0.5 over 100 bets.
    expect(summary.rtp.mean).toBeCloseTo(0.125, 12);
    expect(summary.houseHold.value).toBeCloseTo(0.875, 12);
    const sd = Math.sqrt((4 * 9 + 0.25 - 100 * 0.125 ** 2) / 99);
    expect(summary.rtp.sd).toBeCloseTo(sd, 12);
    expect(summary.rtp.halfWidth).toBeCloseTo((Z_975 * sd) / 10, 12);
    expect(summary.winRate.value).toBe(0.04);
    expect(summary.winRate.ci95[0]).toBeGreaterThan(0.01);
    expect(summary.winRate.ci95[1]).toBeLessThan(0.1);
    // One checkpoint (100 games), and it is the whole run.
    expect(summary.convergence).toEqual([{ games: 100, rtp: summary.rtp.mean, lo: summary.rtp.ci95[0], hi: summary.rtp.ci95[1] }]);
    expect(summary.noise[0].games).toBe(100);
    expect(summary.noise[0].halfWidth).toBeCloseTo(summary.rtp.halfWidth, 12);
    expect(summary.noise[1].halfWidth).toBeCloseTo(summary.rtp.halfWidth / Math.sqrt(10), 12);
  });

  it("follows the house's cumulative profit: where it is behind, its largest fall, its longest stay below a high", () => {
    const profit = summary.houseProfit;
    // −2, −4, −6, then +1 per dead end: zero again after game 9; 41.5 after the cash-out, 39.5 after the exit.
    expect(profit.games).toHaveLength(100);
    expect(profit.profit.slice(0, 4)).toEqual([-2, -4, -6, -5]);
    expect(profit.profit[50]).toBe(41.5);
    expect(profit.profit[51]).toBe(39.5);
    expect(profit.final).toBe(87.5);
    expect(profit.lowest).toEqual({ game: 3, profit: -6 });
    expect(profit.behind).toEqual({ games: 8, share: 0.08, lastGame: 8 });
    expect(profit.maxDrawdown).toEqual({ bets: 6, peakGame: 0, peakProfit: 0, troughGame: 3, troughProfit: -6 });
    expect(profit.longestBelowPeak).toBe(8);
  });

  it('measures runs of games without a win', () => {
    // Two runs of 48: games 4..51 and 53..100.
    expect(summary.streaks.longest).toBe(48);
    expect(summary.streaks.windows).toBe(1);
    expect(summary.streaks.longestInWindow[48]).toBe(1);
    expect(total(summary.streaks.longestInWindow)).toBe(1);
    const byLength = new Map(summary.streaks.inARow.map((row) => [row.k, row]));
    expect(byLength.get(1)!.observed).toBeCloseTo(96 / 100, 12);
    expect(byLength.get(2)!.observed).toBeCloseTo((47 + 47) / 99, 12);
    expect(byLength.get(30)!.observed).toBeCloseTo((19 + 19) / 71, 12);
    expect(byLength.get(50)!.observed).toBe(0);
    expect(byLength.get(3)!.independent).toBeCloseTo(0.96 ** 3, 12);
    // The list stops at the first length that never occurred.
    expect(summary.streaks.inARow[summary.streaks.inARow.length - 1].k).toBe(50);
  });
});

describe('simulateSessions', () => {
  it('a player who always loses lasts exactly as many games as the bankroll has bets', () => {
    const sessions = simulateSessions({ payout: [0], probability: [1] }, { bankroll: 5, sessions: 40, gameCap: 30, seed: 7n });
    expect(sessions.gamesPlayed).toEqual({ p10: 5, median: 5, p90: 5 });
    expect(sessions.ruinedShare).toBe(1);
    expect(sessions.everAheadShare).toBe(0);
    expect(sessions.medianCapped).toBe(false);
    const at = (games: number): number => sessions.survival.share[sessions.survival.games.indexOf(games)];
    expect(sessions.stride).toBe(1);
    expect(at(0)).toBe(1);
    expect(at(4)).toBe(1);
    expect(at(5)).toBe(0);
    expect(at(30)).toBe(0);
    expect(sessions.paths[0]).toEqual({ values: [5, 4, 3, 2, 1, 0], games: 5, final: 0 });
  });

  it('a player who always wins is never ruined and the median is reported as capped', () => {
    const sessions = simulateSessions({ payout: [2], probability: [1] }, { bankroll: 5, sessions: 10, gameCap: 30, seed: 7n });
    expect(sessions.gamesPlayed.median).toBe(30);
    expect(sessions.medianCapped).toBe(true);
    expect(sessions.ruinedShare).toBe(0);
    expect(sessions.everAheadShare).toBe(1);
    expect(sessions.aheadAtEndShare).toBe(1);
    expect(sessions.survival.share.every((share) => share === 1)).toBe(true);
    expect(sessions.paths[0].final).toBe(35);
  });
});

describe('mixGames', () => {
  const games = (value: number): Uint16Array => new Uint16Array(4_000).fill(value);
  const records = { 'naive-greedy': games(1), 'sloppy-greedy': games(2), nervous: games(3), 'random-walk': games(4), best: games(5) };
  const population = { 'naive-greedy': 0.35, 'sloppy-greedy': 0.25, nervous: 0.2, 'random-walk': 0.05, best: 0.15 };

  it('takes every game from the member drawn for it, in the assumed proportions', () => {
    const only = mixGames(records, { 'naive-greedy': 0, 'sloppy-greedy': 0, nervous: 1, 'random-walk': 0, best: 0 }, 1n);
    expect(only.every((value) => value === 3)).toBe(true);
    const mixed = mixGames(records, population, 1n);
    const share = (value: number): number => mixed.filter((entry) => entry === value).length / mixed.length;
    expect(share(1)).toBeCloseTo(0.35, 1);
    expect(share(2)).toBeCloseTo(0.25, 1);
    expect(share(4)).toBeCloseTo(0.05, 1);
    expect(mixGames(records, population, 1n)).toEqual(mixed);
  });
});

describe('collectPlayStats: invariants on real games', () => {
  let stats: PlayStats;
  let cells: CellStats[];

  beforeAll(async () => {
    stats = await collectPlayStats(request(), recordInline);
    cells = stats.tables[0].tiers[0].cells;
  });

  it('runs the requested cells on games the certification did not play', () => {
    expect(cells.map((cell) => cell.player)).toEqual(['random-walk', 'naive-greedy', 'sloppy-greedy', 'nervous']);
    expect(stats.options.firstGame).toBe(STATS_FIRST_GAME + STATS_SEED_SPAN);
    // nervous is the only one of the four that cashes out; random-walk wins least.
    expect(cells[3].rates.cashOut).toBeGreaterThan(0.3);
    expect(cells[1].rates.cashOut).toBe(0);
    expect(cells[0].winRate.value).toBeLessThan(cells[1].winRate.value);
  });

  it('rates sum to 1 and every histogram accounts for every game', () => {
    for (const cell of cells) {
      const n = cell.games;
      expect(n).toBe(3_000);
      expect(cell.rates.exit + cell.rates.deadEnd + cell.rates.cashOut).toBeCloseTo(1, 12);
      expect(cell.outcomes.exit + cell.outcomes.deadEnd + cell.outcomes.cashOut).toBe(n);
      expect(total(cell.endStep.exit)).toBe(cell.outcomes.exit);
      expect(total(cell.endStep.deadEnd)).toBe(cell.outcomes.deadEnd);
      expect(total(cell.endStep.cashOut)).toBe(cell.outcomes.cashOut);
      expect(total(cell.payouts.map((level) => level.games))).toBe(n);
      expect(total(cell.payouts.map((level) => level.share))).toBeCloseTo(1, 12);
      expect(total(cell.streaks.longestInWindow)).toBe(cell.streaks.windows);
      expect(cell.streaks.windows).toBe(30);
      expect(cell.houseProfit.games[cell.houseProfit.games.length - 1]).toBe(n);
      expect(cell.houseProfit.games.length).toBeLessThanOrEqual(300);
    }
  });

  it('the return is total payout over total stake, and the house keeps the rest', () => {
    for (const cell of cells) {
      const paid = total(cell.payouts.map((level) => level.multiple * level.games));
      expect(cell.rtp.mean).toBeCloseTo(paid / cell.games, 10);
      expect(cell.houseHold.value).toBeCloseTo(1 - paid / cell.games, 10);
      expect(cell.houseProfit.final).toBeCloseTo(cell.games - paid, 6);
      expect(cell.rtp.ci95[0]).toBeLessThan(cell.rtp.mean);
      expect(cell.rtp.ci95[1]).toBeGreaterThan(cell.rtp.mean);
      const last = cell.convergence[cell.convergence.length - 1];
      expect(last).toEqual({ games: cell.games, rtp: cell.rtp.mean, lo: cell.rtp.ci95[0], hi: cell.rtp.ci95[1] });
      expect(cell.convergence.map((row) => row.games)).toEqual([100, 200, 500, 1_000, 2_000, 3_000]);
      // More games, narrower interval (the deviation is the cell's own).
      for (let i = 1; i < cell.noise.length; i++) expect(cell.noise[i].halfWidth).toBeLessThan(cell.noise[i - 1].halfWidth);
    }
  });

  it('bankroll survival starts at 1, never increases and agrees with the ruined share', () => {
    for (const cell of cells) {
      const sessions = cell.sessions!;
      const { share, games } = sessions.survival;
      expect(share[0]).toBe(1);
      for (let i = 1; i < share.length; i++) expect(share[i]).toBeLessThanOrEqual(share[i - 1]);
      expect(games[games.length - 1]).toBe(sessions.gameCap);
      expect(share[share.length - 1]).toBeCloseTo(1 - sessions.ruinedShare, 12);
      expect(sessions.gamesPlayed.p10).toBeLessThanOrEqual(sessions.gamesPlayed.median);
      expect(sessions.gamesPlayed.median).toBeLessThanOrEqual(sessions.gamesPlayed.p90);
      expect(sessions.paths.length).toBeGreaterThan(0);
      // A session needs at least `bankroll` games to lose `bankroll` bets.
      expect(sessions.gamesPlayed.p10).toBeGreaterThanOrEqual(sessions.bankroll);
    }
  });

  it('value-lsm without a trained table is left out and reported, and so is the mix that needs it', async () => {
    const result = await collectPlayStats(request({ players: ['random-walk', 'naive-greedy', 'sloppy-greedy', 'nervous', 'value-lsm'], games: 200 }), recordInline);
    const tier = result.tables[0].tiers[0];
    expect(tier.cells.map((cell) => cell.player)).toEqual(['random-walk', 'naive-greedy', 'sloppy-greedy', 'nervous']);
    expect(tier.unavailable).toEqual([
      { player: 'value-lsm', reason: 'no-value-table' },
      { player: 'mix', reason: 'mix-needs-every-member' },
    ]);
    expect(result.tables[0].population).toBeNull();
    expect(playerBot('value-lsm', null)).toBeNull();
  });

  it('rejects a request outside its limits', async () => {
    await expect(collectPlayStats(request({ games: 99 }), recordInline)).rejects.toThrow(/games must be an integer/);
    await expect(collectPlayStats(request({ seed: -1 }), recordInline)).rejects.toThrow(/seed must be an integer/);
    await expect(collectPlayStats(request({ tiers: [3] }), recordInline)).rejects.toThrow(/has no tier 3/);
  });
});

describe('determinism', () => {
  it('the same request gives identical JSON, however the games are split between threads', async () => {
    const first = await collectPlayStats(request({ games: 12_000 }), recordInline);
    // A recorder that plays every job in two halves, as two workers would.
    const halves: Recorder = (job) => {
      const middle = job.from + Math.floor((job.to - job.from) / 2);
      const [a, b] = [recordGames({ ...job, to: middle }), recordGames({ ...job, from: middle })];
      const codes = new Uint16Array(a.length + b.length);
      codes.set(a, 0);
      codes.set(b, a.length);
      return Promise.resolve(codes);
    };
    const second = await collectPlayStats(request({ games: 12_000 }), halves);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const other = await collectPlayStats(request({ games: 12_000, seed: 2 }), recordInline);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(first));
  });
});

describe('agreement with the certification', () => {
  it('replays a cached certification chunk game for game: same wins, dead ends, cash-outs by step and moves', () => {
    // Establishes: recording uses the engine, the mazes and the bot exactly as the certification did.
    const cell = certification.tiers[0].cells.find((entry) => entry.bot === 'nervous(0.10)')!;
    const path = join(reportPaths('production').cache, cell.key, 'chunk-1.json');
    const chunk = JSON.parse(readFileSync(path, 'utf8')) as ChunkRecord<ChunkStats>;
    const econ = tierEconomicsOf(table.tiers[0]);
    const codes = recordGames({ econ, bot: playerBot('nervous', null)!, source: { kind: 'rng', mode: 'fast', stream: 'B' }, from: chunk.from, to: chunk.to });
    const summary = summarizeGames(codes, econ);
    expect(chunk.stats.n).toBe(1_000_000);
    expect(summary.games).toBe(chunk.stats.n);
    expect(summary.outcomes.exit).toBe(chunk.stats.wins);
    expect(summary.outcomes.deadEnd).toBe(chunk.stats.losses);
    expect(summary.endStep.cashOut).toEqual(chunk.stats.cash.slice(0, summary.endStep.cashOut.length));
    expect(summary.outcomes.cashOut).toBe(total(chunk.stats.cash));
    expect(Math.round(summary.meanSteps * summary.games)).toBe(chunk.stats.steps);
    expect(summary.rtp.mean).toBeCloseTo(chunk.stats.sum / chunk.stats.n / 10_000, 12);
  });

  it('judges a sample by the deviation of one game that the certified cell implies, not by the sample\'s own', () => {
    // Establishes: a small sample without a single win (own deviation zero) is still judged against a real interval.
    const econ = tierEconomicsOf(table.tiers[0]);
    const naive = certification.tiers[0].cells.find((entry) => entry.bot === 'naive-greedy')!;
    const allLost = summarizeGames(new Uint16Array(100).fill(code(3, OUTCOME_LOSS)), econ);
    expect(allLost.rtp.sd).toBe(0);
    const check = crossCheck('naive-greedy', allLost, naive, econ);
    // For a sampled cell the implied deviation is the certified one (up to the n − 1 divisor).
    expect(check.se * Math.sqrt(100)).toBeCloseTo(naive.sd, 5);
    expect(check.halfWidth).toBeCloseTo(Z_975 * Math.hypot(naive.sd / 10, naive.se), 5);
    // 100 dead ends in a row are not what naive-greedy does on 5x5 (it wins a third of its games).
    expect(check.difference).toBeCloseTo(-naive.rtp, 12);
    expect(check.agrees).toBe(false);
    // random-walk is certified by exact expectation; its played deviation is M × sqrt(p (1 − p)).
    const walk = certification.tiers[0].cells.find((entry) => entry.bot === 'random-walk')!;
    expect(walk.expected).toBe(true);
    const played = crossCheck('random-walk', allLost, walk, econ);
    const p = walk.winRate;
    expect(played.se * 10).toBeCloseTo((econ.multiplierBps / 10_000) * Math.sqrt(p * (1 - p)), 6);
    expect(played.se * 10).toBeGreaterThan(3 * walk.sd);
  });

  it('an independent sample agrees with certify.json within the combined 95% interval, on every tier', async () => {
    // Games the certification never played (the indexes start at 2^32), so the two estimates are independent.
    const players: PlayerId[] = ['random-walk', 'naive-greedy', 'sloppy-greedy', 'nervous'];
    const stats = await collectPlayStats(request({ tiers: null, players, games: 200_000, sessions: 100 }), recordInline);
    const checks = stats.tables[0].tiers.flatMap((tier) => tier.crossCheck.map((check) => ({ n: tier.n, ...check })));
    expect(checks).toHaveLength(12);
    for (const check of checks) {
      expect(check.certifiedGames).toBeGreaterThanOrEqual(3_000_000);
      expect(check.halfWidth).toBeCloseTo(Z_975 * Math.hypot(check.se, check.certifiedSe), 12);
      expect.soft(Math.abs(check.difference), `${check.n}x${check.n} ${check.player}: ${check.rtp} vs certified ${check.certifiedRtp}`).toBeLessThanOrEqual(check.halfWidth);
      expect.soft(check.agrees).toBe(true);
    }
    expect(stats.tables[0].certified).toBe(true);
  });
});

describe('report.html', () => {
  it('is one self-contained file that embeds the data', async () => {
    const stats = await collectPlayStats(request({ games: 1_000 }), recordInline);
    const html = renderReport(stats, RUN);
    // Nothing is fetched: no absolute URL anywhere, no linked resource, no script or image source.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(html).toContain('<html lang="ko">');
    const embedded = /<script type="application\/json" id="stats-data">(.*?)<\/script>/s.exec(html);
    expect(embedded).not.toBeNull();
    expect(JSON.parse(embedded![1])).toEqual(JSON.parse(JSON.stringify(stats)));
    const run = /<script type="application\/json" id="run-data">(.*?)<\/script>/s.exec(html);
    expect(JSON.parse(run![1])).toEqual(RUN);
    // The style sheet and the script are inline.
    expect(html).toContain('.viz-root');
    expect(html).toContain("document.getElementById('stats-data')");
    expect(html.match(/<script/g)).toHaveLength(3);
  });

  it('data cannot close its script block', async () => {
    const stats = await collectPlayStats(request({ games: 100, players: ['naive-greedy'] }), recordInline);
    stats.tables[0].path = '</script><b>x</b>';
    const html = renderReport(stats, RUN);
    expect(html).not.toContain('</script><b>');
    const embedded = /<script type="application\/json" id="stats-data">(.*?)<\/script>/s.exec(html);
    expect((JSON.parse(embedded![1]) as PlayStats).tables[0].path).toBe('</script><b>x</b>');
  });
});

describe('sim:stats command line', () => {
  function run(out: string, ...extra: string[]): { status: number | null; output: string } {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(simPackageRoot(), 'src', 'cli.ts'), 'stats', '--workers', '0', '--games', '1000', '--sessions', '200', '--tier', '0', '--bots', 'naive-greedy,nervous', '--out', out, ...extra],
      { cwd: simPackageRoot(), encoding: 'utf8' },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('writes stats.json and report.html, prints a summary, and the JSON is byte-identical on a second run', () => {
    const [a, b] = [join(temporaryDirectory(), 'a'), join(temporaryDirectory(), 'b')];
    const first = run(a);
    expect(first.output).toMatch(/sim:stats RESULT exit=0 json=.*stats\.json html=.*report\.html/);
    expect(first.status).toBe(0);
    expect(first.output).toContain('naive-greedy');
    expect(first.output).toContain('출구 방향 플레이어');
    expect(first.output).toMatch(/인증 교차검증: 2개 조합/);
    expect(run(b).status).toBe(0);
    const json = readFileSync(join(a, 'stats.json'));
    expect(json.equals(readFileSync(join(b, 'stats.json')))).toBe(true);
    const stats = JSON.parse(json.toString('utf8')) as PlayStats;
    expect(stats.options).toMatchObject({ games: 1_000, seed: 1, sessions: 200, bankroll: 50 });
    expect(stats.tables[0].tiers.map((tier) => tier.n)).toEqual([5]);
    expect(stats.tables[0].tiers[0].cells.map((cell) => cell.player)).toEqual(['naive-greedy', 'nervous']);
    const html = readFileSync(join(a, 'report.html'), 'utf8');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('id="stats-data"');
  });

  it('refuses unknown player types, tiers the table does not have and too few games', () => {
    const out = join(temporaryDirectory(), 'out');
    const bots = run(out, '--bots', 'naive-greedy,nobody');
    expect(bots.status).toBe(1);
    expect(bots.output).toMatch(/--bots must be "all" or a comma-separated list/);
    const tier = run(out, '--tier', '7');
    expect(tier.status).toBe(1);
    expect(tier.output).toMatch(/--tier must be "all" or distinct tier indexes/);
    const games = run(out, '--games', '10');
    expect(games.status).toBe(1);
    expect(games.output).toMatch(/--games must be an integer in 100 \.\./);
  });
});
