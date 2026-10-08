// Commitment, seed mixing and wall digest (plan §3.5, §7.2).
// Multi-byte integers are big-endian and fields are concatenated without separators.

import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { seedRng } from './rng';
import type { Hex, Maze } from './types';

function toHex(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(bytes)}`;
}

function bytes32(value: Hex, name: string): Uint8Array {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${name} must be 32 bytes of 0x-prefixed hex`);
  }
  return hexToBytes(value.slice(2));
}

function uintBE(value: number, bytes: number, name: string): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** (8 * bytes)) {
    throw new RangeError(`${name} must be an integer that fits in ${bytes} byte(s), got ${value}`);
  }
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[bytes - 1 - i] = (value >>> (8 * i)) & 0xff;
  return out;
}

const COMMIT_TAG_BYTES = keccak_256(utf8ToBytes('MazeBet.commit.v1'));
const SEED_TAG_BYTES = keccak_256(utf8ToBytes('MazeBet.seed.v1'));

/** `keccak256("MazeBet.commit.v1")` */
export const COMMIT_TAG: Hex = toHex(COMMIT_TAG_BYTES);
/** `keccak256("MazeBet.seed.v1")` */
export const SEED_TAG: Hex = toHex(SEED_TAG_BYTES);

/**
 * `sha256( COMMIT_TAG(32) ‖ uint16be(mazeVersion) ‖ uint8(n) ‖ serverSeed(32) )`, 67 bytes hashed.
 * The server signs this before it knows the client seed; the contract recomputes it at settlement.
 */
export function commitmentOf(p: { mazeVersion: number; n: number; serverSeed: Hex }): Hex {
  return toHex(
    sha256(
      concatBytes(
        COMMIT_TAG_BYTES,
        uintBE(p.mazeVersion, 2, 'mazeVersion'),
        uintBE(p.n, 1, 'n'),
        bytes32(p.serverSeed, 'serverSeed'),
      ),
    ),
  );
}

/** The side the start cell opens to. Every maze has exactly one (the "start corridor"). */
export type StartSide = 'E' | 'S';

const START_TAG_BYTES = keccak_256(utf8ToBytes('MazeBet.start.v1'));
/** `keccak256("MazeBet.start.v1")` */
export const START_TAG: Hex = toHex(START_TAG_BYTES);

/** ASCII "MZ>": the first three of the four closing bytes of a client seed that picks a start side. */
const START_MARK = [0x4d, 0x5a, 0x3e] as const;
/** The fourth closing byte: ASCII "E" or "S". */
const START_SIDE_BYTE: Record<StartSide, number> = { E: 0x45, S: 0x53 };
/** A redraw happens with probability 1/2 each time, so 2^-256 is the chance of ever reaching this. */
const MAX_START_DRAWS = 256;

/**
 * The start side a client seed asks for: a seed whose last four bytes are ASCII "MZ>E" or "MZ>S"
 * picks east or south; any other seed picks nothing (and the start side falls out of the mixed
 * seed, as it always did). A random seed carries the mark by chance with probability 2^-31.
 */
export function startSideOf(clientSeed: Hex): StartSide | null {
  const bytes = bytes32(clientSeed, 'clientSeed');
  if (bytes[28] !== START_MARK[0] || bytes[29] !== START_MARK[1] || bytes[30] !== START_MARK[2]) return null;
  if (bytes[31] === START_SIDE_BYTE.E) return 'E';
  if (bytes[31] === START_SIDE_BYTE.S) return 'S';
  return null;
}

/** `seed` with its last four bytes replaced by the mark that picks `side`. */
export function markStartSide(seed: Hex, side: StartSide): Hex {
  const bytes = bytes32(seed, 'seed');
  bytes.set([...START_MARK, START_SIDE_BYTE[side]], 28);
  return toHex(bytes);
}

/**
 * The side the start cell of `generateMaze(finalSeed, n)` opens to, for every `n`: the generator's
 * first draw, `nextBelow(2)`, closes the east edge on 0 (the start opens south) and the south
 * edge on 1 (it opens east).
 */
export function startSideOfFinalSeed(finalSeed: Hex): StartSide {
  return seedRng(finalSeed).nextBelow(2) === 0 ? 'S' : 'E';
}

/**
 * The seed of the maze stream (`seedRng`). First
 * `mixed = sha256( SEED_TAG(32) ‖ serverSeed(32) ‖ clientSeed(32) ‖ gameId(32) )`, 128 bytes hashed.
 *
 * When the client seed picks a start side (`startSideOf`), the result is the first of `mixed`,
 * `sha256( START_TAG(32) ‖ mixed(32) ‖ uint32be(k) )` for `k = 1, 2, ...` whose maze opens to that
 * side; otherwise it is `mixed`. The player may so see the start side before betting. That does
 * not move the odds: the maze is still uniform among the mazes that open to that side, and on a
 * square grid the mirror image across the diagonal pairs every east-opening maze with a
 * south-opening one of equal value. The server committed to its seed before seeing the client's,
 * so it has no say in which maze of that side comes out.
 */
export function deriveFinalSeed(p: { serverSeed: Hex; clientSeed: Hex; gameId: Hex }): Hex {
  const mixed = sha256(
    concatBytes(
      SEED_TAG_BYTES,
      bytes32(p.serverSeed, 'serverSeed'),
      bytes32(p.clientSeed, 'clientSeed'),
      bytes32(p.gameId, 'gameId'),
    ),
  );
  const side = startSideOf(p.clientSeed);
  let seed = toHex(mixed);
  if (side === null) return seed;
  for (let k = 1; startSideOfFinalSeed(seed) !== side; k++) {
    if (k > MAX_START_DRAWS) throw new Error('deriveFinalSeed: no seed opened to the picked start side');
    seed = toHex(sha256(concatBytes(START_TAG_BYTES, mixed, uintBE(k, 4, 'k'))));
  }
  return seed;
}

/** `sha256( uint16be(w) ‖ uint16be(h) ‖ open[0 .. w*h-1] )`: a compact fingerprint of a whole maze. */
export function wallsDigest(maze: Maze): Hex {
  if (maze.open.length !== maze.w * maze.h) {
    throw new RangeError('wallsDigest: maze.open does not have w * h entries');
  }
  return toHex(sha256(concatBytes(uintBE(maze.w, 2, 'w'), uintBE(maze.h, 2, 'h'), maze.open)));
}
