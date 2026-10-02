// Tuning report (plan §9.3 "보고서"). Rendered in Korean, like the plan and the documents that
// `report:check` reads: the labels "가정", "축소 표본", "개선됨" / "개선 없음" are part of its contract.
// Every number is read from the result objects passed in; nothing is typed in.

import { POPULATION_MEMBERS } from './assumptions';
import type { TableCertification, TierCertification } from './certify';
import { houseRevenue } from './engagement';
import type { SensitivityReport } from './sensitivity';
import { halfWidth95 } from './stats';
import { constraintStatus, type CandidateRun, type TierSummary, type TuneResult } from './tune';

const pct = (x: number, digits = 2): string => `${(100 * x).toFixed(digits)}%`;
const points = (x: number, digits = 2): string => `${(100 * x).toFixed(digits)}%p`;
const count = (x: number): string => Math.round(x).toLocaleString('en-US');
const TIER_NAME = ['S', 'M', 'L'];
const tierName = (index: number): string => TIER_NAME[index] ?? `T${index}`;

/** Korean for the fixed English phrases that `tune` records in its result (reasons, stages, scenarios). Anything else is shown as recorded. */
const PHRASES: [pattern: RegExp, korean: string | ((...groups: string[]) => string)][] = [
  [/^an assumption constraint \(E2, E10, E8 or E9\) is violated$/, '가정 제약(E2, E10, E8, E9) 가운데 하나를 위반'],
  [/^first point that satisfies every constraint \(the baseline violates E2 or E10\)$/, '모든 제약을 만족한 첫 점 (기준선이 E2 또는 E10을 위반)'],
  [/^ΔH is at least 0\.2 points and its lower bound is positive$/, 'ΔH가 0.2%p 이상이고 하측 한계가 0보다 크다'],
  [/^ΔH (\S+) \(lower bound (\S+)\) does not meet the adoption rule$/, 'ΔH $1 (하측 한계 $2): 채택 규칙에 못 미침'],
  [/^fixed failure: /, '고정 실패: '],
  [/^E2\/E10 shortfall (\S+) → (\S+) \(spec deviation: tier size changed\)$/, 'E2/E10 위반폭 $1 → $2 (스펙 이탈: 크기 변경)'],
  [/^shortfall did not shrink \((\S+) → (\S+)\)$/, '위반폭이 줄지 않음 ($1 → $2)'],
  [/^the resized candidate failed: /, '크기를 바꾼 후보가 실패: '],
  [/^no adjacent size is available$/, '바꿀 수 있는 인접 크기가 없음'],
  [/^selected$/, '선택'],
  [/^not better at the full game count$/, '전체 판 수에서는 H가 더 크지 않음'],
  [/^exactness gates$/, '정확성 게이트'],
  [/^coarse ranking of search points$/, '탐색 점의 거친 순위'],
  [/^(.+) \(last tier screened\)$/, '$1 (마지막 크기는 축소 표본)'],
  [/^(.+) \(every tier at full N\)$/, '$1 (모든 크기 전체 판 수)'],
  [/^base assumptions$/, '기본 가정'],
  [/^population weight of (\S+) ([+-]50%)$/, (_all, member, change) => `집단 가중치: ${member === 'best' ? '최고 봇' : member} ${change}`],
  [/^E2 floor (\S+)$/, 'E2 하한 $1'],
  [/^share of tier (\d+) ([+-]50%)$/, (_all, tier, change) => `크기 이용 비중: ${tierName(Number(tier))} ${change}`],
];

function ko(text: string): string {
  for (const [pattern, korean] of PHRASES) {
    if (pattern.test(text)) return typeof korean === 'string' ? text.replace(pattern, korean) : text.replace(pattern, korean);
  }
  return text;
}

/** The value-lsm variant of each bot-improvement level (plan §3.3 failure branch 1), in Korean. */
const VARIANT_NAME = [
  '기본 (가치 차이가 0.2 이내일 때만 한 걸음 선행 탐색)',
  '봇 개선 단계 1 (모든 결정에서 한 걸음 선행 탐색)',
  '봇 개선 단계 2 (단계 1 + 임계값 0.4)',
  '봇 개선 단계 3 (단계 2 + 영역 특징)',
];

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}

