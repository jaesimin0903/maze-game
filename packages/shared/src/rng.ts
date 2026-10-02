// Deterministic random streams (plan §3.4 step 1, §7.1).
//
// `seedRng` is the production stream: every maze of a real game comes from it.
// `fastRng` is for the simulator only; it feeds the same generator (`generateGridFromRng`).

import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { Hex } from './types';

export interface Rng {
  /** Next unsigned 32-bit integer, `0 .. 2^32 - 1`. */
  nextU32(): number;
  /**
   * Uniform integer in `0 .. m - 1` by rejection sampling: values `>= floor(2^32 / m) * m`
   * are discarded and the next accepted value is reduced modulo `m`.
   */
  nextBelow(m: number): number;
}

const TWO_32 = 0x1_0000_0000;
const WORDS_PER_BLOCK = 8;

/** `floor(2^32 / m) * m`: values at or above it are rejected by `nextBelow(m)`. */
function rejectionLimit(m: number): number {
  if (!Number.isInteger(m) || m < 1 || m > TWO_32) {
    throw new RangeError(`nextBelow: m must be an integer in 1 .. 2^32, got ${m}`);
  }
  return Math.floor(TWO_32 / m) * m;
}

// Both sources are classes with their own `nextBelow` loop rather than closures sharing one
// helper: the maze generator then stays fast when both kinds pass through it in one process.

class SeedRng implements Rng {
  /** `finalSeed ‖ uint32be(counter)` */
  private readonly input = new Uint8Array(36);
  private readonly inputView = new DataView(this.input.buffer);
  private readonly words = new Uint32Array(WORDS_PER_BLOCK);
  private counter = 0;
  private used = WORDS_PER_BLOCK;

  constructor(seed: Uint8Array) {
    this.input.set(seed, 0);
  }

  nextU32(): number {
    if (this.used === WORDS_PER_BLOCK) {
      if (this.counter >= TWO_32) throw new RangeError('seedRng: the stream is exhausted');
      this.inputView.setUint32(32, this.counter, false);
      const block = sha256(this.input);
      const blockView = new DataView(block.buffer, block.byteOffset, block.byteLength);
      for (let j = 0; j < WORDS_PER_BLOCK; j++) this.words[j] = blockView.getUint32(4 * j, false);
      this.counter += 1;
      this.used = 0;
    }
    return this.words[this.used++];
  }

  nextBelow(m: number): number {
    const limit = rejectionLimit(m);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % m;
    }
  }
}

/**
 * The maze stream: `block_i = sha256(finalSeed ‖ uint32be(i))` for `i = 0, 1, 2, ...`,
 * each block read as eight big-endian `uint32` in order.
 */
export function seedRng(finalSeed: Hex): Rng {
  if (!/^0x[0-9a-fA-F]{64}$/.test(finalSeed)) {
    throw new TypeError('seedRng: finalSeed must be 32 bytes of 0x-prefixed hex');
  }
  return new SeedRng(hexToBytes(finalSeed.slice(2)));
}

const MASK_64 = 0xffff_ffff_ffff_ffffn;

/** xoshiro128**; the four state words are kept as signed 32-bit integers. */
class FastRng implements Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(s0: number, s1: number, s2: number, s3: number) {
    this.s0 = s0;
    this.s1 = s1;
    this.s2 = s2;
    this.s3 = s3;
  }

  nextU32(): number {
    const scrambled = Math.imul(this.s1, 5);
    const result = Math.imul((scrambled << 7) | (scrambled >>> 25), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = (this.s3 << 11) | (this.s3 >>> 21);
    return result;
  }

  nextBelow(m: number): number {
    const limit = rejectionLimit(m);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % m;
    }
  }
}

/**
 * Simulator-only generator: xoshiro128** whose 128-bit state is the first two outputs of
 * splitmix64 started at `seed` (taken modulo 2^64). Distinct seeds give unrelated streams.
 * Never used for a real game.
 */
export function fastRng(seed: bigint): Rng {
  let x = BigInt.asUintN(64, seed);
  const splitmix64 = (): bigint => {
    x = (x + 0x9e37_79b9_7f4a_7c15n) & MASK_64;
    let z = x;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK_64;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK_64;
    return z ^ (z >> 31n);
  };
  const a = splitmix64();
  const b = splitmix64();
  return new FastRng(
    Number(a & 0xffff_ffffn) | 0,
    Number(a >> 32n) | 0,
    Number(b & 0xffff_ffffn) | 0,
    Number(b >> 32n) | 0,
  );
}
