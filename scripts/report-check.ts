// Checks docs/spec-deviations.md and docs/final-report.md (plan §13; AC-D1, AC-D2, AC-T5,
// AC-T6, AC-T11, and the final-report half of AC-X1).
//
//   pnpm report:check [--root <dir>]
//
// `--root` checks another copy of the repository tree (default: this one). The documents are
// written in Korean; the labels below are the plan's own words and are matched literally.
//
// docs/spec-deviations.md
//   One table with the columns "스펙 문구", "실제 동작", "이유", "되돌리는 방법" and a first column
//   holding the item number. Rows 1 .. 11 (plan §13) must all be there with those four cells
//   filled in.
//
// docs/final-report.md
//   sections   eight headings containing: "스펙 이탈", "결론", "받아들인 위험", "후보" with "비교",
//              "튜닝 결과", "실현 엣지", "aside", "BLOCKED". The first lists items 1 .. 11, the
//              second names the three levels (컨트랙트 / 통계 / 가정).
//   items      the sixteen required statements of plan §13. Each is recognised by words that
//              must occur together in one paragraph, list or table (its heading counts); a
//              failure names the item and the words that were not found together.
//   risks      every accepted-risk of docs/exploit-audit.md is named under "받아들인 위험".
//   numbers    when the production table is calibrated: a table under "실현 엣지" with the
//              columns 크기, 배율, 판 수, 최고 봇, 환수율, 상측 신뢰한계, 실현 엣지, rollout(32),
//              value-lookahead-all and one row per size ("5×5"). Every cell is compared with
//              packages/sim/reports/certify.json for the hash of the production table, to the
//              precision the report prints (percentages with at least two decimals). When the
//              production table is not calibrated the report must say "BLOCKED(경제)" under
//              "BLOCKED" instead.
//   blocked    the AC ids named under "BLOCKED" are exactly the criteria that the last
//              `pnpm verify:all` reported as BLOCKED (.data/verify-all/result.json).
//   label      under the candidate comparison, every line about a candidate that was not chosen
//              as the baseline carries "축소 표본" (packages/sim/reports/tune-result.json says
//              which candidates those are).
//   outcome    under "튜닝 결과": "개선됨" or "개선 없음", exactly one, and the one that
//              tune-result.json reports.
//   sensitivity  a heading containing "민감도" with a table under it.
//   house-max  when packages/sim/reports/tuning.house-max.json exists, a heading containing
//              "하우스 최대" whose section names that file and E2, E3, E10 and E11; otherwise a
//              statement that the house-max table is the same ("같다" or "동일") as the base table.
//
// Exit codes: 0 = both documents are complete, 1 = something is missing or wrong, 2 = bad arguments.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseTuning, tableHash, type TuningTable } from '@maze/shared';
import { acceptedRisks, parseMarkdown, rootFromArguments, type Section } from './audit-check';

const root = rootFromArguments('report:check');
const DEVIATIONS = 'docs/spec-deviations.md';
const REPORT = 'docs/final-report.md';
const CERTIFY = 'packages/sim/reports/certify.json';
const TUNE_RESULT = 'packages/sim/reports/tune-result.json';
const HOUSE_MAX = 'packages/sim/reports/tuning.house-max.json';
const PRODUCTION_TABLE = 'packages/shared/src/tuning.json';
const VERIFY_RESULT = '.data/verify-all/result.json';
const SWITCH_COMMAND = /pnpm tuning:apply \S+ && pnpm tuning:check && pnpm dev:down && pnpm dev:up/;