function duration(seconds: number): string {
  if (seconds < 90) return `${seconds.toFixed(0)}초`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)}분`;
  return `${(seconds / 3600).toFixed(2)}시간`;
}

/** The label the plan requires on reduced-sample numbers. */
export function screenedLabel(tier: TierSummary): string {
  return `${tierName(tier.tier)}: 축소 표본 ±${points(tier.bestHalfWidth)}, 고정 게이트 미판정, 적용 불가`;
}

function curveText(tier: TierSummary): string {
  return `e0 ${tier.curve.e0Bps} / a ${tier.curve.aBps} / φ ${tier.curve.phi}`;
}

function exactSection(runs: CandidateRun[]): string {
  const rows = runs
    .filter((run) => run.exact !== null)
    .map((run) => {
      const exact = run.exact!;
      const trend = exact.gaps['5x4'] <= exact.gaps['4x4'] + 0.0025 ? '커지지 않음' : '커짐';
      const branch =
        exact.branch === 'pass'
          ? '통과 (실패 분기 없음)'
          : exact.branch === 'lower-ceiling'
            ? `분기 2 (ceilingBps ${exact.ceilingBps}, e0Bps ${exact.e0Bps})`
            : exact.branch === 'improve-bot'
              ? '분기 1 (봇 개선 필요)'
              : '분기 3 (BLOCKED)';
      return [run.name, VARIANT_NAME[exact.variant.level] ?? exact.variant.label, points(exact.gaps['3x3'], 3), points(exact.gaps['4x4'], 3), points(exact.gaps['5x4'], 3), trend, branch];
    });
  const grids = runs
    .filter((run) => run.exact !== null)
    .flatMap((run) =>
      run.exact!.grids.map((grid) => [
        run.name,
        `e0 ${grid.curve.e0Bps} / a ${grid.curve.aBps} / φ ${grid.curve.phi}`,
        `${grid.w}×${grid.h} (${count(grid.mazes)}개)`,
        (grid.multiplierBps / 10_000).toFixed(4),
        pct(grid.botRtp, 4),
        pct(grid.optimalRtp, 4),
        points(grid.gap, 4),
      ]),
    );
  return [
    '## 정확성 게이트 (AC-T1)',
    '',
    '작은 격자(3×3, 4×4, 5×4)에서는 가능한 미로를 전부 나열할 수 있어서 "수학적으로 가장 잘하는 플레이"의 환수율을 오차 없이 계산할 수 있다. 보정 기준 봇(value-lsm)의 정확 환수율이 96.00%가 되도록 배율을 맞춘 뒤, 같은 배율에서 정확 최적이 얼마나 더 받는지를 잰 값이 간격이다. 통과 기준은 세 격자 모두 0.50%p 이하. 5×5·7×7·10×10에서는 정확 최적을 구할 수 없으므로, 그 크기에서의 간격은 **가정**으로 남는다.',
    '',
    table(['후보', '보정 봇', '3×3', '4×4', '5×4', '추세', '분기'], rows),
    '',
    table(['후보', '곡선', '격자 (미로 수)', '적용 배율', 'value-lsm (정확)', '정확 최적', '간격'], grids),
  ].join('\n');
}

function candidateRows(run: CandidateRun, mark: string): string[][] {
  return run.tiers.map((tier) => [
    `${run.name}${mark}`,
    tierName(tier.tier),
    `${tier.n}×${tier.n}`,
    curveText(tier),
    `${(tier.multiplierBps / 10_000).toFixed(4)}배`,
    `${pct(tier.bestRtp)} [${pct(tier.bestRtp - tier.bestHalfWidth)}, ${pct(tier.bestRtp + tier.bestHalfWidth)}] (${tier.bestBot})`,
    pct(tier.population['naive-greedy'].rtp),
    pct(tier.population['sloppy-greedy'].rtp),
    tier.basis === 'screened' ? screenedLabel(tier) : `스트림 ${tier.stream}, ${count(tier.sampleGames)}판, 고정 게이트 판정`,
  ]);
}

function behaviourRows(run: CandidateRun, mark: string, result: TuneResult): string[][] {
  const revenue = houseRevenue(run.tiers.map((tier) => tier.population), result.assumptions);
  return run.tiers.map((tier, i) => {
    const e = tier.engagement;
    return [
      `${run.name}${mark}`,
      tierName(tier.tier),
      pct(e.e4CashOutRate),
      pct(e.e3EarlyQuitRate),
      e.m1ContinuationMargin === null ? '—' : points(e.m1ContinuationMargin),
      `${e.e11SessionMedian}판`,
      pct(revenue.byTier[i]),
      tier.basis === 'screened' ? '축소 표본' : '인증',
    ];
  });
}

function comparisonSection(result: TuneResult): string {
  const chosen = result.baseline?.name ?? null;
  const mark = (run: CandidateRun): string => (run.name === chosen ? ' (기준선)' : '');
  const summary = result.candidates.map((run) => [
    `${run.name}${mark(run)}`,
    run.status === 'ok' ? '판정한 게이트 통과' : run.status === 'failed' ? `고정 실패: ${ko(run.reason ?? '')}` : `BLOCKED: ${ko(run.reason ?? '')}`,
    run.h === null ? '—' : `${pct(run.h, 3)} ± ${points(1.96 * (run.hSe ?? 0), 3)}`,
    run.state.notes.map(ko).join(' / ') || '—',
  ]);
  return [
    '## 후보 3개 비교',
    '',
    '세 후보는 환불 곡선이 다르다. (i)은 사용자의 말에 가장 가까운 곡선(첫 걸음 뒤 90%에서 완만하게 감소), (ii)는 첫 걸음에서 73%로 떨어진 뒤 감소, (iii)은 베팅 직후 80%에서 시작한다. S와 M은 스트림 B의 전체 판 수로 인증한 값이고, L은 선택된 표에만 전체 판 수를 쓴다(계획 §9.3). **선택되지 않은 후보의 L 수치는 축소 표본이며 고정 게이트로 판정되지 않았고 배포할 수 없다. L에서의 후보 순위는 인증 정밀도가 아니다.**',
    '',
    table(['후보', '크기', '격자', '곡선', '출구 배율', '최고 봇 환수율 [95% 신뢰구간]', '캐주얼(naive-greedy) 환수율', '실수 플레이어(sloppy-greedy) 환수율', '표본'], result.candidates.flatMap((run) => candidateRows(run, mark(run)))),
    '',
    '최고 봇의 행동과 세션 지표. 캐시아웃 비율은 최고 봇이 중간에 환불받고 나오는 판의 비율, 조기 포기율은 전체 판 가운데 한 걸음 이내에 환불받고 나오는 판의 비율, M1은 둘째 칸이 갈림길일 때 "계속 가는 가치 − 지금 환불받는 금액"(value-lsm 자신의 추정), 세션 중앙값은 naive-greedy가 50배 잔고로 1배씩 걸 때 버티는 판 수(상한 2,000, **가정** 범위와 비교), 크기별 하우스 몫은 집단 가중 평균 (1 − 환수율)이다(**가정**에 의존).',
    '',
    table(['후보', '크기', '최고 봇 캐시아웃 비율', '조기 포기율 (k ≤ 1)', 'M1', '세션 중앙값', '크기별 하우스 몫 (가정)', '표본'], result.candidates.flatMap((run) => behaviourRows(run, mark(run), result))),
    '',
    table(['후보', '판정', '집단 가중 하우스 수익 H (가정)', '적용된 조치'], summary),
  ].join('\n');
}

/** What the outcome means for this run, in one sentence (empty while the run is incomplete or blocked). */
function outcomeNote(result: TuneResult): string {
  if (result.outcome === 'no-improvement') return ' — 기준선을 유지한다. 이것은 실패가 아니라 유효한 결과다.';
  if (result.outcome !== 'improved') return '';
  const adopted = result.points.find((point) => point.status === 'adopted');
  const delta = adopted === undefined || adopted.deltaH === null ? '' : ` (기준선 대비 실측 ΔH ${points(adopted.deltaH, 3)}, 95% 하측 한계 ${points(adopted.deltaHLcb ?? 0, 3)})`;
  return result.pointMode === 'repair'
    ? ` — 기준선이 캐주얼·실수 플레이어 환수율 하한(E2 또는 E10)을 위반해서, 모든 제약을 만족하는 표로 바꿨다는 뜻이다. 하우스 수익 H가 늘었다는 뜻이 아니다${delta}.`
    : ` — 기준선보다 하우스 수익 H가 큰 표로 바꿨다${delta}.`;
}

/** The lowest naive-greedy RTP of a run and the tier it occurs on. */
function worstNaive(run: CandidateRun): string {
  const tier = run.tiers.reduce((worst, entry) => (entry.population['naive-greedy'].rtp < worst.population['naive-greedy'].rtp ? entry : worst));
  return `${tierName(tier.tier)} ${tier.n}×${tier.n}에서 ${pct(tier.population['naive-greedy'].rtp)}`;
}

/** How the default table was arrived at, as plain sentences built from the recorded decisions. */
function selectionStory(result: TuneResult): string[] {
  const a = result.assumptions;
  const story: string[] = [];
  const failing = (result.selection?.rows ?? []).filter((row) => !row.status.e2).map((row) => result.candidates.find((run) => run.name === row.name));
  const listed = failing.filter((run): run is CandidateRun => run !== undefined && run.tiers.length > 0);
  if (listed.length > 0) {
    story.push(`캐주얼 환수율 하한(E2, ${pct(a.e2NaiveRtpMin, 0)} 이상)을 못 지킨 후보: ${listed.map((run) => `${run.name} (${worstNaive(run)})`).join(', ')}.`);
  }
  for (const change of result.sizeChanges.filter((entry) => entry.adopted)) {
    story.push(`그래서 후보 ${change.candidate}의 ${tierName(change.tier)} 크기를 ${change.from}×${change.from}에서 ${change.to}×${change.to}로 줄였다(스펙 이탈). 축소 표본으로는 하한을 지켰다.`);
  }
  if (result.baseline !== null && result.baseline.tiers.length > 0) {
    const status = constraintStatus(result.baseline.tiers, a);
    story.push(`기준선 ${result.baseline.name}을 전체 판 수로 인증하자 캐주얼 환수율이 가장 낮은 곳은 ${worstNaive(result.baseline)}였다(E2 ${status.e2 ? '충족' : '위반'}).`);
  }
  if (result.points.length > 0) {
    const adopted = result.points.find((point) => point.status === 'adopted');
    const rejected = result.points.filter((point) => point.status === 'rejected').map((point) => point.name);
    story.push(
      `탐색 점 ${result.points.length}개를 새로 보정·인증했다${rejected.length > 0 ? ` (기각: ${rejected.join(', ')})` : ''}. ` +
        (adopted === undefined ? '채택된 점이 없어 기준선을 유지한다.' : `${adopted.name}을 채택했다.`),
    );
  }
  return story;
}

function selectionSection(result: TuneResult): string {
  const parts: string[] = ['## 기본 표의 선택', ''];
  const a = result.assumptions;
  const story = selectionStory(result);
  if (story.length > 0) parts.push(story.join(' '), '');
  if (result.selection !== null) {
    parts.push(
      table(
        ['후보', 'H (가정)', 'E2 (naive ≥ ' + pct(a.e2NaiveRtpMin, 0) + ')', 'E10 (sloppy ≥ ' + pct(a.e10SloppyRtpMin, 0) + ')', 'E8 (배율)', 'E9 (환불 하한)', '가능 여부'],
        result.selection.rows.map((row) => [
          row.name,
          pct(row.h, 3),
          row.status.e2 ? '충족' : '위반',
          row.status.e10 ? '충족' : '위반',
          row.status.e8 ? '충족' : '위반',
          row.status.e9 ? '충족' : '위반',
          row.feasible ? '가능' : '불가',
        ]),
      ),
      '',
    );
    parts.push(`- 규칙: 고정 게이트를 통과한 후보 가운데 가정 제약(E2, E10, E8, E9)을 만족하는 것 중 H가 가장 큰 후보. H 차이가 0.2%p 이내면 베팅 시 차감(e0)이 작은 쪽, 그다음 aBps가 큰 쪽.`);
    parts.push(`- 선호 순서: ${result.selection.order.join(' → ') || '없음'}`);
    parts.push(`- 완화한 제약: ${result.relaxed.length === 0 ? '없음' : result.relaxed.join(', ')} (완화 순서는 E9 → E8뿐이다. E2와 E10은 완화하지 않는다)`);
    parts.push(`- 가정 범위: ${result.assumptionRangeMet ? '충족' : '**가정 범위 미충족** (위반폭이 가장 작은 기준선을 채택)'}`);
  }
  for (const change of result.sizeChanges) {
    parts.push(`- 크기 변경 시도 (${change.candidate}, ${tierName(change.tier)}): ${change.from} → ${change.to}, ${change.adopted ? '채택 (스펙 이탈)' : '기각'} — ${ko(change.reason)}`);
  }
  for (const attempt of result.baselineAttempts) {
    parts.push(`- 전체 판 수(L 포함)에서의 기준선 시도: ${attempt.name} — ${attempt.status === 'ok' ? '모든 게이트 통과' : `실패 (${ko(attempt.reason ?? '')})`}`);
  }
  if (result.baseline !== null) {
    const status = constraintStatus(result.baseline.tiers, a);
    parts.push(`- 기준선 ${result.baseline.name} (L 인증 후): E2 ${status.e2 ? '충족' : '위반'}, E10 ${status.e10 ? '충족' : '위반'}, E8 ${status.e8 ? '충족' : '위반'}, E9 ${status.e9 ? '충족' : '위반'}, H ${result.baseline.h === null ? '—' : pct(result.baseline.h, 3)}`);
  }
  return parts.join('\n');
}

function gateRows(tier: TierCertification): string[][] {
  const g = tier.gates;
  const cal = tier.calibration;
  const verdict = (pass: boolean): string => (pass ? '통과' : '**실패**');
  return [
    [tierName(tier.tier), '보정 (스트림 A): 최대 상측 한계 U ≤ 상한', cal.u === null ? cal.status : `${pct(cal.u, 3)} (${cal.best})`, `${((cal.ceilingBps ?? 0) / 100).toFixed(2)}%`, verdict(cal.pass) + (cal.windowMissed ? ' (창 미달)' : '')],
    [tierName(tier.tier), '최고 봇 점추정 (스트림 A) ∈ [94%, 96%]', g.bestPoint.value === null ? '—' : pct(g.bestPoint.value, 3), '94.00% ~ 96.00%', verdict(g.bestPoint.pass)],
    [tierName(tier.tier), '고정 게이트 1 (스트림 B): 인증 봇 전부의 상측 한계', `${pct(g.gate1.value, 3)} (${g.gate1.worst})`, `≤ ${pct(g.gate1.limit)}`, verdict(g.gate1.pass)],
    [tierName(tier.tier), '고정 게이트 2: 적대자를 포함한 모든 합법 봇의 상측 한계', `${pct(g.gate2.value, 3)} (${g.gate2.worst})`, `≤ ${pct(g.gate2.limit)}`, verdict(g.gate2.pass)],
    [tierName(tier.tier), 'N1 플레이 프리미엄: 최고 봇 점추정 − refund(0)', points(g.playPremium.value, 3), '> 0', verdict(g.playPremium.pass)],
    [
      tierName(tier.tier),
      `AC-X8 시작 방향 대칭 (harmonic 승률 차, ${count(g.startSymmetry.gamesEast + g.startSymmetry.gamesSouth)}판)`,
      `${points(g.startSymmetry.diff, 3)} [${points(g.startSymmetry.ci[0], 3)}, ${points(g.startSymmetry.ci[1], 3)}]`,
      `±${points(g.startSymmetry.margin, 3)} 안 (TOST, α 0.01)`,
      verdict(g.startSymmetry.pass),
    ],
  ];
}

function certificationSection(title: string, certification: TableCertification | null): string {
  if (certification === null) return `## ${title}\n\n인증 기록이 없다.`;
  const parts: string[] = [`## ${title}`, '', `tableHash \`${certification.tableHash}\`, 시뮬레이터 코드 해시 \`${certification.simCodeHash}\`, 판정: ${certification.pass ? '**모든 게이트 통과**' : '**실패**'}`];

  parts.push('', '### 게이트 결과', '', table(['크기', '게이트', '측정값', '기준', '판정'], certification.tiers.flatMap(gateRows)));

  parts.push(
    '',
    '### 실현 엣지',
    '',
    '하우스가 "가장 잘하는 봇"을 상대로 갖는 몫이다. 보정이 상측 신뢰한계를 상한에 맞추므로, 표본이 적어 신뢰구간이 넓은 크기일수록 점추정이 낮게(하우스에 유리하게) 잡힌다.',
    '',
    // Same columns and precision as `report:check` expects in the final report.
    table(
      ['크기', '배율', '판 수', '최고 봇', '환수율', '상측 신뢰한계', '실현 엣지', 'rollout(32)', 'value-lookahead-all'],
      certification.tiers.map((tier) => {
        const adversary = (name: string): string => {
          const pair = tier.pairs.find((entry) => entry.adversary === name);
          return pair === undefined ? '—' : pct(pair.rtp);
        };
        return [
          `${tier.n}×${tier.n}`,
          `${(tier.multiplierBps / 10_000).toFixed(4)}배`,
          tier.games.toLocaleString('en-US'),
          tier.best.bot,
          pct(tier.best.rtp),
          pct(tier.best.ucb975),
          pct(1 - tier.best.rtp),
          adversary('rollout(32)'),
          adversary('value-lookahead-all'),
        ];
      }),
    ),
  );

  for (const tier of certification.tiers) {
    parts.push('', `### ${tierName(tier.tier)} (${tier.n}×${tier.n}, ${(tier.multiplierBps / 10_000).toFixed(4)}배, 셀당 ${count(tier.games)}판)`, '');
    parts.push(
      table(
        ['봇', '스트림', '판 수', '환수율', '95% 신뢰구간', '97.5% 상측 한계', '표준편차'],
        tier.cells.map((cell) => [
          cell.bot,
          cell.stream,
          count(cell.games),
          pct(cell.rtp, 3),
          `[${pct(cell.ci95[0], 3)}, ${pct(cell.ci95[1], 3)}]`,
          pct(cell.ucb975, 3),
          cell.sd.toFixed(4),
        ]),
      ),
    );
    parts.push(
      '',
      '적대자는 너무 느려서 전체 판 수를 돌릴 수 없는 봇이다. value-lsm과 **같은 미로**에서 짝으로 돌려 차이를 재고, 적대자의 환수율은 "value-lsm의 스트림 B 환수율 + 짝 차이 평균"으로 추정한다(두 분산을 더한다). 판정은 상측 한계로 한다.',
      '',
      table(
        ['적대자 (스트림 D)', '점추정', '96.5%와의 차', '상측 한계', '99.0% 게이트', '짝 차이 평균', '달성 반폭', '짝 수'],
        tier.pairs.map((pair) => [
          pair.adversary,
          pct(pair.rtp, 3),
          points(pair.rtp - 0.965, 3),
          pct(pair.ucb975, 3),
          pair.ucb975 <= tier.gates.gate2.limit ? '통과' : '**실패**',
          points(pair.meanDiff, 3),
          `±${points(pair.halfWidthDiff, 3)}${pair.capped ? ` (짝 수 상한 ${count(pair.pairs)}쌍에 걸림)` : ''}`,
          count(pair.pairs),
        ]),
      ),
    );
  }
  return parts.join('\n');
}

