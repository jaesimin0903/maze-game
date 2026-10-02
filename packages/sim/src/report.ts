// Tuning report (plan §9.3 "보고서"). Rendered in Korean, like the plan and the documents that
// `report:check` reads: the labels "가정", "축소 표본", "개선됨" / "개선 없음" are part of its contract.

import type { TableCertification } from './certify';
import { POPULATION_MEMBERS } from './assumptions';
import type { SensitivityReport } from './sensitivity';
import type { CandidateRun, TierSummary, TuneResult } from './tune';

const pct = (x: number, digits = 2): string => `${(100 * x).toFixed(digits)}%`;
const points = (x: number, digits = 2): string => `${(100 * x).toFixed(digits)}%p`;
const TIER_NAME = ['S', 'M', 'L'];
const tierName = (index: number): string => TIER_NAME[index] ?? `T${index}`;

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}

/** The label the plan requires on reduced-sample numbers. */
export function screenedLabel(tier: TierSummary): string {
  return `${tierName(tier.tier)}: 축소 표본 ±${points(tier.bestHalfWidth)}, 고정 게이트 미판정, 적용 불가`;
}

function exactSection(runs: CandidateRun[]): string {
  const rows = runs
    .filter((run) => run.exact !== null)
    .map((run) => {
      const exact = run.exact!;
      const trend = exact.gaps['5x4'] <= exact.gaps['4x4'] + 0.0025 ? '커지지 않음' : '커짐';
      const branch =
        exact.branch === 'pass'
          ? '통과'
          : exact.branch === 'lower-ceiling'
            ? `분기 2 (ceilingBps ${exact.ceilingBps}, e0Bps ${exact.e0Bps})`
            : exact.branch === 'improve-bot'
              ? '분기 1 (봇 개선 필요)'
              : '분기 3 (BLOCKED)';
      return [run.name, exact.variant.label, points(exact.gaps['3x3'], 3), points(exact.gaps['4x4'], 3), points(exact.gaps['5x4'], 3), trend, branch];
    });
  const grids = runs
    .filter((run) => run.exact !== null)
    .flatMap((run) =>
      run.exact!.grids.map((grid) => [
        run.name,
        `e0 ${grid.curve.e0Bps} / a ${grid.curve.aBps} / φ ${grid.curve.phi}`,
        `${grid.w}×${grid.h}`,
        (grid.multiplierBps / 10_000).toFixed(4),
        pct(grid.botRtp, 4),
        pct(grid.optimalRtp, 4),
        points(grid.gap, 4),
      ]),
    );
  return [
    '## 정확성 게이트 (AC-T1)',
    '',
    'value-lsm을 정확 환수율 96.00%로 보정한 배율에서 정확 최적(전 미로 열거)의 환수율을 잰 값이다. 통과 기준은 세 격자 모두 0.50%p 이하.',
    '',
    table(['후보', '봇', '3×3', '4×4', '5×4', '추세', '분기'], rows),
    '',
    table(['후보', '곡선', '격자', '적용 배율', 'value-lsm (정확)', '정확 최적', '간격'], grids),
  ].join('\n');
}

function comparisonSection(result: TuneResult): string {
  const rows: string[][] = [];
  for (const run of result.candidates) {
    for (const tier of run.tiers) {
      const label = tier.basis === 'screened' ? screenedLabel(tier) : `스트림 B, ${tier.sampleGames.toLocaleString('en-US')}판`;
      rows.push([
        run.name,
        tierName(tier.tier),
        `${tier.n}×${tier.n}`,
        `e0 ${tier.curve.e0Bps} / a ${tier.curve.aBps} / φ ${tier.curve.phi}`,
        `${(tier.multiplierBps / 10_000).toFixed(4)}배`,
        `${pct(tier.bestRtp)} ± ${points(tier.bestHalfWidth)} (${tier.bestBot})`,
        pct(tier.population['naive-greedy'].rtp),
        pct(tier.population['sloppy-greedy'].rtp),
        pct(tier.engagement.e4CashOutRate),
        tier.engagement.m1ContinuationMargin === null ? '—' : points(tier.engagement.m1ContinuationMargin),
        label,
      ]);
    }
  }
  const summary = result.candidates.map((run) => [
    run.name,
    run.status === 'ok' ? '통과' : run.status === 'failed' ? `고정 실패: ${run.reason}` : `BLOCKED: ${run.reason}`,
    run.h === null ? '—' : pct(run.h, 3),
    run.state.notes.join(' / ') || '—',
  ]);
  return [
    '## 후보 3개 비교',
    '',
    '선택되지 않은 후보의 L 수치는 축소 표본이며 고정 게이트로 판정되지 않았고 배포할 수 없다. L에서의 후보 순위는 인증 정밀도가 아니다.',
    '',
    table(['후보', '크기', '격자', '곡선', '배율', '최고 봇 환수율', 'naive-greedy', 'sloppy-greedy', '최고 봇 캐시아웃 비율', 'M1', '표본'], rows),
    '',
    table(['후보', '판정', '하우스 수익 H (가정)', '적용된 조치'], summary),
  ].join('\n');
}