let failures = 0;
function report(name: string, problems: string[]): void {
  if (problems.length === 0) {
    console.log(`PASS  ${name}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${name}`);
  for (const problem of problems) console.log(`        - ${problem}`);
}

function readText(path: string): string | null {
  const file = resolve(root, path);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function readJson<T>(path: string): T | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ----- Markdown tables and blocks -----

interface Table {
  header: string[];
  rows: string[][];
}

const cellText = (cell: string): string => cell.replace(/\*\*|`/g, '').trim();

function tablesOf(markdown: string): Table[] {
  const tables: Table[] = [];
  let lines: string[] = [];
  const flush = (): void => {
    if (lines.length >= 2 && /^\|?[\s:|-]+\|?$/.test(lines[1]) && lines[1].includes('-')) {
      const cells = lines.map((line) =>
        line
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split(/(?<!\\)\|/)
          .map(cellText),
      );
      tables.push({ header: cells[0], rows: cells.slice(2) });
    }
    lines = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (line.trim().startsWith('|')) lines.push(line);
    else flush();
  }
  flush();
  return tables;
}

/** Paragraphs, lists and tables, each with the title of the heading it stands under. */
function blocksOf(sections: readonly Section[], preamble: string): string[] {
  const blocks: string[] = [];
  const add = (title: string, text: string): void => {
    for (const block of text.split(/\n\s*\n/)) {
      if (block.trim() !== '') blocks.push(`${title}\n${block}`);
    }
  };
  add('', preamble);
  for (const section of sections) add(section.title, section.own);
  return blocks;
}

const sectionWith = (sections: readonly Section[], pattern: RegExp): Section | undefined =>
  sections.find((section) => pattern.test(section.title));

// ----- docs/spec-deviations.md (AC-D1) -----

const DEVIATION_COLUMNS = ['스펙 문구', '실제 동작', '이유', '되돌리는 방법'];
const DEVIATION_COUNT = 11;

function checkDeviations(): void {
  const text = readText(DEVIATIONS);
  if (text === null) {
    report(`${DEVIATIONS} (AC-D1)`, ['the file does not exist']);
    return;
  }
  const problems: string[] = [];
  const found = new Map<number, string[]>();
  for (const table of tablesOf(text)) {
    const columns = DEVIATION_COLUMNS.map((name) => table.header.indexOf(name));
    if (columns.some((index) => index === -1)) continue;
    for (const row of table.rows) {
      const number = Number((row[0] ?? '').replace(/[#.)]/g, ''));
      if (Number.isInteger(number) && number >= 1) found.set(number, columns.map((index) => row[index] ?? ''));
    }
  }
  if (found.size === 0) {
    problems.push(`no table with the columns ${DEVIATION_COLUMNS.join(' | ')} and numbered rows`);
  } else {
    for (let item = 1; item <= DEVIATION_COUNT; item++) {
      const cells = found.get(item);
      if (cells === undefined) {
        problems.push(`item ${item} of plan §13 has no row`);
        continue;
      }
      cells.forEach((cell, index) => {
        if (cell === '' || cell === '-') problems.push(`item ${item}: "${DEVIATION_COLUMNS[index]}" is empty`);
      });
    }
  }
  report(`${DEVIATIONS} (AC-D1)`, problems);
}

// ----- docs/final-report.md -----

const REPORT_SECTIONS: { name: string; pattern: RegExp }[] = [
  { name: '스펙 이탈 목록', pattern: /스펙 이탈/ },
  { name: '결론의 세 수준', pattern: /결론/ },
  { name: '받아들인 위험 목록', pattern: /받아들인 위험/ },
  { name: '곡선 후보 3개 비교표', pattern: /후보.*비교|비교.*후보/ },
  { name: '튜닝 결과', pattern: /튜닝 결과/ },
  { name: '크기별 실현 엣지와 배율', pattern: /실현 엣지/ },
  { name: 'aside 시나리오 결과와 사용한 경로', pattern: /aside/i },
  { name: 'BLOCKED 항목', pattern: /BLOCKED/ },
];

/** Plan §13, "필수 내용 (16개)". Every pattern of an entry must match within one block. */
const REQUIRED_ITEMS: { item: number; what: string; together: RegExp[] }[] = [
  { item: 1, what: 'base and house-max table side by side', together: [/기본 표/, /하우스 최대/] },
  { item: 1, what: 'the command that switches tables', together: [SWITCH_COMMAND] },
  { item: 2, what: 'assumption: population mix', together: [/가정/, /집단/] },
  { item: 2, what: 'assumption: size shares', together: [/가정/, /비중/] },
  { item: 2, what: 'assumption: engagement ranges', together: [/가정/, /흥미/] },
  { item: 3, what: 'games per cell next to the requested "1,000"', together: [/1,000/, /판/] },
  { item: 4, what: 'early-quit rate of the best bot', together: [/조기 포기/] },
  { item: 4, what: 'cash-out rate of the best bot', together: [/캐시아웃 비율/] },
  { item: 4, what: 'RTP of naive-greedy', together: [/naive-greedy/, /환수율/] },
  { item: 4, what: 'RTP of sloppy-greedy', together: [/sloppy-greedy/, /환수율/] },
  { item: 4, what: 'session metric', together: [/세션/] },
  { item: 5, what: 'exactness gaps on 3×3, 4×4, 5×4 and the branch taken', together: [/3\s*[×x]\s*3/, /4\s*[×x]\s*4/, /5\s*[×x]\s*4/] },
  { item: 5, what: 'the branch of the exactness gate', together: [/정확성 게이트/, /분기/] },
  { item: 6, what: 'both adversaries next to 96.5%', together: [/rollout\(32\)/, /value-lookahead-all/, /96\.5\s*%/] },
  { item: 7, what: 'unselected candidates: L not gated, not deployable', together: [/축소 표본/, /고정 게이트/, /적용 불가|배포할 수 없/] },
  { item: 8, what: 'payouts may be deferred to pendingWithdrawals (30,000 gas)', together: [/pendingWithdrawals/, /30,?000/] },
  { item: 9, what: '/reveal publishes seeds of unused tickets and reclaimed games', together: [/\/reveal/, /티켓/, /회수/] },
  { item: 10, what: 'test-only surface; the guard is one environment flag', together: [/MAZE_ALLOW_TEST_HOOKS/, /테스트/] },
  { item: 11, what: 'no end-to-end run with truly random seeds', together: [/무작위 시드/, /종단/] },
  { item: 12, what: 'retuning means redeploying the contract', together: [/재튜닝/, /재배포/] },
  { item: 13, what: 'aside drives the user\'s real browser', together: [/aside/, /실제 브라우저/] },
  { item: 14, what: 'BLOCKED(경제): no production table, test table only', together: [/BLOCKED\(경제\)/, /테스트 표/] },
  { item: 15, what: 'a game never started loses 5% to the 120 s idle cash-out', together: [/\/start/, /120/, /5\s*%/] },
  { item: 16, what: 'chosen constants', together: [/0\.001/, /0\.1(?!\d)/, /120/, /900/, /1800/] },
];

interface CertifyTier {
  n: number;
  multiplierBps: number;
  games: number;
  best: { bot: string; rtp: number; ucb975: number };
  pairs: { adversary: string; rtp: number }[];
}

interface CertifyFile {
  tables?: Record<string, { tiers?: CertifyTier[] }>;
}

const ADVERSARIES = ['rollout(32)', 'value-lookahead-all'];
const NUMBER_COLUMNS = ['크기', '배율', '판 수', '최고 봇', '환수율', '상측 신뢰한계', '실현 엣지', ...ADVERSARIES];

/** The first number in a cell and how many decimals it was printed with. */
function printed(cell: string): { value: number; decimals: number; percent: boolean } | null {
  const match = /-?\d[\d,]*(?:\.(\d+))?/.exec(cell);
  if (match === null) return null;
  return { value: Number(match[0].replace(/,/g, '')), decimals: match[1]?.length ?? 0, percent: /%/.test(cell) };
}

function agrees(cell: string, actual: number, percent: boolean): string | null {
  const number = printed(cell);
  if (number === null) return 'no number';
  if (percent && (!number.percent || number.decimals < 2)) return 'a percentage with at least two decimals is required';
  const expected = percent ? actual * 100 : actual;
  return Math.abs(number.value - expected) <= 0.5 * 10 ** -number.decimals + 1e-9 ? null : `certify.json has ${expected.toFixed(Math.max(number.decimals, 2))}${percent ? '%' : ''}`;
}

function expectedRow(tier: CertifyTier): string {
  const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
  const pair = (name: string): string => {
    const found = tier.pairs.find((entry) => entry.adversary === name);
    return found === undefined ? '?' : pct(found.rtp);
  };
  return `| ${tier.n}×${tier.n} | ${(tier.multiplierBps / 10_000).toFixed(4)}배 | ${tier.games.toLocaleString('en-US')} | ${tier.best.bot} | ${pct(tier.best.rtp)} | ${pct(tier.best.ucb975)} | ${pct(1 - tier.best.rtp)} | ${ADVERSARIES.map(pair).join(' | ')} |`;
}

function checkNumbers(table: TuningTable, edge: Section | undefined, blocked: Section | undefined): void {
  const name = 'final report: numbers against certify.json (AC-D2)';
  if (!table.calibration.calibrated) {
    report(
      name,
      blocked !== undefined && /BLOCKED\(경제\)/.test(blocked.text)
        ? []
        : [`${PRODUCTION_TABLE} is not calibrated, so there are no certified numbers; the report must then record BLOCKED(경제) under "BLOCKED"`],
    );
    return;
  }
  const hash = tableHash(table);
  const tiers = readJson<CertifyFile>(CERTIFY)?.tables?.[hash]?.tiers;
  if (tiers === undefined || tiers.length !== table.tiers.length) {
    report(name, [`${CERTIFY} has no complete record for the production table ${hash}`]);
    return;
  }
  const model = [`| ${NUMBER_COLUMNS.join(' | ')} |`, `|${NUMBER_COLUMNS.map(() => '---').join('|')}|`, ...tiers.map(expectedRow)];
  const candidates = edge === undefined ? [] : tablesOf(edge.text);
  const found = candidates.find((entry) => NUMBER_COLUMNS.every((column) => entry.header.includes(column)));
  if (found === undefined) {
    report(name, [`no table under "실현 엣지" with the columns ${NUMBER_COLUMNS.join(', ')}. From certify.json it reads:`, ...model]);
    return;
  }
  const column = (label: string): number => found.header.indexOf(label);
  const problems: string[] = [];
  for (const tier of tiers) {
    const size = new RegExp(`^${tier.n}\\s*[×x]\\s*${tier.n}`);
    const row = found.rows.find((cells) => size.test(cells[column('크기')] ?? ''));
    if (row === undefined) {
      problems.push(`no row for ${tier.n}×${tier.n}; from certify.json: ${expectedRow(tier)}`);
      continue;
    }
    const cell = (label: string): string => row[column(label)] ?? '';
    const compare = (label: string, actual: number, percent: boolean): void => {
      const difference = agrees(cell(label), actual, percent);
      if (difference !== null) problems.push(`${tier.n}×${tier.n} ${label}: the report says "${cell(label)}", ${difference}`);
    };
    compare('배율', tier.multiplierBps / 10_000, false);
    compare('판 수', tier.games, false);
    if (!cell('최고 봇').includes(tier.best.bot)) {
      problems.push(`${tier.n}×${tier.n} 최고 봇: the report says "${cell('최고 봇')}", certify.json has ${tier.best.bot}`);
    }
    compare('환수율', tier.best.rtp, true);
    compare('상측 신뢰한계', tier.best.ucb975, true);
    compare('실현 엣지', 1 - tier.best.rtp, true);
    for (const adversary of ADVERSARIES) {
      const pair = tier.pairs.find((entry) => entry.adversary === adversary);
      if (pair === undefined) problems.push(`${tier.n}×${tier.n}: certify.json has no ${adversary} comparison`);
      else compare(adversary, pair.rtp, true);
    }
  }
  report(name, problems);
}

function checkBlocked(blocked: Section | undefined): void {
  const name = 'final report: BLOCKED list against verify:all (AC-D2)';
  if (blocked === undefined) {
    report(name, ['no "BLOCKED" section']);
    return;
  }
  const result = readJson<{ finishedAt?: string; acs?: Record<string, { status?: string }> }>(VERIFY_RESULT);
  if (result?.acs === undefined) {
    report(name, [`${VERIFY_RESULT} does not exist: run "pnpm verify:all" (it writes the result, then runs this check itself)`]);
    return;
  }
  const expected = Object.entries(result.acs)
    .filter(([, value]) => value.status === 'BLOCKED')
    .map(([id]) => id);
  const listed = new Set(blocked.text.match(/AC-[A-Z]\d+/g) ?? []);
  const problems = [
    ...expected.filter((id) => !listed.has(id)).map((id) => `${id} was BLOCKED in the last verify:all but is not named under "BLOCKED"`),
    ...[...listed].filter((id) => !expected.includes(id)).map((id) => `${id} is named under "BLOCKED" but was not BLOCKED in the last verify:all`),
  ];
  report(name, problems);
}

interface TuneResult {
  outcome?: string;
  baseline?: { name?: string } | null;
  candidates?: { name?: string }[];
}

function checkCandidates(comparison: Section | undefined, outcomeSection: Section | undefined, tune: TuneResult | null): void {
  const labelName = 'final report: "축소 표본" on unselected candidates (AC-D2)';
  if (comparison === undefined) {
    report(labelName, ['no candidate comparison section']);
  } else {
    const lines = comparison.text.split('\n');
    const names = (tune?.candidates ?? []).map((candidate) => candidate.name).filter((name): name is string => typeof name === 'string');
    const baseline = tune?.baseline?.name;
    if (names.length === 0 || typeof baseline !== 'string') {
      const labelled = lines.filter((line) => line.includes('축소 표본')).length;
      report(labelName, labelled >= 2 ? [] : [`${TUNE_RESULT} does not say which candidate is the baseline; then at least two lines must carry "축소 표본" (found ${labelled})`]);
    } else {
      const problems: string[] = [];
      for (const candidate of names.filter((name) => name !== baseline)) {
        const mention = new RegExp(`(^|[^A-Za-z0-9])\\(?${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)?([^A-Za-z0-9]|$)`);
        if (!lines.some((line) => mention.test(line) && line.includes('축소 표본'))) {
          problems.push(`candidate ${candidate} was not chosen as the baseline: its line needs the label "축소 표본"`);
        }
      }
      report(labelName, problems);
    }
  }

  const outcomeName = 'final report: tuning outcome (AC-T6)';
  if (outcomeSection === undefined) {
    report(outcomeName, ['no "튜닝 결과" section']);
    return;
  }
  const improved = outcomeSection.text.includes('개선됨');
  const unchanged = outcomeSection.text.includes('개선 없음');
  const problems: string[] = [];
  if (improved === unchanged) problems.push('the section must say exactly one of "개선됨" and "개선 없음"');
  if (tune?.outcome === 'no-improvement' && !unchanged) problems.push(`${TUNE_RESULT} reports no-improvement: the section must say "개선 없음"`);
  if (tune?.outcome === 'improved' && !improved) problems.push(`${TUNE_RESULT} reports improved: the section must say "개선됨"`);
  if (tune?.outcome !== undefined && tune.outcome !== 'improved' && improved) problems.push(`${TUNE_RESULT} reports ${tune.outcome}, not an improvement`);
  report(outcomeName, problems);
}

function checkReport(): void {
  const text = readText(REPORT);
  if (text === null) {
    report(`${REPORT} (AC-D2)`, ['the file does not exist']);
    return;
  }
  const sections = parseMarkdown(text);
  const preamble = text.split(/^#{1,6}\s/m)[0] ?? '';
  const blocks = blocksOf(sections, preamble);

  // Sections.
  const problems: string[] = [];
  for (const { name, pattern } of REPORT_SECTIONS) {
    if (sectionWith(sections, pattern) === undefined) problems.push(`no heading for "${name}"`);
  }
  const deviations = sectionWith(sections, /스펙 이탈/);
  if (deviations !== undefined) {
    const numbers = new Set<number>();
    for (const table of tablesOf(deviations.text)) for (const row of table.rows) numbers.add(Number((row[0] ?? '').replace(/[#.)]/g, '')));
    for (const match of deviations.text.matchAll(/^\s*(\d+)[.)]\s/gm)) numbers.add(Number(match[1]));
    const missing = Array.from({ length: DEVIATION_COUNT }, (_, i) => i + 1).filter((item) => !numbers.has(item));
    if (missing.length > 0) problems.push(`"스펙 이탈": items ${missing.join(', ')} of plan §13 are not listed (numbered rows or a numbered list)`);
  }
  const conclusions = sectionWith(sections, /결론/);
  if (conclusions !== undefined) {
    for (const level of ['컨트랙트', '통계', '가정']) {
      if (!conclusions.text.includes(level)) problems.push(`"결론": the level "${level}" is not there`);
    }
  }
  report('final report: required sections (AC-D2)', problems);

  // The sixteen statements.
  const missing: string[] = [];
  for (const { item, what, together } of REQUIRED_ITEMS) {
    if (!blocks.some((block) => together.every((pattern) => pattern.test(block)))) {
      missing.push(`item ${item} (${what}): not found together in one paragraph, list or table: ${together.map((pattern) => pattern.source).join('  ')}`);
    }
  }
  report('final report: the sixteen required statements (AC-D2)', missing);

  // Accepted risks.
  const risks = sectionWith(sections, /받아들인 위험/);
  report(
    'final report: accepted risks of the audit (AC-X1)',
    risks === undefined
      ? ['no "받아들인 위험" section']
      : acceptedRisks(root)
          .filter((id) => !new RegExp(`(^|[^0-9A-Za-z])${id}(?![0-9A-Za-z])`).test(risks.text))
          .map((id) => `${id} is an accepted-risk in docs/exploit-audit.md but is not named`),
  );

  // Numbers, BLOCKED list, candidates, outcome.
  const blocked = sectionWith(sections, /BLOCKED/);
  const tableText = readText(PRODUCTION_TABLE);
  if (tableText === null) {
    report('final report: numbers against certify.json (AC-D2)', [`${PRODUCTION_TABLE} does not exist`]);
  } else {
    checkNumbers(parseTuning(JSON.parse(tableText)), sectionWith(sections, /실현 엣지/), blocked);
  }
  checkBlocked(blocked);
  checkCandidates(sectionWith(sections, /후보.*비교|비교.*후보/), sectionWith(sections, /튜닝 결과/), readJson<TuneResult>(TUNE_RESULT));

  // Sensitivity table (AC-T5).
  const sensitivity = sectionWith(sections, /민감도/);
  report(
    'final report: sensitivity table (AC-T5)',
    sensitivity !== undefined && tablesOf(sensitivity.text).length > 0 ? [] : ['no heading containing "민감도" with a table under it'],
  );

  // House-max table (AC-T11).
  const houseMaxProblems: string[] = [];
  if (existsSync(resolve(root, HOUSE_MAX))) {
    const section = sectionWith(sections, /하우스 최대/);
    if (section === undefined) {
      houseMaxProblems.push(`${HOUSE_MAX} exists, so the house-max table differs: a heading containing "하우스 최대" is required`);
    } else {
      if (!section.text.includes('tuning.house-max.json')) houseMaxProblems.push('"하우스 최대": the file tuning.house-max.json is not named');
      for (const metric of ['E2', 'E3', 'E10', 'E11']) {
        if (!new RegExp(`(^|[^0-9A-Za-z])${metric}(?![0-9])`).test(section.text)) houseMaxProblems.push(`"하우스 최대": ${metric} of the two tables is not there`);
      }
    }
  } else if (!blocks.some((block) => /하우스 최대/.test(block) && /같다|같음|동일/.test(block))) {
    houseMaxProblems.push(`${HOUSE_MAX} does not exist, so the house-max table is the base table: the report must say so ("하우스 최대" with "같다" or "동일")`);
  }
  report('final report: house-max table (AC-T11)', houseMaxProblems);
}

checkDeviations();
checkReport();

if (failures > 0) {
  console.error(`report:check FAILED: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('report:check OK: docs/spec-deviations.md and docs/final-report.md are complete.');