function engagementSection(run: CandidateRun): string {
  const rows = run.tiers.map((tier) => {
    const e = tier.engagement;
    const flag = (ok: boolean): string => (ok ? '' : ' **(범위 밖)**');
    return [
      tierName(tier.tier),
      `${pct(e.e1WinRate)} (범위 ${pct(e.e1Range[0], 0)}~${pct(e.e1Range[1], 0)})${flag(e.e1InRange)}`,
      `${pct(e.e2NaiveRtp)}${flag(e.e2Pass)}`,
      pct(e.e3EarlyQuitRate),
      pct(e.e4CashOutRate),
      e.e6MeanSteps.toFixed(2),
      pct(e.e7NearMissRate),
      `${e.e8Multiplier.toFixed(2)}배 (≥ ${e.e8Min})${flag(e.e8Pass)}`,
      `${e.e9Refund1Bps} / ${e.e9RefundAtShortestBps}${flag(e.e9Pass)}`,
      `${pct(e.e10SloppyRtp)}${flag(e.e10Pass)}`,
      `${e.e11SessionMedian} (≥ ${e.e11Min})${flag(e.e11Pass)}`,
      points(e.n1PlayPremium, 3),
      e.m1ContinuationMargin === null ? '—' : points(e.m1ContinuationMargin),
    ];
  });
  return table(
    ['크기', 'E1 승리 빈도 (naive)', 'E2 naive 환수율', 'E3 조기 포기율', 'E4 캐시아웃 비율', 'E6 평균 걸음', 'E7 근접 패배', 'E8 배율', 'E9 refund[1] / refund[L] (bps)', 'E10 sloppy 환수율', 'E11 세션 중앙값', 'N1 플레이 프리미엄', 'M1'],
    rows,
  );
}

