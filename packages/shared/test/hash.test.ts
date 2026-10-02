import { createHash } from 'node:crypto';
import { encodePacked, keccak256, sha256, stringToBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  COMMIT_TAG,
  commitmentOf,
  deriveFinalSeed,
  generateMaze,
  MAZE_VERSION,
  SEED_TAG,
  wallsDigest,
  type Hex,
  type Maze,
} from '../src';

const serverSeed: Hex = `0x${'11'.repeat(32)}`;
const clientSeed: Hex = `0x${'22'.repeat(32)}`;
const gameId: Hex = `0x${'33'.repeat(32)}`;

const bytes = (hex: Hex): Buffer => Buffer.from(hex.slice(2), 'hex');
const sha = (data: Buffer): Hex => `0x${createHash('sha256').update(data).digest('hex')}`;

describe('tags', () => {
  it('are keccak256 of the tag strings', () => {
    expect(COMMIT_TAG).toBe(keccak256(stringToBytes('MazeBet.commit.v1')));
    expect(SEED_TAG).toBe(keccak256(stringToBytes('MazeBet.seed.v1')));
    // The same values from Foundry: `cast keccak "MazeBet.commit.v1"`, `cast keccak "MazeBet.seed.v1"`.
    expect(COMMIT_TAG).toBe('0xed864b0ca7634f58f71e4d1df994aa183825515f573d02b9a2e3056f3f3dfb88');
    expect(SEED_TAG).toBe('0x995880426b3369b1120725e66a7f97aa20fc6718bcb598da60ed9392f22aebf1');
  });
});

describe('commitmentOf', () => {
  it('AC-M6 is sha256(COMMIT_TAG ‖ uint16be(mazeVersion) ‖ uint8(n) ‖ serverSeed) over 67 bytes', () => {
    const preimage = Buffer.concat([bytes(COMMIT_TAG), Buffer.from([0x01, 0x02]), Buffer.from([10]), bytes(serverSeed)]);
    expect(preimage).toHaveLength(67);
    expect(commitmentOf({ mazeVersion: 0x0102, n: 10, serverSeed })).toBe(sha(preimage));
  });

  it('AC-M4 equals the contract expression sha256(abi.encodePacked(tag, uint16, uint8, bytes32))', () => {
    for (const n of [5, 7, 10, 255]) {
      const packed = encodePacked(
        ['bytes32', 'uint16', 'uint8', 'bytes32'],
        [COMMIT_TAG, MAZE_VERSION, n, serverSeed],
      );
      expect(commitmentOf({ mazeVersion: MAZE_VERSION, n, serverSeed })).toBe(sha256(packed));
    }
  });

  it('AC-M6 covers the maze version, the size and the server seed', () => {
    const base = commitmentOf({ mazeVersion: 1, n: 5, serverSeed });
    expect(commitmentOf({ mazeVersion: 1, n: 5, serverSeed })).toBe(base);
    expect(commitmentOf({ mazeVersion: 2, n: 5, serverSeed })).not.toBe(base);
    expect(commitmentOf({ mazeVersion: 1, n: 7, serverSeed })).not.toBe(base);
    expect(commitmentOf({ mazeVersion: 1, n: 5, serverSeed: clientSeed })).not.toBe(base);
    // The version is two big-endian bytes: 256 and 1 are different preimages.
    expect(commitmentOf({ mazeVersion: 256, n: 5, serverSeed })).not.toBe(base);
  });

  it('X8 depends on (mazeVersion, n, serverSeed) only, so it reveals nothing about the walls', () => {
    const commitment = commitmentOf({ mazeVersion: MAZE_VERSION, n: 5, serverSeed });
    const mazes = new Set<string>();
    const starts = new Set<number>();
    for (let i = 0; i < 64; i++) {
      const client: Hex = `0x${i.toString(16).padStart(64, '0')}`;
      const maze = generateMaze(deriveFinalSeed({ serverSeed, clientSeed: client, gameId }), 5);
      mazes.add(Array.from(maze.open).join());
      starts.add(maze.open[0]);
      // Nothing about the client seed or the game enters the commitment.
      expect(commitmentOf({ mazeVersion: MAZE_VERSION, n: 5, serverSeed })).toBe(commitment);
    }
    expect(mazes.size).toBe(64);
    expect(starts).toEqual(new Set([2, 4])); // one commitment, both start directions
  });

  it('rejects values that do not fit their field', () => {
    for (const mazeVersion of [-1, 65536, 1.5, Number.NaN]) {
      expect(() => commitmentOf({ mazeVersion, n: 5, serverSeed })).toThrow(RangeError);
    }
    for (const n of [-1, 256, 2.5]) {
      expect(() => commitmentOf({ mazeVersion: 1, n, serverSeed })).toThrow(RangeError);
    }
    for (const bad of ['0x1234', `0x${'11'.repeat(33)}`, '11'.repeat(32), `0x${'xy'.repeat(32)}`]) {
      expect(() => commitmentOf({ mazeVersion: 1, n: 5, serverSeed: bad as Hex })).toThrow(TypeError);
    }
  });
});

