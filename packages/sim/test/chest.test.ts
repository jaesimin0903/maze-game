// AC-P8: the treasure-chest analysis (`pnpm sim:chest`, packages/sim/src/chest). Its mazes are on
// a stream of their own, every game asks the production chest rule about the cells it entered and
// nothing else (rule 2: path cells and the dead end it ended in), the counts add up, the
// points-counting person is the thoughtful person with a lowered cash-out value, and the money
// version's multiplier is what its formula says. The certification is not touched: these modules
// are outside the simulator code hash.

import { chestDraw, chestKindOf, chestPoints, loadTuning, type TuningTable } from '@maze/shared';
import { describe, expect, it } from 'vitest';
import { certifiedTiers } from '../src/attack/context';
import { createBot } from '../src/bots/index';
import { mergeGames, playGames, playSessions, PointsMinded, type GamesJob } from '../src/chest/jobs';
import { ChestFeed, chestFinalSeed, chestOfGame, chestStreamDisjoint, DeadEndSeeker } from '../src/chest/model';
import { InlineChestExecutor } from '../src/chest/pool';
import { renderMarkdown } from '../src/chest/report';
import { collectChestStats, type ChestRequest } from '../src/chest/run';
import { hashedFiles, simPackageRoot } from '../src/codehash';
import { createPolicy } from '../src/human/catalog';
import { NOVICE_DEFAULTS } from '../src/human/models';
import { Game, OUTCOME_CASH, OUTCOME_EXIT, OUTCOME_LOSS, play } from '../src/engine';
import { tierEconomicsOf } from '../src/tables';

const production: TuningTable = loadTuning();
const MIN_BET = production.limits.minBetWei;

function gamesJob(player: GamesJob['player'], tier: number, games: number, first = 0, rule = 2): GamesJob {
  return { kind: 'games', econ: tierEconomicsOf(production.tiers[tier]), player, noiseKey: 'test', first, games, betWei: MIN_BET, rule };
}

function request(overrides: Partial<ChestRequest>): ChestRequest {
  return {
    tables: [{ label: '기본 표', path: 'packages/shared/src/tuning.json', table: production, valueTables: null }],
    players: ['naive-greedy'],
    games: 2_000,
    sessions: 4,
    bankrollBets: 50,
    gameCap: 300,
    checkGames: 0,
    fitGames: 100,
    reachGames: 400,
    betWei: MIN_BET,
    seed: 0,
    rule: 2,
    ...overrides,
  };
}

