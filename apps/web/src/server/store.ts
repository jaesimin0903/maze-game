// Append-only event log (plan §7.8).
//
// The log is the only durable state of the server. A ticket, every move and the terminal
// signature are appended and flushed to disk BEFORE the response that reveals them is sent, and
// the in-memory state is changed only after the append succeeded. Booting replays the log.
//
// File format: `<dir>/events.jsonl`, one JSON object per line. Events that must be stored
// together or not at all (the last move of a game and its ending) are written as one line,
// `{"type":"group","events":[...]}`: a line is either complete or, if the process died while
// writing it, an unterminated tail that the next boot discards.
//
// One process at a time: `<dir>/events.lock` holds the pid of the process that has the log open.
// Two servers appending to one log would each keep their own state and could each sign an
// ending for the same game.

import { mkdir, open, readFile, rm, truncate, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Dir, Hex } from '@maze/shared';

/** Why a game ended. `chain` marks an ending the server learned from a `GameSettled` log only. */
export type EndCause = 'exit' | 'dead-end' | 'cashout' | 'idle' | 'max-game' | 'chain';

/** Times are chain seconds. Amounts and block numbers are decimal strings. */
export type StoreEvent =
  | { type: 'meta'; chainId: number; contract: Hex }
  | {
      type: 'ticket-issued';
      gameId: Hex;
      player: Hex;
      tier: number;
      n: number;
      serverSeed: Hex;
      commitment: Hex;
      sessionTokenHash: Hex;
      expirySec: number;
      signature: Hex;
      atSec: number;
    }
  | {
      type: 'chain-created';
      gameId: Hex;
      clientSeed: Hex;
      betWei: string;
      maxPayoutWei: string;
      createdAtSec: number;
      settleDeadlineSec: number;
      blockNumber: string;
      /** Open mask of the start cell, the first cell the player is shown. */
      startOpen: number;
      atSec: number;
    }
  | {
      type: 'move';
      gameId: Hex;
      /** Moves made once this one is applied. */
      step: number;
      dir: Dir;
      /** Arrival cell and its open mask. */
      cell: number;
      open: number;
      atSec: number;
    }
  | {
      type: 'ended';
      gameId: Hex;
      outcome: 0 | 1 | 2;
      steps: number;
      payoutWei: string;
      /** Server signature over the EIP-712 `Settlement`. */
      signature: Hex;
      auto: boolean;
      cause: EndCause;
      atSec: number;
    }
  | { type: 'settle-sent'; gameId: Hex; txHash: Hex; nonce: number; atSec: number }
  | { type: 'settle-mined'; gameId: Hex; txHash: Hex; blockNumber: string; atSec: number }
  | {
      type: 'reclaimed';
      gameId: Hex;
      txHash: Hex;
      blockNumber: string;
      amountWei: string;
      atSec: number;
    }
  | { type: 'block-scanned'; blockNumber: string; blockHash: Hex };

export interface EventStore {
  /** Every event stored so far, in order. */
  load(): Promise<StoreEvent[]>;
  /**
   * Stores one event, or several atomically, and resolves once they are durable. Appends are
   * applied in call order. After a failed append the store rejects every later one: the file
   * may end in a partial line, which only a reboot repairs.
   */
  append(events: StoreEvent | readonly StoreEvent[]): Promise<void>;
  close(): Promise<void>;
}

const EVENT_TYPES: ReadonlySet<string> = new Set([
  'meta',
  'ticket-issued',
  'chain-created',
  'move',
  'ended',
  'settle-sent',
  'settle-mined',
  'reclaimed',
  'block-scanned',
]);

function isEvent(value: unknown): value is StoreEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    EVENT_TYPES.has((value as { type?: unknown }).type as string)
  );
}

function encode(input: StoreEvent | readonly StoreEvent[]): string {
  const events = Array.isArray(input) ? (input as readonly StoreEvent[]) : [input as StoreEvent];
  if (events.length === 0) throw new RangeError('store: nothing to append');
  return `${JSON.stringify(events.length === 1 ? events[0] : { type: 'group', events })}\n`;
}

