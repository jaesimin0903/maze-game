// Reads and updates the KEY=VALUE files the Monad scripts keep their settings in (`.env.monad`,
// docs/deploy-monad.md).
//
// The game server never reads such a file: it takes its settings from the process environment.
// Values are written unquoted, one per line, which is the format `docker run --env-file` and
// `fly secrets import` read. These files hold the only copy of the keys, so they are written
// whole or not at all (`writeSecretFile`), with mode 600, and the previous version is kept.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where `pnpm monad:keys` writes the settings and every other Monad script reads them. */
export const DEFAULT_ENV_FILE = path.join(ROOT, '.env.monad');

export type EnvValues = Record<string, string>;

const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/**
 * `KEY=VALUE` lines; blank lines and `#` comments are skipped, one pair of outer quotes removed.
 * A key given twice takes its last value.
 */
export function parseEnv(text: string): EnvValues {
  const values: EnvValues = {};
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = LINE.exec(line);
    // Never the line itself: it may hold a key.
    if (match === null) throw new Error(`line ${index + 1} is not a KEY=VALUE line`);
    const value = match[2].trim();
    values[match[1]] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return values;
}

export function readEnvFile(file: string): EnvValues {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`${file} does not exist; run "pnpm monad:keys" first`);
  }
  try {
    return parseEnv(text);
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
}

/**
 * Sets `updates` in `file`: every line of a key gets the new value in its place (so a key given
 * twice reads back as written), a key without a line is appended. Comments and every other line
 * stay as they are.
 */
export function updateEnvFile(file: string, updates: EnvValues): void {
  const lines = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n');
  const written = new Set<string>();
  const updated = lines.map((line) => {
    const match = LINE.exec(line.trim());
    if (match === null || !Object.hasOwn(updates, match[1])) return line;
    written.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  for (const [key, value] of Object.entries(updates)) if (!written.has(key)) updated.push(`${key}=${value}`);
  writeSecretFile(file, `${updated.join('\n')}\n`);
}

/**
 * Writes `file` so that a crash or a full disk never leaves it half written: the content goes to
 * `${file}.tmp` (mode 600), is flushed to disk and then renamed over `file`, whose previous
 * content is kept in `${file}.bak` (mode 600). With `create`, `file` must not exist yet and is
 * never replaced.
 */
export function writeSecretFile(file: string, content: string, options: { create?: boolean } = {}): void {
  const temp = `${file}.tmp`;
  rmSync(temp, { force: true });
  writeFlushed(temp, content);
  try {
    if (options.create === true) {
      // `link` fails when `file` exists: a file that appeared in the meantime is never replaced.
      linkSync(temp, file);
    } else {
      if (existsSync(file)) {
        const backup = `${file}.bak`;
        rmSync(backup, { force: true });
        writeFlushed(backup, readFileSync(file, 'utf8'));
      }
      renameSync(temp, file);
    }
  } finally {
    rmSync(temp, { force: true });
  }
  // The new name is durable only once the directory is.
  const directory = openSync(path.dirname(file), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Creates `file` (which must not exist) with mode 600 and flushes it to disk. */
function writeFlushed(file: string, content: string): void {
  const fd = openSync(file, 'wx', 0o600);
  try {
    // Unlike one `writeSync`, this writes until every byte is out, or throws.
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(file, 0o600);
}

/** `file` relative to the repository root when it lies inside it, absolute otherwise. */
export function shown(file: string): string {
  const relative = path.relative(ROOT, file);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? file : relative;
}

/** The value of `name`, which must be set and not empty. */
export function requireValue(env: EnvValues, name: string, file: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set in ${file}`);
  return value;
}

/** The value after `name` on the command line, or `undefined` when the option is absent. */
export function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

/**
 * `--env <path>`, resolved against the directory the command was started from. (Not
 * `--env-file`: tsx takes that one as Node's own flag, wherever it stands.)
 */
export function envFileOption(args: readonly string[]): string {
  const given = option(args, '--env');
  return given === undefined ? DEFAULT_ENV_FILE : path.resolve(process.env.INIT_CWD ?? process.cwd(), given);
}