function certificationSection(title: string, certification: TableCertification | null): string {
  if (certification === null) return `## ${title}\n\n인증 기록이 없다.`;
  const parts: string[] = [`## ${title}`, '', `tableHash \`${certification.tableHash}\`, 시뮬레이터 코드 해시 \`${certification.simCodeHash}\`, 판정: ${certification.pass ? '통과' : '실패'}`];
  for (const tier of certification.tiers) {
    parts.push('', `### ${tierName(tier.tier)} (${tier.n}×${tier.n}, ${(tier.multiplierBps / 10_000).toFixed(4)}배, 셀당 ${tier.games.toLocaleString('en-US')}판)`, '');
    parts.push(
      table(
        ['봇', '스트림', '판 수', '환수율', '95% 신뢰구간', '97.5% 상측 한계', '표준편차'],
        tier.cells.map((cell) => [
          cell.bot,
          cell.stream,
          cell.games.toLocaleString('en-US'),
          pct(cell.rtp, 3),
          `[${pct(cell.ci95[0], 3)}, ${pct(cell.ci95[1], 3)}]`,
          pct(cell.ucb975, 3),
          cell.sd.toFixed(4),
        ]),
      ),
    );
    const cal = tier.calibration;
    parts.push(
      '',
      `- 보정 (스트림 A): ${cal.u === null ? cal.status : `U = ${pct(cal.u, 3)} (${cal.best}), 상한 ${cal.ceilingBps} bps`}${cal.windowMissed ? ', **창 미달**(window missed)' : ''}`,
      `- 고정 게이트 1 (≤ ${pct(tier.gates.gate1.limit)}): ${tier.gates.gate1.worst} ${pct(tier.gates.gate1.value, 3)} — ${tier.gates.gate1.pass ? '통과' : '실패'}`,
      `- 고정 게이트 2 (≤ ${pct(tier.gates.gate2.limit)}): ${tier.gates.gate2.worst} ${pct(tier.gates.gate2.value, 3)} — ${tier.gates.gate2.pass ? '통과' : '실패'}`,
      `- 실현 엣지: ${pct(1 - tier.best.rtp, 3)} (최고 봇 ${tier.best.bot} 점추정 ${pct(tier.best.rtp, 3)})`,
    );
    parts.push(
      '',
      table(
        ['적대자 (스트림 D)', '점추정', '96.5%와의 차', '상측 한계', '짝 차이 평균', '달성 반폭', '짝 수'],
        tier.pairs.map((pair) => [
          pair.adversary,
          pct(pair.rtp, 3),
          points(pair.rtp - 0.965, 3),
          pct(pair.ucb975, 3),
          points(pair.meanDiff, 3),
          `±${points(pair.halfWidthDiff, 3)}${pair.capped ? ` (짝 수 상한 ${pair.pairs.toLocaleString('en-US')}쌍에 걸림)` : ''}`,
          pair.pairs.toLocaleString('en-US'),
        ]),
      ),
    );
  }
  return parts.join('\n');
}

function engagementSection(run: CandidateRun): string {
  const rows = run.tiers.map((tier) => {
    const e = tier.engagement;
    return [
      tierName(tier.tier),
      `${pct(e.e1WinRate)} (범위 ${pct(e.e1Range[0], 0)}~${pct(e.e1Range[1], 0)})`,
      `${pct(e.e2NaiveRtp)} ${e.e2Pass ? '' : '(미충족)'}`,
      pct(e.e3EarlyQuitRate),
      pct(e.e4CashOutRate),
      e.e6MeanSteps.toFixed(2),
      pct(e.e7NearMissRate),
      `${e.e8Multiplier.toFixed(2)}배 ${e.e8Pass ? '' : '(미충족)'}`,
      `${e.e9Refund1Bps} / ${e.e9RefundAtShortestBps} ${e.e9Pass ? '' : '(미충족)'}`,
      `${pct(e.e10SloppyRtp)} ${e.e10Pass ? '' : '(미충족)'}`,
      `${e.e11SessionMedian} (≥ ${e.e11Min}) ${e.e11Pass ? '' : '(미충족)'}`,
      points(e.n1PlayPremium, 3),
    ];
  });
  return table(['크기', 'E1 승리 빈도', 'E2 naive 환수율', 'E3 조기 포기율', 'E4 캐시아웃 비율', 'E6 평균 걸음', 'E7 근접 패배', 'E8 배율', 'E9 refund[1] / refund[L]', 'E10 sloppy 환수율', 'E11 세션 중앙값', 'N1 플레이 프리미엄'], rows);
}

