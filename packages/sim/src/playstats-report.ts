// What `sim:stats` shows of a `PlayStats` result: the self-contained report.html and the
// summary printed to the terminal. Both are written for someone who has not seen the simulator.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { simPackageRoot } from './codehash';
import { MIX_ID, type CellStats, type CellTiming, type PlayStats, type RowId } from './playstats';
import { Z_975 } from './stats';

/** How a result was produced. Unlike the result itself this differs from run to run. */
export interface RunInfo {
  /** Local time the run finished. */
  generatedAt: string;
  /** The command line, for the header of the report. */
  command: string;
  seconds: number;
  /** Worker threads; 0 when the games were played on the calling thread. */
  workers: number;
  timings: CellTiming[];
}

/** The page's style sheet and script live next to this module as plain files. */
function asset(name: string): string {
  return readFileSync(join(simPackageRoot(), 'src', name), 'utf8');
}

/** JSON for a script block; `<` is escaped so that the data cannot end the block. */
function embed(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** One HTML file with the data, the style sheet and the script inline. It refers to nothing outside itself. */
export function renderReport(stats: PlayStats, run: RunInfo): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>미로 게임 시뮬레이션 통계</title>
<style>
${asset('playstats-report.css')}</style>
</head>
<body>
<svg id="svg-namespace" width="0" height="0" aria-hidden="true" style="position:absolute"></svg>
<div id="app" class="viz-root"><noscript>이 보고서는 자바스크립트로 차트를 그립니다. 자바스크립트를 켜고 다시 열어 주세요.</noscript></div>
<script type="application/json" id="stats-data">${embed(stats)}</script>
<script type="application/json" id="run-data">${embed(run)}</script>
<script>
${asset('playstats-report.client.js')}</script>
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

const whole = (x: number): string => Math.round(x).toLocaleString('en-US');
const pct = (x: number, digits = 2): string => `${(100 * x).toFixed(digits)}%`;

const COLUMNS: { title: string; width: number; value: (cell: CellStats, speed: number | null) => string }[] = [
  { title: '출구도착', width: 9, value: (cell) => pct(cell.rates.exit) },
  { title: '막다른길', width: 9, value: (cell) => pct(cell.rates.deadEnd) },
  { title: '캐시아웃', width: 9, value: (cell) => pct(cell.rates.cashOut) },
  { title: '환수율', width: 9, value: (cell) => pct(cell.rtp.mean) },
  { title: '95%오차', width: 10, value: (cell) => `±${pct(cell.rtp.halfWidth)}p` },
  { title: '하우스몫', width: 9, value: (cell) => pct(cell.houseHold.value) },
  { title: '표준편차', width: 9, value: (cell) => cell.rtp.sd.toFixed(2) },
  { title: '최장연패', width: 9, value: (cell) => whole(cell.streaks.longest) },
  {
    title: '세션중앙값',
    width: 11,
    value: (cell) => (cell.sessions === null ? '-' : `${cell.sessions.medianCapped ? '>=' : ''}${whole(cell.sessions.gamesPlayed.median)}`),
  },
  { title: '판/초', width: 10, value: (_, speed) => (speed === null ? '-' : whole(speed)) },
];

const rowName = (id: RowId): string => (id === MIX_ID ? `${MIX_ID} (가정)` : id);

/** The summary `sim:stats` prints: one line per (tier, player type), then what the rows mean. */
export function formatSummary(stats: PlayStats, run: RunInfo): string {
  const { options } = stats;
  const two = stats.tables.length > 1;
  const lines: string[] = [
    `sim:stats  유형 × 크기 조합마다 ${whole(options.games)}판  시드 ${options.seed}  ` +
      `세션 ${whole(options.sessions)}명 (시작 ${options.bankroll}베팅, 최대 ${whole(options.sessionGameCap)}판)  ${run.seconds.toFixed(1)}초  워커 ${run.workers}`,
  ];
  const excluded: string[] = [];
  const outside: string[] = [];
  let checks = 0;
  let largest = 0;
  for (const table of stats.tables) {
    lines.push(`${two ? `${table.role === 'main' ? 'A' : 'B'} ` : ''}표 ${table.path}  ${table.tableHash.slice(0, 12)}…  ${table.certified ? '인증 통과' : '이 코드로 인증된 기록 없음'}`);
    for (const tier of table.tiers) {
      const size = `${tier.n}x${tier.n}`;
      lines.push(`  ${size}  출구 배당 ${tier.multiplier.toFixed(4)}배  최단 경로 ${tier.shortestPath}걸음`);
      lines.push(`    ${pad('유형', 16, 'left')}${COLUMNS.map((column) => pad(column.title, column.width)).join('')}`);
      for (const cell of tier.cells) {
        const timing = run.timings.find((entry) => entry.role === table.role && entry.tier === tier.tier && entry.player === cell.player);
        const speed = timing === undefined ? null : timing.games / Math.max(timing.seconds, 1e-9);
        lines.push(`    ${pad(rowName(cell.player), 16, 'left')}${COLUMNS.map((column) => pad(column.value(cell, speed), column.width)).join('')}`);
      }
      for (const check of tier.crossCheck) {
        checks += 1;
        largest = Math.max(largest, Math.abs(check.z));
        if (!check.agrees) outside.push(`${table.path} ${size} ${check.player}: 이 실행 ${pct(check.rtp)} / 인증 ${pct(check.certifiedRtp)} (z ${check.z.toFixed(2)})`);
      }
    }
    const sizesWithout = (reason: string): string =>
      table.tiers
        .filter((tier) => tier.unavailable.some((gap) => gap.reason === reason))
        .map((tier) => `${tier.n}x${tier.n}`)
        .join(', ');
    if (sizesWithout('no-value-table') !== '') {
      excluded.push(`${table.path} ${sizesWithout('no-value-table')}: value-lsm 은 학습된 가치표가 캐시에 없어 뺐습니다 (가치표는 인증을 돌릴 때 만들어지며, 여기서는 새로 학습하지 않습니다)`);
    }
    if (sizesWithout('mix-needs-every-member') !== '') {
      excluded.push(`${table.path} ${sizesWithout('mix-needs-every-member')}: ${MIX_ID} 는 집단을 이루는 유형이 모두 있어야 만들 수 있어 뺐습니다`);
    }
    if (table.population !== null) {
      lines.push(`  전체 하우스 몫 (가정한 집단 구성과 크기별 이용 비율로 가중): ${pct(table.population.houseHold)} ±${pct(Z_975 * table.population.se)}p`);
    }
  }
  lines.push('유형 설명');
  for (const player of stats.players) lines.push(`  ${pad(rowName(player.id), 16, 'left')}${player.name}: ${player.description}`);
  lines.push(
    '읽는 법: 환수율 = 돌려받은 금액 / 베팅액, 하우스몫 = 1 − 환수율, 95%오차 = 환수율의 95% 신뢰구간 반폭, 표준편차 = 한 판 수익률(배),',
    '        최장연패 = 출구에 못 간 판이 이어진 최대 길이, 세션중앙값 = 가진 돈이 떨어질 때까지 플레이한 판 수의 중앙값.',
  );
  if (checks === 0) {
    lines.push('인증 교차검증: 이 표와 코드에 대한 인증 기록이 없어 하지 못했습니다.');
  } else {
    lines.push(`인증 교차검증: ${checks}개 조합 가운데 ${checks - outside.length}개가 95% 범위 안에서 일치 (가장 큰 |z| ${largest.toFixed(2)})`);
    for (const line of outside) lines.push(`  범위 밖  ${line}`);
    if (outside.length > 0) lines.push('  우연만으로도 20개 중 1개쯤은 벗어납니다. 다른 --seed 에서도 같은 조합이 벗어나면 엔진 사용에 문제가 있다는 신호입니다.');
  }
  for (const line of excluded) lines.push(`제외  ${line}`);
  return lines.join('\n');
}
