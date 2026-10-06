// Bankroll sessions: one person plays game after game with a bankroll of 50 bets.
//
// The baseline session stakes one bet per game on one size until the bankroll cannot cover a
// bet (or 2,000 games). On top of it, session behaviour can be switched on:
//   size choice  before every game the player picks a size with probability proportional to
//                exp(pull × ln(multiplier) + stay × [same size as last game] + nearMissStay ×
//                [same size, and the last game was a near miss]); `pull` is drawn per person
//                (some like the big multiplier, some do not).
//   quitting     the player leaves when the bankroll reaches (1 + goal) × start ("quit while
//                ahead"), or after a run of games without reaching the exit; a near miss (a dead
//                end within 2 cells of the exit) does not count toward the run, it feels like progress.
//   chasing      below the starting bankroll, the stake grows by `factor` after every game
//                without a win, up to `cap` times the base stake ("a win is due"); back to one
//                bet after a win or once the player is no longer behind.
//
// MODELLING ASSUMPTIONS. Attraction to long shots, quitting rules, near-miss persistence and
// loss chasing are documented in gambling research (e.g. Reid 1986 and Clark et al. 2009 on near
// misses, Lesieur 1979 on chasing, Croson & Sundali 2005 on the gambler's fallacy in casino
// data); their size here is an illustrative choice, not a measurement of this game's players.
//
// Every session is a pure function of its index: game j on size t of session s is maze
// `first + s × SESSION_STRIDE + j_t` of that size, so every model meets the same mazes in the
// same order, and the player's traits and choices come from generators keyed by the session.

import { type Rng } from '@maze/shared';
import { Game, OUTCOME_EXIT, OUTCOME_LOSS, play, type TierEconomics } from '../engine';
import { median } from '../stats';
import { createPolicy, type ModelSpec } from './catalog';
import { gaussian, HumanFeed, NoiseSource, uniform } from './feed';
import type { HumanPolicy } from './models';

/** Mazes reserved per session and size; a session never plays more games than this on one size. */
export const SESSION_STRIDE = 4096;

export interface SizeChoice {
  /** Weight of ln(multiplier), per person: normal with this mean and standard deviation. */
  pull: [mean: number, sd: number];
  stay: number;
  nearMissStay: number;
}

export interface QuitRules {
  /** Quit once the bankroll reaches (1 + goal) × start; goal uniform in this range per person. */
  winGoal: [number, number];
  /** Quit after this many games in a row without reaching the exit; uniform per person (rounded). */
  losingRun: [number, number];
}

export interface ChaseRules {
  factor: number;
  cap: number;
}

export interface SessionRules {
  bankroll: number;
  gameCap: number;
  sizeChoice: SizeChoice | null;
  quit: QuitRules | null;
  chase: ChaseRules | null;
}

export const SIZE_CHOICE: SizeChoice = { pull: [0.3, 0.6], stay: 1, nearMissStay: 1 };
export const QUIT_RULES: QuitRules = { winGoal: [0.2, 1], losingRun: [15, 60] };
export const CHASE_RULES: ChaseRules = { factor: 1.5, cap: 4 };

export const SESSION_VARIANTS = ['size-choice', 'quit', 'quit-chase'] as const;
export type SessionVariant = (typeof SESSION_VARIANTS)[number];

export const VARIANT_INFO: Record<SessionVariant, { name: string; description: string }> = {
  'size-choice': {
    name: '크기 고르기만',
    description:
      '판마다 크기를 고릅니다(큰 배율에 끌리는 정도는 사람마다 다름, 같은 크기를 이어 하는 습관, 아깝게 진 직후엔 같은 크기를 더 이어 함). 한 베팅씩, 돈이 떨어지거나 2,000판이 될 때까지.',
  },
  quit: {
    name: '크기 고르기 + 그만두기',
    description: '위에 더해, 시작 잔고의 20~100%를 따면 일어서고, 출구에 못 간 판이 15~60판 이어지면 그만둡니다(아깝게 진 판은 세지 않음).',
  },
  'quit-chase': {
    name: '크기 고르기 + 그만두기 + 손실 추격',
    description: '위에 더해, 시작 잔고보다 잃고 있을 때 출구에 못 간 판마다 베팅을 1.5배씩 올립니다(최대 4배, 이기거나 본전을 찾으면 1배로).',
  },
};

export function variantRules(variant: SessionVariant, bankroll: number, gameCap: number): SessionRules {
  return {
    bankroll,
    gameCap,
    sizeChoice: SIZE_CHOICE,
    quit: variant === 'size-choice' ? null : QUIT_RULES,
    chase: variant === 'quit-chase' ? CHASE_RULES : null,
  };
}