describe('deriveFinalSeed', () => {
  it('AC-M6 is sha256(SEED_TAG ‖ serverSeed ‖ clientSeed ‖ gameId) over 128 bytes', () => {
    const preimage = Buffer.concat([bytes(SEED_TAG), bytes(serverSeed), bytes(clientSeed), bytes(gameId)]);
    expect(preimage).toHaveLength(128);
    expect(deriveFinalSeed({ serverSeed, clientSeed, gameId })).toBe(sha(preimage));
    expect(deriveFinalSeed({ serverSeed, clientSeed, gameId })).toBe(
      sha256(encodePacked(['bytes32', 'bytes32', 'bytes32', 'bytes32'], [SEED_TAG, serverSeed, clientSeed, gameId])),
    );
  });

  it('depends on each input and on which is which', () => {
    const base = deriveFinalSeed({ serverSeed, clientSeed, gameId });
    const other: Hex = `0x${'44'.repeat(32)}`;
    expect(deriveFinalSeed({ serverSeed: other, clientSeed, gameId })).not.toBe(base);
    expect(deriveFinalSeed({ serverSeed, clientSeed: other, gameId })).not.toBe(base);
    expect(deriveFinalSeed({ serverSeed, clientSeed, gameId: other })).not.toBe(base);
    expect(deriveFinalSeed({ serverSeed: clientSeed, clientSeed: serverSeed, gameId })).not.toBe(base);
  });

  it('AC-M6 the walls follow from the revealed server seed and the on-chain client seed and game id', () => {
    const walls = (p: { serverSeed: Hex; clientSeed: Hex; gameId: Hex }): string =>
      Array.from(generateMaze(deriveFinalSeed(p), 7).open).join();
    const base = walls({ serverSeed, clientSeed, gameId });
    expect(walls({ serverSeed, clientSeed, gameId })).toBe(base);
    expect(walls({ serverSeed, clientSeed: gameId, gameId })).not.toBe(base);
    expect(walls({ serverSeed, clientSeed, gameId: clientSeed })).not.toBe(base);
    expect(walls({ serverSeed: gameId, clientSeed, gameId })).not.toBe(base);
  });

  it('accepts upper-case hex and always answers in lower case', () => {
    const upper = (hex: Hex): Hex => `0x${hex.slice(2).toUpperCase()}`;
    const mixed: Hex = `0x${'aB'.repeat(32)}`;
    const lower = deriveFinalSeed({ serverSeed: `0x${'ab'.repeat(32)}`, clientSeed, gameId });
    expect(deriveFinalSeed({ serverSeed: mixed, clientSeed: upper(clientSeed), gameId })).toBe(lower);
    expect(lower).toMatch(/^0x[0-9a-f]{64}$/);
    expect(commitmentOf({ mazeVersion: 1, n: 5, serverSeed: mixed })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('rejects seeds that are not 32 bytes of hex', () => {
    const bad = '0xabc' as Hex;
    expect(() => deriveFinalSeed({ serverSeed: bad, clientSeed, gameId })).toThrow(/serverSeed/);
    expect(() => deriveFinalSeed({ serverSeed, clientSeed: bad, gameId })).toThrow(/clientSeed/);
    expect(() => deriveFinalSeed({ serverSeed, clientSeed, gameId: bad })).toThrow(/gameId/);
  });
});

describe('wallsDigest', () => {
  const maze: Maze = { w: 3, h: 3, open: Uint8Array.from([4, 6, 8, 7, 11, 12, 3, 8, 1]) };

  it('is sha256(uint16be(w) ‖ uint16be(h) ‖ open)', () => {
    expect(wallsDigest(maze)).toBe(sha(Buffer.concat([Buffer.from([0, 3, 0, 3]), Buffer.from(maze.open)])));
    const wide: Maze = { w: 258, h: 1, open: new Uint8Array(258) };
    expect(wallsDigest(wide)).toBe(sha(Buffer.concat([Buffer.from([1, 2, 0, 1]), Buffer.alloc(258)])));
  });

  it('changes with a single wall and with the shape', () => {
    const flipped = Uint8Array.from(maze.open);
    flipped[4] ^= 4;
    expect(wallsDigest({ w: 3, h: 3, open: flipped })).not.toBe(wallsDigest(maze));
    const open = new Uint8Array(20);
    expect(wallsDigest({ w: 5, h: 4, open })).not.toBe(wallsDigest({ w: 4, h: 5, open }));
  });

  it('rejects a wall array that does not match the shape', () => {
    expect(() => wallsDigest({ w: 3, h: 3, open: new Uint8Array(8) })).toThrow(RangeError);
  });
});
