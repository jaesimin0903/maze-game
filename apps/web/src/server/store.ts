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
//
// The file is only ever read as a stream, line by line, so its size is not limited by the
// longest string the runtime can hold, and the store keeps no copy of it in memory. Tickets that
// expired without creating a game are cut out of the file when it is opened, once the server's
// own chain scan has passed their expiry by the retention window (`compact`).

import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, truncate, type FileHandle } from 'node:fs/promises';
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
      /** The owner of a ticket that has not created its game yet asked for it again. */
      type: 'ticket-rebound';
      gameId: Hex;
      sessionTokenHash: Hex;
      /** The ticket's expiry, repeated so that this line can be judged on its own. */
      expirySec: number;
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
      /**
       * Only on an ending in a dead end: the chest rule version applied to that dead end. Absent
       * on every other ending and in logs written before chests existed.
       */
      chestRule?: number;
    }
  | {
      /**
       * Points for the chest in the dead end that ended the game. Stored in the same line as the
       * ending (and the move into the dead end), so the award and the ending exist together or
       * not at all. The points ledger is rebuilt from these events alone. Points have no cash value.
       */
      type: 'chest-awarded';
      gameId: Hex;
      /** Checksummed address the ticket was issued to, on its wallet signature. */
      player: Hex;
      n: number;
      /** The dead end, `y * n + x`. */
      cell: number;
      betWei: string;
      rewardBps: number;
      /** Decimal: floor(bet × rewardBps / 10000 / 10^12). */
      points: string;
      chestRule: number;
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
  | {
      type: 'block-scanned';
      blockNumber: string;
      blockHash: Hex;
      /** Timestamp of that block. Absent in logs written before the field existed. */
      timestampSec?: number;
    };

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
  'ticket-rebound',
  'chain-created',
  'move',
  'ended',
  'chest-awarded',
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

/** The events of line `index` (0-based) of a log. An empty line holds none. */
function decodeLine(line: string, index: number): StoreEvent[] {
  if (line === '') return [];
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`event log: line ${index + 1} is not valid JSON`);
  }
  const group =
    typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'group'
      ? (value as { events?: unknown }).events
      : [value];
  if (!Array.isArray(group) || group.length === 0 || !group.every(isEvent)) {
    throw new Error(`event log: line ${index + 1} is not a known event`);
  }
  return group;
}