export function baselineRules(bankroll: number, gameCap: number): SessionRules {
  return { bankroll, gameCap, sizeChoice: null, quit: null, chase: null };
}

/** How a session ended. */
export const END_BROKE = 0;
export const END_CAP = 1;
export const END_GOAL = 2;
export const END_RUN = 3;

/** One record per session, as columns. Money is in bets. */
export interface SessionColumns {
  sessions: number;
  tiers: number;
  games: Int32Array;
  staked: Float64Array;
  returned: Float64Array;
  final: Float64Array;
  peak: Float64Array;
  everAhead: Uint8Array;
  end: Uint8Array;
  /** `tierGames[s × tiers + t]`: games of session `s` on tier `t`. */
  tierGames: Int32Array;
  /** Games played when the bankroll could no longer cover a bet; -1 for a session that did not go broke. */
  ruinedAt: Int32Array;
}

export interface SessionJob {
  econs: TierEconomics[];
  /** One model per tier (the same person; a size-specific calibration or rule may differ). */
  specs: ModelSpec[];
  /** Play only this tier; null lets the player choose a size before each game. */
  fixedTier: number | null;
  rules: SessionRules;
  /** First maze index of session 0 (on every size). */
  first: number;
  /** Sessions `from .. to - 1`. */
  from: number;
  to: number;
  /** Keys the person's traits, choices and per-game noise. */
  noiseKey: string;
}

/** The policies of one person on each tier. A learning person keeps one memory across sizes. */
function personPolicies(specs: ModelSpec[], games: Game[]): HumanPolicy[] {
  if (specs.every((spec) => spec.model === 'learning')) {
    let largest = 0;
    for (let t = 1; t < games.length; t++) if (games[t].cells > games[largest].cells) largest = t;
    const shared = createPolicy(specs[0], games[largest]);
    return specs.map(() => shared);
  }
  return specs.map((spec, t) => createPolicy(spec, games[t]));
}

function emptyColumns(sessions: number, tiers: number): SessionColumns {
  return {
    sessions,
    tiers,
    games: new Int32Array(sessions),
    staked: new Float64Array(sessions),
    returned: new Float64Array(sessions),
    final: new Float64Array(sessions),
    peak: new Float64Array(sessions),
    everAhead: new Uint8Array(sessions),
    end: new Uint8Array(sessions),
    tierGames: new Int32Array(sessions * tiers),
    ruinedAt: new Int32Array(sessions),
  };
}

