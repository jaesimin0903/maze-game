// Text of `sim:chest`: a short summary for the terminal and a Markdown report (Korean) with every
// table of the run. Numbers come from `ChestStats` only.

import { POINT_UNIT_WEI } from '@maze/shared';
import { PLAYER_INFO, type ChestRow, type ChestStats, type Interval, type MoneyCost } from './run';

export interface ChestRunInfo {
  generatedAt: string;
  command: string;
  seconds: number;
  workers: number;
}

const pct = (value: number, digits = 2): string => `${(value * 100).toFixed(digits)}%`;
const pp = (value: number, digits = 2): string => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%p`;
const int = (value: number): string => Math.round(value).toLocaleString('en-US');
const num = (value: number, digits = 1): string =>
  value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const ci = (interval: Interval, digits = 2): string =>
  `${pct(interval.mean, digits)} [${pct(interval.ci95[0], digits)}, ${pct(interval.ci95[1], digits)}]`;
const multiplier = (bps: number): string => `${(bps / 10_000).toFixed(4)}배`;
/** Wei per point as a multiple of the point unit (10^12 wei). */
const units = (wei: number): string => (wei / Number(POINT_UNIT_WEI)).toFixed(2);

function rowLine(n: number, row: ChestRow): string {
  const s = row.sessions;
  return [
    `${n}×${n}`,
    PLAYER_INFO[row.player].name,
    int(row.games),
    pct(row.lossRate, 1),
    ci(row.chestRate),
    pct(row.chestShareOfLosses, 1),
    num(row.pointsPerGame, 2),
    int(row.pointsPerEth),
    ci(row.rtp),
    ci(row.moneyRtp),
    pp(row.chestEv.mean),
    row.breakEvenWeiPerPoint === null ? '—' : units(row.breakEvenWeiPerPoint),
    s === null ? '—' : `${int(s.points.p50)} [${int(s.points.p10)}, ${int(s.points.p90)}]`,
    s === null ? '—' : pct(s.withChest, 0),
    s === null ? '—' : int(s.medianGames),
  ].join(' | ');
}

function costLine(n: number, cost: MoneyCost): string {
  const check =
    cost.check === null
      ? '—'
      : `${pct(cost.check.rtpToday, 3)} → ${pct(cost.check.rtpWithChests, 3)} (차이 ${pp(cost.check.diff.mean, 3)} [${pp(cost.check.diff.ci95[0], 3)}, ${pp(cost.check.diff.ci95[1], 3)}], ${int(cost.check.games)}판 짝)`;
  return [
    `${n}×${n}`,
    PLAYER_INFO[cost.player].name,
    multiplier(cost.multiplierBps),
    pct(cost.rtp, 3),
    pp(cost.chestEv, 3),
    pct(cost.winRate, 2),
    multiplier(cost.requiredMultiplierBps),
    pct(cost.requiredMultiplierBps / cost.multiplierBps - 1, 2),
    check,
  ].join(' | ');
}

/** The Markdown report of a run. */
export function renderMarkdown(stats: ChestStats, run: ChestRunInfo): string {
  const lines: string[] = [];
  const o = stats.options;
  lines.push('# sim:chest 결과', '');
  lines.push(`- 생성: ${run.generatedAt}, 명령 \`${run.command}\`, ${num(run.seconds, 1)}초, 작업 스레드 ${run.workers}개`);
  lines.push(
    `- 보물상자 규칙 v${stats.rule.version} (태그 ${stats.rule.tag}): 막다른 칸의 ${stats.rule.rateBps / 100}%, 보상 베팅액의 ${stats.rule.rewardMinBps / 100}~${stats.rule.rewardMaxBps / 100}%, 1포인트 = ${stats.rule.pointUnitWei} wei 베팅 상당`,
  );
  lines.push(
    `- 판 수: 줄마다 평가 ${int(o.games)}판, 세션 ${int(o.sessions)}개(잔고 ${o.bankrollBets}배, 상한 ${int(o.gameCap)}판), 배율 짝 검증 ${int(o.checkGames)}판. 포인트는 베팅 ${o.betWei} wei 기준(서버처럼 상자마다 내림)`,
  );
  lines.push(
    `- 미로 스트림 ${stats.stream.label} (${stats.stream.base}), 인증 스트림 A~E·사람 스트림과 겹치지 않음: ${stats.stream.disjoint ? '예' : '아니오'}`,
  );
  lines.push('');
  for (const table of stats.tables) {
    lines.push(`## ${table.label} (\`${table.path}\`)`, '');
    lines.push(
      '| 크기 | 플레이어 | 판 수 | 막다른 칸 패배율 | 상자로 끝난 판 [95%] | 패배 중 상자 | 판당 포인트 | 1 ETH당 포인트 | 환수율(돈) [95%] | 상자를 돈으로 주면 [95%] | 증가분 | 손익분기 포인트 가치(1포인트 단위의 배수) | 세션 포인트 중앙값 [p10, p90] | 상자 1개 이상 세션 | 세션 판 수 중앙값 |',
    );
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const tier of table.tiers) for (const row of tier.rows) lines.push(`| ${rowLine(tier.n, row)} |`);
    lines.push('');
    const costs = table.tiers.flatMap((tier) => tier.moneyCost.map((cost) => ({ n: tier.n, cost })));
    if (costs.length > 0) {
      lines.push('상자를 돈으로 줄 때 가장 강한 전략을 지금의 환수율로 되돌리는 출구 배율(계산만 함, 적용하지 않음):', '');
      lines.push('| 크기 | 전략 | 지금 배율 | 지금 환수율 | 상자 기댓값 | 출구 도달률 | 필요한 배율 | 배율 변화 | 짝 검증 (지금 → 새 배율 + 돈 상자) |');
      lines.push('|---|---|---|---|---|---|---|---|---|');
      for (const { n, cost } of costs) lines.push(`| ${costLine(n, cost)} |`);
      lines.push('');
    }
    if (table.population !== null) {
      const p = table.population;
      lines.push(
        `가정한 플레이어 구성(봇 구성, 크기 비중 50/35/15%)의 하우스 몫: 지금 ${pct(p.houseTake, 3)}, 상자를 돈으로 주면 ${pct(p.houseTakeIfMoney, 3)} (${pp(p.houseTakeIfMoney - p.houseTake, 3)}). 이 구성의 1 ETH당 포인트 ${int(p.pointsPerEth)}.`,
      );
      if (p.humanHouseTake !== null && p.humanHouseTakeIfMoney !== null) {
        lines.push(
          `사람 모델 구성(초보 30, 보통 40, 생각 20, 배우는 10%): 지금 ${pct(p.humanHouseTake, 3)}, 상자를 돈으로 주면 ${pct(p.humanHouseTakeIfMoney, 3)}.`,
        );
      }
      lines.push('');
    }
  }
  if (stats.cheapestPoints !== null) {
    const c = stats.cheapestPoints;
    lines.push(
      `가장 싸게 포인트를 얻는 줄: ${c.table} ${c.n}×${c.n}의 ${PLAYER_INFO[c.player].name}. 1포인트의 가치가 ${num(c.weiPerPoint, 0)} wei(1포인트 단위의 ${units(c.weiPerPoint)}배) 이상이면 그 플레이가 손익분기를 넘습니다.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** A few lines for the terminal. */
export function formatSummary(stats: ChestStats, run: ChestRunInfo): string {
  const lines = [
    `sim:chest: ${num(run.seconds, 1)} s, ${run.workers} worker(s), ${int(stats.options.games)} games per row, bet ${stats.options.betWei} wei`,
  ];
  for (const table of stats.tables) {
    for (const tier of table.tiers) {
      for (const row of tier.rows) {
        lines.push(
          `  ${table.label} ${tier.n}x${tier.n} ${row.player.padEnd(20)} chest ${pct(row.chestRate.mean).padStart(7)}  points/game ${num(row.pointsPerGame, 2).padStart(7)}  rtp ${pct(row.rtp.mean).padStart(7)} -> ${pct(row.moneyRtp.mean).padStart(7)} if money  break-even ${row.breakEvenWeiPerPoint === null ? '-' : units(row.breakEvenWeiPerPoint)} units/point`,
        );
      }
      for (const cost of tier.moneyCost) {
        lines.push(
          `  ${table.label} ${tier.n}x${tier.n} ${cost.player}: multiplier ${multiplier(cost.multiplierBps)} -> ${multiplier(cost.requiredMultiplierBps)} would offset money chests${cost.check === null ? '' : ` (paired check ${pp(cost.check.diff.mean, 3)})`}`,
        );
      }
    }
  }
  return lines.join('\n');
}