function decode(text: string): StoreEvent[] {
  const events: StoreEvent[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(lines[i]);
    } catch {
      throw new Error(`event log: line ${i + 1} is not valid JSON`);
    }
    const group =
      typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'group'
        ? (value as { events?: unknown }).events
        : [value];
    if (!Array.isArray(group) || group.length === 0 || !group.every(isEvent)) {
      throw new Error(`event log: line ${i + 1} is not a known event`);
    }
    events.push(...group);
  }
  return events;
}

/** A store that keeps events in memory. Used by unit tests. */
export function createMemoryStore(initial: readonly StoreEvent[] = []): EventStore {
  // Round-trips through the file encoding so both stores hand back the same shapes.
  let text = initial.map(encode).join('');
  return {
    load: () => Promise.resolve(decode(text)),
    append(events) {
      text += encode(events);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
}

const OPEN_LOGS = Symbol.for('maze.server.openLogs');

/** Resolved directories of the logs this process has open, kept on `globalThis`. */
function openLogs(): Set<string> {
  const globals = globalThis as { [OPEN_LOGS]?: Set<string> };
  globals[OPEN_LOGS] ??= new Set();
  return globals[OPEN_LOGS];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Takes `lockFile` for this process. A lock left by a process that no longer runs (it was
 * killed) is replaced; a lock held by a live process is an error.
 */
async function acquireLock(lockFile: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(lockFile, 'wx');
      try {
        await handle.writeFile(`${process.pid}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const owner = Number((await readFile(lockFile, 'utf8').catch(() => '')).trim());
    if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && isAlive(owner)) {
      throw new Error(`event log: ${path.dirname(lockFile)} is in use by process ${owner}`);
    }
    await rm(lockFile, { force: true });
  }
  throw new Error(`event log: cannot take ${lockFile}`);
}

/**
 * Opens (creating if needed) the event log in `dir`. An unterminated last line, left by a
 * process that died mid-write, is cut off: it was never flushed, so nothing was answered from it.
 */
export async function openFileStore(dir: string): Promise<EventStore> {
  const key = path.resolve(dir);
  const file = path.join(dir, 'events.jsonl');
  const lockFile = path.join(dir, 'events.lock');

  // Within one process the pid in the lock file cannot tell two openers apart, so the logs
  // this process has open are tracked as well, across every loaded copy of this module.
  const opened = openLogs();
  if (opened.has(key)) throw new Error(`event log: ${key} is already open in this process`);
  opened.add(key);

  let loaded: StoreEvent[];
  let handle: FileHandle;
  let locked = false;
  try {
    await mkdir(dir, { recursive: true });
    await acquireLock(lockFile);
    locked = true;
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    if (complete.length !== text.length) await truncate(file, Buffer.byteLength(complete, 'utf8'));
    loaded = decode(complete);

    handle = await open(file, 'a');
    await handle.sync();
    // Make the file's directory entry durable too.
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (error) {
    // The lock is released only if this call took it; a lock held by another process stays.
    if (locked) await rm(lockFile, { force: true });
    opened.delete(key);
    throw error;
  }

  let tail: Promise<unknown> = Promise.resolve();
  let failure: Error | null = null;
  let closed = false;

  return {
    load: () => Promise.resolve([...loaded]),
    append(events) {
      const line = encode(events);
      const done = tail.then(async () => {
        if (closed) throw new Error('event log: the store is closed');
        if (failure !== null) throw failure;
        try {
          await handle.appendFile(line, 'utf8');
          await handle.sync();
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          throw failure;
        }
        loaded.push(...decode(line));
      });
      tail = done.catch(() => undefined);
      return done;
    },
    async close() {
      await tail;
      if (closed) return;
      closed = true;
      await handle.close();
      await rm(lockFile, { force: true });
      opened.delete(key);
    },
  };
}