const GAME_KINDS: [kind: string, label: string][] = [
  ['eval:A', '보정 (스트림 A)'],
  ['eval:B', '인증 (스트림 B)'],
  ['pair:D', '적대자 짝 비교 (스트림 D, 한 쌍 = 두 판)'],
  ['train:C', '학습 (스트림 C: 가치표 정책 반복, region 표)'],
  ['trajectories:C', 'harmonic 궤적 (스트림 C, harmonic-lsm 학습용)'],
  ['trajectories:E', '궤적 캐시 (스트림 E, 거친 순위용)'],
  ['search:C', 'param-search θ 탐색 (스트림 C, θ 하나당 20만 판)'],
];

function exactGateGames(result: TuneResult, trainPasses: number): number {
  const seen = new Set<string>();
  let total = 0;
  const runs = [...result.candidates, ...(result.baseline ? [result.baseline] : []), ...(result.final ? [result.final] : []), ...(result.houseMax?.run ? [result.houseMax.run] : [])];
  for (const run of runs) {
    for (const grid of run.exact?.grids ?? []) {
      const id = `${run.exact!.variant.level}|${grid.curve.e0Bps}|${grid.curve.aBps}|${grid.curve.phi}|${grid.w}x${grid.h}`;
      if (seen.has(id)) continue;
      seen.add(id);
      // Harmonic pass and harmonic evaluation once; then per evaluated multiplier: the training passes and one evaluation of every maze.
      total += grid.trainGames + grid.mazes + grid.evaluations.length * (trainPasses * grid.trainGames + grid.mazes);
    }
  }
  return total;
}

