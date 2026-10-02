import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fastRng, seedRng, type Hex } from '../src';

const SEED: Hex = `0x${'ab'.repeat(32)}`;

/** The maze stream written straight from the plan (§3.4 step 1) with node:crypto. */
function referenceWords(seed: Hex, count: number): number[] {
  const words: number[] = [];
  for (let i = 0; words.length < count; i++) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(i);
    const block = createHash('sha256')
      .update(Buffer.from(seed.slice(2), 'hex'))
      .update(counter)
      .digest();
    for (let j = 0; j < 8; j++) words.push(block.readUInt32BE(4 * j));
  }
  return words.slice(0, count);
}

const MASK_64 = (1n << 64n) - 1n;
const MASK_32 = (1n << 32n) - 1n;

function referenceSplitmix64(seed: bigint): () => bigint {
  let x = seed & MASK_64;
  return () => {
    x = (x + 0x9e3779b97f4a7c15n) & MASK_64;
    let z = x;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
    return z ^ (z >> 31n);
  };
}

/** xoshiro128** in BigInt arithmetic, so that no 32-bit overflow trick is shared with the module. */
function referenceFast(seed: bigint, count: number): number[] {
  const next64 = referenceSplitmix64(seed);
  const a = next64();
  const b = next64();
  const s = [a & MASK_32, a >> 32n, b & MASK_32, b >> 32n];
  const rotl = (v: bigint, k: bigint): bigint => ((v << k) | (v >> (32n - k))) & MASK_32;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Number((rotl((s[1] * 5n) & MASK_32, 7n) * 9n) & MASK_32));
    const t = (s[1] << 9n) & MASK_32;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11n);
  }
  return out;
}

describe('seedRng', () => {
  it('AC-M1 block_i = sha256(finalSeed ‖ uint32be(i)), eight big-endian uint32 per block', () => {
    const rng = seedRng(SEED);
    const expected = referenceWords(SEED, 200);
    expect(expected.map(() => rng.nextU32())).toEqual(expected);
  });

  it('AC-M1 the stream depends only on the seed bytes, not on the hex case', () => {
    const lower = seedRng(SEED);
    const upper = seedRng(`0x${'AB'.repeat(32)}`);
    for (let i = 0; i < 40; i++) expect(upper.nextU32()).toBe(lower.nextU32());
  });

  it('every value is an unsigned 32-bit integer', () => {
    const rng = seedRng(SEED);
    for (let i = 0; i < 2000; i++) {
      const value = rng.nextU32();
      expect(Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff).toBe(true);
    }
  });

  it('rejects a seed that is not 32 bytes of 0x-prefixed hex', () => {
    for (const bad of ['', '0x', `0x${'ab'.repeat(31)}`, `0x${'ab'.repeat(33)}`, 'ab'.repeat(32), `0x${'zz'.repeat(32)}`]) {
      expect(() => seedRng(bad as Hex)).toThrow(TypeError);
    }
  });

  it('nextBelow discards values >= floor(2^32 / m) * m and reduces the rest modulo m', () => {
    const words = referenceWords(SEED, 4096);
    for (const m of [1, 2, 3, 4, 5, 7, 10, 1000, 2 ** 31 + 1, 2 ** 32 - 1, 2 ** 32]) {
      const limit = Math.floor(2 ** 32 / m) * m;
      const expected = words.filter((word) => word < limit).map((word) => word % m);
      const rng = seedRng(SEED);
      expect(expected.map(() => rng.nextBelow(m))).toEqual(expected);
    }
    // m = 2^31 + 1 rejects close to half of the stream, so the rejection branch really ran.
    const half = words.filter((word) => word < 2 ** 31 + 1).length;
    expect(half).toBeGreaterThan(1800);
    expect(half).toBeLessThan(2300);
  });

  it('nextBelow(2) and nextBelow(4) never discard a value (2^32 is a multiple of both)', () => {
    const words = referenceWords(SEED, 64);
    const two = seedRng(SEED);
    const four = seedRng(SEED);
    expect(words.map(() => two.nextBelow(2))).toEqual(words.map((word) => word % 2));
    expect(words.map(() => four.nextBelow(4))).toEqual(words.map((word) => word % 4));
  });
});

describe('fastRng', () => {
  it('the reference splitmix64 reproduces the published outputs for seed 0', () => {
    const next64 = referenceSplitmix64(0n);
    expect(next64()).toBe(0xe220a8397b1dcdafn);
    expect(next64()).toBe(0x6e789e6aa1b965f4n);
  });

  it('is xoshiro128** seeded with two splitmix64 outputs', () => {
    for (const seed of [0n, 1n, 42n, 0xdead_beef_cafe_f00dn, MASK_64]) {
      const rng = fastRng(seed);
      const expected = referenceFast(seed, 1000);
      expect(expected.map(() => rng.nextU32())).toEqual(expected);
    }
  });

  it('takes the seed modulo 2^64', () => {
    const head = (seed: bigint): number[] => {
      const rng = fastRng(seed);
      return Array.from({ length: 8 }, () => rng.nextU32());
    };
    expect(head((1n << 64n) + 5n)).toEqual(head(5n));
    expect(head(-1n)).toEqual(head(MASK_64));
    expect(head(5n)).not.toEqual(head(6n));
  });

  it('nextBelow uses the same rejection rule as the production stream', () => {
    for (const m of [2, 3, 4, 10, 2 ** 31 + 1]) {
      const limit = Math.floor(2 ** 32 / m) * m;
      const expected = referenceFast(7n, 4096)
        .filter((word) => word < limit)
        .map((word) => word % m);
      const rng = fastRng(7n);
      expect(expected.map(() => rng.nextBelow(m))).toEqual(expected);
    }
  });
});

describe('nextBelow argument', () => {
  it.each([
    ['seedRng', () => seedRng(SEED)],
    ['fastRng', () => fastRng(1n)],
  ])('%s: m must be an integer in 1 .. 2^32', (_name, make) => {
    for (const bad of [0, -1, 1.5, 2 ** 32 + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => make().nextBelow(bad)).toThrow(RangeError);
    }
    expect(make().nextBelow(1)).toBe(0);
    const value = make().nextBelow(2 ** 32);
    expect(value).toBe(make().nextU32());
  });
});
