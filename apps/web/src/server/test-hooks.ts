// Test-only surface (plan §7.9, §9.1). Nothing here is reachable unless the server was booted
// with test hooks on (`MAZE_ALLOW_TEST_HOOKS=1` and chain id 31337): the container passes the
// seed secret to the game service and the snapshot routes answer 404 otherwise.

import { createHash } from 'node:crypto';
import type { Hex, UiSnapshot, UiSnapshotInput } from '@maze/shared';
import { ApiError } from './errors';

/** The 14 ASCII bytes `6d 61 7a 65 2d 74 65 73 74 2d 73 65 65 64`. */
export const TEST_SEED_TAG = 'maze-test-seed';

/**
 * The server seed of a game while the seed hook is on:
 *
 *   serverSeed = sha256( TAG ‖ SECRET ‖ GAME_ID )
 *
 *   TAG      the 14 ASCII bytes of "maze-test-seed"
 *   SECRET   the UTF-8 bytes of `MAZE_TEST_SEED_SECRET`, exactly as given
 *            (no length prefix, no terminator, no trimming)
 *   GAME_ID  the 32 raw bytes of the game id (not its hex text)
 *
 * The three parts are concatenated without separators and the 32-byte digest is returned as
 * 0x-prefixed lowercase hex. The game id itself stays random, so a scenario reads it from the
 * ticket and can rebuild the maze offline: `deriveFinalSeed({ serverSeed, clientSeed, gameId })`
 * followed by `generateMaze(finalSeed, n)`.
 */
export function testServerSeed(secret: string, gameId: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(gameId)) {
    throw new TypeError('testServerSeed: gameId must be 32 bytes of 0x-prefixed hex');
  }
  const digest = createHash('sha256')
    .update(TEST_SEED_TAG, 'utf8')
    .update(secret, 'utf8')
    .update(Buffer.from(gameId.slice(2), 'hex'))
    .digest('hex');
  return `0x${digest}`;
}

const MAX_ITEMS = 2000;

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

/** Validates the body of `POST /api/test/ui-snapshot` and copies exactly the declared fields. */
export function parseUiSnapshot(body: Record<string, unknown>): UiSnapshotInput {
  const { url, chainNowSec, items } = body;
  if (typeof url !== 'string' || typeof chainNowSec !== 'number' || !Number.isFinite(chainNowSec)) {
    throw new ApiError('BAD_REQUEST');
  }
  if (typeof items !== 'object' || items === null || Array.isArray(items)) {
    throw new ApiError('BAD_REQUEST');
  }
  const entries = Object.entries(items);
  if (entries.length > MAX_ITEMS) throw new ApiError('BAD_REQUEST');
  // `Object.fromEntries` defines own properties, whatever the key is called.
  const copy: UiSnapshotInput['items'] = Object.fromEntries(
    entries.map(([testId, item]) => {
      const { text, attrs } = (item ?? {}) as { text?: unknown; attrs?: unknown };
      if (typeof text !== 'string' || !isStringRecord(attrs)) throw new ApiError('BAD_REQUEST');
      return [testId, { text, attrs: Object.fromEntries(Object.entries(attrs)) }];
    }),
  );
  return { url, chainNowSec, items: copy };
}

/** The latest DOM snapshot posted by the page's `TestBeacon`, kept in memory only. */
export class UiSnapshots {
  private seq = 0;
  private latest: UiSnapshot | null = null;

  put(input: UiSnapshotInput): void {
    this.seq += 1;
    this.latest = { seq: this.seq, ...input };
  }

  get(): UiSnapshot | null {
    return this.latest;
  }
}
