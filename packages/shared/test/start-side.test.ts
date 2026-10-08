// The start side a client seed may pick (deriveFinalSeed): a seed ending in ASCII "MZ>E" or
// "MZ>S" makes the start cell open east or south; every other seed gives the old final seed.

import { createHash } from 'node:crypto';
import { keccak256, stringToBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  SEED_TAG,
  START_TAG,
  deriveFinalSeed,
  generateMaze,
  markStartSide,
  startSideOf,
  startSideOfFinalSeed,
  type Hex,
  type Maze,
  type StartSide,
} from '../src';

const serverSeed: Hex = `0x${'11'.repeat(32)}`;
const gameId: Hex = `0x${'33'.repeat(32)}`;

const bytes = (hex: Hex): Buffer => Buffer.from(hex.slice(2), 'hex');
const sha = (data: Buffer): Hex => `0x${createHash('sha256').update(data).digest('hex')}`;
const label = (text: string): Hex => sha(Buffer.from(text, 'utf8'));
const uint32be = (k: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(k);
  return out;
};

/** The side the start cell of `maze` opens to, read from its walls. */
function opensTo(maze: Maze): StartSide {
  expect([2, 4]).toContain(maze.open[0]);
  return maze.open[0] === 4 ? 'S' : 'E';
}

/**
 * The rule written out again from its description, independently of `deriveFinalSeed` and of
 * `startSideOfFinalSeed`: the side comes from the maze actually generated.
 */
function reference(p: { serverSeed: Hex; clientSeed: Hex; gameId: Hex }): { finalSeed: Hex; k: number } {
  const mixed = sha(Buffer.concat([bytes(SEED_TAG), bytes(p.serverSeed), bytes(p.clientSeed), bytes(p.gameId)]));
  const tail = bytes(p.clientSeed).subarray(28).toString('latin1');
  const side = tail === 'MZ>E' ? 'E' : tail === 'MZ>S' ? 'S' : null;
  if (side === null) return { finalSeed: mixed, k: 0 };
  let finalSeed = mixed;
  let k = 0;
  while (opensTo(generateMaze(finalSeed, 5)) !== side) {
    k += 1;
    finalSeed = sha(Buffer.concat([bytes(START_TAG), bytes(mixed), uint32be(k)]));
  }
  return { finalSeed, k };
}

describe('START_TAG', () => {
  it('is keccak256("MazeBet.start.v1")', () => {
    expect(START_TAG).toBe(keccak256(stringToBytes('MazeBet.start.v1')));
    expect(START_TAG).toBe('0xe8fcd6f78730941a3f262ddb6999fc4cba7c98709d8f7717547f9c3adc6b5b35');
  });
});

describe('startSideOf and markStartSide', () => {
  it('a mark round-trips, keeps the first 28 bytes and takes the last four', () => {
    for (let i = 0; i < 16; i++) {
      const seed = label(`round trip ${i}`);
      for (const side of ['E', 'S'] as const) {
        const marked = markStartSide(seed, side);
        expect(startSideOf(marked)).toBe(side);
        expect(marked.slice(0, 58)).toBe(seed.slice(0, 58));
        expect(bytes(marked).subarray(28).toString('latin1')).toBe(`MZ>${side}`);
        // Marking again, for either side, only changes the last byte.
        expect(markStartSide(marked, side)).toBe(marked);
        expect(startSideOf(markStartSide(marked, side === 'E' ? 'S' : 'E'))).toBe(side === 'E' ? 'S' : 'E');
      }
    }
    // Upper-case hex reads the same; the marked seed comes back in lower case.
    const upper = `0x${label('upper').slice(2).toUpperCase()}` as Hex;
    expect(markStartSide(upper, 'E')).toBe(markStartSide(label('upper'), 'E'));
    expect(startSideOf(`0x${markStartSide(upper, 'S').slice(2).toUpperCase()}` as Hex)).toBe('S');
  });

  it('a seed without the full mark picks nothing', () => {
    const head = label('no mark').slice(0, 58);
    const ending = (ascii: string): Hex => `${head}${Buffer.from(ascii, 'latin1').toString('hex')}` as Hex;
    for (const tail of ['MZ>X', 'MZ>e', 'MZ>s', 'mz>E', 'MZ<E', 'MZ E', 'NZ>E', 'MY>S', 'MZ>\u0000']) {
      expect(startSideOf(ending(tail)), tail).toBeNull();
    }
    expect(startSideOf(ending('MZ>E'))).toBe('E');
    expect(startSideOf(ending('MZ>S'))).toBe('S');
    expect(startSideOf(`0x${'00'.repeat(32)}`)).toBeNull();
    expect(startSideOf(`0x${'ff'.repeat(32)}`)).toBeNull();
  });

  it('refuses what is not 32 bytes of hex', () => {
    expect(() => startSideOf('0x1234' as Hex)).toThrow(TypeError);
    expect(() => markStartSide('0x1234' as Hex, 'E')).toThrow(TypeError);
  });
});

