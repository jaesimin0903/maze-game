// Commitment, seed mixing and wall digest (plan §3.5, §7.2).
// Multi-byte integers are big-endian and fields are concatenated without separators.

import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
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

/**
 * `sha256( SEED_TAG(32) ‖ serverSeed(32) ‖ clientSeed(32) ‖ gameId(32) )`, 128 bytes hashed.
 * The result seeds the maze stream (`seedRng`).
 */
export function deriveFinalSeed(p: { serverSeed: Hex; clientSeed: Hex; gameId: Hex }): Hex {
  return toHex(
    sha256(
      concatBytes(
        SEED_TAG_BYTES,
        bytes32(p.serverSeed, 'serverSeed'),
        bytes32(p.clientSeed, 'clientSeed'),
        bytes32(p.gameId, 'gameId'),
      ),
    ),
  );
}

/** `sha256( uint16be(w) ‖ uint16be(h) ‖ open[0 .. w*h-1] )`: a compact fingerprint of a whole maze. */
export function wallsDigest(maze: Maze): Hex {
  if (maze.open.length !== maze.w * maze.h) {
    throw new RangeError('wallsDigest: maze.open does not have w * h entries');
  }
  return toHex(sha256(concatBytes(uintBE(maze.w, 2, 'w'), uintBE(maze.h, 2, 'h'), maze.open)));
}
