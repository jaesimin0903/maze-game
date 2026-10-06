// Mazes and per-game randomness of `sim:human`, on a stream of their own.
//
// The certification streams A..E (streams.ts) each own the seed interval [base, base + 2^56)
// with base = the first eight bytes of sha256("maze-sim/stream/<name>/v1"). This command uses
// one more stream built the same way from the label "maze-sim/stream/human/v1"; its interval
// does not meet any of A..E (`humanStreamDisjoint`, checked by the tests), so no maze played
// here was played by the certification (stream B below 2^24) or by `sim:stats` (stream B from
// 2^32 upward). Game `i` of a `w × h` grid is seeded with
//
//   seed = base + ((w << 8 | h) << 40) + i      (mod 2^64)
//
// and drawn with the engine's fast generator, so the mazes follow the certified distribution.
// Inside a size the index space is split into disjoint ranges by purpose (training, evaluation,
// sessions), and `--seed s` moves every range by `s × SEED_SPAN`.
//
// The players' own randomness (noise in their choices, their personal traits) comes from
// separate generators keyed by purpose, never from the maze generator, so a player's choices
// cannot depend on the hidden part of the maze through the random stream.

import { fastRng, generateGridFromRng, type Rng } from '@maze/shared';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { STREAM_NAMES, STREAM_SPAN, streamBase } from '../streams';

export const HUMAN_STREAM_LABEL = 'maze-sim/stream/human/v1';
const MASK_64 = (1n << 64n) - 1n;
const INDEX_BITS = 40n;

/** Games per seed within a purpose. A seed's games must fit here. */
export const SEED_SPAN = 2 ** 28;
/** Seeds per purpose: each purpose owns 2^36 indexes of a size. */
export const SEED_LIMIT = 2 ** 36 / SEED_SPAN;

/** Index ranges of a size, by purpose. Training and evaluation never share a maze. */
export const PURPOSE_FIRST = {
  /** Rule search and the calibration of the thoughtful player's gut feel. */
  train: 0,
  /** Per-game evaluation of every model and of the selected rule. */
  eval: 2 ** 36,
  /** Learning careers and bankroll sessions. */
  sessions: 2 ** 37,
} as const;
export type Purpose = keyof typeof PURPOSE_FIRST;

function hashBase(label: string): bigint {
  return BigInt(`0x${bytesToHex(sha256(utf8ToBytes(label)).slice(0, 8))}`);
}

let base: bigint | null = null;

export function humanStreamBase(): bigint {
  base ??= hashBase(HUMAN_STREAM_LABEL);
  return base;
}

export function humanStreamBaseHex(): string {
  return `0x${humanStreamBase().toString(16).padStart(16, '0')}`;
}

/** True when the seed interval of this stream meets none of the certification streams A..E. */
export function humanStreamDisjoint(): boolean {
  const own = humanStreamBase();
  return STREAM_NAMES.every((name) => {
    const other = streamBase(name);
    return ((other - own) & MASK_64) >= STREAM_SPAN && ((own - other) & MASK_64) >= STREAM_SPAN;
  });
}

/** First game index of a purpose for `seed`. */
export function firstIndex(purpose: Purpose, seed: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed >= SEED_LIMIT) throw new RangeError(`seed must be an integer in 0 .. ${SEED_LIMIT - 1}, got ${seed}`);
  return PURPOSE_FIRST[purpose] + seed * SEED_SPAN;
}

/** The 64-bit seed of maze `index` of a `w × h` grid on this stream. */
export function humanGameSeed(w: number, h: number, index: number): bigint {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 40) throw new RangeError(`game index must be an integer in 0 .. 2^40 - 1, got ${index}`);
  const tag = BigInt((w << 8) | h);
  return (humanStreamBase() + (tag << INDEX_BITS) + BigInt(index)) & MASK_64;
}

/** Yields maze `index` of one grid size. */
export class HumanFeed {
  open: Uint8Array = new Uint8Array(0);
  /** The maze generator after the maze was drawn. Players never draw from it. */
  rng: Rng = fastRng(0n);

  constructor(
    readonly w: number,
    readonly h: number,
  ) {}

  load(index: number): void {
    const rng = fastRng(humanGameSeed(this.w, this.h, index));
    this.open = generateGridFromRng(rng, this.w, this.h).open;
    this.rng = rng;
  }
}

/** Generators for the player's own randomness, keyed by purpose and an index (game, session, career). */
export class NoiseSource {
  private readonly base: bigint;

  constructor(key: string) {
    this.base = hashBase(`maze-sim/human/noise/v1/${key}`);
  }

  at(index: number): Rng {
    return fastRng((this.base + BigInt(index)) & MASK_64);
  }
}

/** A uniform draw in [0, 1). */
export function uniform(rng: Rng): number {
  return rng.nextU32() / 0x1_0000_0000;
}

/** A standard normal draw (Box–Muller; the second value of the pair is not used, so every call takes two words). */
export function gaussian(rng: Rng): number {
  const u = (rng.nextU32() + 1) / 0x1_0000_0001;
  const v = rng.nextU32() / 0x1_0000_0000;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