function scaleSection(input: ReportInput): string {
  const { result } = input;
  const parts: string[] = ['## 시뮬레이션 규모', ''];
  const certification = input.finalCertification;
  parts.push('사용자가 요구한 것은 "1,000회 이상"이다. 1,000판으로는 환수율을 가릴 수 없어서(아래 표의 마지막 열) 인증은 셀(봇 하나 × 크기 하나) 하나에 수백만 판을 쓴다. 판 수는 실행 전에 고정했고, 실행 중에 줄이는 경로는 없다.', '');
  if (certification !== null) {
    parts.push(
      table(
        ['크기', '셀당 판 수 (선택된 표)', '사용자 기준 1,000판 대비', '인증 셀 수', '이 크기의 인증 판 수', '최고 봇 95% 반폭', '1,000판이었다면 반폭'],
        certification.tiers.map((tier) => {
          const reference = tier.cells.find((cell) => cell.bot === 'value-lsm');
          return [
            `${tierName(tier.tier)} (${tier.n}×${tier.n})`,
            count(tier.games),
            `${count(tier.games / 1000)}배`,
            String(tier.cells.length),
            count(tier.cells.reduce((total, cell) => total + cell.games, 0)),
            reference === undefined ? '—' : `±${points(halfWidth95(reference.sd, reference.games), 3)}`,
            reference === undefined ? '—' : `±${points(halfWidth95(reference.sd, 1000), 1)}`,
          ];
        }),
      ),
      '',
    );
  }
  const games = input.games ?? {};
  const rows: string[][] = [];
  let total = 0;
  for (const [kind, label] of GAME_KINDS) {
    const value = games[kind] ?? 0;
    if (value === 0) continue;
    rows.push([label, count(value)]);
    total += value;
  }
  const exact = exactGateGames(result, input.trainPasses ?? 3);
  // A rejected search point keeps no exactness record in the result, so its gate cannot be counted here.
  const rejectedPoints = result.points.some((point) => point.status === 'rejected' && point.certified !== null);
  if (exact > 0) {
    rows.push([`정확성 게이트 (3×3, 4×4, 5×4 전 미로 열거 위에서의 학습·평가${rejectedPoints ? '. 결과 파일에 남은 표만 센 값이다' : ''})`, count(exact)]);
    total += exact;
  }
  if (rows.length > 0) {
    rows.push([rejectedPoints ? '**합계 (최소)**' : '**합계**', `**${count(total)}**`]);
    parts.push('이 튜닝 실행 전체에서 시뮬레이션한 판 수(캐시에서 다시 읽은 판은 한 번만 센다. 처리량을 재는 벤치마크 판은 뺐다):', '', table(['용도', '판 수'], rows));
    if (rejectedPoints) parts.push('', '기각된 탐색 점의 정확성 게이트는 결과 파일에 기록이 남지 않아 위 합계에서 빠졌다. 실제로 돌린 판은 합계보다 많다.');
  }
  const stages = Object.entries(input.stageSeconds ?? {}).filter(([name]) => name.startsWith('stage:'));
  if (stages.length > 0) {
    const totalSeconds = (input.stageSeconds ?? {}).tune;
    parts.push(
      '',
      '### 단계별 소요 시간 (벽시계)',
      '',
      '여러 번의 호출(호출당 최대 100분)에 걸친 누적 시간이다. 끝난 작업을 캐시에서 다시 읽는 시간이 조금 포함된다.',
      '',
      table(
        ['단계', '누적 시간'],
        [...stages.map(([name, seconds]) => [ko(name.slice('stage:'.length)), duration(seconds)]), ...(totalSeconds === undefined ? [] : [['**tune 전체**', `**${duration(totalSeconds)}**`]])],
      ),
    );
  }
  return parts.join('\n');
}

function deviationSection(input: ReportInput): string {
  const certification = input.finalCertification;
  const lookahead: string[] = [];
  const degenerate: string[] = [];
  for (const tier of certification?.tiers ?? []) {
    const pair = tier.pairs.find((entry) => entry.adversary === 'value-lookahead-all');
    if (pair !== undefined) lookahead.push(`${tierName(tier.tier)} ${points(pair.meanDiff, 3)} ± ${points(pair.halfWidthDiff, 3)}`);
    const region = tier.cells.find((cell) => cell.bot === 'region-heuristic');
    const search = tier.cells.find((cell) => cell.bot === 'param-search');
    if (region !== undefined && search !== undefined) {
      degenerate.push(`${tierName(tier.tier)}: region-heuristic ${pct(region.rtp, 3)} (표준편차 ${region.sd.toFixed(4)}), param-search ${pct(search.rtp, 3)} (표준편차 ${search.sd.toFixed(4)})`);
    }
  }
  const level = input.result.final?.state.level ?? 0;
  return [
    '## 계획과 달라진 점',
    '',
    '시뮬레이터 구현(WS-E)에서 계획 문구와 다르게 했거나 계획이 예상하지 못한 사실 일곱 가지다. 1~5는 오케스트레이터가 구현대로 승인했고, 6~7은 결함이 아니라 발견이다.',
    '',
    '1. **학습 규칙.** 계획 §3.3은 "갈림길 수가 j보다 적은 탐색 판은 탐욕 판으로 센다"고 했다. 그대로 하면 일찍 끝난 판(대부분 패배)만 골라 기록하게 되어 초반 가치가 낮게 치우친다. 문구대로 구현했을 때 후보 (ii)의 정확성 간격은 0.00 / 1.30 / 2.52%p(게이트 실패)였고, "탐색 판이 j번째 갈림길에 닿지 못하면 아무것도 기록하지 않는다"로 바꾸자 0.00 / 0.04 / 0.14%p가 되어 Architect의 전 미로 열거 수치와 일치했다. 바꾼 규칙을 쓴다.',
    '2. **선행 탐색의 P(m).** 계획은 패턴마다 띠행렬 로그 행렬식을 구한다고 했다. 실제로는 한 번의 분해에서 Green 함수 갱신으로 같은 값을 구한다(수학적으로 동일). 로그 행렬식 구현을 기준으로 남겨 두었고, 둘 다 4×4 전 미로 열거와 1e-12 이내, 서로는 5×5·7×7·10×10에서 1e-10 이내로 일치한다.',
    '3. **캐시 키.** 계획은 표 전체의 `tableHash`를 키에 넣는다고 했다. 실제 키는 `sha256(크기별 경제 해시 ‖ 시뮬레이터 코드 해시 ‖ 셀 정의)`이고, 경제 해시는 그 크기의 격자·배율·환불 표만 덮는다. 다른 크기를 바꿔도 이 크기의 인증이 유지되게 하기 위해서다("그 크기만 다시 계산한다"). 결과에 영향을 주는 입력은 모두 키에 들어 있다.',
    '4. **AC-X8 몬테카를로.** 시작 방향 대칭 검정(S 2M / M 4M / L 8M)은 단위 테스트가 아니라 `sim:certify`가 스트림 B의 harmonic 셀(3M / 5M / 11M 이상)로 판정하며, 동등성이 나오지 않으면 인증이 실패한다. 결과는 위 "게이트 결과" 표에 있다.',
    '5. **AC-R6의 [94%, 96%].** 최고 봇 점추정 범위는 보정 표본(스트림 A)에서 읽는다. 스트림 B에서 읽으면 상한과 우연히 모순될 수 있어 계획 §3.8의 "한쪽 조건"과 맞지 않는다.',
    `6. **value-lookahead-all은 value-lsm보다 항상 강하지 않다.** 첫 결정(k = 0)에서 직접 추정값 A[1] 대신 한 단계 선행 추정을 쓰기 때문에, value-lsm이 계속 가는 판에서 캐시아웃할 수 있다. 선택된 표에서 측정한 짝 차이(value-lookahead-all − value-lsm): ${lookahead.join(', ') || '기록 없음'}.${level >= 1 ? ' 이 표는 적대자 흡수 규칙 또는 정확성 게이트 분기 1로 value-lsm 자체가 모든 결정에서 선행 탐색을 하므로 두 봇이 같다.' : ''}`,
    `7. **region-heuristic과 param-search의 퇴화.** 정의대로면 e0 = 5% 곡선에서 \`M × Ŵ[0][d] < refund(0)\`이라 첫 걸음 전에 캐시아웃하고 환수율이 정확히 refund(0)가 된다. 선택된 표에서의 측정값 — ${degenerate.join('; ') || '기록 없음'}. 표준편차가 0이면 모든 판에서 첫 걸음 전에 캐시아웃했다는 뜻이다(베팅 시 차감이 큰 곡선에서는 퇴화하지 않는다). 두 봇은 정의대로 인증 묶음에 남아 있고 게이트 판정에 포함된다.`,
    '',
    '캠페인 중에 고친 것 (시뮬레이터 코드 해시 범위 밖, 캐시 무효화 없음): 탐색 점의 거친 순위는 처음에 harmonic-lsm의 "정책 가치"가 같아지는 배율을 찾았다. 보정된 배율에서는 harmonic-lsm이 첫 걸음 전에 캐시아웃하는 쪽을 택해 그 가치가 넓은 배율 구간에서 정확히 refund(0)로 평평하므로 배율을 구별하지 못했고(M과 L에서 추정 배율이 기준선 + 1 bps 또는 1.0배로 나왔다), 기준선이 E2를 위반했는데도 시도할 점이 하나도 뽑히지 않았다. "첫 걸음을 내딛었을 때의 가치(플레이 가치)"가 같아지는 배율을 찾도록 고쳤고(`packages/sim/src/campaign.ts`, 테스트 `test/campaign.test.ts`), 순위만 다시 계산했다.',
  ].join('\n');
}

