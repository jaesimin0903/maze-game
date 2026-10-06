// The rows of `sim:human`: which model with which parameters, and how the report describes it.

import type { Game } from '../engine';
import {
  AVERAGE_AS_NAIVE,
  AVERAGE_DEFAULTS,
  AveragePlayer,
  LEARNING_DEFAULTS,
  LearningPlayer,
  NOVICE_DEFAULTS,
  NovicePlayer,
  THOUGHTFUL_DEFAULTS,
  ThoughtfulPlayer,
  type AverageParams,
  type CueWeights,
  type HumanPolicy,
  type LearningParams,
  type NoviceParams,
  type ResolvedThoughtful,
} from './models';
import { RISK_NEUTRAL } from './prospect';
import { RulePlayer, type RuleParams } from './rules';

/** Everything a worker needs to build a model. Plain data, so it crosses threads. */
export type ModelSpec =
  | { model: 'novice'; params: NoviceParams }
  | { model: 'average'; params: AverageParams }
  | { model: 'thoughtful'; params: ResolvedThoughtful }
  | { model: 'learning'; params: LearningParams }
  | { model: 'rule'; params: RuleParams };

export function createPolicy(spec: ModelSpec, g: Game): HumanPolicy {
  switch (spec.model) {
    case 'novice':
      return new NovicePlayer(spec.params);
    case 'average':
      return new AveragePlayer(g, spec.params);
    case 'thoughtful':
      return new ThoughtfulPlayer(g, spec.params);
    case 'learning':
      return new LearningPlayer(g, spec.params);
    case 'rule':
      return new RulePlayer(g, spec.params);
  }
}

/** Rows of the per-game tables, in report order. */
export const ROW_IDS = ['novice', 'average', 'thoughtful', 'thoughtful-neutral', 'thoughtful-ideal', 'learning', 'rule-no-stop', 'rule-one-stop', 'best-rule', 'naive-check'] as const;
export type RowId = (typeof ROW_IDS)[number];

/** Rows that also get bankroll sessions (the comparison and validation rows do not). */
export const SESSION_ROWS: readonly RowId[] = ['novice', 'average', 'thoughtful', 'learning', 'best-rule'];

export interface RowInfo {
  id: RowId;
  /** Short Korean name and a plain-Korean description of the behaviour. */
  name: string;
  description: string;
  /** Which behavioural findings the model borrows; they are modelling assumptions, not facts about this game's players. */
  assumptions: string[];
  /** A model of a person (true), or a searched rule / a validation row (false). */
  human: boolean;
}

