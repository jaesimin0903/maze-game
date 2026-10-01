// Checks that every changed path is owned by a stream that was active (plan §8.2, AC-I2).
// The working tree is shared, so a change cannot be attributed to one stream; the check is
// "changed paths are a subset of the UNION of the active streams' paths" (scripts/ownership.json).
//
//   pnpm ownership:check                         every changed path is owned by some stream
//   pnpm ownership:check --phase 2               ... by a stream active in phase 2
//   pnpm ownership:check --streams WS-A,WS-B     ... by one of the named streams
//
// Changed paths = working tree against HEAD: modified, added, deleted, renamed (both names) and
// untracked files. Git-ignored files are not considered.
//
// Exit codes: 0 = all owned, 1 = at least one path is not owned, 2 = usage or environment error.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface StreamOwnership {
  paths: string[];
  except?: string[];
}

interface OwnershipFile {
  streams: Record<string, StreamOwnership>;
  phases: Record<string, string[]>;
}

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

function usageError(message: string): never {
  console.error(`ownership:check: ${message}`);
  console.error('usage: pnpm ownership:check [--phase <id> | --streams <name>[,<name>...]]');
  process.exit(2);
}

/** Supports `**` (any depth, including none), `*` (within one path segment) and literal text. */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char !== '*') {
      source += char.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    } else if (glob.charAt(i + 1) !== '*') {
      source += '[^/]*';
    } else if (glob.charAt(i + 2) === '/') {
      source += '(?:.*/)?';
      i += 2;
    } else {
      source += '.*';
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

function owns(stream: StreamOwnership, path: string): boolean {
  const matches = (globs: string[] | undefined) =>
    (globs ?? []).some((glob) => globToRegExp(glob).test(path));
  return matches(stream.paths) && !matches(stream.except);
}

function changedPaths(): string[] {
  let output: string;
  try {
    output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    usageError(`git status failed in ${repoRoot}: ${(error as Error).message}`);
  }
  const tokens = output.split('\0').filter((token) => token.length > 0);
  const paths = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] as string;
    const status = entry.slice(0, 2);
    paths.add(entry.slice(3));
    // Renames and copies are followed by a second token holding the original path.
    if (status.includes('R') || status.includes('C')) {
      i += 1;
      paths.add(tokens[i] as string);
    }
  }
  return [...paths].sort();
}

function selectStreams(ownership: OwnershipFile, args: string[]): { label: string; names: string[] } {
  const rest = args.filter((arg) => arg !== '--');
  if (rest.length === 0) {
    return { label: 'all streams', names: Object.keys(ownership.streams) };
  }
  const [flag, value, ...extra] = rest;
  if (extra.length > 0 || value === undefined) usageError(`unexpected arguments: ${rest.join(' ')}`);
  if (flag === '--phase') {
    const names = ownership.phases[value];
    if (names === undefined) {
      usageError(`unknown phase "${value}" (known: ${Object.keys(ownership.phases).join(', ')})`);
    }
    return { label: `phase ${value}`, names };
  }
  if (flag === '--streams') {
    return { label: 'the named streams', names: value.split(',').map((name) => name.trim()) };
  }
  usageError(`unknown option "${flag}"`);
}

const ownership = JSON.parse(
  readFileSync(resolve(scriptsDir, 'ownership.json'), 'utf8'),
) as OwnershipFile;

for (const [phase, names] of Object.entries(ownership.phases)) {
  for (const name of names) {
    if (ownership.streams[name] === undefined) {
      usageError(`ownership.json: phase ${phase} names the unknown stream "${name}"`);
    }
  }
}

const selection = selectStreams(ownership, process.argv.slice(2));
for (const name of selection.names) {
  if (ownership.streams[name] === undefined) {
    usageError(`unknown stream "${name}" (known: ${Object.keys(ownership.streams).join(', ')})`);
  }
}

const active = selection.names.map((name) => ownership.streams[name] as StreamOwnership);
const changed = changedPaths();
const violations = changed.filter((path) => !active.some((stream) => owns(stream, path)));

if (violations.length > 0) {
  console.error(
    `ownership:check FAILED: ${violations.length} of ${changed.length} changed paths are outside ` +
      `${selection.label} (${selection.names.join(', ')}).`,
  );
  for (const path of violations) {
    const owners = Object.entries(ownership.streams)
      .filter(([, stream]) => owns(stream, path))
      .map(([name]) => name);
    console.error(`  - ${path}  (${owners.length > 0 ? `owned by ${owners.join(', ')}` : 'no owner'})`);
  }
  process.exit(1);
}

console.log(
  `ownership:check OK: ${changed.length} changed paths, all inside ${selection.label} ` +
    `(${selection.names.join(', ')}).`,
);