function cautionSection(input: ReportInput): string {
  const { result } = input;
  const final = result.final;
  if (final === null) return '';
  const a = result.assumptions;
  const lines: string[] = ['## 적용 전에 따져 볼 점', ''];
  for (const tier of final.tiers) {
    const e = tier.engagement;
    lines.push(
      `- ${tierName(tier.tier)} (${tier.n}×${tier.n}): 캐주얼 환수율 ${pct(e.e2NaiveRtp)}는 E2 하한 ${pct(a.e2NaiveRtpMin, 0)}보다 ${points(e.e2NaiveRtp - a.e2NaiveRtpMin)} ${e.e2NaiveRtp >= a.e2NaiveRtpMin ? '높다' : '**낮다**'}. ` +
        `최고 봇은 전체 판의 ${pct(e.e4CashOutRate)}에서 캐시아웃하고, 전체 판의 ${pct(e.e3EarlyQuitRate)}에서는 한 걸음 이내에 나온다. 플레이 프리미엄(최고 봇이 "아예 안 걷고 환불받기"보다 더 받는 몫)은 ${points(e.n1PlayPremium, 3)}이다.` +
        (e.m1ContinuationMargin === null ? '' : ` 둘째 칸이 갈림길일 때 계속 가는 쪽의 여유(M1)는 ${points(e.m1ContinuationMargin)}${e.m1ContinuationMargin < 0 ? '로 음수다(그 자리에서는 환불받는 쪽이 낫다)' : '이다'}.`) +
        (tier.windowMissed ? ' 보정이 상한 아래 0.1%p 창에 들지 못했다(창 미달: 배율이 필요 이상 낮다, 하우스에 유리한 쪽).' : ''),
    );
  }
  for (const point of result.points) {
    if (point.certified === null) continue;
    const margin = point.certified.naiveRtp - a.e2NaiveRtpMin;
    lines.push(
      `- 탐색 점 ${point.name}: 인증된 naive-greedy 환수율 ${pct(point.certified.naiveRtp, 3)}, E2 하한과의 차 ${points(margin, 3)} → ${point.status === 'adopted' ? '채택' : '기각'}. ` +
        `E2는 점추정으로 판정하며, 이 차이가 보정이 상한 아래 어디에 떨어지느냐(창 미달 폭)에 따라 달라지는 크기와 비슷하면 판정은 우연에 가깝다.`,
    );
  }
  for (const change of result.sizeChanges.filter((entry) => entry.adopted)) {
    lines.push(`- ${tierName(change.tier)} 크기 ${change.from} → ${change.to}은 스펙 이탈이다. 표시 배율이 작아지고(E8 가정 범위 밖일 수 있다) 사용자가 고른 "3단계 5 / 7 / 10"과 달라진다. 스펙 크기를 유지하려면 E2(캐주얼 환수율 ≥ ${pct(a.e2NaiveRtpMin, 0)}) 가정을 낮추거나 하우스 최대 표처럼 E2 없이 고른 표를 써야 한다.`);
  }
  const b = result.houseMax?.run ?? null;
  if (b !== null && b.tiers.length > 0) {
    const lowest = (pick: (tier: TierSummary) => number): TierSummary => b.tiers.reduce((worst, tier) => (pick(tier) < pick(worst) ? tier : worst));
    const naive = lowest((tier) => tier.engagement.e2NaiveRtp);
    const sloppy = lowest((tier) => tier.engagement.e10SloppyRtp);
    const session = lowest((tier) => tier.engagement.e11SessionMedian);
    lines.push(
      `- 하우스 최대 표 (b) ${b.name}로 바꾸면 H는 ${final.h === null || b.h === null ? '—' : points(b.h - final.h, 3)} 늘지만(가정에 의존), 캐주얼 환수율은 가장 낮은 곳이 ${pct(naive.engagement.e2NaiveRtp)} (${tierName(naive.tier)}), ` +
        `실수 플레이어 환수율은 ${pct(sloppy.engagement.e10SloppyRtp)} (${tierName(sloppy.tier)}, E10 하한 ${pct(a.e10SloppyRtpMin, 0)}까지 ${points(sloppy.engagement.e10SloppyRtp - a.e10SloppyRtpMin)}), ` +
        `세션 중앙값은 ${session.engagement.e11SessionMedian}판 (${tierName(session.tier)})까지 내려가고, 최고 봇은 전체 판의 ${b.tiers.map((tier) => pct(tier.engagement.e3EarlyQuitRate, 1)).join(' / ')}에서 한 걸음 이내에 나온다.`,
    );
  }
  const others = result.candidates.filter((run) => run.status === 'ok' && run.name !== (result.baseline?.name ?? ''));
  const base = result.candidates.find((run) => run.name === result.baseline?.name);
  for (const other of others) {
    if (base?.h !== null && base?.h !== undefined && other.h !== null) {
      lines.push(`- 후보 ${other.name}와의 H 차이는 ${points(other.h - base.h, 3)}이다(비교 시점 수치, L은 축소 표본으로 잡음 약 ±${points(1.96 * Math.hypot(other.hSe ?? 0, base.hSe ?? 0), 3)}).`);
    }
  }
  lines.push('- 5×5 이상에서 최고 봇과 진짜 최적 사이의 간격은 **가정**이다. 근거는 3×3·4×4·5×4의 정확 간격과 그 추세뿐이다.');
  lines.push('- 하우스 수익 H, 흥미 범위, 집단 구성은 전부 **가정**이다. 실제 플레이어 데이터가 생기면 바꿔야 한다.');
  return lines.join('\n');
}

