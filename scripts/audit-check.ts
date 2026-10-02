// Checks docs/exploit-audit.md (plan §9.2, AC-X1, AC-X10).
//
//   pnpm audit:exploit [--root <dir>]
//
// `--root` checks the documents of another copy of the repository tree (default: this one).
//
// The format this command reads:
//
//   ### X12 — one line naming the attack            a heading (any level) that starts with the id
//   - 가설: what the attacker hopes for               (Hypothesis)
//   - 시도: what was tried                            (Attempt)
//   - 결과: what happened                             (Result)
//   - 조치: what was changed, or why nothing was      (Action)
//   - 테스트: `name of a test`, `another`, T-cert     (Tests)
//   - 상태: fixed                                     (Status)
//
// A field runs until the next field or heading. Rules:
//   - every id X1 .. X30 of the plan's list is present, no id twice; findings continue at X31;
//   - 상태 is exactly one of fixed, not-exploitable, accepted-risk;
//   - 가설, 시도, 결과 and 조치 are filled in;
//   - fixed and not-exploitable need evidence in 테스트: at least one test name in backticks
//     that occurs literally in a test source (apps/web/test, packages/*/test, contracts/test,
//     e2e/aside), or T-cert / T-exact for a claim that only the simulation can support. A name
//     in backticks that occurs in no test source is an error;
//   - accepted-risk needs `- 근거:` (Rationale) and, once docs/final-report.md exists, must be
//     named in that report's section on accepted risks ("받아들인 위험");
//   - free exploration: two sections whose headings contain "자유 탐색" and "1회차" / "2회차"
//     (or "Free exploration" and "round 1" / "round 2"). Under each, at least five
//     sub-headings, one per attack tried, each with `- 가설:`, `- 한 일:` and `- 결과:`.
//
// Exit codes: 0 = the audit document is complete, 1 = it is missing or incomplete.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AUDIT_DOC = 'docs/exploit-audit.md';
export const FINAL_REPORT = 'docs/final-report.md';

/** The tree to check: `--root <dir>`, or this repository. Any other argument is a usage error. */
export function rootFromArguments(command: string): string {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length === 0) return REPO_ROOT;
  if (args.length === 2 && args[0] === '--root') return resolve(args[1]);
  console.error(`usage: pnpm ${command} [--root <dir>]`);
  process.exit(2);
}

// ----- Markdown -----

export interface Section {
  level: number;
  title: string;
  /** Text between this heading and the next heading of any level. */
  own: string;
  /** Text between this heading and the next heading of the same or a higher level. */
  text: string;
}

/** The headings of a document with their text. Lines inside code fences are never headings. */
export function parseMarkdown(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const headings: { level: number; title: string; line: number }[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) headings.push({ level: heading[1].length, title: heading[2], line: index });
  });
  return headings.map((heading, i) => {
    const next = headings[i + 1]?.line ?? lines.length;
    const end = headings.slice(i + 1).find((later) => later.level <= heading.level)?.line ?? lines.length;
    return {
      level: heading.level,
      title: heading.title,
      own: lines.slice(heading.line + 1, next).join('\n'),
      text: lines.slice(heading.line + 1, end).join('\n'),
    };
  });
}

/** The sections below `sections[index]`, down to the next heading of its level or higher. */
export function subsections(sections: readonly Section[], index: number): Section[] {
  const out: Section[] = [];
  for (let i = index + 1; i < sections.length && sections[i].level > sections[index].level; i++) {
    out.push(sections[i]);
  }
  return out;
}

const FIELD_LABELS: Record<string, string> = {
  가설: 'hypothesis',
  hypothesis: 'hypothesis',
  시도: 'attempt',
  '한 일': 'attempt',
  attempt: 'attempt',
  결과: 'result',
  result: 'result',
  조치: 'action',
  action: 'action',
  근거: 'rationale',
  rationale: 'rationale',
  테스트: 'tests',
  '테스트 이름': 'tests',
  test: 'tests',
  tests: 'tests',
  상태: 'status',
  status: 'status',
};

