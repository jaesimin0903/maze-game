// Text of `sim:escape`: the main table for the terminal and a Markdown report (Korean) with every
// table of the run. Numbers come from `EscapeStats` only.

import type { PolicyId } from './jobs';
import { summarizeHistogram, type CellResult, type EscapeStats, type HistogramSummary, type Interval } from './run';

export interface EscapeRunInfo {
  generatedAt: string;
  command: string;
  seconds: number;
  workers: number;
}

export const POLICY_NAMES: Record<PolicyId, string> = {
  'random-walk': 'random-walk (무작위)',
  'naive-greedy': 'naive-greedy (출구 쪽으로)',
  harmonic: 'harmonic (본 것으로 계산)',
  'value-lsm': 'value-lsm (최강 인증 봇)',
};

/** A probability in percent, with more digits when it is small. */
const prob = (value: number): string => `${(value * 100).toFixed(value < 0.01 ? 3 : 2)}%`;
const pct = (value: number, digits = 1): string => `${(value * 100).toFixed(digits)}%`;
const int = (value: number): string => Math.round(value).toLocaleString('en-US');
const num = (value: number, digits = 2): string => value.toFixed(digits);
const interval = (mean: number, ci: Interval): string => `${prob(mean)} [${prob(ci.lo)}, ${prob(ci.hi)}]`;
const signed = (value: number): string => {
  const rounded = Number(value.toFixed(2));
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(2)}`;
};

function mainLine(cell: CellResult): string {
  const exactAll = cell.fullExact?.pHat.value ?? null;
  return [
    `${cell.n}×${cell.n}`,
    POLICY_NAMES[cell.policy],
    int(cell.games),
    `${int(cell.escapes)}${cell.reachedTarget ? '' : ' (상한)'}`,
    interval(cell.pHat, cell.wilson95),
    cell.exactAverage === null ? '—' : interval(cell.exactAverage.mean, cell.exactAverage.ci95),
    exactAll === null ? '—' : prob(exactAll),
    `${pct(cell.rates.exit)} / ${pct(cell.rates.cashOut)} / ${pct(cell.rates.deadEnd)}`,
    cell.meanStepsToExit === null ? '—' : num(cell.meanStepsToExit),
  ].join(' | ');
}

function pathLine(n: number, games: number, s: HistogramSummary, source: string): string {
  return [`${n}×${n}`, source, int(games), num(s.mean), num(s.sd), s.min, s.p10, s.p50, s.p90, s.max, 2 * n - 2].join(' | ');
}

/** The Markdown report of a run. */
export function renderMarkdown(stats: EscapeStats, run: EscapeRunInfo): string {
  const r = stats.request;
  const lines: string[] = [
    '# 탈출 확률 (sim:escape)',
    '',
    `- 생성: ${run.generatedAt}, 명령 \`${run.command}\`, ${num(run.seconds, 1)}초, 워커 ${run.workers}개`,
    `- 멈춤 규칙: 칸(크기 × 정책)마다 미로 0, 1, 2, …를 차례로 두어 **${int(r.escapes)}번째 탈출**이 나온 판에서 멈춤 (판 수 상한 ${int(r.maxGames)})`,
    `- 미로: \`${stats.stream.label}\` 흐름 (기준 ${stats.stream.base}, 시드 ${r.seed} → 첫 판 번호 ${int(stats.stream.firstIndex)}). 인증 흐름 A–E·human·chest와 시드 구간이 겹치지 ${stats.stream.disjoint ? '않음' : '**겹침**'}`,
    '- 신뢰구간: p̂는 Wilson 95% 점수 구간, 정확 평균은 평균 ± 1.96 × 표준오차',
    '',
    '## 표 1. 크기 × 정책별 탈출 확률',
    '',
    '| 크기 | 정책 | 판 수 | 탈출 | p̂ [95% CI] | 정확 평균 [95% CI] | 전체 미로 정확값 | 출구 / 캐시아웃 / 막다른 길 | 출구까지 평균 걸음 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...stats.cells.map((cell) => `| ${mainLine(cell)} |`),
    '',
  ];
  if (stats.skipped.length > 0) {
    lines.push(`돌리지 않은 칸: ${stats.skipped.map((s) => `${s.n}×${s.n} ${s.policy}`).join(', ')}. 이 크기에는 인증된 단계(배율, 환불 곡선, 가치 표)가 없습니다.`, '');
  }

  const lsm = stats.cells.filter((cell) => cell.policy === 'value-lsm');
  if (lsm.length > 0) {
    lines.push(
      '## 표 2. value-lsm: 출구 / 캐시아웃 / 막다른 길',
      '',
      '| 크기 | 출구 배율 | 판 수 | 출구 [95% CI] | 캐시아웃 | 막다른 길 | 캐시아웃하지 않은 판의 출구 비율 | 평균 캐시아웃 걸음 | 평균 걸음 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const cell of lsm) {
      const tier = stats.tiers.find((t) => t.n === cell.n);
      lines.push(
        `| ${[
          `${cell.n}×${cell.n}`,
          tier === undefined ? '—' : `${(tier.multiplierBps / 10_000).toFixed(4)}배`,
          int(cell.games),
          interval(cell.rates.exit, cell.wilson95),
          pct(cell.rates.cashOut, 2),
          pct(cell.rates.deadEnd, 2),
          cell.exitGivenNoCashOut === null ? '—' : prob(cell.exitGivenNoCashOut),
          cell.meanCashOutStep === null ? '—' : num(cell.meanCashOutStep),
          num(cell.meanSteps),
        ].join(' | ')} |`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## 표 3. 출발–출구 경로 길이 (걸음)',
    '',
    '각 크기에서 판 수가 가장 많은 칸의 미로로 셌습니다. 3×3·4×4는 전체 미로의 정확한 분포도 함께 적었습니다. 마지막 열은 격자에서 가능한 가장 짧은 경로(2n − 2)입니다.',
    '',
    '| 크기 | 출처 | 미로 수 | 평균 | 표준편차 | 최소 | 10% | 중앙값 | 90% | 최대 | 2n − 2 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const n of r.sizes) {
    const cells = stats.cells.filter((cell) => cell.n === n);
    if (cells.length === 0) continue;
    const widest = cells.reduce((a, b) => (b.games > a.games ? b : a));
    lines.push(`| ${pathLine(n, widest.games, widest.pathLength, `${widest.policy} 칸`)} |`);
    const exact = stats.exact.find((e) => e.exact.n === n);
    if (exact !== undefined) {
      const s = summarizeHistogram(exact.exact.pathLength);
      if (s !== null) lines.push(`| ${pathLine(n, exact.exact.mazes, s, '전체 미로 (정확)')} |`);
    }
  }
  lines.push('');

  lines.push(
    '## 표 4. 탈출한 판의 경로 길이',
    '',
    '되돌아갈 수 없고 미로가 나무이므로, 출구에 닿은 판은 반드시 그 미로의 유일한 경로를 그대로 걸었습니다. 그래서 "출구까지 걸음"은 탈출한 미로의 경로 길이와 같습니다.',
    '',
    '| 크기 | 정책 | 전체 판의 평균 경로 | 탈출한 판의 평균 경로 | 차이 |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const cell of stats.cells) {
    const escaped = summarizeHistogram(cell.counts.exitPathHist);
    if (escaped === null) continue;
    lines.push(
      `| ${cell.n}×${cell.n} | ${POLICY_NAMES[cell.policy]} | ${num(cell.pathLength.mean)} | ${num(escaped.mean)} | ${signed(escaped.mean - cell.pathLength.mean)} |`,
    );
  }
  lines.push('');

  if (stats.exact.length > 0) {
    lines.push(
      '## 표 5. 전체 미로 열거 (3×3, 4×4)',
      '',
      '| 크기 | 미로 수 | 동쪽 / 남쪽 출발 | 생성기 인구조사 | 사용 | random-walk | naive-greedy | harmonic | 최선 (어떤 정책도 못 넘는 값) |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const e of stats.exact) {
      const c = e.census;
      lines.push(
        `| ${[
          `${e.exact.n}×${e.exact.n}`,
          int(e.exact.mazes),
          `${int(e.exact.eastMazes)} / ${int(e.exact.southMazes)}`,
          c === null
            ? '안 함'
            : `${int(c.draws)}번 뽑기, χ² ${num(c.chiSquare, 1)} (자유도 ${int(c.df)}), z ${num(c.z)}, 목록 밖 ${c.unknown}, 한 번도 안 나온 미로 ${c.zeroCells} (기대 ${c.expectedZeroCells.toPrecision(2)}), 최소 ${int(c.minCount)}번, 최대 표준화 잔차 ${num(c.maxResidual)} → ${c.pass ? '통과' : '**실패**'}`,
          e.used ? '예' : '**아니오**',
          prob(e.exact.escape['random-walk']),
          prob(e.exact.escape['naive-greedy']),
          prob(e.exact.escape.harmonic),
          prob(e.exact.optimal),
        ].join(' | ')} |`,
      );
    }
    lines.push('');
  }

  if (stats.comparisons.length > 0) {
    lines.push(
      '## 표 6. 같은 미로에서 짝지은 비교',
      '',
      '두 정책이 미로 0 … 판 수 − 1을 똑같이 둡니다(각 칸에서 둔 판을 모두 포함). 차이는 판마다의 [a 출구] − [b 출구]의 평균이고, 구간은 그 표준오차로 낸 95% 구간입니다. 구간이 0을 포함하면 "차이 보이지 않음"입니다.',
      '',
      '| 크기 | a − b | 판 수 | a 출구 | b 출구 | 차이 [95% CI] | 판정 | a가 캐시아웃한 판에서 b의 출구 비율 | 무작위로 같은 수만큼 그만뒀다면 잃을 출구 |',
      '| --- | --- | ---: | ---: | ---: | --- | --- | --- | ---: |',
    );
    for (const c of stats.comparisons) {
      const pp = (value: number): string => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%p`;
      lines.push(
        `| ${[
          `${c.n}×${c.n}`,
          `${c.a} − ${c.b}`,
          int(c.games),
          prob(c.exitA),
          prob(c.exitB),
          `${pp(c.diff)} [${pp(c.ci95.lo)}, ${pp(c.ci95.hi)}]`,
          c.shown ? '차이 있음' : '차이 보이지 않음',
          c.cashOut === null ? '—' : `${prob(c.cashOut.bExitWhenCashed)} [${prob(c.cashOut.bExitWhenCashed95.lo)}, ${prob(c.cashOut.bExitWhenCashed95.hi)}]`,
          c.cashOut === null ? '—' : pp(-c.cashOut.proportionalLoss),
        ].join(' | ')} |`,
      );
    }
    lines.push('');
  }

  lines.push('## 자체 검사', '', '| 검사 | 결과 | 내용 |', '| --- | --- | --- |');
  for (const c of stats.checks) lines.push(`| ${c.name} | ${c.pass ? '통과' : '**실패**'} | ${c.detail} |`);
  lines.push('');
  return lines.join('\n');
}

/** The main table for the terminal. */
export function formatSummary(stats: EscapeStats, run: EscapeRunInfo): string {
  const header = ['size', 'policy', 'games', 'escapes', 'p-hat [95% CI]', 'exact avg [95% CI]', 'exact (all)', 'exit/cash/dead', 'steps to exit'];
  const rows = stats.cells.map((cell) => {
    const exactAll = cell.fullExact?.pHat.value ?? null;
    return [
      `${cell.n}x${cell.n}`,
      cell.policy,
      int(cell.games),
      `${int(cell.escapes)}${cell.reachedTarget ? '' : '*'}`,
      interval(cell.pHat, cell.wilson95),
      cell.exactAverage === null ? '-' : interval(cell.exactAverage.mean, cell.exactAverage.ci95),
      exactAll === null ? '-' : prob(exactAll),
      `${pct(cell.rates.exit)}/${pct(cell.rates.cashOut)}/${pct(cell.rates.deadEnd)}`,
      cell.meanStepsToExit === null ? '-' : num(cell.meanStepsToExit),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cols: string[]): string => cols.map((col, i) => col.padEnd(widths[i])).join('  ').trimEnd();
  const failed = stats.checks.filter((c) => !c.pass);
  return [
    `sim:escape: ${int(stats.request.escapes)} escapes per cell (cap ${int(stats.request.maxGames)} games), seed ${stats.request.seed}, ${num(run.seconds, 1)} s, ${run.workers} worker(s)`,
    line(header),
    ...rows.map(line),
    ...(rows.some((row) => row[3].endsWith('*')) ? ['* stopped at the game cap before the target'] : []),
    `checks: ${stats.checks.length - failed.length}/${stats.checks.length} passed${failed.length > 0 ? ` (FAILED: ${failed.map((c) => c.name).join('; ')})` : ''}`,
  ].join('\n');
}