describe('AC-P8: sim:chest', () => {
  it('AC-P8 plays mazes of its own stream and stays outside the simulator code hash', () => {
    expect(chestStreamDisjoint()).toBe(true);
    const hashed = hashedFiles(simPackageRoot()).map((file) => file.replaceAll('\\', '/'));
    expect(hashed.some((file) => file.includes('/src/chest/'))).toBe(false);
    expect(hashed.some((file) => file.endsWith('/shared/src/chest.ts'))).toBe(false);
  });

  it('AC-P8 asks the production chest rule about the cells a game entered: path cells, and the dead end it ended in', () => {
    expect(chestOfGame(7, 7, 12, 30)).toEqual(chestDraw(chestFinalSeed(7, 7, 12), 30, 2, 'dead-end'));
    expect(chestOfGame(7, 7, 12, 30, 2, 'path')).toEqual(chestDraw(chestFinalSeed(7, 7, 12), 30, 2, 'path'));
    expect(chestOfGame(7, 7, 12, 30, 1, 'path')).toEqual({ placed: false, rewardBps: 0 });
    // A game that ends in a loss ends on a dead end: one opening, not the start, not the exit;
    // every other cell it entered is a path cell, and so is the cell of a cash-out.
    const econ = tierEconomicsOf(production.tiers[1]);
    const g = new Game(econ);
    const feed = new ChestFeed(econ.w, econ.h);
    const maze = (open: Uint8Array) => ({ w: econ.w, h: econ.h, open });
    let losses = 0;
    for (let index = 0; index < 400; index++) {
      feed.load(index);
      play(g, new DeadEndSeeker(), feed.open, feed.rng);
      for (let i = 1; i < g.k; i++) expect(chestKindOf(maze(g.open), g.path[i])).toBe('path');
      if (g.outcome !== OUTCOME_LOSS) continue;
      losses += 1;
      expect([1, 2, 4, 8]).toContain(g.open[g.cell]);
      expect(chestKindOf(maze(g.open), g.cell)).toBe('dead-end');
    }
    expect(losses).toBeGreaterThan(380);
  });

  it('AC-P8 path chests: about 10% of the path cells a game enters, worth 2-5% of the bet; none under rule 1', () => {
    const naive: GamesJob['player'] = { kind: 'bot', spec: { bot: 'naive-greedy' } };
    const stats = playGames(gamesJob(naive, 1, 6_000));
    const pathCells = stats.steps - stats.wins - stats.losses;
    expect(Math.abs(stats.pathChests / pathCells - 0.1)).toBeLessThan(0.01);
    expect(stats.sumPathReward / stats.pathChests).toBeGreaterThan(330);
    expect(stats.sumPathReward / stats.pathChests).toBeLessThan(370);
    // The same games under rule 1: no path chests, and the dead ends exactly as under rule 2.
    const rule1 = playGames(gamesJob(naive, 1, 6_000, 0, 1));
    expect([rule1.pathChests, rule1.sumPathReward, rule1.pathPoints]).toEqual([0, 0, 0]);
    expect([rule1.chests, rule1.sumDeadReward, rule1.points, rule1.steps]).toEqual([
      stats.chests,
      stats.sumDeadReward,
      stats.points,
      stats.steps,
    ]);
    expect(stats.sumReward).toBe(stats.sumDeadReward + stats.sumPathReward);
  });

  it('AC-P8 the points maximiser never cashes out and ends nearly every game in a dead end', () => {
    const stats = playGames(gamesJob({ kind: 'seeker' }, 2, 3_000));
    expect(stats.cashouts).toBe(0);
    expect(stats.losses / stats.games).toBeGreaterThan(0.97);
    // About 30% of dead ends hold a chest, whoever walks into them.
    expect(Math.abs(stats.chests / stats.losses - 0.3)).toBeLessThan(0.03);
    expect(stats.sumDeadReward / stats.chests).toBeGreaterThan(1900);
    expect(stats.sumDeadReward / stats.chests).toBeLessThan(2100);
    expect(stats.pathChests).toBeGreaterThan(0);
  });

  it('AC-P8 counts points per award as the server does, and job splits add up exactly', () => {
    const naive: GamesJob['player'] = { kind: 'bot', spec: { bot: 'naive-greedy' } };
    const whole = playGames(gamesJob(naive, 0, 4_000));
    const first = playGames(gamesJob(naive, 0, 1_500));
    mergeGames(first, playGames(gamesJob(naive, 0, 2_500, 1_500)));
    expect(first).toEqual(whole);

    // The same games again by hand: every award is chestPoints(bet, reward), rounded down.
    const econ = tierEconomicsOf(production.tiers[0]);
    const g = new Game(econ);
    const bot = createBot({ bot: 'naive-greedy' }, g);
    const feed = new ChestFeed(econ.w, econ.h);
    let points = 0;
    let chests = 0;
    let pathPoints = 0;
    let pathChests = 0;
    for (let index = 0; index < 4_000; index++) {
      feed.load(index);
      play(g, bot, feed.open, feed.rng);
      const last = g.outcome === OUTCOME_CASH ? g.k : g.k - 1;
      for (let i = 1; i <= last; i++) {
        const draw = chestOfGame(g.w, g.h, index, g.path[i], 2, 'path');
        if (!draw.placed) continue;
        pathChests += 1;
        pathPoints += Number(chestPoints(BigInt(MIN_BET), draw.rewardBps));
      }
      if (g.outcome === OUTCOME_EXIT || g.outcome === OUTCOME_CASH) continue;
      const draw = chestOfGame(g.w, g.h, index, g.cell);
      if (!draw.placed) continue;
      chests += 1;
      points += Number(chestPoints(BigInt(MIN_BET), draw.rewardBps));
    }
    expect([whole.chests, whole.points, whole.pathChests, whole.pathPoints]).toEqual([chests, points, pathChests, pathPoints]);
    expect(points).toBeGreaterThan(0);
    expect(pathPoints).toBeGreaterThan(0);
  });

  it('AC-P8 a session stops when the bankroll cannot cover a bet, and its points never extend it', () => {
    const econ = tierEconomicsOf(production.tiers[0]);
    const sessions = playSessions({
      kind: 'sessions',
      econ,
      player: { kind: 'seeker' },
      noiseKey: 'test',
      first: 0,
      stride: 4096,
      firstSession: 0,
      sessions: 6,
      bankrollBets: 10,
      gameCap: 2_000,
      betWei: MIN_BET,
      rule: 2,
    });
    for (let s = 0; s < 6; s++) {
      // The seeker loses almost every bet, so ten bets last about ten games, chests or not.
      expect(sessions.games[s]).toBeGreaterThanOrEqual(10);
      expect(sessions.games[s]).toBeLessThan(40);
      // A chest of either kind is worth at most 30% of the minimum bet: 300 points.
      expect(sessions.points[s]).toBeLessThanOrEqual(sessions.chests[s] * 300);
    }
  });

  it('AC-P8 every row adds up: chest share of losses near 30%, points split by kind, money version = money + chest value, same request same result', async () => {
    const req = request({
      players: ['naive-greedy', 'novice', 'learning', 'thoughtful', 'thoughtful-points', 'dead-end-seeker'],
      games: 1_200,
    });
    const first = await collectChestStats(req, new InlineChestExecutor());
    const second = await collectChestStats(req, new InlineChestExecutor());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.rule).toMatchObject({ version: 2, path: { rateBps: 1000, rewardMinBps: 200, rewardMaxBps: 500 } });
    expect(first.tables[0].tiers).toHaveLength(3);
    for (const tier of first.tables[0].tiers) {
      expect(tier.rows).toHaveLength(6);
      for (const row of tier.rows) {
        expect(row.games).toBe(1_200);
        expect(row.moneyRtp.mean - row.rtp.mean).toBeCloseTo(row.chestEv.mean, 12);
        expect(row.pointsPerGame).toBeCloseTo(row.pathPointsPerGame + row.deadEndPointsPerGame, 9);
        if (row.lossRate > 0.3) expect(Math.abs(row.chestShareOfLosses - 0.3)).toBeLessThan(0.1);
        if (row.meanSteps > 3) expect(Math.abs(row.pathChestShareOfCells - 0.1)).toBeLessThan(0.05);
        expect(row.sessions?.sessions).toBe(4);
      }
      expect(tier.pointsMinded).not.toBeNull();
    }
    const markdown = renderMarkdown(first, { generatedAt: 'now', command: 'test', seconds: 0, workers: 0 });
    expect(markdown).toContain('막다른 길 사냥꾼');
    expect(markdown).toContain('판당 길 상자');
    expect(markdown).toContain('포인트를 세는 생각하는 사람');
  });

  it('AC-P8 the points-counting person is the thoughtful person with a lower cash-out value: the same at no bonus, and it walks at least as far', async () => {
    // The wrapper puts the refund table back after every decision.
    const econ = tierEconomicsOf(production.tiers[1]);
    const g = new Game(econ);
    const before = Float64Array.from(g.refund);
    const minded = new PointsMinded(createPolicy({ model: 'novice', params: NOVICE_DEFAULTS }, g), 500);
    const feed = new ChestFeed(econ.w, econ.h);
    feed.load(3);
    g.begin(feed.open, feed.rng);
    minded.startGame(feed.rng);
    minded.decide(g);
    expect(Array.from(g.refund)).toEqual(Array.from(before));

    const stats = await collectChestStats(
      request({ players: ['thoughtful', 'thoughtful-points'], games: 3_000, sessions: 2 }),
      new InlineChestExecutor(),
    );
    for (const tier of stats.tables[0].tiers) {
      const m = tier.pointsMinded!;
      expect(m.pointValue).toBe(1);
      // The bonus is the thoughtful person's chest reward per step, over the 2 steps it looks ahead.
      expect(m.bonusBps).toBeCloseTo(m.perStepBps * 2, 9);
      expect(m.perStepBps).toBeGreaterThan(0);
      expect(m.counting.meanSteps).toBeGreaterThanOrEqual(m.ignoring.meanSteps);
      expect(m.counting.cashRate).toBeLessThanOrEqual(m.ignoring.cashRate);
    }
    // With no bonus the two are the same person: same mazes, same noise, same games.
    const thoughtful = stats.tables[0].tiers[1].rows.find((row) => row.player === 'thoughtful')!;
    const human = { kind: 'human' as const, spec: { model: 'novice' as const, params: NOVICE_DEFAULTS }, career: 0 };
    expect(playGames(gamesJob({ ...human, pointsBonusBps: 0 }, 1, 2_000))).toEqual(playGames(gamesJob(human, 1, 2_000)));
    expect(thoughtful.games).toBe(3_000);
  });

  it('AC-P8 the money version multiplier offsets the chest value for the strongest certified strategy, and is checked by a paired run', async () => {
    const valueTables = (await certifiedTiers('production')).map((tier) => tier.valueTable);
    const stats = await collectChestStats(
      request({
        tables: [{ label: '기본 표', path: 'packages/shared/src/tuning.json', table: production, valueTables }],
        players: ['value-lsm'],
        games: 3_000,
        sessions: 2,
        checkGames: 2_000,
      }),
      new InlineChestExecutor(),
    );
    for (const tier of stats.tables[0].tiers) {
      const [cost] = tier.moneyCost;
      expect(cost.player).toBe('value-lsm');
      expect(cost.requiredMultiplierBps).toBe(Math.floor(tier.multiplierBps - (cost.chestEv * 10_000) / cost.winRate));
      expect(cost.requiredMultiplierBps).toBeLessThan(tier.multiplierBps);
      expect(cost.check?.games).toBe(2_000);
    }
    expect(stats.tables[0].population).toBeNull();
  });
});
