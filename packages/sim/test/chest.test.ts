// AC-P8: the treasure-chest analysis (`pnpm sim:chest`, packages/sim/src/chest). Its mazes are on
// a stream of their own, every game asks the production chest rule about the dead end it ended
// in and nothing else, the counts add up, and the money version's multiplier is what its formula
// says. The certification is not touched: these modules are outside the simulator code hash.

import { chestDraw, chestPoints, loadTuning, type TuningTable } from '@maze/shared';
import { describe, expect, it } from 'vitest';
import { certifiedTiers } from '../src/attack/context';
import { createBot } from '../src/bots/index';
import { mergeGames, playGames, playSessions, type GamesJob } from '../src/chest/jobs';
import { ChestFeed, chestFinalSeed, chestOfGame, chestStreamDisjoint, DeadEndSeeker } from '../src/chest/model';
import { InlineChestExecutor } from '../src/chest/pool';
import { renderMarkdown } from '../src/chest/report';
import { collectChestStats, type ChestRequest } from '../src/chest/run';
import { hashedFiles, simPackageRoot } from '../src/codehash';
import { Game, OUTCOME_LOSS, play } from '../src/engine';
import { tierEconomicsOf } from '../src/tables';

const production: TuningTable = loadTuning();
const MIN_BET = production.limits.minBetWei;

function gamesJob(player: GamesJob['player'], tier: number, games: number, first = 0): GamesJob {
  return { kind: 'games', econ: tierEconomicsOf(production.tiers[tier]), player, noiseKey: 'test', first, games, betWei: MIN_BET };
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

  it('AC-P8 asks the production chest rule (v1) about the dead end a game ended in', () => {
    expect(chestOfGame(7, 7, 12, 30)).toEqual(chestDraw(chestFinalSeed(7, 7, 12), 30));
    // A game that ends in a loss ends on a chest site: one opening, not the start, not the exit.
    const econ = tierEconomicsOf(production.tiers[1]);
    const g = new Game(econ);
    const feed = new ChestFeed(econ.w, econ.h);
    let losses = 0;
    for (let index = 0; index < 400; index++) {
      feed.load(index);
      play(g, new DeadEndSeeker(), feed.open, feed.rng);
      if (g.outcome !== OUTCOME_LOSS) continue;
      losses += 1;
      expect([1, 2, 4, 8]).toContain(g.open[g.cell]);
      expect(g.cell).not.toBe(0);
      expect(g.cell).not.toBe(g.exit);
    }
    expect(losses).toBeGreaterThan(380);
  });

  it('AC-P8 the points maximiser never cashes out and ends nearly every game in a dead end', () => {
    const stats = playGames(gamesJob({ kind: 'seeker' }, 2, 3_000));
    expect(stats.cashouts).toBe(0);
    expect(stats.losses / stats.games).toBeGreaterThan(0.97);
    // About 30% of dead ends hold a chest, whoever walks into them.
    expect(Math.abs(stats.chests / stats.losses - 0.3)).toBeLessThan(0.03);
    expect(stats.sumReward / stats.chests).toBeGreaterThan(1900);
    expect(stats.sumReward / stats.chests).toBeLessThan(2100);
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
    for (let index = 0; index < 4_000; index++) {
      feed.load(index);
      play(g, bot, feed.open, feed.rng);
      if (g.outcome !== OUTCOME_LOSS) continue;
      const draw = chestOfGame(g.w, g.h, index, g.cell);
      if (!draw.placed) continue;
      chests += 1;
      points += Number(chestPoints(BigInt(MIN_BET), draw.rewardBps));
    }
    expect([whole.chests, whole.points]).toEqual([chests, points]);
    expect(points).toBeGreaterThan(0);
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
    });
    for (let s = 0; s < 6; s++) {
      // The seeker loses almost every bet, so ten bets last about ten games, chests or not.
      expect(sessions.games[s]).toBeGreaterThanOrEqual(10);
      expect(sessions.games[s]).toBeLessThan(40);
      expect(sessions.points[s]).toBeLessThanOrEqual(sessions.chests[s] * 300);
    }
  });

  it('AC-P8 every row adds up: chest share of losses near 30%, money version = money + chest value, same request same result', async () => {
    const req = request({ players: ['naive-greedy', 'novice', 'learning', 'thoughtful', 'dead-end-seeker'], games: 1_200 });
    const first = await collectChestStats(req, new InlineChestExecutor());
    const second = await collectChestStats(req, new InlineChestExecutor());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.tables[0].tiers).toHaveLength(3);
    for (const tier of first.tables[0].tiers) {
      expect(tier.rows).toHaveLength(5);
      for (const row of tier.rows) {
        expect(row.games).toBe(1_200);
        expect(row.moneyRtp.mean - row.rtp.mean).toBeCloseTo(row.chestEv.mean, 12);
        if (row.lossRate > 0.3) expect(Math.abs(row.chestShareOfLosses - 0.3)).toBeLessThan(0.1);
        expect(row.sessions?.sessions).toBe(4);
      }
    }
    const markdown = renderMarkdown(first, { generatedAt: 'now', command: 'test', seconds: 0, workers: 0 });
    expect(markdown).toContain('막다른 길 사냥꾼');
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
