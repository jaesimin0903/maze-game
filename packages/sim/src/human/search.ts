// Selection of the strongest learnable rule from the training scores, and its plain-Korean text.
//
// Every rule of the family (rules.ts) is scored on the same training games; the one with the
// highest mean payout is selected and then measured again on evaluation games that training
// never saw, so the reported return does not carry the optimism of picking the best of many.

import { Z_975 } from '../stats';
import { FORK_KINDS, moveParts, type ForkKind, type MoveCue, type MovePart, type PartScores, type RuleParams, type StopCondition, type StopScore } from './rules';

/** A second condition is kept only when it adds at least this much return on the training games. */
export const PAIR_MARGIN = 0.0005;

export interface RuleView {
  params: RuleParams;
  /** What a person would be told to do. */
  text: string;
  /** Return on the training games (the selection is made on this). */
  train: { rtp: number; se: number; halfWidth: number };
}

export interface RuleLandscape {
  part: MovePart;
  forks: ForkKind;
  minDistance: number[];
  /** -1 (never cash out at a fork) and then 0, 1, … */
  maxStep: number[];
  /** `rtp[i][j]`: training return of the one-condition rule minDistance[i], maxStep[j]. */
  rtp: number[][];
}

export interface RuleSearch {
  trainGames: number;
  /** Rules scored: every rule with no or one condition, and the second conditions tried. */
  candidates: number;
  /** The selected rule: the best two-condition rule when its second condition earns its place, else the best one-condition rule. */
  best: RuleView;
  /** The best rule with at most one stop condition. */
  oneStop: RuleView;
  /** The best rule without a stop part. */
  noStop: RuleView;
  /** The best few one-condition rules that behave differently, for a sense of how flat the top is. */
  top: RuleView[];
  /** The best rule (at most two conditions) of each move part. */
  byMove: RuleView[];
  /** Training return over the one-condition stop parts of the best one-condition rule's move part and fork kind. */
  landscape: RuleLandscape;
}

const MOVE_TEXT: Record<MoveCue, string> = {
  exit: '출구 쪽 갈래(둘 다 출구 쪽이면 출구까지 남은 거리가 더 먼 축 방향)',
  space: '빈 공간이 더 넓은 쪽 갈래',
  route: '출구까지 막히지 않은 길이 가장 짧은 갈래',
};

const FORK_TEXT: Record<ForkKind, string> = {
  any: '갈래가 둘 이상인 갈림길',
  even: '어느 쪽도 뚜렷이 출구 쪽이 아닌 갈림길(갈래가 모두 출구 쪽이거나 모두 반대쪽)',
  away: '모든 갈래가 출구에서 멀어지는 갈림길',
};

const percent = (bps: number): string => `${(bps / 100).toFixed(1)}%`;

function conditionText(stop: StopCondition, refundBps: readonly number[]): string {
  const far = stop.minDistance > 0 ? `출구까지 ${stop.minDistance}칸 이상 남았고 ` : '';
  return `${FORK_TEXT[stop.forks]}에서 ${far}화면의 환급액이 ${percent(refundBps[stop.maxStep])} 이상(${stop.maxStep}걸음 이하)`;
}

export function describeRule(params: RuleParams, refundBps: readonly number[]): string {
  const parts = ['출구가 바로 옆이면 들어간다.'];
  if (params.avoidWalled) parts.push('내 길과 지금까지 본 벽 때문에 출구와 막혀 버린 갈래에는 들어가지 않는다(갈 수 있는 갈래가 모두 막혔으면 그 자리에서 캐시아웃).');
  parts.push(`나머지 가운데 ${MOVE_TEXT[params.move]}로 간다.`);
  if (params.stops.length === 0) parts.push('중간에 캐시아웃하지 않는다.');
  else if (params.stops.length === 1) parts.push(`${conditionText(params.stops[0], refundBps)}이면 캐시아웃한다.`);
  else parts.push(`다음 둘 중 하나면 캐시아웃한다: ${params.stops.map((stop, i) => `(${i + 1}) ${conditionText(stop, refundBps)}`).join(', ')}.`);
  return parts.join(' ');
}