describe('startSideOfFinalSeed', () => {
  it('is the side the start of the generated maze opens to, for every size', () => {
    for (let i = 0; i < 40; i++) {
      const seed = label(`final ${i}`);
      const side = startSideOfFinalSeed(seed);
      for (const n of [2, 3, 5, 7, 10, 16]) expect(opensTo(generateMaze(seed, n)), `${i} n=${n}`).toBe(side);
    }
  });
});

describe('deriveFinalSeed with a start side', () => {
  it('a seed without a mark gives exactly the old formula', () => {
    for (let i = 0; i < 24; i++) {
      const clientSeed = label(`unmarked ${i}`);
      expect(startSideOf(clientSeed)).toBeNull();
      const old = sha(Buffer.concat([bytes(SEED_TAG), bytes(serverSeed), bytes(clientSeed), bytes(gameId)]));
      expect(deriveFinalSeed({ serverSeed, clientSeed, gameId })).toBe(old);
    }
  });

  it('a marked seed gives a maze that opens to the picked side, for every size', () => {
    for (let i = 0; i < 40; i++) {
      for (const side of ['E', 'S'] as const) {
        const clientSeed = markStartSide(label(`marked ${i}`), side);
        const finalSeed = deriveFinalSeed({ serverSeed, clientSeed, gameId });
        expect(startSideOfFinalSeed(finalSeed)).toBe(side);
        for (const n of [2, 5, 7, 10, 16]) expect(opensTo(generateMaze(finalSeed, n)), `${i} ${side} n=${n}`).toBe(side);
      }
    }
  });

  it('follows the written rule: the mixed seed when it opens that way, else the first redraw that does', () => {
    const ks = new Set<number>();
    for (let i = 0; i < 40; i++) {
      for (const side of ['E', 'S'] as const) {
        const clientSeed = markStartSide(label(`rule ${i}`), side);
        const { finalSeed, k } = reference({ serverSeed, clientSeed, gameId });
        expect(deriveFinalSeed({ serverSeed, clientSeed, gameId })).toBe(finalSeed);
        ks.add(k);
      }
    }
    // Both branches ran: kept as mixed (k = 0) and redrawn (k >= 1), more than once in a row too.
    expect(ks.has(0)).toBe(true);
    expect(ks.has(1)).toBe(true);
    expect([...ks].some((k) => k >= 2)).toBe(true);
  });

  it('fixed vector: a seed that picks east, found on the third redraw', () => {
    const clientSeed: Hex = '0x98c15860ca5ebb463468135d3ccc6de5853c1d4c9a5847037f6392d14d5a3e45';
    expect(clientSeed).toBe(markStartSide(label('vector 6'), 'E'));
    expect(startSideOf(clientSeed)).toBe('E');
    const mixed: Hex = '0xcfa8e5017831e012c7151fa86a8fd9d4650d5c5d2895255afaf6c99f40f527c6';
    const finalSeed: Hex = '0x25e16520553641a743dcaebea585434360f8ce7667c2a29e8959b105ff54c487';

    expect(sha(Buffer.concat([bytes(SEED_TAG), bytes(serverSeed), bytes(clientSeed), bytes(gameId)]))).toBe(mixed);
    expect(startSideOfFinalSeed(mixed)).toBe('S');
    // k = 1 and k = 2 open south as well; k = 3 is the first that opens east.
    const draw = (k: number): Hex => sha(Buffer.concat([bytes(START_TAG), bytes(mixed), uint32be(k)]));
    expect([1, 2, 3].map((k) => startSideOfFinalSeed(draw(k)))).toEqual(['S', 'S', 'E']);
    expect(draw(3)).toBe(finalSeed);
    expect(deriveFinalSeed({ serverSeed, clientSeed, gameId })).toBe(finalSeed);
    expect(reference({ serverSeed, clientSeed, gameId })).toEqual({ finalSeed, k: 3 });

    // The same seed marked south: the mixed seed of that seed already opens south and is kept.
    const south = markStartSide(clientSeed, 'S');
    const southMixed = sha(Buffer.concat([bytes(SEED_TAG), bytes(serverSeed), bytes(south), bytes(gameId)]));
    expect(reference({ serverSeed, clientSeed: south, gameId }).k).toBe(0);
    expect(deriveFinalSeed({ serverSeed, clientSeed: south, gameId })).toBe(southMixed);
  });

  it('still depends on the server seed and the game, so the player picks the side and nothing more', () => {
    const clientSeed = markStartSide(label('depends'), 'S');
    const base = deriveFinalSeed({ serverSeed, clientSeed, gameId });
    const other: Hex = `0x${'44'.repeat(32)}`;
    expect(deriveFinalSeed({ serverSeed: other, clientSeed, gameId })).not.toBe(base);
    expect(deriveFinalSeed({ serverSeed, clientSeed, gameId: other })).not.toBe(base);
    const walls = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const seed = deriveFinalSeed({ serverSeed: label(`server ${i}`), clientSeed, gameId });
      walls.add(Array.from(generateMaze(seed, 5).open).join());
    }
    expect(walls.size).toBe(32);
  });
});