export interface ReportInput {
  result: TuneResult;
  sensitivity: SensitivityReport | null;
  finalCertification: TableCertification | null;
  houseMaxCertification: TableCertification | null;
  candidateTablePath: string;
  houseMaxTablePath: string;
}

export function renderTuningReport(input: ReportInput): string {
  const { result, sensitivity } = input;
  const a = result.assumptions;
  const outcome = result.outcome === 'improved' ? '개선됨' : result.outcome === 'no-improvement' ? '개선 없음' : result.outcome === 'blocked' ? 'BLOCKED' : '미완료';
  const parts: string[] = [];
  parts.push('# 튜닝 보고서', '');
  parts.push(`- 프로파일: \`${result.profile}\`${result.profile === 'production' ? '' : ' (운영 수치가 아니다. 이 프로파일의 표는 배포할 수 없다)'}`);
  parts.push(`- 시뮬레이터 코드 해시: \`${result.simCodeHash}\``);
  parts.push(`- 생성 시각: ${result.generatedAt}`);
  parts.push(`- **튜닝 결과: ${outcome}**`);
  if (result.blocked !== null) parts.push(`- **BLOCKED(${result.blocked.kind === 'economic' ? '경제' : '실행 시간'})**: ${result.blocked.message}`);
  parts.push('', '**캐주얼 환수율 하한(E2)이 하우스 수익의 상한을 정한다.** 최고 플레이어 기준 엣지는 보정 규칙이 정하고, 하우스의 추가 수익은 최고 플레이어와 평범한 플레이어의 간격에서 나오며, 그 간격은 E2라는 가정이 막는다.');

  parts.push('', '## 가정', '', '아래 값은 전부 **가정**이다(실제 플레이어 데이터가 없다). 하우스 수익 H, 흥미 지표의 판정, 후보 선택이 이 값에 의존한다.', '');
  parts.push(table(['집단 (가정)', '가중치'], POPULATION_MEMBERS.map((member) => [member === 'best' ? '최고 봇' : member, a.population[member].toFixed(2)])));
  parts.push('', `크기 이용 비중 (가정): ${a.tierShare.map((share, i) => `${tierName(i)} ${share.toFixed(2)}`).join(', ')}`);
  parts.push(`흥미 범위 (가정): E2 ≥ ${pct(a.e2NaiveRtpMin, 0)}, E10 ≥ ${pct(a.e10SloppyRtpMin, 0)}, E8 ≥ ${a.e8MultiplierMin.join(' / ')}배, E9 refund[1] ≥ ${a.e9Refund1MinBps} bps · refund[L] ≥ ${a.e9RefundAtShortestMinBps} bps`);

  const exactRuns = [...result.candidates, ...(result.final !== null && !result.candidates.some((run) => run.name === result.final!.name) ? [result.final] : [])];
  parts.push('', exactSection(exactRuns));
  parts.push('', comparisonSection(result));

  parts.push('', '## 기준선 선택과 완화한 제약', '');
  if (result.selection !== null) {
    parts.push(`- 선호 순서: ${result.selection.order.join(' → ') || '없음'}`);
    parts.push(`- 완화한 제약: ${result.relaxed.length === 0 ? '없음' : result.relaxed.join(', ')} (완화 순서는 E9 → E8뿐이다. E2와 E10은 완화하지 않는다)`);
    parts.push(`- 가정 범위: ${result.assumptionRangeMet ? '충족' : '**가정 범위 미충족** (위반폭이 가장 작은 기준선을 채택)'}`);
  }
  for (const change of result.sizeChanges) {
    parts.push(`- 크기 변경 시도 (${change.candidate}, ${tierName(change.tier)}): ${change.from} → ${change.to}, ${change.adopted ? '채택 (스펙 이탈)' : '기각'} — ${change.reason}`);
  }
  for (const attempt of result.baselineAttempts) {
    parts.push(`- 전체 판 수에서의 기준선 시도: ${attempt.name} — ${attempt.status === 'ok' ? '통과' : `실패 (${attempt.reason})`}`);
  }

  parts.push('', '## 탐색 점', '');
  if (result.points.length === 0) {
    parts.push('보정한 탐색 점이 없다. 거친 추정에서 목표 개선(0.2%p)에 닿는 점이 없었다(게이트 약화가 아니라 개선 불가 판정).');
  } else {
    parts.push(
      table(
        ['점', '크기', 'a / φ', '거친 ΔH', '실측 ΔH', 'ΔH 95% 하측 한계', '판정', '이유'],
        result.points.map((point) => [
          point.name,
          tierName(point.estimate.tier),
          `${point.estimate.aBps} / ${point.estimate.phi}`,
          points(point.estimate.deltaH, 3),
          point.deltaH === null ? '—' : points(point.deltaH, 3),
          point.deltaHLcb === null ? '—' : points(point.deltaHLcb, 3),
          point.status === 'adopted' ? '채택' : '기각',
          point.reason,
        ]),
      ),
    );
  }
  parts.push('', `**튜닝 결과: ${outcome}**${result.outcome === 'no-improvement' ? ' — 기준선을 유지한다. 이것은 실패가 아니라 유효한 결과다.' : ''}`);

  if (result.final !== null) {
    parts.push('', certificationSection(`선택된 표 (a): ${result.final.name}`, input.finalCertification));
    parts.push('', '### 흥미·세션 지표 (가정)', '', engagementSection(result.final));
  }

  parts.push('', '## 기본 표와 하우스 최대 표', '');
  if (result.houseMax === null) {
    parts.push('하우스 최대 표를 판정하지 못했다.');
  } else if (result.houseMax.same || result.houseMax.run === null) {
    parts.push('하우스 최대 표 (b)는 기본 표 (a)와 **같다**. 이미 보정된 표 가운데 고정 게이트·N1·E10 아래에서 H가 더 큰 표가 없다.');
  } else if (result.final !== null) {
    const b = result.houseMax.run;
    parts.push(`하우스 최대 표 (b): ${b.name} — \`${input.houseMaxTablePath}\``, '');
    parts.push(
      table(
        ['표', '크기', '배율', 'E2 naive 환수율', 'E3 조기 포기율', 'E10 sloppy 환수율', 'E11 세션 중앙값', 'H (가정)'],
        [result.final, b].flatMap((run, i) =>
          run.tiers.map((tier) => [
            i === 0 ? `(a) ${run.name}` : `(b) ${run.name}`,
            tierName(tier.tier),
            `${(tier.multiplierBps / 10_000).toFixed(4)}배`,
            pct(tier.engagement.e2NaiveRtp),
            pct(tier.engagement.e3EarlyQuitRate),
            pct(tier.engagement.e10SloppyRtp),
            String(tier.engagement.e11SessionMedian),
            run.h === null ? '—' : pct(run.h, 3),
          ]),
        ),
      ),
    );
    parts.push('', `전환 명령 (재튜닝은 컨트랙트 재배포를 뜻한다): \`pnpm tuning:apply ${input.houseMaxTablePath} && pnpm tuning:check && pnpm dev:down && pnpm dev:up\``);
    parts.push('', certificationSection(`하우스 최대 표 (b): ${b.name}`, input.houseMaxCertification));
  }
  for (const tried of result.houseMax?.tried ?? []) parts.push(`- 하우스 최대 후보 ${tried.name}: ${tried.status}${tried.reason ? ` (${tried.reason})` : ''}`);

  parts.push('', '## 민감도 분석 (가정)', '');
  if (sensitivity === null) {
    parts.push('민감도 표가 없다 (`pnpm sim:sensitivity`).');
  } else {
    parts.push(sensitivity.note, '');
    parts.push(
      table(
        ['시나리오 (가정)', '선택되는 후보', '그 후보의 H', '선택된 표의 H', '완화', '선택 변화'],
        sensitivity.rows.map((row) => [
          row.scenario,
          row.selected ?? '—',
          row.selectedH === null ? '—' : pct(row.selectedH, 3),
          row.finalH === null ? '—' : pct(row.finalH, 3),
          row.relaxed.join(', ') || '없음',
          row.changesSelection ? '바뀜' : '같음',
        ]),
      ),
    );
  }
  return `${parts.join('\n')}\n`;
}
