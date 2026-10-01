// Compares packages/shared/src/abi.ts with the forge artifact of MazeBet (plan §7.2, AC-I1).
// The comparison ignores entry order and `internalType`; everything else must be identical,
// including parameter names, struct component names, `indexed` and `stateMutability`.
//
// Exit codes: 0 = identical, 1 = different, 2 = the artifact is missing or unreadable.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mazeBetAbi } from '@maze/shared';

interface AbiParam {
  name?: string;
  type: string;
  indexed?: boolean;
  components?: readonly AbiParam[];
}

interface AbiItem {
  type: string;
  name?: string;
  stateMutability?: string;
  anonymous?: boolean;
  inputs?: readonly AbiParam[];
  outputs?: readonly AbiParam[];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = resolve(repoRoot, 'contracts/out/MazeBet.sol/MazeBet.json');
const artifactLabel = relative(repoRoot, artifactPath);

function canonicalType(param: AbiParam): string {
  if (!param.type.startsWith('tuple')) return param.type;
  const inner = (param.components ?? []).map(canonicalType).join(',');
  return `(${inner})${param.type.slice('tuple'.length)}`;
}

function describeParam(param: AbiParam, isEventInput: boolean): string {
  const type = param.type.startsWith('tuple')
    ? `(${(param.components ?? []).map((c) => describeParam(c, false)).join(', ')})${param.type.slice('tuple'.length)}`
    : param.type;
  const parts = [type];
  if (isEventInput && param.indexed) parts.push('indexed');
  if (param.name) parts.push(param.name);
  return parts.join(' ');
}

/** Identity of an entry: kind, name and input types (what selectors and topics are derived from). */
function keyOf(item: AbiItem): string {
  return `${item.type} ${item.name ?? ''}(${(item.inputs ?? []).map(canonicalType).join(',')})`;
}

/** Full description of an entry, including every name and modifier that must match. */
function describeItem(item: AbiItem): string {
  const inputs = (item.inputs ?? []).map((p) => describeParam(p, item.type === 'event')).join(', ');
  switch (item.type) {
    case 'function': {
      const outputs = (item.outputs ?? []).map((p) => describeParam(p, false)).join(', ');
      return `function ${item.name}(${inputs}) ${item.stateMutability} returns (${outputs})`;
    }
    case 'event':
      return `event ${item.name}(${inputs})${item.anonymous ? ' anonymous' : ''}`;
    case 'error':
      return `error ${item.name}(${inputs})`;
    case 'constructor':
      return `constructor(${inputs}) ${item.stateMutability}`;
    default:
      return `${item.type}() ${item.stateMutability}`;
  }
}

function indexAbi(label: string, abi: readonly AbiItem[], problems: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const item of abi) {
    const key = keyOf(item);
    if (index.has(key)) problems.push(`duplicate entry in ${label}: ${key}`);
    index.set(key, describeItem(item));
  }
  return index;
}

function fail(code: number, lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(code);
}

if (!existsSync(artifactPath)) {
  fail(2, [
    `abi:check: ${artifactLabel} does not exist.`,
    'Build the contract first: forge build --root contracts (contracts/src/MazeBet.sol is created by WS-B).',
  ]);
}

let artifactAbi: readonly AbiItem[];
try {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as { abi?: unknown };
  if (!Array.isArray(artifact.abi)) throw new Error('the artifact has no "abi" array');
  artifactAbi = artifact.abi as AbiItem[];
} catch (error) {
  fail(2, [`abi:check: cannot read ${artifactLabel}: ${(error as Error).message}`]);
}

const problems: string[] = [];
const expected = indexAbi('packages/shared/src/abi.ts', mazeBetAbi, problems);
const actual = indexAbi(artifactLabel, artifactAbi, problems);

for (const [key, description] of expected) {
  const found = actual.get(key);
  if (found === undefined) {
    problems.push(`missing in the contract: ${description}`);
  } else if (found !== description) {
    problems.push(`differs: ${key}\n    abi.ts:   ${description}\n    contract: ${found}`);
  }
}
for (const [key, description] of actual) {
  if (!expected.has(key)) problems.push(`not in abi.ts: ${description}`);
}

if (problems.length > 0) {
  fail(1, [
    `abi:check FAILED: packages/shared/src/abi.ts and ${artifactLabel} differ (${problems.length}).`,
    ...problems.sort().map((p) => `  - ${p}`),
    'abi.ts is frozen (plan §8.1): change the contract to match it, or go through the modification procedure.',
  ]);
}

console.log(`abi:check OK: ${expected.size} entries match ${artifactLabel}.`);
