// `sim:human`: models of people, the learnable-rule search, bankroll sessions and the report.
//
// Legality is checked twice: the maze is wrapped so that every read of a cell the player has not
// stood on is counted (with a cheating policy as the negative control), and the unseen part of
// the maze is redrawn from the exact posterior, after which the decisions must not change. The
// rule search's after-the-fact scoring is checked against playing the rules, the aggregations
// against hand-computed numbers, and the naive-greedy-equivalent parameters against the
// certified naive-greedy, move for move and in return.

import { tableHash, type Rng } from '@maze/shared';
import { describe, expect, it } from 'vitest';
import { NaiveGreedy } from '../src/bots/naive-greedy';
import type { Bot } from '../src/bots/types';
import type { CertifyFile, TableCertification } from '../src/certify';
import { simCodeHash } from '../src/codehash';
import { CASH_OUT, FREE, Game, OUTCOME_CASH, OUTCOME_EXIT, OUTCOME_LOSS, play, VISITED } from '../src/engine';
import { crossCheck, summarizeGames } from '../src/playstats';
import { Posterior, samplePosteriorMaze, WilsonScratch } from '../src/posterior';
import { ownerOfSeed } from '../src/streams';
import { productionTablePath, readJsonFile, readTableFile, reportPaths, tierEconomicsOf } from '../src/tables';
import { fitSoftmax } from '../src/human/calibrate';
import { createPolicy, type ModelSpec } from '../src/human/catalog';
import { Cues, WALLED } from '../src/human/cues';
import { firstIndex, HumanFeed, humanGameSeed, humanStreamDisjoint, NoiseSource, SEED_SPAN } from '../src/human/feed';
import { CODE_OUTCOMES, playGames, searchMovePart } from '../src/human/jobs';
import { AVERAGE_AS_NAIVE, AVERAGE_DEFAULTS, LEARNING_DEFAULTS, LearningPlayer, NOVICE_DEFAULTS, THOUGHTFUL_DEFAULTS, type HumanPolicy, type ResolvedThoughtful } from '../src/human/models';
import { InlineHumanExecutor } from '../src/human/pool';
import { cashOutUtility, goOnUtility, indifferenceChance, RISK_NEUTRAL, TK1992, weight } from '../src/human/prospect';
import { renderReport } from '../src/human/report';
import { NAIVE_RULE, RulePlayer, type RuleParams, type StopScore } from '../src/human/rules';
import { collectHumanStats, learningCurve, population, type HumanRequest, type TierHuman } from '../src/human/run';
import { describeRule } from '../src/human/search';
import { baselineRules, END_BROKE, END_CAP, END_GOAL, END_RUN, runSessions, summarizeSessions, variantRules, type SessionColumns } from '../src/human/sessions';

const table = readTableFile(productionTablePath());
const certification: TableCertification | null = readJsonFile<CertifyFile>(reportPaths('production').certifyJson)?.tables[tableHash(table)] ?? null;
const ECON5 = tierEconomicsOf(table.tiers[0]);
const ECON7 = tierEconomicsOf(table.tiers[1]);

/** A maze generator that must never be drawn from: the models have their own. */
const POISON: Rng = {
  nextU32: () => {
    throw new Error('a model drew from the maze generator');
  },
  nextBelow: () => {
    throw new Error('a model drew from the maze generator');
  },
};

const THOUGHTFUL: ResolvedThoughtful = {
  ...THOUGHTFUL_DEFAULTS,
  cue: { route: 3, space: 0.4, toward: 0.1, diagonal: 0.2 },
  reach: Array.from({ length: 26 }, (_, r) => Math.max(0.05, 1 - r / 12)),
};