export const ROW_INFO: Record<RowId, RowInfo> = {
  novice: {
    id: 'novice',
    name: '초보 플레이어',
    description:
      '대체로 출구 쪽으로 가지만 갈림길에서 고르는 손이 거칩니다. "출구에 가까워지는가"와 "가던 방향 그대로인가" 두 가지만 보고 그 점수를 높은 온도의 소프트맥스로 흐리게 고릅니다(출구 쪽과 반대쪽이 갈리는 갈림길에서 출구 쪽을 고르는 비율이 열에 아홉쯤, 둘 다 출구 쪽이면 거의 동전 던지기). 막힌 곳을 알아보지 못하고, 거의 캐시아웃하지 않습니다(갈림길마다 2% 확률로 겁이 나서 그만둠).',
    assumptions: ['제한된 합리성: 몇 가지 단서만 씀', '잡음이 있는 선택(소프트맥스, 무작위 효용)'],
    human: true,
  },
  average: {
    id: 'average',
    name: '보통 플레이어',
    description:
      '출구 쪽으로 가고(갈림길에서 5%는 실수), 본 벽을 기억해서 자기 길과 벽으로 막혀 버린 작은 주머니(6칸 이하)는 피합니다. 사람마다 정한 환급 하한(직진했을 때 받을 환급액의 60~100%)보다 화면의 환급액이 내려가면, 출구가 3칸 안에 있지 않은 한 그만둡니다. 길이 두 번 연속 출구에서 멀어지면 겁이 나서 30% 확률로 그만둡니다.',
    assumptions: ['제한된 합리성', '개인별 손절 기준', '목표 근접 효과(출구가 가까우면 버팀)'],
    human: true,
  },
  thoughtful: {
    id: 'thoughtful',
    name: '생각하는 플레이어',
    description:
      '방향, 출구까지 막히지 않은 가장 짧은 길, 그쪽에 남은 빈 공간, 대각선 유지라는 네 단서로 "출구가 어느 갈래 뒤에 있을지"를 어림합니다(정확한 사후확률에 맞춘 가중치에 잡음을 더한 것). 가장 그럴듯한 갈래로 가고, 경험으로 익힌 "여기서 이기는 감"과 "안 풀리면 나중에라도 빠질 수 있다"를 지금의 환급액과 비교해 그만둘지 정합니다. 그 비교에 전망이론의 왜곡(손실을 2.25배 무겁게 느낌, 작은 확률을 크게 느낌)이 들어갑니다.',
    assumptions: ['전망이론: 손실 회피와 확률 가중(Tversky & Kahneman 1992의 실험실 추정치)', '경험으로 보정된 감(평균적으로는 맞음)', '제한된 합리성'],
    human: true,
  },
  'thoughtful-neutral': {
    id: 'thoughtful-neutral',
    name: '생각하는 플레이어 (왜곡 없음)',
    description: '생각하는 플레이어와 같지만 전망이론의 왜곡 없이 기댓값으로 비교합니다. 왜곡이 하우스 몫에 얼마나 기여하는지 보는 비교용입니다.',
    assumptions: ['경험으로 보정된 감', '제한된 합리성'],
    human: true,
  },
  'thoughtful-ideal': {
    id: 'thoughtful-ideal',
    name: '생각하는 플레이어 (잡음·왜곡 없음)',
    description:
      '같은 네 단서와 같은 판단 방식을 쓰되 어림에 잡음이 없고 전망이론의 왜곡도 없는, 머릿속 계산이 완벽한 가상의 사람입니다. 사람이 "생각해서" 풀 때의 상한에 가깝고, AI(value-lsm)와의 차이는 단서 네 개로는 담기지 않는 정보와 앞을 내다보는 계산에서 옵니다.',
    assumptions: ['경험으로 보정된 감'],
    human: false,
  },
  learning: {
    id: 'learning',
    name: '배우는 플레이어',
    description:
      '처음엔 출구 쪽으로만 가는 초심자이고 판을 거듭하며 배웁니다. 판이 끝나면 게임이 미로 전체를 보여 주므로(검증 화면) 지나온 갈림길에서 맞는 길이 어디였는지 보고 단서 가중치를 고칩니다. 막힌 주머니를 못 보고 졌을 때마다 그런 주머니를 알아보는 확률이 올라가고, 끝까지 가 본 판들의 결과로 "이 거리의 갈림길에서 밀고 가면 몇 번에 한 번 이기나"를 세어 환급액과 비교합니다. 표의 값은 처음 시작한 사람이 정해진 판 수를 하는 동안의 평균입니다.',
    assumptions: ['피드백 학습(델타 규칙)', '연습 효과(학습률이 점점 줄어듦)', '두드러진 실패에서 배움'],
    human: true,
  },
  'rule-no-stop': {
    id: 'rule-no-stop',
    name: '규칙: 길 고르기만',
    description: '탐색한 규칙 가운데 캐시아웃 조건 없이 길 고르기만으로 가장 나았던 규칙입니다. 막힌 곳 피하기와 길 고르는 단서만의 효과를 봅니다.',
    assumptions: [],
    human: false,
  },
  'rule-one-stop': {
    id: 'rule-one-stop',
    name: '규칙: 캐시아웃 조건 1개',
    description: '길 고르기에 캐시아웃 조건을 하나까지 더한 규칙 가운데 학습용 미로에서 가장 나았던 것입니다.',
    assumptions: [],
    human: false,
  },
  'best-rule': {
    id: 'best-rule',
    name: '배울 수 있는 최선의 규칙',
    description:
      '사람이 머릿속으로 적용할 수 있는 규칙(길 고르는 방법 하나와 "이런 갈림길에서 환급액이 이만큼 이상이면 그만둔다"는 조건 두 개까지) 가운데 학습용 미로에서 환수율이 가장 높았던 것을, 겹치지 않는 평가용 미로에서 다시 잰 값입니다. 두 번째 조건이 학습용 미로에서 0.05%p도 보태지 못하면 조건 하나짜리를 씁니다.',
    assumptions: [],
    human: false,
  },
  'naive-check': {
    id: 'naive-check',
    name: '검증: naive-greedy와 같은 매개변수',
    description: '보통 플레이어의 매개변수를 실수 0, 주머니 인식 0, 그만두기 0으로 두면 인증 묶음의 naive-greedy와 똑같이 움직입니다. 이 실행의 엔진 사용이 인증과 같은지 확인하는 줄입니다.',
    assumptions: [],
    human: false,
  },
};

/** What the thoughtful player takes from the calibration of its grid size. */
export interface SizeCalibration {
  cue: CueWeights;
  reach: number[];
  /** The gut-feel table of a player whose estimate has no noise. */
  reachIdeal: number[];
}

/** The model spec of a row; the rule rows need the rules the search selected for the tier. */
export function rowSpec(id: RowId, calibration: SizeCalibration, rule: { best: RuleParams; oneStop: RuleParams; noStop: RuleParams }): ModelSpec {
  switch (id) {
    case 'novice':
      return { model: 'novice', params: NOVICE_DEFAULTS };
    case 'average':
      return { model: 'average', params: AVERAGE_DEFAULTS };
    case 'thoughtful':
      return { model: 'thoughtful', params: { ...THOUGHTFUL_DEFAULTS, cue: calibration.cue, reach: calibration.reach } };
    case 'thoughtful-neutral':
      return { model: 'thoughtful', params: { ...THOUGHTFUL_DEFAULTS, cue: calibration.cue, reach: calibration.reach, prospect: RISK_NEUTRAL } };
    case 'thoughtful-ideal':
      return { model: 'thoughtful', params: { ...THOUGHTFUL_DEFAULTS, cue: calibration.cue, reach: calibration.reachIdeal, perception: 0, gutNoise: 0, prospect: RISK_NEUTRAL } };
    case 'learning':
      return { model: 'learning', params: LEARNING_DEFAULTS };
    case 'rule-no-stop':
      return { model: 'rule', params: rule.noStop };
    case 'rule-one-stop':
      return { model: 'rule', params: rule.oneStop };
    case 'best-rule':
      return { model: 'rule', params: rule.best };
    case 'naive-check':
      return { model: 'average', params: AVERAGE_AS_NAIVE };
  }
}

/** The default parameters of every model, for the report. */
export const MODEL_DEFAULTS = {
  novice: NOVICE_DEFAULTS,
  average: AVERAGE_DEFAULTS,
  thoughtful: { ...THOUGHTFUL_DEFAULTS, cue: 'fitted per grid size', reach: 'calibrated per grid size' },
  learning: LEARNING_DEFAULTS,
  naiveCheck: AVERAGE_AS_NAIVE,
};
