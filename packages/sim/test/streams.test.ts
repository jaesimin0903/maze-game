// Random streams: A calibrates, B certifies, C trains, D pairs adversaries, E feeds the
// trajectory cache. They must never share a game.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateGridFromRng, generateMaze, seedRng, type Hex } from '@maze/shared';
import vectors from '../../shared/test/vectors/maze-v1.json';
import { MazeFeed } from '../src/engine';
import {
  allStreamsDisjoint,
  GAME_INDEX_LIMIT,
  gameFinalSeed,
  gameSeed,
  ownerOfSeed,
  sizeBase,
  STREAM_NAMES,
  STREAM_SPAN,
  streamBase,
  streamIdentifiers,
  streamsAreDisjoint,
} from '../src/streams';

const SIZES: [number, number][] = [
  [5, 5],
  [7, 7],
  [10, 10],
  [3, 3],
  [5, 4],
  [255, 255],
];

function hex(open: Uint8Array): string {
  return `0x${Array.from(open, (mask) => mask.toString(16).padStart(2, '0')).join('')}`;
}

describe('AC-T3 stream seeds', () => {
  it('each base seed is the first eight bytes of sha256("maze-sim/stream/<name>/v1")', () => {
    for (const name of STREAM_NAMES) {
      const digest = createHash('sha256').update(`maze-sim/stream/${name}/v1`, 'utf8').digest();
      expect(streamBase(name)).toBe(digest.readBigUInt64BE(0));
      expect(streamIdentifiers()[name]).toBe(`0x${digest.subarray(0, 8).toString('hex')}`);
    }
  });

  it('AC-T3 the five streams own pairwise disjoint seed intervals', () => {
    // Establishes: no game of one stream can have the seed of a game of another stream, for
    // any grid size up to 255×255 and any game index below 2^40.
    expect(allStreamsDisjoint()).toBe(true);
    for (const a of STREAM_NAMES) {
      for (const b of STREAM_NAMES) expect(streamsAreDisjoint(a, b)).toBe(a !== b);
    }
    // The interval of a stream covers every (size, index) it can be asked for.
    expect((255n << 8n) | 255n).toBeLessThan(1n << 16n);
    expect(BigInt(GAME_INDEX_LIMIT)).toBe(1n << 40n);
    expect(STREAM_SPAN).toBe(1n << 56n);
  });

  it('AC-T3 every seed a stream hands out is owned by that stream alone', () => {
    const indices = [0, 1, 2_999_999, 10_999_999, 1_000_000_000, GAME_INDEX_LIMIT - 1];
    const seen = new Map<bigint, string>();
    for (const name of STREAM_NAMES) {
      for (const [w, h] of SIZES) {
        for (const index of indices) {
          const seed = gameSeed(name, w, h, index);
          expect(ownerOfSeed(seed)).toBe(name);
          const id = `${name}/${w}x${h}/${index}`;
          expect(seen.has(seed), `${id} collides with ${seen.get(seed)}`).toBe(false);
          seen.set(seed, id);
        }
      }
    }
  });

  it('game seeds are consecutive within a size and reject indices outside 0 .. 2^40 - 1', () => {
    expect(gameSeed('A', 10, 10, 7) - gameSeed('A', 10, 10, 0)).toBe(7n);
    expect(gameSeed('A', 10, 10, 0)).toBe(sizeBase('A', 10, 10));
    expect(() => gameSeed('A', 10, 10, -1)).toThrow(RangeError);
    expect(() => gameSeed('A', 10, 10, GAME_INDEX_LIMIT)).toThrow(RangeError);
    expect(() => gameSeed('A', 1, 10, 0)).toThrow(RangeError);
  });

  it('game i of a stream is the same maze whenever and in whatever order it is drawn, and differs across streams', () => {
    // Establishes: the randomness of a game depends on (stream, size, i) only.
    const feed = new MazeFeed({ kind: 'rng', mode: 'fast', stream: 'B' }, 7, 7);
    feed.load(123);
    const first = hex(feed.open);
    feed.load(5);
    feed.load(123);
    expect(hex(feed.open)).toBe(first);
    const other = new MazeFeed({ kind: 'rng', mode: 'fast', stream: 'A' }, 7, 7);
    let different = 0;
    for (let i = 0; i < 50; i++) {
      feed.load(i);
      other.load(i);
      if (hex(feed.open) !== hex(other.open)) different += 1;
    }
    expect(different).toBe(50);
  });
});

describe('AC-M1 --rng=seed', () => {
  it('AC-M1 the simulator\'s seed-mode maze path reproduces every fixed vector', () => {
    // Establishes: fed the production stream, the simulator builds exactly the maze a real game gets.
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(9);
    for (const vector of vectors.vectors) {
      const maze = generateGridFromRng(seedRng(vector.finalSeed as Hex), vector.n, vector.n);
      expect(hex(maze.open)).toBe(vector.open);
    }
  });

  it('AC-M1 seed mode draws game i from seedRng(sha256(tag ‖ game seed))', () => {
    const feed = new MazeFeed({ kind: 'rng', mode: 'seed', stream: 'A' }, 5, 5);
    for (const index of [0, 1, 99]) {
      const finalSeed = gameFinalSeed('A', 5, 5, index);
      const tag = Buffer.from('maze-sim/final-seed/v1', 'utf8');
      const seed = Buffer.alloc(8);
      seed.writeBigUInt64BE(gameSeed('A', 5, 5, index));
      expect(finalSeed).toBe(`0x${createHash('sha256').update(tag).update(seed).digest('hex')}`);
      feed.load(index);
      expect(hex(feed.open)).toBe(hex(generateMaze(finalSeed, 5).open));
    }
  });
});
