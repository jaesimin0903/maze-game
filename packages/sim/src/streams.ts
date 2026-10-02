// Random streams of the simulator (plan §9.3).
//
// Every stream has a 64-bit base seed: the first eight bytes of
// sha256("maze-sim/stream/<name>/v1"). Game `i` of a `w × h` grid on a stream is seeded by
//
//   seed = base + ((w << 8 | h) << 40) + i      (mod 2^64),   0 <= i < 2^40
//
// so the randomness of a game depends on (stream, size, i) and on nothing else. A stream
// therefore owns the half-open interval [base, base + 2^56) of the 64-bit seed circle, and two
// streams are disjoint exactly when their intervals do not overlap (`streamsAreDisjoint`).
// `fastRng` expands a seed with splitmix64, which is a bijection, so distinct seeds are
// distinct generator states.

import { fastRng, seedRng, type Hex, type Rng } from '@maze/shared';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const STREAM_NAMES = ['A', 'B', 'C', 'D', 'E'] as const;
export type StreamName = (typeof STREAM_NAMES)[number];

/** What each stream is for. A calibrates, B certifies, C trains, D pairs adversaries, E feeds the trajectory cache. */
export const STREAM_PURPOSE: Record<StreamName, string> = {
  A: 'calibration',
  B: 'certification (fixed gates 1 and 2)',
  C: 'training (value tables, region table, param-search)',
  D: 'paired comparison of the adversaries against value-lsm',
  E: 'trajectory cache for coarse ranking',
};

const MASK_64 = (1n << 64n) - 1n;
/** Games per (stream, size). */
export const GAME_INDEX_LIMIT = 2 ** 40;
const GAME_INDEX_BITS = 40n;
/** Width of the seed interval a stream owns: 16 bits of size tag above 40 bits of game index. */
export const STREAM_SPAN = 1n << 56n;

export function streamLabel(name: StreamName): string {
  return `maze-sim/stream/${name}/v1`;
}

/** First eight bytes (big-endian) of sha256 of the stream label. */
export function streamBase(name: StreamName): bigint {
  const digest = sha256(utf8ToBytes(streamLabel(name)));
  return BigInt(`0x${bytesToHex(digest.slice(0, 8))}`);
}

export function streamBaseHex(name: StreamName): string {
  return `0x${streamBase(name).toString(16).padStart(16, '0')}`;
}

/** The identifiers written into `certify.json` and into a calibrated table. */
export function streamIdentifiers(): Record<StreamName, string> {
  return {
    A: streamBaseHex('A'),
    B: streamBaseHex('B'),
    C: streamBaseHex('C'),
    D: streamBaseHex('D'),
    E: streamBaseHex('E'),
  };
}

function sizeTag(w: number, h: number): bigint {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w > 255 || h > 255) {
    throw new RangeError(`grid size must be integers in 2 .. 255, got ${w}x${h}`);
  }
  return BigInt((w << 8) | h);
}

/** Seed of game 0 of a `w × h` grid on a stream; game `i` is this plus `i`. */
export function sizeBase(name: StreamName, w: number, h: number): bigint {
  return (streamBase(name) + (sizeTag(w, h) << GAME_INDEX_BITS)) & MASK_64;
}

export function gameSeed(name: StreamName, w: number, h: number, index: number): bigint {
  if (!Number.isInteger(index) || index < 0 || index >= GAME_INDEX_LIMIT) {
    throw new RangeError(`game index must be an integer in 0 .. 2^40 - 1, got ${index}`);
  }
  return (sizeBase(name, w, h) + BigInt(index)) & MASK_64;
}

/** True when the seed intervals of the two streams do not intersect on the 64-bit circle. */
export function streamsAreDisjoint(a: StreamName, b: StreamName): boolean {
  if (a === b) return false;
  const forward = (streamBase(b) - streamBase(a)) & MASK_64;
  const backward = (streamBase(a) - streamBase(b)) & MASK_64;
  return forward >= STREAM_SPAN && backward >= STREAM_SPAN;
}

export function allStreamsDisjoint(): boolean {
  for (let i = 0; i < STREAM_NAMES.length; i++) {
    for (let j = i + 1; j < STREAM_NAMES.length; j++) {
      if (!streamsAreDisjoint(STREAM_NAMES[i], STREAM_NAMES[j])) return false;
    }
  }
  return true;
}

/** Which stream owns a seed, or `null`. Used by the disjointness test. */
export function ownerOfSeed(seed: bigint): StreamName | null {
  for (const name of STREAM_NAMES) {
    if (((seed - streamBase(name)) & MASK_64) < STREAM_SPAN) return name;
  }
  return null;
}

/**
 * `--rng=seed` mode: the production maze stream (`seedRng`) driven by a per-game `finalSeed`,
 * `sha256("maze-sim/final-seed/v1" ‖ uint64be(gameSeed))`.
 */
export function gameFinalSeed(name: StreamName, w: number, h: number, index: number): Hex {
  const tag = utf8ToBytes('maze-sim/final-seed/v1');
  const input = new Uint8Array(tag.length + 8);
  input.set(tag, 0);
  new DataView(input.buffer).setBigUint64(tag.length, gameSeed(name, w, h, index), false);
  return `0x${bytesToHex(sha256(input))}`;
}

export type RngMode = 'fast' | 'seed';

/**
 * The generator of game `index`. `base` is `sizeBase(name, w, h)`, passed in so that a loop
 * over games does not redo the per-size arithmetic.
 */
export function gameRng(mode: RngMode, name: StreamName, w: number, h: number, base: bigint, index: number): Rng {
  if (mode === 'fast') return fastRng((base + BigInt(index)) & MASK_64);
  return seedRng(gameFinalSeed(name, w, h, index));
}