describe('distribution sanity', () => {
  /** Whether the cell the start opens into has two or more ways on (a junction). */
  function secondIsJunction(maze: Maze, n: number): boolean {
    const second = maze.open[0] === 4 ? n : 1;
    let ways = 0;
    for (const bit of [1, 2, 4, 8]) if ((maze.open[second] & bit) !== 0) ways += 1;
    return ways >= 3;
  }

  it('a marked seed always opens to its side, and its second cell is a junction about as often as with an unmarked seed of that side', () => {
    const n = 7;
    const games = 1500;
    const tally = (): Record<StartSide, { junctions: number; count: number }> => ({
      E: { junctions: 0, count: 0 },
      S: { junctions: 0, count: 0 },
    });
    const marked = tally();
    const unmarked = tally();
    for (let i = 0; i < games; i++) {
      const game = label(`game ${i}`);
      const server = label(`server ${i}`);
      for (const side of ['E', 'S'] as const) {
        const maze = generateMaze(
          deriveFinalSeed({ serverSeed: server, clientSeed: markStartSide(label(`client ${i}`), side), gameId: game }),
          n,
        );
        expect(opensTo(maze)).toBe(side);
        marked[side].count += 1;
        if (secondIsJunction(maze, n)) marked[side].junctions += 1;
      }
      const plain = generateMaze(deriveFinalSeed({ serverSeed: server, clientSeed: label(`plain ${i}`), gameId: game }), n);
      const side = opensTo(plain);
      unmarked[side].count += 1;
      if (secondIsJunction(plain, n)) unmarked[side].junctions += 1;
    }

    // Unmarked seeds open either way about half the time.
    expect(Math.abs(unmarked.E.count / games - 0.5)).toBeLessThan(4 * Math.sqrt(0.25 / games));
    for (const side of ['E', 'S'] as const) {
      const p1 = marked[side].junctions / marked[side].count;
      const p2 = unmarked[side].junctions / unmarked[side].count;
      const p = (marked[side].junctions + unmarked[side].junctions) / (marked[side].count + unmarked[side].count);
      const se = Math.sqrt(p * (1 - p) * (1 / marked[side].count + 1 / unmarked[side].count));
      // Four standard errors; the seeds are fixed, so the outcome is too.
      expect(Math.abs(p1 - p2), `${side}: marked ${p1.toFixed(3)} unmarked ${p2.toFixed(3)}`).toBeLessThan(4 * se);
      expect(p1).toBeGreaterThan(0.05);
      expect(p1).toBeLessThan(0.95);
    }
  });
});