/** One of every model and rule shape, with parameters that switch every behaviour on. */
const SPECS: { label: string; spec: ModelSpec }[] = [
  { label: 'novice', spec: { model: 'novice', params: NOVICE_DEFAULTS } },
  { label: 'average', spec: { model: 'average', params: AVERAGE_DEFAULTS } },
  { label: 'average (jumpy)', spec: { model: 'average', params: { ...AVERAGE_DEFAULTS, lapse: 0.3, scareQuit: 0.6, pocketLimit: 30 } } },
  { label: 'thoughtful', spec: { model: 'thoughtful', params: THOUGHTFUL } },
  { label: 'thoughtful (ideal)', spec: { model: 'thoughtful', params: { ...THOUGHTFUL, perception: 0, gutNoise: 0, prospect: RISK_NEUTRAL } } },
  { label: 'learning', spec: { model: 'learning', params: { ...LEARNING_DEFAULTS, startAttention: 0.5, explore: 0.5 } } },
  {
    label: 'rule (two conditions)',
    spec: {
      model: 'rule',
      params: {
        avoidWalled: true,
        move: 'space',
        stops: [
          { forks: 'even', minDistance: 2, maxStep: 3 },
          { forks: 'away', minDistance: 0, maxStep: 9 },
        ],
      },
    },
  },
  { label: 'rule (route)', spec: { model: 'rule', params: { avoidWalled: false, move: 'route', stops: [{ forks: 'any', minDistance: 3, maxStep: 1 }] } } },
  { label: 'rule (naive)', spec: { model: 'rule', params: NAIVE_RULE } },
];

