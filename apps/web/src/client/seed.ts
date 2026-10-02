// Client-side randomness: the client seed mixed into the maze and the session token that
// authorises a game's requests (plan §3.5, §7.3).

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Hex } from '@maze/shared';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export function isHex32(value: unknown): value is Hex {
  return typeof value === 'string' && HEX32.test(value);
}

/** 32 bytes from the platform CSPRNG as 0x-prefixed lowercase hex. */
export function randomHex32(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${bytesToHex(bytes)}`;
}

/** The exact string later sent as `Authorization: Bearer <token>`. */
export function newSessionToken(): string {
  return randomHex32().slice(2);
}

/** `sha256` of the token's UTF-8 bytes, the `sessionTokenHash` of `POST /api/games`. */
export function hashSessionToken(token: string): Hex {
  return `0x${bytesToHex(sha256(utf8ToBytes(token)))}`;
}
