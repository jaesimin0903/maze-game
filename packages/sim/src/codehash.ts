// Simulator code hash (plan §9.3, AC-T9).
//
// It covers exactly the code that can change the result of a simulated game:
//   packages/sim/src/{engine,worker,posterior,lsm,streams,stats}.ts
//   packages/sim/src/bots/**
//   packages/shared/src/{rng,maze,economics}.ts
// Report, CLI, calibration and certification code is deliberately left out, so editing it does
// not invalidate certified results.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** `packages/sim`, whether this module runs from `src/` (tests) or from `dist/` (the built CLI). */
export function simPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

const SIM_FILES = ['engine.ts', 'worker.ts', 'posterior.ts', 'lsm.ts', 'streams.ts', 'stats.ts'];
const SHARED_FILES = ['rng.ts', 'maze.ts', 'economics.ts'];

function listTree(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listTree(path));
    else out.push(path);
  }
  return out;
}

/** Absolute paths of the files the code hash covers, for the given package root. */
export function hashedFiles(simRoot: string): string[] {
  const src = join(simRoot, 'src');
  const shared = resolve(simRoot, '..', 'shared', 'src');
  return [
    ...SIM_FILES.map((name) => join(src, name)),
    ...listTree(join(src, 'bots')),
    ...SHARED_FILES.map((name) => join(shared, name)),
  ];
}

/** Hash of a set of files: sha256 over one `path NUL sha256(content) LF` line per file, sorted by path. */
export function hashFiles(paths: readonly string[], relativeTo: string): string {
  const lines = paths
    .map((path) => `${relative(relativeTo, path).split(sep).join('/')}\0${bytesToHex(sha256(readFileSync(path)))}\n`)
    .sort();
  return bytesToHex(sha256(utf8ToBytes(lines.join(''))));
}

let cached: string | null = null;

/** The simulator code hash of the sources on disk. */
export function simCodeHash(simRoot: string = simPackageRoot()): string {
  if (simRoot === simPackageRoot() && cached !== null) return cached;
  const hash = hashFiles(hashedFiles(simRoot), resolve(simRoot, '..'));
  if (simRoot === simPackageRoot()) cached = hash;
  return hash;
}