export interface ReportInput {
  result: TuneResult;
  sensitivity: SensitivityReport | null;
  finalCertification: TableCertification | null;
  houseMaxCertification: TableCertification | null;
  candidateTablePath: string;
  houseMaxTablePath: string;
  /** Games simulated by kind, from the run-time ledger. */
  games?: Record<string, number>;
  /** Accumulated wall-clock seconds by stage (`stage:<name>`) and for the whole command (`tune`). */
  stageSeconds?: Record<string, number>;
  /** Policy-iteration passes per training (for the exactness-gate game count). */
  trainPasses?: number;
}

export function renderTuningReport(input: ReportInput): string {
  const { result, sensitivity } = input;
  const a = result.assumptions;
  const outcome = result.outcome === 'improved' ? '개선됨' : result.outcome === 'no-improvement' ? '개선 없음' : result.outcome === 'blocked' ? 'BLOCKED' : '미완료';
  const parts: string[] = [];
  parts.push('# 튜닝 보고서', '');
  parts.push('이 문서는 `pnpm tune`이 결과 파일(`packages/sim/reports/tune-result.json`, `certify.json`, 캐시의 실행 기록)에서 직접 만든다. 손으로 적은 수치는 없다.', '');
  parts.push(`- 프로파일: \`${result.profile}\`${result.profile === 'production' ? '' : ' (운영 수치가 아니다. 이 프로파일의 표는 배포할 수 없다)'}`);
  parts.push(`- 시뮬레이터 코드 해시: \`${result.simCodeHash}\``);
  parts.push(`- 생성 시각: ${result.generatedAt}`);
  parts.push(`- **튜닝 결과: ${outcome}**${outcomeNote(result)}`);
  if (result.final !== null) {
    parts.push(`- 선택된 기본 표 (a): 후보 \`${result.final.name}\` → \`${input.candidateTablePath}\``);
    parts.push(`- 출구 배율: ${result.final.tiers.map((tier) => `${tierName(tier.tier)} ${tier.n}×${tier.n} ${(tier.multiplierBps / 10_000).toFixed(4)}배`).join(', ')}`);
  }
  if (result.houseMax !== null) {
    parts.push(`- 하우스 최대 표 (b): ${result.houseMax.same || result.houseMax.run === null ? '기본 표와 같다' : `후보 \`${result.houseMax.run.name}\` → \`${input.houseMaxTablePath}\``}`);
  }
  const revenue = (run: CandidateRun | null | undefined): string => (run === null || run === undefined || run.h === null ? '—' : `${pct(run.h, 3)} ± ${points(1.96 * (run.hSe ?? 0), 3)}`);
  if (result.final !== null) {
    parts.push(`- 집단 가중 하우스 수익 H (**가정**에 의존): (a) ${revenue(result.final)}${result.houseMax?.run ? `, (b) ${revenue(result.houseMax.run)}` : ''}`);
  }
  for (const change of result.sizeChanges.filter((entry) => entry.adopted)) {
    parts.push(`- **스펙 이탈: ${tierName(change.tier)} 크기를 ${change.from}×${change.from}에서 ${change.to}×${change.to}로 바꿨다.** 스펙 크기에서는 어느 후보도 캐주얼 환수율 하한(E2)을 만족하지 못해 계획 §9.3 우선순위 2번의 크기 변경을 적용했다.`);
  }
  if (result.relaxed.length > 0) parts.push(`- 완화한 가정 제약: ${result.relaxed.join(', ')}`);
  if (result.blocked !== null) parts.push(`- **BLOCKED(${result.blocked.kind === 'economic' ? '경제' : '실행 시간'})**: ${result.blocked.message}`);
  parts.push(
    '',
    '**캐주얼 환수율 하한(E2)이 하우스 수익의 상한을 정한다.** 최고 플레이어 기준 엣지는 보정 규칙이 정하고(가장 잘하는 봇의 97.5% 상측 신뢰한계가 상한 이하), 하우스의 추가 수익은 최고 플레이어와 평범한 플레이어의 간격에서 나오며, 그 간격을 얼마나 벌릴 수 있는지는 "평범한 플레이어도 85%는 돌려받아야 한다"는 E2라는 **가정**이 막는다.',
    '',
    '용어: 환수율(RTP)은 베팅액 대비 평균 지급액. 상측 신뢰한계는 "평균 + 1.96 × 표준오차"(97.5% 한쪽). 스트림 A는 보정, B는 인증, C는 학습, D는 적대자 짝 비교, E는 궤적 캐시에만 쓰는 서로 겹치지 않는 난수열이다.',
  );

  parts.push('', scaleSection(input));

  parts.push('', '## 가정', '', '아래 값은 전부 **가정**이다(실제 플레이어 데이터가 없다). 하우스 수익 H, 흥미 지표의 판정, 후보 선택이 이 값에 의존한다.', '');
  parts.push(table(['집단 (가정)', '가중치'], POPULATION_MEMBERS.map((member) => [member === 'best' ? '최고 봇' : member, a.population[member].toFixed(2)])));
  parts.push('', `- 크기 이용 비중 (가정): ${a.tierShare.map((share, i) => `${tierName(i)} ${share.toFixed(2)}`).join(', ')}`);
  parts.push(`- 흥미 범위 (가정): E2 naive-greedy 환수율 ≥ ${pct(a.e2NaiveRtpMin, 0)}, E10 sloppy-greedy 환수율 ≥ ${pct(a.e10SloppyRtpMin, 0)}, E8 표시 배율 ≥ ${a.e8MultiplierMin.join(' / ')}배, E9 refund[1] ≥ ${a.e9Refund1MinBps} bps · refund[L] ≥ ${a.e9RefundAtShortestMinBps} bps`);
  parts.push(`- E1 승리 빈도 범위 (가정): ${a.e1WinRate.map((range, i) => `${tierName(i)} ${pct(range[0], 0)}~${pct(range[1], 0)}`).join(', ')}; E11 세션 중앙값 하한 (가정): ${a.e11MedianMin.join(' / ')}판`);

  const exactRuns = [...result.candidates];
  for (const extra of [result.baseline, result.final, result.houseMax?.run ?? null]) {
    if (extra !== null && extra.exact !== null && !exactRuns.some((run) => run.name === extra.name && run.exact?.variant.level === extra.exact?.variant.level)) exactRuns.push(extra);
  }
  parts.push('', exactSection(exactRuns));
  parts.push('', comparisonSection(result));
  parts.push('', selectionSection(result));

  parts.push('', '## 탐색 점', '');
  parts.push(`탐색 "점"은 한 크기의 (aBps, φ) 하나다. 크기마다 격자 35점을 궤적 캐시로 거칠게 순위 매겨, ${result.pointMode === 'repair' ? '기준선이 E2 또는 E10을 위반하므로 모든 제약을 만족하는 첫 점을 찾았다(우선순위 3번)' : '거친 ΔH가 0.2%p 이상인 점만 최대 3개까지 새로 보정·인증했다(우선순위 4번: ΔH ≥ 0.2%p이고 95% 하측 한계 > 0일 때만 채택)'}.`, '');
  if (result.points.length === 0) {
    parts.push('보정한 탐색 점이 없다. 거친 추정에서 목표 개선(0.2%p)에 닿는 점이 없었다(게이트 약화가 아니라 개선 불가 판정).');
  } else {
    parts.push(
      table(
        ['점', '크기', 'a / φ', '거친 추정: 배율 · naive 환수율 · ΔH', '보정된 배율', '인증된 naive 환수율', '인증된 최고 봇 환수율', '실측 ΔH (95% 하측 한계)', '판정', '이유'],
        result.points.map((point) => [
          point.name,
          tierName(point.estimate.tier),
          `${point.estimate.aBps} / ${point.estimate.phi}`,
          `${(point.estimate.multiplierBps / 10_000).toFixed(4)}배 · ${pct(point.estimate.naiveRtp)} · ${points(point.estimate.deltaH, 3)}`,
          point.certified ? `${(point.certified.multiplierBps / 10_000).toFixed(4)}배${point.certified.windowMissed ? ' (창 미달)' : ''}${point.certified.level > 0 ? `, 봇 개선 단계 ${point.certified.level}` : ''}` : '—',
          point.certified ? pct(point.certified.naiveRtp, 3) : '—',
          point.certified ? pct(point.certified.bestRtp, 3) : '—',
          point.deltaH === null ? '—' : `${points(point.deltaH, 3)} (${points(point.deltaHLcb ?? 0, 3)})`,
          point.status === 'adopted' ? '채택' : '기각',
          ko(point.reason),
        ]),
      ),
    );
  }
  parts.push('', `**튜닝 결과: ${outcome}**${outcomeNote(result)}`);

  if (result.final !== null) {
    parts.push('', certificationSection(`선택된 표 (a): ${result.final.name}`, input.finalCertification));
    parts.push('', '### 흥미·세션 지표 (가정)', '', '범위와 하한은 전부 **가정**이다. E3·E4·E6·E7·M1은 보고만 한다.', '', engagementSection(result.final));
  }

  parts.push('', '## 기본 표와 하우스 최대 표', '');
  parts.push('(a) 기본 표는 E2(캐주얼 환수율 ≥ 85%)를 지킨 선택이고, (b) 하우스 최대 표는 **이미 보정된 표들 가운데** E2를 적용하지 않고 고정 게이트·N1·E10만으로 H가 가장 큰 표다. 따로 탐색하지 않는다.', '');
  if (result.houseMax === null) {
    parts.push('하우스 최대 표를 판정하지 못했다.');
  } else if (result.houseMax.same || result.houseMax.run === null) {
    parts.push('하우스 최대 표 (b)는 기본 표 (a)와 **같다**. 이미 보정된 표 가운데 고정 게이트·N1·E10 아래에서 H가 더 큰 표가 없다.');
  } else if (result.final !== null) {
    const b = result.houseMax.run;
    parts.push(`하우스 최대 표 (b): ${b.name} — \`${input.houseMaxTablePath}\``, '');
    parts.push(
      table(
        ['표', '크기', '곡선', '출구 배율', 'E2 naive 환수율', 'E3 조기 포기율', 'E10 sloppy 환수율', 'E11 세션 중앙값', '최고 봇 환수율', 'H (가정)'],
        [result.final, b].flatMap((run, i) =>
          run.tiers.map((tier) => [
            i === 0 ? `(a) ${run.name}` : `(b) ${run.name}`,
            tierName(tier.tier),
            curveText(tier),
            `${(tier.multiplierBps / 10_000).toFixed(4)}배`,
            pct(tier.engagement.e2NaiveRtp),
            pct(tier.engagement.e3EarlyQuitRate),
            pct(tier.engagement.e10SloppyRtp),
            String(tier.engagement.e11SessionMedian),
            pct(tier.bestRtp),
            run.h === null ? '—' : pct(run.h, 3),
          ]),
        ),
      ),
    );
    // The contract is redeployed before the check: `tuning:check` compares the table with the deployed contract.
    parts.push('', `전환 명령 (재튜닝은 컨트랙트 재배포를 뜻한다): \`pnpm tuning:apply ${input.houseMaxTablePath} && pnpm dev:down && pnpm dev:up && pnpm tuning:check\``);
    parts.push('', certificationSection(`하우스 최대 표 (b): ${b.name}`, input.houseMaxCertification));
    parts.push('', '### 하우스 최대 표의 흥미·세션 지표 (가정)', '', engagementSection(b));
  }
  for (const tried of result.houseMax?.tried ?? []) parts.push(`- 하우스 최대 후보 ${tried.name}: ${ko(tried.status)}${tried.reason ? ` (${ko(tried.reason)})` : ''}`);

  parts.push('', '## 민감도 분석 (가정)', '');
  if (sensitivity === null) {
    parts.push('민감도 표가 없다 (`pnpm sim:sensitivity`).');
  } else {
    parts.push('새 시뮬레이션 없이, 가정을 하나씩 바꿨을 때 기준선 규칙이 어느 후보를 고르는지 다시 계산한 표다. 후보는 tune이 비교한 그대로(S·M 인증, L 축소 표본) 들어간다.', '');
    parts.push(
      table(
        ['시나리오 (가정)', '선택되는 후보', '그 후보의 H', '선택된 표의 H', '완화', '가정 범위', '선택 변화'],
        sensitivity.rows.map((row) => [
          ko(row.scenario),
          row.selected ?? '—',
          row.selectedH === null ? '—' : pct(row.selectedH, 3),
          row.finalH === null ? '—' : pct(row.finalH, 3),
          row.relaxed.join(', ') || '없음',
          row.assumptionRangeMet ? '충족' : '미충족',
          row.changesSelection ? '바뀜' : '같음',
        ]),
      ),
    );
  }

  parts.push('', deviationSection(input));
  const caution = cautionSection(input);
  if (caution !== '') parts.push('', caution);
  return `${parts.join('\n')}\n`;
}