function view(score: StopScore, part: MovePart, refundBps: readonly number[]): RuleView {
  const params: RuleParams = { ...part, stops: score.stops };
  const mean = score.sum / score.n / 10_000;
  const variance = Math.max(0, (score.sumSq / score.n / 1e8 - mean * mean) * (score.n / (score.n - 1)));
  const se = Math.sqrt(variance / score.n);
  return { params, text: describeRule(params, refundBps), train: { rtp: mean, se, halfWidth: Z_975 * se } };
}

/**
 * The first `count` entries that behave differently: rules of one move part with exactly the
 * same training sums made the same decisions (a threshold no fork reaches changes nothing), so
 * only the first, simplest one is kept.
 */
function distinct<T extends { part: number; score: StopScore }>(ranked: T[], count: number): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const entry of ranked) {
    const key = `${entry.part}/${entry.score.sum}/${entry.score.sumSq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length === count) break;
  }
  return out;
}

/** Picks the rules from the scores of every move part (in the order of `moveParts()`). */
export function selectRule(scoresByPart: PartScores[], refundBps: readonly number[], shortest: number, trainGames: number): RuleSearch {
  const parts = moveParts();
  if (scoresByPart.length !== parts.length) throw new RangeError('selectRule: one score set per move part is needed');
  const singles: { part: number; score: StopScore; order: number }[] = [];
  scoresByPart.forEach((scores, part) => {
    for (const score of scores.singles) singles.push({ part, score, order: singles.length });
  });
  // Highest mean first; on a tie the earlier entry wins (no stop before a stop, smaller thresholds first).
  const ranked = [...singles].sort((a, b) => b.score.sum - a.score.sum || a.order - b.order);
  const one = ranked[0];
  const none = ranked.find((entry) => entry.score.stops.length === 0)!;
  let pairPart = 0;
  scoresByPart.forEach((scores, part) => {
    if (scores.pair.sum > scoresByPart[pairPart].pair.sum) pairPart = part;
  });
  const pair = scoresByPart[pairPart].pair;
  const oneStop = view(one.score, parts[one.part], refundBps);
  const pairView = view(pair, parts[pairPart], refundBps);
  const best = pair.stops.length === 2 && pairView.train.rtp > oneStop.train.rtp + PAIR_MARGIN ? pairView : oneStop;
  const byMove = parts.map((part, index) => {
    const own = ranked.find((entry) => entry.part === index)!.score;
    const two = scoresByPart[index].pair;
    return view(two.stops.length === 2 && (two.sum - own.sum) / two.n / 10_000 > PAIR_MARGIN ? two : own, part, refundBps);
  });
  const forks = one.score.stops[0]?.forks ?? 'any';
  const maxSteps = [-1, ...Array.from({ length: Math.min(refundBps.length, 2 * shortest + 1) }, (_, k) => k)];
  const minDistances = Array.from({ length: shortest + 1 }, (_, d) => d);
  const partScores = scoresByPart[one.part].singles;
  const noStopRtp = partScores[0].sum / partScores[0].n / 10_000;
  const lookup = new Map(
    partScores.filter((score) => score.stops.length === 1 && score.stops[0].forks === forks).map((score) => [`${score.stops[0].minDistance}/${score.stops[0].maxStep}`, score.sum / score.n / 10_000]),
  );
  const perPart = 1 + FORK_KINDS.length * (shortest + 1) * refundBps.length;
  return {
    trainGames,
    candidates: parts.length * perPart * 3,
    best,
    oneStop,
    noStop: view(none.score, parts[none.part], refundBps),
    top: distinct(ranked, 8).map((entry) => view(entry.score, parts[entry.part], refundBps)),
    byMove,
    landscape: {
      part: parts[one.part],
      forks,
      minDistance: minDistances,
      maxStep: maxSteps,
      rtp: minDistances.map((d) => maxSteps.map((k) => (k < 0 ? noStopRtp : (lookup.get(`${d}/${k}`) ?? Number.NaN)))),
    },
  };
}