/** The labelled fields of a block of text: `- 가설: …` up to the next label. */
export function fieldsOf(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  let current: string | null = null;
  for (const line of text.split('\n')) {
    const match = /^\s*(?:[-*+]\s+)?(?:\*\*)?([^:：*]{1,20}?)(?:\*\*)?\s*[:：](?:\*\*)?\s*(.*)$/.exec(line);
    const key = match === null ? undefined : FIELD_LABELS[match[1].trim().toLowerCase()];
    if (match !== null && key !== undefined) {
      current = key;
      fields.set(key, match[2]);
    } else if (current !== null) {
      fields.set(current, `${fields.get(current)}\n${line}`);
    }
  }
  for (const [key, value] of fields) fields.set(key, value.trim());
  return fields;
}

const filled = (value: string | undefined): value is string => value !== undefined && value !== '' && value !== '-';

// ----- the audit document -----

export const STATUSES = ['fixed', 'not-exploitable', 'accepted-risk'] as const;
export type AuditStatus = (typeof STATUSES)[number];

export interface AuditItem {
  id: string;
  title: string;
  status: AuditStatus | null;
  fields: Map<string, string>;
}

const REQUIRED_IDS = Array.from({ length: 30 }, (_, i) => `X${i + 1}`);
const SIMULATION_EVIDENCE = new Set(['T-cert', 'T-exact']);
const TEST_ROOTS = ['apps/web/test', 'packages/shared/test', 'packages/sim/test', 'contracts/test', 'e2e/aside'];
const TEST_EXTENSIONS = new Set(['.ts', '.tsx', '.sol', '.sh']);

function testSources(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules' && name !== 'out') walk(path);
      } else if (TEST_EXTENSIONS.has(extname(name))) {
        parts.push(readFileSync(path, 'utf8'));
      }
    }
  };
  for (const testRoot of TEST_ROOTS) {
    const dir = resolve(root, testRoot);
    if (existsSync(dir)) walk(dir);
  }
  return parts.join('\n');
}