function decode(text: string): StoreEvent[] {
  return text.split('\n').flatMap(decodeLine);
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

interface Scan {
  /** Bytes read so far. */
  totalBytes: number;
  /** Bytes read so far that belong to complete (newline-terminated) lines. */
  completeBytes: number;
}

/**
 * Yields the complete lines of `file`, in order, in batches of one read each. The file is never
 * held in memory as a whole. An unterminated tail is not yielded; `scan` tells how long it is.
 * A file that does not exist has no lines.
 */
async function* readLines(file: string, scan: Scan): AsyncGenerator<string[]> {
  let carry: Buffer[] = [];
  let carried = 0;
  try {
    const stream: AsyncIterable<Buffer> = createReadStream(file, { highWaterMark: 1 << 20 });
    for await (const chunk of stream) {
      const batch: string[] = [];
      let start = 0;
      for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
        const piece = chunk.subarray(start, end);
        batch.push((carry.length === 0 ? piece : Buffer.concat([...carry, piece])).toString('utf8'));
        carry = [];
        carried = 0;
        start = end + 1;
      }
      if (start < chunk.length) {
        carry.push(chunk.subarray(start));
        carried += chunk.length - start;
      }
      scan.totalBytes += chunk.length;
      scan.completeBytes = scan.totalBytes - carried;
      if (batch.length > 0) yield batch;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Rewrites `file` without the single-event lines for which `droppable` is true. The new file
 * replaces the old one in one rename, so a process that dies half way leaves the old log intact.
 */
async function compact(file: string, droppable: (event: StoreEvent) => boolean): Promise<void> {
  const temp = `${file}.compact`;
  const out = await open(temp, 'w');
  let dropped = 0;
  try {
    for await (const batch of readLines(file, { totalBytes: 0, completeBytes: 0 })) {
      const kept: string[] = [];
      for (const line of batch) {
        // Only ticket lines can be dropped; the rest is copied without being parsed again.
        if (line.includes('"ticket-')) {
          const events = decodeLine(line, 0);
          if (events.length === 1 && droppable(events[0])) {
            dropped += 1;
            continue;
          }
        }
        if (line !== '') kept.push(line);
      }
      if (kept.length > 0) await out.appendFile(`${kept.join('\n')}\n`, 'utf8');
    }
    await out.sync();
  } finally {
    await out.close();
  }
  if (dropped === 0) await rm(temp, { force: true });
  else await rename(temp, file);
}

export interface FileStoreOptions {
  /**
   * How many chain seconds a ticket that never created a game is kept after its expiry. When
   * set, the log is compacted as it is opened: a ticket (and its re-bindings) is removed once a
   * `block-scanned` marker of the log carries a block timestamp later than
   * `expirySec + ticketRetentionSec` and the log holds no `chain-created` for it. The marker
   * proves that the server read every block up to a time past the ticket's expiry without
   * finding its game, and `createGame` refuses a ticket after its expiry, so no game can ever
   * exist for it. Without a timestamped marker nothing is removed.
   */
  ticketRetentionSec?: number;
}

/**
 * Opens (creating if needed) the event log in `dir`. An unterminated last line, left by a
 * process that died mid-write, is cut off: it was never flushed, so nothing was answered from it.
 */
export async function openFileStore(dir: string, options: FileStoreOptions = {}): Promise<EventStore> {
  const key = path.resolve(dir);
  const file = path.join(dir, 'events.jsonl');
  const lockFile = path.join(dir, 'events.lock');

  // Within one process the pid in the lock file cannot tell two openers apart, so the logs
  // this process has open are tracked as well, across every loaded copy of this module.
  const opened = openLogs();
  if (opened.has(key)) throw new Error(`event log: ${key} is already open in this process`);
  opened.add(key);

  let handle: FileHandle;
  let locked = false;
  try {
    await mkdir(dir, { recursive: true });
    await acquireLock(lockFile);
    locked = true;
    // Left behind by a process that died while compacting; the log itself is still whole.
    await rm(`${file}.compact`, { force: true });

    // One pass over the file: every line is checked, and what compaction needs is collected.
    const created = new Set<Hex>();
    let scannedSec: number | null = null;
    let oldestExpirySec = Number.POSITIVE_INFINITY;
    const scan: Scan = { totalBytes: 0, completeBytes: 0 };
    let index = 0;
    for await (const batch of readLines(file, scan)) {
      for (const line of batch) {
        for (const event of decodeLine(line, index)) {
          if (event.type === 'chain-created') created.add(event.gameId);
          else if (event.type === 'ticket-issued') {
            oldestExpirySec = Math.min(oldestExpirySec, event.expirySec);
          } else if (event.type === 'block-scanned' && event.timestampSec !== undefined) {
            scannedSec = event.timestampSec;
          }
        }
        index += 1;
      }
    }
    if (scan.completeBytes !== scan.totalBytes) await truncate(file, scan.completeBytes);

    const retentionSec = options.ticketRetentionSec;
    const markerSec: number | null = scannedSec;
    if (retentionSec !== undefined && markerSec !== null && oldestExpirySec + retentionSec < markerSec) {
      await compact(
        file,
        (event) =>
          (event.type === 'ticket-issued' || event.type === 'ticket-rebound') &&
          !created.has(event.gameId) &&
          event.expirySec + retentionSec < markerSec,
      );
    }

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
    load() {
      // Queued behind the appends made so far, and read back from the file itself.
      const done = tail.then(async () => {
        const events: StoreEvent[] = [];
        let index = 0;
        for await (const batch of readLines(file, { totalBytes: 0, completeBytes: 0 })) {
          for (const line of batch) events.push(...decodeLine(line, index++));
        }
        return events;
      });
      tail = done.catch(() => undefined);
      return done;
    },
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