export function runSessions(job: SessionJob): SessionColumns {
  const { econs, rules } = job;
  const tiers = econs.length;
  if (rules.gameCap > SESSION_STRIDE) throw new RangeError(`a session may play at most ${SESSION_STRIDE} games, got a cap of ${rules.gameCap}`);
  if (job.fixedTier !== null && (job.fixedTier < 0 || job.fixedTier >= tiers)) throw new RangeError(`no tier ${job.fixedTier}`);
  if (job.specs.length !== tiers) throw new RangeError('runSessions: one model spec per tier is needed');
  const games = econs.map((econ) => new Game(econ));
  const feeds = econs.map((econ) => new HumanFeed(econ.w, econ.h));
  const policies = personPolicies(job.specs, games);
  const distinct = [...new Set(policies)];
  const traits = new NoiseSource(`session-traits/${job.noiseKey}`);
  const choices = new NoiseSource(`session-choices/${job.noiseKey}`);
  const gameNoise = new NoiseSource(`session-games/${job.noiseKey}`);
  const logMultiplier = econs.map((econ) => Math.log(econ.multiplierBps / 10_000));
  const out = emptyColumns(job.to - job.from, tiers);
  const weight = new Float64Array(tiers);
  const played = new Int32Array(tiers);

  for (let s = job.from; s < job.to; s++) {
    const row = s - job.from;
    // The same draws give every tier's policy the same personal traits.
    for (const policy of distinct) policy.newPlayer(traits.at(s));
    const rng: Rng = choices.at(s);
    const pull = rules.sizeChoice === null ? 0 : rules.sizeChoice.pull[0] + rules.sizeChoice.pull[1] * gaussian(rng);
    const goal = rules.quit === null ? Number.POSITIVE_INFINITY : rules.quit.winGoal[0] + (rules.quit.winGoal[1] - rules.quit.winGoal[0]) * uniform(rng);
    const runLimit = rules.quit === null ? Number.POSITIVE_INFINITY : Math.round(rules.quit.losingRun[0] + (rules.quit.losingRun[1] - rules.quit.losingRun[0]) * uniform(rng));

    const start = rules.bankroll;
    let bankroll = start;
    let peak = start;
    let staked = 0;
    let returned = 0;
    let count = 0;
    let ahead = false;
    let run = 0;
    let multiple = 1;
    let last = -1;
    let lastNearMiss = false;
    let end = END_CAP;
    played.fill(0);
    while (count < rules.gameCap) {
      if (bankroll < 1) {
        end = END_BROKE;
        break;
      }
      let tier = job.fixedTier ?? 0;
      if (job.fixedTier === null && rules.sizeChoice !== null) {
        const choice = rules.sizeChoice;
        let total = 0;
        for (let t = 0; t < tiers; t++) {
          let u = pull * logMultiplier[t];
          if (t === last) u += choice.stay + (lastNearMiss ? choice.nearMissStay : 0);
          weight[t] = Math.exp(u);
          total += weight[t];
        }
        let draw = uniform(rng) * total;
        tier = tiers - 1;
        for (let t = 0; t < tiers; t++) {
          draw -= weight[t];
          if (draw < 0) {
            tier = t;
            break;
          }
        }
      }
      const stake = Math.min(bankroll, multiple);
      const g = games[tier];
      const feed = feeds[tier];
      const policy = policies[tier];
      feed.load(job.first + s * SESSION_STRIDE + played[tier]);
      played[tier] += 1;
      policy.startGame(gameNoise.at(s * SESSION_STRIDE + count));
      play(g, policy, feed.open, feed.rng);
      policy.endGame(g);
      const payout = (stake * g.payoutBps) / 10_000;
      bankroll += payout - stake;
      staked += stake;
      returned += payout;
      count += 1;
      if (bankroll > peak) peak = bankroll;
      if (bankroll > start) ahead = true;
      const win = g.outcome === OUTCOME_EXIT;
      lastNearMiss = g.outcome === OUTCOME_LOSS && g.dist[g.cell] <= 2;
      last = tier;
      if (win) run = 0;
      else if (!lastNearMiss) run += 1;
      if (rules.chase !== null) {
        if (win || bankroll >= start) multiple = 1;
        else multiple = Math.min(rules.chase.cap, multiple * rules.chase.factor);
      }
      if (bankroll >= start * (1 + goal)) {
        end = END_GOAL;
        break;
      }
      if (run >= runLimit) {
        end = END_RUN;
        break;
      }
    }
    if (end === END_CAP && bankroll < 1) end = END_BROKE;
    out.games[row] = count;
    out.staked[row] = staked;
    out.returned[row] = returned;
    out.final[row] = bankroll;
    out.peak[row] = peak;
    out.everAhead[row] = ahead ? 1 : 0;
    out.end[row] = end;
    out.ruinedAt[row] = end === END_BROKE ? count : -1;
    for (let t = 0; t < tiers; t++) out.tierGames[row * tiers + t] = played[t];
  }
  return out;
}

/** Concatenates the columns of consecutive session ranges. */
export function joinSessions(parts: SessionColumns[]): SessionColumns {
  const out = emptyColumns(
    parts.reduce((total, part) => total + part.sessions, 0),
    parts[0].tiers,
  );
  let at = 0;
  for (const part of parts) {
    out.games.set(part.games, at);
    out.staked.set(part.staked, at);
    out.returned.set(part.returned, at);
    out.final.set(part.final, at);
    out.peak.set(part.peak, at);
    out.everAhead.set(part.everAhead, at);
    out.end.set(part.end, at);
    out.tierGames.set(part.tierGames, at * out.tiers);
    out.ruinedAt.set(part.ruinedAt, at);
    at += part.sessions;
  }
  return out;
}

/** Games after which the survival curve is read off. */
export const SURVIVAL_POINTS = [10, 20, 50, 100, 200, 500, 1000, 2000];