export function auditItems(sections: readonly Section[]): AuditItem[] {
  const items: AuditItem[] = [];
  for (const section of sections) {
    const match = /^(X\d+)(?![0-9A-Za-z])\s*[-—–:.]?\s*(.*)$/.exec(section.title);
    if (match === null) continue;
    const fields = fieldsOf(section.own);
    const status = (fields.get('status') ?? '').replace(/[`*]/g, '').trim().toLowerCase();
    items.push({
      id: match[1],
      title: match[2],
      status: (STATUSES as readonly string[]).includes(status) ? (status as AuditStatus) : null,
      fields,
    });
  }
  return items;
}

/** Ids of the accepted risks in the audit document; empty when the document does not exist. */
export function acceptedRisks(root: string): string[] {
  const doc = resolve(root, AUDIT_DOC);
  if (!existsSync(doc)) return [];
  return auditItems(parseMarkdown(readFileSync(doc, 'utf8')))
    .filter((item) => item.status === 'accepted-risk')
    .map((item) => item.id);
}

function freeExploration(sections: readonly Section[], round: 1 | 2, problems: string[]): number {
  const pattern = new RegExp(`자유\\s*탐색.*${round}\\s*회차|${round}\\s*회차.*자유\\s*탐색|free exploration.*round\\s*${round}`, 'i');
  const index = sections.findIndex((section) => pattern.test(section.title));
  if (index === -1) {
    problems.push(`free exploration round ${round}: no heading with "자유 탐색" and "${round}회차"`);
    return 0;
  }
  let complete = 0;
  for (const attempt of subsections(sections, index)) {
    const fields = fieldsOf(attempt.own);
    if (filled(fields.get('hypothesis')) && filled(fields.get('attempt')) && filled(fields.get('result'))) {
      complete += 1;
    }
  }
  if (complete < 5) {
    problems.push(
      `free exploration round ${round}: ${complete} attack(s) described with 가설, 한 일 and 결과; at least 5 are required`,
    );
  }
  return complete;
}

function main(): void {
  const root = rootFromArguments('audit:exploit');
  const name = AUDIT_DOC;
  const doc = resolve(root, AUDIT_DOC);
  const finalReport = resolve(root, FINAL_REPORT);
  if (!existsSync(doc)) {
    console.error(`audit:exploit FAILED: ${name} does not exist.`);
    process.exit(1);
  }
  const sections = parseMarkdown(readFileSync(doc, 'utf8'));
  const items = auditItems(sections);
  const problems: string[] = [];

  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) problems.push(`${item.id}: listed more than once`);
    seen.add(item.id);
  }
  for (const id of REQUIRED_IDS) {
    if (!seen.has(id)) problems.push(`${id}: missing (the plan's list runs from X1 to X30)`);
  }

  const sources = testSources(root);
  for (const item of items) {
    const { id, fields } = item;
    if (item.status === null) {
      problems.push(`${id}: 상태 must be one of ${STATUSES.join(', ')} (found "${fields.get('status') ?? ''}")`);
    }
    for (const [key, label] of [['hypothesis', '가설'], ['attempt', '시도'], ['result', '결과'], ['action', '조치']]) {
      if (!filled(fields.get(key))) problems.push(`${id}: ${label} is missing or empty`);
    }
    const tests = fields.get('tests') ?? '';
    const names = [...tests.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
    const simulation = [...SIMULATION_EVIDENCE].filter((token) => new RegExp(`(^|[^A-Za-z-])${token}(?![A-Za-z-])`).test(tests));
    const unknown = names.filter((test) => !SIMULATION_EVIDENCE.has(test) && !sources.includes(test));
    for (const test of unknown) problems.push(`${id}: the test \`${test}\` is not found in any test source`);
    if (item.status === 'fixed' || item.status === 'not-exploitable') {
      if (names.length - unknown.length === 0 && simulation.length === 0) {
        problems.push(`${id}: ${item.status} needs a test name in backticks under 테스트 (or T-cert / T-exact)`);
      }
    }
    if (item.status === 'accepted-risk' && !filled(fields.get('rationale'))) {
      problems.push(`${id}: accepted-risk needs 근거`);
    }
  }

  const rounds = [freeExploration(sections, 1, problems), freeExploration(sections, 2, problems)];

  const accepted = items.filter((item) => item.status === 'accepted-risk').map((item) => item.id);
  if (existsSync(finalReport)) {
    const report = parseMarkdown(readFileSync(finalReport, 'utf8'));
    const section = report.find((entry) => /받아들인 위험|accepted risk/i.test(entry.title));
    if (section === undefined) {
      problems.push(`${FINAL_REPORT} has no section on accepted risks ("받아들인 위험")`);
    } else {
      for (const id of accepted) {
        if (!new RegExp(`(^|[^0-9A-Za-z])${id}(?![0-9A-Za-z])`).test(section.text)) {
          problems.push(`${id}: accepted-risk, but not named in the final report's section on accepted risks`);
        }
      }
    }
  } else if (accepted.length > 0) {
    console.log(
      `note: ${FINAL_REPORT} does not exist yet; once it does, it must name ${accepted.join(', ')} as accepted risks.`,
    );
  }

  const count = (status: AuditStatus): number => items.filter((item) => item.status === status).length;
  const summary =
    `${items.length} items (${count('fixed')} fixed, ${count('not-exploitable')} not-exploitable, ` +
    `${count('accepted-risk')} accepted-risk), free exploration ${rounds[0]} + ${rounds[1]} attacks`;
  if (problems.length > 0) {
    console.error(`audit:exploit FAILED: ${problems.length} problem(s) in ${name}; ${summary}.`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`audit:exploit OK: ${name}: ${summary}.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
