// The client seed before the bet: the reroll draws a seed that picks a start side, and the seed
// dresses the console screen (start side, theme, torches, a short code).

import { describe, expect, it } from 'vitest';
import { markStartSide, startSideOf, type Hex } from '@maze/shared';
import { THEMES, dungeonOf } from '../../src/client/dungeon';
import { isHex32, randomStartSeed } from '../../src/client/seed';

/** A seed with `bytes` at the front and 0x11 after them. */
function seedWith(bytes: number[]): Hex {
  const all = [...bytes, ...Array<number>(32 - bytes.length).fill(0x11)];
  return `0x${all.map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

describe('randomStartSeed', () => {
  it('is 28 random bytes followed by the mark of the side asked for', () => {
    for (const side of ['E', 'S'] as const) {
      const seeds = Array.from({ length: 16 }, () => randomStartSeed(side));
      for (const seed of seeds) {
        expect(isHex32(seed)).toBe(true);
        expect(seed).toMatch(/^0x[0-9a-f]{64}$/);
        expect(seed.slice(-8)).toBe(side === 'E' ? '4d5a3e45' : '4d5a3e53');
        expect(startSideOf(seed)).toBe(side);
      }
      expect(new Set(seeds).size).toBe(seeds.length);
    }
  });

  it('without a side picks one at random, so both come up', () => {
    const sides = Array.from({ length: 64 }, () => startSideOf(randomStartSeed()));
    expect(sides.every((side) => side === 'E' || side === 'S')).toBe(true);
    expect(new Set(sides)).toEqual(new Set(['E', 'S']));
  });
});

describe('dungeonOf', () => {
  it('reads the start side from the mark, and none from a seed without one', () => {
    const base = seedWith([0x3f, 0x9a, 0x02, 0x05, 0x10, 0x80, 0xff]);
    expect(dungeonOf(markStartSide(base, 'E')).side).toBe('E');
    expect(dungeonOf(markStartSide(base, 'S')).side).toBe('S');
    expect(dungeonOf(base).side).toBeNull();
    // "MZ>X" is no mark.
    expect(dungeonOf(`${base.slice(0, 58)}4d5a3e58` as Hex).side).toBeNull();
  });

  it('names the seed by its first four hex digits', () => {
    expect(dungeonOf(seedWith([0x3f, 0x9a])).code).toBe('3F9A');
    expect(dungeonOf(seedWith([0x00, 0x0b])).code).toBe('000B');
  });

  it('picks the theme from the third byte', () => {
    for (let k = 0; k < 8; k++) {
      expect(dungeonOf(seedWith([0, 0, k])).theme).toBe(THEMES[k % THEMES.length]);
    }
    expect(THEMES).toEqual(['stone', 'moss', 'crypt', 'ember']);
  });

  it('hangs two to four torches, alternating sides, off the top row and the exit corner', () => {
    for (let b3 = 0; b3 < 256; b3 += 7) {
      for (const height of [0x00, 0x80, 0xff]) {
        const { torches } = dungeonOf(seedWith([0, 0, 0, b3, height, 255 - height, height, 0x40]));
        expect(torches).toHaveLength(2 + (b3 % 3));
        expect(torches[0].side).toBe(b3 & 0x80 ? 'L' : 'R');
        torches.forEach((torch, k) => {
          if (k > 0) expect(torch.side).not.toBe(torches[k - 1].side);
          expect(torch.at).toBeGreaterThanOrEqual(0.15);
          expect(torch.at).toBeLessThanOrEqual(0.7 + 1e-9);
        });
      }
    }
    expect(dungeonOf(seedWith([0, 0, 0, 0, 0x00])).torches[0].at).toBeCloseTo(0.15, 10);
    expect(dungeonOf(seedWith([0, 0, 0, 0, 0xff])).torches[0].at).toBeCloseTo(0.7, 10);
  });

  it('dresses a seed the same whichever side it picks: the look tells nothing about the maze', () => {
    const base = seedWith([0x3f, 0x9a, 0x02, 0x05, 0x10, 0x80, 0xff]);
    const east = dungeonOf(markStartSide(base, 'E'));
    const south = dungeonOf(markStartSide(base, 'S'));
    expect({ ...east, side: null }).toEqual({ ...south, side: null });
  });
});