export interface SessionSummary {
  sessions: number;
  bankroll: number;
  gameCap: number;
  /** Games played per session (the session length). */
  games: { mean: number; p10: number; median: number; p90: number };
  /** Share of sessions by how they ended. */
  ended: { broke: number; cap: number; goal: number; run: number };
  /** Median over all sessions of the games until the bankroll could not cover a bet (a session that did not go broke counts as longer than any); null when half or more did not go broke. */
  gamesUntilBroke: { median: number | null; brokeShare: number };
  everAheadShare: number;
  aheadAtEndShare: number;
  /** Highest bankroll reached, in bets. */
  peak: { mean: number; median: number; p90: number };
  final: { mean: number; median: number };
  staked: { mean: number };
  /** What the house kept per session, in bets (stakes minus payouts, i.e. start minus final bankroll). */
  houseTake: { mean: number; ci95: [number, number] };
  /** Kept per bet staked: ratio of sums with a delta-method interval. */
  takePerStake: { value: number; ci95: [number, number] };
  /** Share of all games played on each tier. */
  tierShare: number[];
  /** Share of sessions not yet broke after `SURVIVAL_POINTS[i]` games (a session that ended otherwise counts as not broke). */
  survival: number[];
}

function quantile(sorted: Float64Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const Z = 1.959963984540054;

export function summarizeSessions(columns: SessionColumns, rules: SessionRules): SessionSummary {
  const n = columns.sessions;
  if (n < 2) throw new RangeError('summarizeSessions: at least two sessions are needed');
  const games = Float64Array.from(columns.games).sort();
  let sumGames = 0;
  for (const value of columns.games) sumGames += value;
  const ended = { broke: 0, cap: 0, goal: 0, run: 0 };
  for (const end of columns.end) {
    if (end === END_BROKE) ended.broke += 1;
    else if (end === END_CAP) ended.cap += 1;
    else if (end === END_GOAL) ended.goal += 1;
    else ended.run += 1;
  }
  let broke = 0;
  let ahead = 0;
  let aheadAtEnd = 0;
  let peakSum = 0;
  let finalSum = 0;
  let stakeSum = 0;
  let takeSum = 0;
  let takeSq = 0;
  for (let s = 0; s < n; s++) {
    if (columns.ruinedAt[s] >= 0) broke += 1;
    ahead += columns.everAhead[s];
    if (columns.final[s] > rules.bankroll) aheadAtEnd += 1;
    peakSum += columns.peak[s];
    finalSum += columns.final[s];
    stakeSum += columns.staked[s];
    const take = columns.staked[s] - columns.returned[s];
    takeSum += take;
    takeSq += take * take;
  }
  const takeMean = takeSum / n;
  const takeSe = Math.sqrt(Math.max(0, (takeSq - n * takeMean * takeMean) / (n - 1)) / n);
  const ratio = stakeSum > 0 ? takeSum / stakeSum : 0;
  let residual = 0;
  for (let s = 0; s < n; s++) {
    const e = columns.staked[s] - columns.returned[s] - ratio * columns.staked[s];
    residual += e * e;
  }
  const ratioSe = stakeSum > 0 ? Math.sqrt(residual / (n - 1) / n) / (stakeSum / n) : 0;
  const peaks = Float64Array.from(columns.peak).sort();
  const finals = Float64Array.from(columns.final).sort();
  const tierTotals = new Array<number>(columns.tiers).fill(0);
  for (let s = 0; s < n; s++) for (let t = 0; t < columns.tiers; t++) tierTotals[t] += columns.tierGames[s * columns.tiers + t];
  const survival = SURVIVAL_POINTS.map((point) => {
    let alive = 0;
    for (let s = 0; s < n; s++) if (columns.ruinedAt[s] < 0 || columns.ruinedAt[s] > point) alive += 1;
    return alive / n;
  });
  return {
    sessions: n,
    bankroll: rules.bankroll,
    gameCap: rules.gameCap,
    games: { mean: sumGames / n, p10: quantile(games, 0.1), median: median(Array.from(games)), p90: quantile(games, 0.9) },
    ended: { broke: ended.broke / n, cap: ended.cap / n, goal: ended.goal / n, run: ended.run / n },
    gamesUntilBroke: {
      median: broke * 2 > n ? median(Array.from(columns.ruinedAt, (at) => (at < 0 ? Number.POSITIVE_INFINITY : at))) : null,
      brokeShare: broke / n,
    },
    everAheadShare: ahead / n,
    aheadAtEndShare: aheadAtEnd / n,
    peak: { mean: peakSum / n, median: median(Array.from(peaks)), p90: quantile(peaks, 0.9) },
    final: { mean: finalSum / n, median: median(Array.from(finals)) },
    staked: { mean: stakeSum / n },
    houseTake: { mean: takeMean, ci95: [takeMean - Z * takeSe, takeMean + Z * takeSe] },
    takePerStake: { value: ratio, ci95: [ratio - Z * ratioSe, ratio + Z * ratioSe] },
    tierShare: tierTotals.map((total) => total / Math.max(1, sumGames)),
    survival,
  };
}
