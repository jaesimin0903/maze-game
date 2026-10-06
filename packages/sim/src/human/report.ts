// What `sim:human` shows of a result: the self-contained report.html and the terminal summary.
//
// The page follows the `sim:stats` report: one file, offline, in Korean, light and dark themes,
// every chart drawn as inline SVG by a script that reads the embedded JSON. It reuses that
// report's style sheet (playstats-report.css) and adds its own small one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { simPackageRoot } from '../codehash';
import { Z_975 } from '../stats';
import type { RowId } from './catalog';
import type { HumanStats, PhaseTiming } from './run';

export interface HumanRunInfo {
  /** Local time the run finished. */
  generatedAt: string;
  command: string;
  seconds: number;
  /** Worker threads; 0 when every job ran on the calling thread. */
  workers: number;
  timings: PhaseTiming[];
}

function asset(...path: string[]): string {
  return readFileSync(join(simPackageRoot(), 'src', ...path), 'utf8');
}

/** JSON for a script block; `<` is escaped so that the data cannot end the block. */
function embed(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderReport(stats: HumanStats, run: HumanRunInfo): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>사람 플레이 시뮬레이션</title>
<style>
${asset('playstats-report.css')}
${asset('human', 'report.css')}</style>
</head>
<body>
<svg id="svg-namespace" width="0" height="0" aria-hidden="true" style="position:absolute"></svg>
<div id="app" class="viz-root"><noscript>이 보고서는 자바스크립트로 차트를 그립니다. 자바스크립트를 켜고 다시 열어 주세요.</noscript></div>
<script type="application/json" id="human-data">${embed(stats)}</script>
<script type="application/json" id="run-data">${embed(run)}</script>
<script>
${asset('human', 'report.client.js')}</script>
</body>
</html>
`;
}

/** Columns a string takes in a terminal: Hangul and other wide characters take two. */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += char.codePointAt(0)! >= 0x1100 ? 2 : 1;
  return width;
}

function pad(text: string, width: number, align: 'left' | 'right' = 'right'): string {
  const space = ' '.repeat(Math.max(0, width - displayWidth(text)));
  return align === 'left' ? text + space : space + text;
}

const pct = (x: number, digits = 2): string => `${(100 * x).toFixed(digits)}%`;
const points = (x: number, digits = 2): string => `${x >= 0 ? '+' : '−'}${(100 * Math.abs(x)).toFixed(digits)}%p`;

/** One line per (table, tier, model), the references from the certification, and the selected rule. */
export function formatSummary(stats: HumanStats, run: HumanRunInfo): string {
  const nameOf = (row: RowId): string => stats.rows.find((info) => info.id === row)!.name;
  const o = stats.options;
  const lines: string[] = [
    `sim:human  평가 ${o.games.toLocaleString('en-US')}판/모델·크기, 규칙 학습 ${o.trainGames.toLocaleString('en-US')}판/이동규칙, 배우는 플레이어 ${o.careers}명 × ${o.careerGames}판, ` +
      `세션 ${o.sessions}명 (시작 ${o.bankroll}베팅), 시드 ${o.seed}, ${run.seconds.toFixed(1)}초, 워커 ${run.workers}`,
    `미로: 전용 흐름 ${stats.stream.label} (${stats.stream.base}), 인증 흐름 A–E와 ${stats.stream.disjoint ? '겹치지 않음' : '겹침'}`,
  ];
  const header = `    ${pad('유형', 32, 'left')}${pad('출구도착', 9)}${pad('환수율', 9)}${pad('95%오차', 10)}${pad('하우스몫', 9)}${pad('vs value-lsm', 13)}${pad('파산까지', 9)}${pad('앞선적', 8)}`;
  for (const table of stats.tables) {
    lines.push(`${table.label}  ${table.path}  ${table.tableHash.slice(0, 12)}…  ${table.certified ? '인증 통과' : '이 코드로 인증된 기록 없음'}`);
    for (const tier of table.tiers) {
      lines.push(`  ${tier.n}x${tier.n}  출구 배당 ${tier.multiplier.toFixed(4)}배  최단 ${tier.shortestPath}걸음`);
      lines.push(header);
      for (const cell of tier.cells) {
        const broke = cell.sessions === null ? '-' : cell.sessions.gamesUntilBroke.median === null ? `>${o.gameCap}` : String(Math.round(cell.sessions.gamesUntilBroke.median));
        const ahead = cell.sessions === null ? '-' : pct(cell.sessions.everAheadShare, 0);
        const versus = cell.vsValueLsm === null ? '-' : points(cell.vsValueLsm.difference, 1);
        lines.push(
          `    ${pad(nameOf(cell.row), 32, 'left')}${pad(pct(cell.rates.exit), 9)}${pad(pct(cell.rtp.mean), 9)}${pad(`±${(100 * cell.rtp.halfWidth).toFixed(2)}p`, 10)}` +
            `${pad(pct(cell.houseHold.value), 9)}${pad(versus, 13)}${pad(broke, 9)}${pad(ahead, 8)}`,
        );
      }
      for (const reference of [tier.certified.valueLsm, tier.certified.naiveGreedy]) {
        if (reference === null) continue;
        lines.push(
          `    ${pad(`${reference.bot} (인증 ${(reference.games / 1e6).toFixed(0)}백만 판)`, 32, 'left')}${pad(pct(reference.winRate), 9)}${pad(pct(reference.rtp), 9)}` +
            `${pad(`±${(100 * Z_975 * reference.se).toFixed(2)}p`, 10)}${pad(pct(1 - reference.rtp), 9)}`,
        );
      }
      const gap = tier.ruleGap.toValueLsm;
      lines.push(
        `    최선의 규칙: 학습 ${pct(tier.rule.best.train.rtp)}, 평가 ${pct(tier.ruleGap.rtp)} ±${(100 * tier.ruleGap.halfWidth).toFixed(2)}p` +
          `${gap === null ? '' : `, value-lsm 대비 ${points(gap.difference)} ±${(100 * gap.halfWidth).toFixed(2)}p`}` +
          `${tier.ruleGap.closedShare === null ? '' : `, naive→value-lsm 간격의 ${pct(tier.ruleGap.closedShare, 0)}`}`,
      );
      lines.push(`      ${tier.rule.best.text}`);
      if (tier.naiveCheck !== null) {
        const check = tier.naiveCheck;
        lines.push(`    naive-greedy 재현: 이 실행 ${pct(check.rtp)} / 인증 ${pct(check.certifiedRtp)} (z ${check.z.toFixed(2)}) ${check.agrees ? '일치' : '범위 밖'}`);
      }
    }
    const population = table.population;
    lines.push(
      `  하우스 몫 (가정한 사람 구성과 크기 비율로 가중): 사람 ${pct(population.houseTake.humans)}, 모두 최선의 규칙 ${pct(population.houseTake.bestRule)}` +
        `${population.houseTake.valueLsm === null ? '' : `, 모두 value-lsm ${pct(population.houseTake.valueLsm)}`}, 모두 즉시 캐시아웃 ${pct(population.houseTake.immediateCashout)}`,
    );
    lines.push('  세션 행동 (판마다 크기를 고름): 유형 / 행동 → 세션당 판 수(평균), 세션당 하우스 몫(베팅), 건 돈 대비 하우스 몫, 딴 채로 끝낸 비율');
    for (const entry of table.behaviour) {
      const s = entry.summary;
      lines.push(
        `    ${pad(`${nameOf(entry.row)} / ${stats.variants.find((variant) => variant.id === entry.variant)!.name}`, 56, 'left')}` +
          `${pad(s.games.mean.toFixed(0), 7)}${pad(s.houseTake.mean.toFixed(1), 8)}${pad(pct(s.takePerStake.value, 1), 8)}${pad(pct(s.aheadAtEndShare, 0), 6)}`,
      );
    }
  }
  return lines.join('\n');
}