/** Counts reads of `open` at cells that are not VISITED, except while `state.over` (the game is over and the maze is public). */
function watched(open: Uint8Array, g: Game, state: { reads: number; illegal: number; over: boolean }): Uint8Array {
  return new Proxy(open, {
    get(target, property) {
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        const cell = Number(property);
        state.reads += 1;
        if (!state.over && g.status[cell] !== VISITED) state.illegal += 1;
        return target[cell];
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Plays games with the maze wrapped. One person plays them all, so a learning player carries its memory over. */
function playWatched(spec: ModelSpec, games = 200): { reads: number; illegal: number } {
  const g = new Game(ECON7);
  const policy = createPolicy(spec, g);
  const feed = new HumanFeed(7, 7);
  const noise = new NoiseSource('test/legality');
  const state = { reads: 0, illegal: 0, over: false };
  policy.newPlayer(noise.at(0));
  for (let i = 0; i < games; i++) {
    feed.load(firstIndex('train', 3) + i);
    state.over = false;
    policy.startGame(noise.at(i + 1));
    play(g, policy, watched(feed.open, g, state), POISON);
    state.over = true;
    policy.endGame(g);
  }
  return state;
}

/** Child directions a policy chooses over one game, or -1 for a cash-out; its own draws come from `rng()`. */
function decisions(g: Game, policy: HumanPolicy, open: Uint8Array, rng: () => Rng, limit = Number.POSITIVE_INFINITY): number[] {
  const draws = rng();
  policy.newPlayer(draws);
  policy.startGame(draws);
  g.begin(open, POISON);
  policy.begin(g);
  const out: number[] = [];
  while (out.length < limit) {
    const action = policy.decide(g);
    out.push(action === CASH_OUT ? -1 : g.childDir[action]);
    if (action === CASH_OUT) break;
    g.advance(action);
    if (g.cell === g.exit || g.nc === 0) break;
  }
  return out;
}

describe('the maze stream of sim:human', () => {
  it('meets none of the certification streams A..E', () => {
    expect(humanStreamDisjoint()).toBe(true);
    const last = firstIndex('sessions', 2 ** 36 / SEED_SPAN - 1) + SEED_SPAN - 1;
    for (const n of [5, 7, 9, 10]) {
      for (const index of [0, firstIndex('eval', 0), firstIndex('sessions', 0), last, 2 ** 40 - 1]) expect(ownerOfSeed(humanGameSeed(n, n, index))).toBeNull();
    }
  });

  it('keeps training, evaluation and session games apart for every seed', () => {
    const seeds = 2 ** 36 / SEED_SPAN;
    expect(firstIndex('train', seeds - 1) + SEED_SPAN).toBeLessThanOrEqual(firstIndex('eval', 0));
    expect(firstIndex('eval', seeds - 1) + SEED_SPAN).toBeLessThanOrEqual(firstIndex('sessions', 0));
    expect(() => firstIndex('eval', seeds)).toThrow(RangeError);
  });
});

describe('legality: the models decide from what the player has seen', () => {
  it('no model reads a wall of a cell it has not stood on, and none draws from the maze generator', () => {
    for (const { label, spec } of SPECS) {
      const counts = playWatched(spec);
      expect(counts.reads, label).toBeGreaterThan(0);
      expect(counts.illegal, label).toBe(0);
    }
  });

  it('the instrumentation catches a policy that peeks (negative control)', () => {
    const peeker: HumanPolicy = {
      newPlayer: () => {},
      startGame: () => {},
      begin: () => {},
      endGame: () => {},
      // Prefers a child whose own (unseen) walls show more than the way back.
      decide: (g) => {
        for (let i = 0; i < g.nc; i++) if (g.open[g.childCell[i]] !== g.back[g.childCell[i]]) return i;
        return 0;
      },
    };
    const g = new Game(ECON7);
    const feed = new HumanFeed(7, 7);
    const state = { reads: 0, illegal: 0, over: false };
    for (let i = 0; i < 50; i++) {
      feed.load(i);
      play(g, peeker, watched(feed.open, g, state), POISON);
    }
    expect(state.illegal).toBeGreaterThan(0);
  });

  it('redrawing the unseen part of the maze changes no decision before the redraw (fresh players)', () => {
    const g = new Game(ECON7);
    const feed = new HumanFeed(7, 7);
    const scratch = new WilsonScratch(g.cells);
    const redrawn = new Uint8Array(g.cells);
    const chooser = new NoiseSource('test/redraw').at(0);
    for (const { label, spec } of SPECS) {
      const policy = createPolicy(spec, g);
      const noise = new NoiseSource(`test/redraw/${label}`);
      let mismatches = 0;
      for (let index = 0; index < 120; index++) {
        feed.load(firstIndex('train', 5) + index);
        const original = feed.open.slice();
        const first = decisions(g, policy, original, () => noise.at(index));
        const step = chooser.nextBelow(first.length);
        g.begin(original, POISON);
        for (let t = 0; t < step; t++) g.advance(Array.from(g.childDir.subarray(0, g.nc)).indexOf(first[t]));
        samplePosteriorMaze(g, chooser, scratch, redrawn);
        const second = decisions(g, policy, redrawn, () => noise.at(index), step + 1);
        if (second.join(',') !== first.slice(0, step + 1).join(',')) mismatches += 1;
      }
      expect(mismatches, label).toBe(0);
    }
  });
});

describe('cues', () => {
  it('a branch is walled off exactly when the exact posterior gives it probability zero', () => {
    const g = new Game(ECON7);
    const feed = new HumanFeed(7, 7);
    const cues = new Cues(g.cells);
    const posterior = new Posterior(7, 7);
    const naive = new NaiveGreedy();
    const q = new Float64Array(4);
    let walled = 0;
    let checked = 0;
    let disagreements = 0;
    const checker: Bot = {
      begin: () => {},
      decide: (game) => {
        cues.compute(game, -1);
        if (game.status[game.exit] === FREE) {
          posterior.childPosterior(game, q);
          for (let i = 0; i < game.nc; i++) {
            checked += 1;
            if (cues.route[i] === WALLED) walled += 1;
            if ((cues.route[i] === WALLED) !== q[i] < 1e-9) disagreements += 1;
          }
        }
        return naive.decide(game);
      },
    };
    for (let i = 0; i < 300; i++) {
      feed.load(firstIndex('train', 7) + i);
      play(g, checker, feed.open, feed.rng);
    }
    expect(disagreements).toBe(0);
    expect(checked).toBeGreaterThan(1000);
    expect(walled).toBeGreaterThan(10);
  });
});

describe('naive-greedy-equivalent parameters', () => {
  it('the average player with AVERAGE_AS_NAIVE and the rule NAIVE_RULE make exactly the moves of naive-greedy', () => {
    const g = new Game(ECON7);
    const feed = new HumanFeed(7, 7);
    const naive = new NaiveGreedy();
    const average = createPolicy({ model: 'average', params: AVERAGE_AS_NAIVE }, g);
    const rule = createPolicy({ model: 'rule', params: NAIVE_RULE }, g);
    const noise = new NoiseSource('test/naive');
    const naiveMoves = (open: Uint8Array): number[] => {
      g.begin(open, POISON);
      const out: number[] = [];
      for (;;) {
        const action = naive.decide(g);
        out.push(g.childDir[action]);
        g.advance(action);
        if (g.cell === g.exit || g.nc === 0) return out;
      }
    };
    for (let i = 0; i < 400; i++) {
      feed.load(firstIndex('eval', 2) + i);
      const reference = naiveMoves(feed.open);
      expect(decisions(g, average, feed.open, () => noise.at(i))).toEqual(reference);
      expect(decisions(g, rule, feed.open, () => noise.at(i))).toEqual(reference);
    }
  });

  it('reproduces the certified naive-greedy return within the 95% interval', () => {
    expect(certification).not.toBeNull();
    for (const [tier, econ] of [
      [0, ECON5],
      [1, ECON7],
    ] as const) {
      const codes = playGames({ kind: 'play', econ, spec: { model: 'average', params: AVERAGE_AS_NAIVE }, noiseKey: 'test/naive-rtp', first: firstIndex('eval', 0), games: 100_000, career: 0 });
      const cell = certification!.tiers.find((entry) => entry.tier === tier)!.cells.find((entry) => entry.bot === 'naive-greedy' && entry.stream === 'B')!;
      const check = crossCheck('naive-greedy', summarizeGames(codes, econ), cell, econ);
      expect(check.agrees, `tier ${tier}: ${check.rtp} against ${check.certifiedRtp}`).toBe(true);
    }
  });
});

describe('determinism', () => {
  it('a play job gives the same codes every time and does not depend on how its range is split', () => {
    const spec: ModelSpec = { model: 'thoughtful', params: THOUGHTFUL };
    const whole = playGames({ kind: 'play', econ: ECON5, spec, noiseKey: 'test/split', first: 1000, games: 600, career: 0 });
    const again = playGames({ kind: 'play', econ: ECON5, spec, noiseKey: 'test/split', first: 1000, games: 600, career: 0 });
    const left = playGames({ kind: 'play', econ: ECON5, spec, noiseKey: 'test/split', first: 1000, games: 250, career: 0 });
    const right = playGames({ kind: 'play', econ: ECON5, spec, noiseKey: 'test/split', first: 1250, games: 350, career: 0 });
    expect(Array.from(again)).toEqual(Array.from(whole));
    expect([...left, ...right]).toEqual(Array.from(whole));
    // Careers split on career boundaries give the same codes too.
    const learner: ModelSpec = { model: 'learning', params: LEARNING_DEFAULTS };
    const careers = playGames({ kind: 'play', econ: ECON5, spec: learner, noiseKey: 'test/career', first: 0, games: 120, career: 40 });
    const firstPart = playGames({ kind: 'play', econ: ECON5, spec: learner, noiseKey: 'test/career', first: 0, games: 80, career: 40 });
    const rest = playGames({ kind: 'play', econ: ECON5, spec: learner, noiseKey: 'test/career', first: 80, games: 40, career: 40 });
    expect([...firstPart, ...rest]).toEqual(Array.from(careers));
  });

  it('sessions are a function of their index', () => {
    const job = {
      econs: table.tiers.map(tierEconomicsOf),
      specs: table.tiers.map((): ModelSpec => ({ model: 'average', params: AVERAGE_DEFAULTS })),
      fixedTier: null,
      rules: variantRules('quit-chase', 50, 2000),
      first: 12_345,
      noiseKey: 'test/sessions',
    };
    const all = runSessions({ ...job, from: 0, to: 6 });
    const tail = runSessions({ ...job, from: 3, to: 6 });
    expect(Array.from(tail.games)).toEqual(Array.from(all.games.subarray(3)));
    expect(Array.from(tail.final)).toEqual(Array.from(all.final.subarray(3)));
  });

  it('the whole command gives the same result twice, and its report needs nothing outside itself', async () => {
    const request: HumanRequest = {
      tables: [{ label: '기본 표', path: 'packages/shared/src/tuning.json', table, certification }],
      games: 200,
      trainGames: 300,
      careers: 5,
      careerGames: 20,
      sessions: 3,
      behaviourSessions: 3,
      bankroll: 10,
      gameCap: 200,
      fitGames: 60,
      reachGames: 300,
      seed: 9,
      codeHash: simCodeHash(),
    };
    const first = await collectHumanStats(request, new InlineHumanExecutor());
    const second = await collectHumanStats(request, new InlineHumanExecutor());
    expect(JSON.stringify(second.stats)).toBe(JSON.stringify(first.stats));
    expect(first.stats.tables[0].tiers).toHaveLength(3);
    expect(first.stats.tables[0].tiers[0].naiveCheck).not.toBeNull();
    const html = renderReport(first.stats, { generatedAt: '2026-01-02 03:04:05', command: 'pnpm sim:human', seconds: 1, workers: 0, timings: first.timings });
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\//);
    expect(html).toContain('id="human-data"');
    expect(html).toContain('사람이 플레이할 때');
  }, 120_000);
});

describe('the rule search', () => {
  /** Plays a rule on the training games of a search job and sums its payouts, in bps. */
  function playRule(params: RuleParams, first: number, games: number): { sum: number; sumSq: number } {
    const g = new Game(ECON5);
    const rule = new RulePlayer(g, params);
    const feed = new HumanFeed(5, 5);
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < games; i++) {
      feed.load(first + i);
      play(g, rule, feed.open, POISON);
      sum += g.payoutBps;
      sumSq += g.payoutBps * g.payoutBps;
    }
    return { sum, sumSq };
  }

  it('scores stop parts exactly as playing the rules would', () => {
    const first = firstIndex('train', 11);
    const games = 2000;
    for (const part of [
      { avoidWalled: true, move: 'route' as const },
      { avoidWalled: false, move: 'exit' as const },
    ]) {
      const scores = searchMovePart({ kind: 'search', econ: ECON5, part, first, games });
      const picks: StopScore[] = [scores.singles[0], scores.pair];
      for (const at of [7, 100, 333, scores.singles.length - 1]) picks.push(scores.singles[at]);
      for (const score of picks) {
        const played = playRule({ ...part, stops: score.stops }, first, games);
        expect(score.sum, JSON.stringify(score.stops)).toBe(played.sum);
        expect(score.sumSq, JSON.stringify(score.stops)).toBe(played.sumSq);
      }
      // The pair search starts from the best single rule, so it is never worse.
      expect(scores.pair.sum).toBeGreaterThanOrEqual(Math.max(...scores.singles.map((score) => score.sum)));
    }
  });

  it('describes a rule with the refund it acts on', () => {
    const text = describeRule({ avoidWalled: true, move: 'route', stops: [{ forks: 'away', minDistance: 4, maxStep: 2 }] }, ECON5.refundBps);
    expect(text).toContain('막혀 버린 갈래에는 들어가지 않는다');
    expect(text).toContain('출구까지 4칸 이상');
    expect(text).toContain(`${(ECON5.refundBps[2] / 100).toFixed(1)}% 이상(2걸음 이하)`);
  });
});

describe('prospect theory', () => {
  it('weights small chances up and large chances down, and is the identity when c = 1', () => {
    expect(weight(0, TK1992.gamma)).toBe(0);
    expect(weight(1, TK1992.gamma)).toBe(1);
    expect(weight(0.3, 1)).toBe(0.3);
    expect(weight(0.05, TK1992.gamma)).toBeGreaterThan(0.05);
    expect(weight(0.9, TK1992.gamma)).toBeLessThan(0.9);
  });

  it('is the risk-neutral expected value with every parameter at 1', () => {
    const [m, r, s, later] = [6.6, 0.73, 0.5, 0.65];
    expect(indifferenceChance(r, m, s, later, RISK_NEUTRAL)).toBeCloseTo((r - s * later) / (m - s * later), 9);
    expect(goOnUtility(0.2, m, s, later, RISK_NEUTRAL) - cashOutUtility(r, RISK_NEUTRAL)).toBeCloseTo(0.2 * m + 0.8 * s * later - r, 12);
  });

  it('going on feels better as the chance grows; loss aversion asks for a higher chance', () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (let i = 0; i <= 20; i++) {
      const u = goOnUtility(i / 20, 18.5, 0.5, 0.6, TK1992);
      expect(u).toBeGreaterThan(previous);
      previous = u;
    }
    const neutral = indifferenceChance(0.73, 2.6, 0.5, 0.67, RISK_NEUTRAL);
    const averse = indifferenceChance(0.73, 2.6, 0.5, 0.67, { ...RISK_NEUTRAL, lambda: 2.25 });
    expect(averse).toBeGreaterThan(neutral);
  });
});

describe('cue fit', () => {
  it('recovers the weights that generated soft targets', () => {
    const truth = [2.5, -0.7, 0.4, 1.1];
    const rng = new NoiseSource('test/fit').at(0);
    const u = (): number => rng.nextU32() / 0x1_0000_0000;
    const features: number[] = [];
    const target: number[] = [];
    const offsets = [0];
    for (let p = 0; p < 400; p++) {
      const heads = 2 + Math.floor(u() * 3);
      const z: number[] = [];
      for (let h = 0; h < heads; h++) {
        const f = [u() - 1, Math.log(1 + 10 * u()), u() < 0.5 ? 1 : -1, u() < 0.5 ? 1 : 0];
        features.push(...f);
        z.push(f.reduce((total, value, i) => total + value * truth[i], 0));
      }
      const top = Math.max(...z);
      const total = z.reduce((sum, value) => sum + Math.exp(value - top), 0);
      for (const value of z) target.push(Math.exp(value - top) / total);
      offsets.push(target.length);
    }
    const fit = fitSoftmax(features, target, offsets);
    fit.weights.forEach((fitted, i) => expect(fitted).toBeCloseTo(truth[i], 5));
    expect(fit.crossEntropy).toBeLessThan(fit.uniformCrossEntropy);
  });
});

describe('aggregation', () => {
  it('summarizes sessions from hand-made columns', () => {
    const columns: SessionColumns = {
      sessions: 4,
      tiers: 2,
      games: Int32Array.from([10, 30, 2000, 5]),
      staked: Float64Array.from([10, 30, 2000, 8]),
      returned: Float64Array.from([0, 20, 1990, 18]),
      final: Float64Array.from([0, 30, 40, 60]),
      peak: Float64Array.from([50, 55, 70, 60]),
      everAhead: Uint8Array.from([0, 1, 1, 1]),
      end: Uint8Array.from([END_BROKE, END_RUN, END_CAP, END_GOAL]),
      tierGames: Int32Array.from([10, 0, 15, 15, 1000, 1000, 5, 0]),
      ruinedAt: Int32Array.from([10, -1, -1, -1]),
    };
    const summary = summarizeSessions(columns, baselineRules(50, 2000));
    expect(summary.games.mean).toBe((10 + 30 + 2000 + 5) / 4);
    expect(summary.games.median).toBe(20);
    expect(summary.ended).toEqual({ broke: 0.25, cap: 0.25, goal: 0.25, run: 0.25 });
    expect(summary.gamesUntilBroke).toEqual({ median: null, brokeShare: 0.25 });
    expect(summary.everAheadShare).toBe(0.75);
    expect(summary.aheadAtEndShare).toBe(0.25);
    expect(summary.houseTake.mean).toBeCloseTo((10 + 10 + 10 - 10) / 4, 12);
    expect(summary.takePerStake.value).toBeCloseTo(20 / 2048, 12);
    expect(summary.peak.mean).toBeCloseTo(58.75, 12);
    expect(summary.tierShare[0]).toBeCloseTo(1030 / 2045, 12);
    // The session that went broke on its tenth game is no longer able to bet after ten games.
    expect(summary.survival[0]).toBe(0.75);
    expect(summary.survival[summary.survival.length - 1]).toBe(0.75);
  });

  it('every session balances: the house keeps what the bankroll lost', () => {
    const econs = table.tiers.map(tierEconomicsOf);
    for (const rules of [baselineRules(20, 400), variantRules('quit-chase', 20, 400)]) {
      const columns = runSessions({
        econs,
        specs: econs.map((): ModelSpec => ({ model: 'novice', params: NOVICE_DEFAULTS })),
        fixedTier: rules.sizeChoice === null ? 1 : null,
        rules,
        first: 777,
        from: 0,
        to: 12,
        noiseKey: 'test/balance',
      });
      for (let s = 0; s < columns.sessions; s++) {
        expect(columns.staked[s] - columns.returned[s]).toBeCloseTo(rules.bankroll - columns.final[s], 9);
        expect(columns.peak[s]).toBeGreaterThanOrEqual(Math.max(rules.bankroll, columns.final[s]));
        if (columns.end[s] === END_BROKE) {
          expect(columns.final[s]).toBeLessThan(1);
          expect(columns.ruinedAt[s]).toBe(columns.games[s]);
        } else expect(columns.ruinedAt[s]).toBe(-1);
        if (columns.end[s] === END_CAP) expect(columns.games[s]).toBe(rules.gameCap);
        let games = 0;
        for (let t = 0; t < econs.length; t++) games += columns.tierGames[s * econs.length + t];
        expect(games).toBe(columns.games[s]);
      }
    }
  });

  it('computes the learning curve by game position within careers', () => {
    const career = 30;
    const codes = new Uint16Array(3 * career);
    for (let c = 0; c < 3; c++) {
      for (let j = 0; j < career; j++) {
        // The first ten games of each career reach the exit after 8 moves, the next fifteen cash out after one, the rest are lost.
        codes[c * career + j] = j < 10 ? 8 * CODE_OUTCOMES + OUTCOME_EXIT : j < 25 ? 1 * CODE_OUTCOMES + OUTCOME_CASH : 3 * CODE_OUTCOMES + OUTCOME_LOSS;
      }
    }
    const curve = learningCurve(codes, career, ECON5);
    expect(curve.map((point) => [point.from, point.to, point.games])).toEqual([
      [0, 10, 30],
      [10, 25, 45],
      [25, 30, 15],
    ]);
    expect(curve[0].rtp).toBeCloseTo(ECON5.multiplierBps / 10_000, 12);
    expect(curve[1].rtp).toBeCloseTo(ECON5.refundBps[1] / 10_000, 12);
    expect(curve[2].rtp).toBe(0);
    expect(() => learningCurve(codes.subarray(0, 40), career, ECON5)).toThrow(RangeError);
  });

  it('weights the house take of the population by the assumed tier shares and mix', () => {
    const tier = (rtp: Record<string, number>, lsm: number): TierHuman =>
      ({
        cells: Object.entries(rtp).map(([row, value]) => ({ row, rtp: { mean: value } })),
        certified: { valueLsm: { rtp: lsm }, naiveGreedy: null },
        refund: [0.95],
      }) as unknown as TierHuman;
    const tiers = [
      tier({ novice: 0.5, average: 0.8, thoughtful: 0.9, learning: 0.85, 'best-rule': 0.94 }, 0.96),
      tier({ novice: 0.4, average: 0.7, thoughtful: 0.8, learning: 0.75, 'best-rule': 0.92 }, 0.955),
      tier({ novice: 0.3, average: 0.6, thoughtful: 0.7, learning: 0.65, 'best-rule': 0.9 }, 0.95),
    ];
    const result = population(tiers);
    const shares = [0.5, 0.35, 0.15];
    const mixed = (t: number): number => 0.3 * (1 - [0.5, 0.4, 0.3][t]) + 0.4 * (1 - [0.8, 0.7, 0.6][t]) + 0.2 * (1 - [0.9, 0.8, 0.7][t]) + 0.1 * (1 - [0.85, 0.75, 0.65][t]);
    expect(result.houseTake.humans).toBeCloseTo(shares.reduce((total, share, t) => total + share * mixed(t), 0), 12);
    expect(result.houseTake.bestRule).toBeCloseTo(0.5 * 0.06 + 0.35 * 0.08 + 0.15 * 0.1, 12);
    expect(result.houseTake.valueLsm).toBeCloseTo(0.5 * 0.04 + 0.35 * 0.045 + 0.15 * 0.05, 12);
    expect(result.houseTake.immediateCashout).toBeCloseTo(0.05, 12);
    expect(result.learnedShare[0].houseTake).toBeCloseTo(result.houseTake.humans, 12);
    expect(result.learnedShare[10].houseTake).toBeCloseTo(result.houseTake.bestRule, 12);
  });
});

describe('the learning player', () => {
  it('starts as a beginner, then changes its cue weights and its attention from its own games', () => {
    const g = new Game(ECON7);
    const learner = new LearningPlayer(g, LEARNING_DEFAULTS);
    const noise = new NoiseSource('test/learner');
    const feed = new HumanFeed(7, 7);
    const start = [LEARNING_DEFAULTS.start.obvious, LEARNING_DEFAULTS.start.toward];
    learner.newPlayer();
    expect(Array.from(learner.weights)).toEqual(start);
    expect(learner.attention).toBe(LEARNING_DEFAULTS.startAttention);
    for (let i = 0; i < 300; i++) {
      feed.load(firstIndex('sessions', 4) + i);
      learner.startGame(noise.at(i + 1));
      play(g, learner, feed.open, POISON);
      learner.endGame(g);
    }
    expect(Array.from(learner.weights)).not.toEqual(start);
    expect(learner.attention).toBeGreaterThan(LEARNING_DEFAULTS.startAttention);
    // Starting over forgets everything.
    learner.newPlayer();
    expect(learner.attention).toBe(LEARNING_DEFAULTS.startAttention);
    expect(Array.from(learner.weights)).toEqual(start);
  });
});
