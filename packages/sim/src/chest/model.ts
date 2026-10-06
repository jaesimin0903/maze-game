// Mazes, chest draws and the points-maximising player of `sim:chest`.
//
// Mazes come from a stream of their own, built like the certification streams A..E (streams.ts)
// and the human stream (human/feed.ts): game `i` of a `w × h` grid is seeded with
//
//   seed = base + ((w << 8 | h) << 40) + i      (mod 2^64),  base = first 8 bytes of sha256(label)
//
// with the label "maze-sim/stream/chest/v1", and drawn with the engine's fast generator, so the
// mazes follow the certified distribution. `chestStreamDisjoint` checks that the stream's seed
// interval meets none of A..E nor the human stream, so no maze here was played there.
//
// Chests use the production rule itself (`chestDraw` of @maze/shared, rule v1), applied to a
// synthetic final seed per game: sha256 of "maze-sim/chest/final-seed/v1/<w>x<h>/<i>". In a real
// game the chest hash and the maze stream are two unrelated functions of the same final seed;
// here the maze comes from the fast generator and the chest hash from this seed, which is the
// same thing in distribution: which dead ends hold a chest, and what each is worth, is
// independent of the walls. As on the server, a game asks about one cell only: the dead end it
// ended in.

import { chestDraw, fastRng, generateGridFromRng, type ChestDraw, type Hex, type Rng } from '@maze/shared';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Bot } from '../bots/types';
import type { Game } from '../engine';
import { HUMAN_STREAM_LABEL } from '../human/feed';
import { STREAM_NAMES, STREAM_SPAN, streamBase } from '../streams';

export const CHEST_STREAM_LABEL = 'maze-sim/stream/chest/v1';
const MASK_64 = (1n << 64n) - 1n;
const INDEX_BITS = 40n;

/** Index ranges of a size, by purpose; they never share a maze. */
export const CHEST_PURPOSE_FIRST = {
  /** Per-game statistics of every player. */
  eval: 0,
  /** Bankroll sessions. */
  sessions: 2 ** 36,
  /** The paired check of the money version's multiplier. */
  check: 2 ** 37,
} as const;

/** Games per seed within a purpose. */
export const CHEST_SEED_SPAN = 2 ** 30;

function hashBase(label: string): bigint {
  return BigInt(`0x${bytesToHex(sha256(utf8ToBytes(label)).slice(0, 8))}`);
}

let base: bigint | null = null;

export function chestStreamBase(): bigint {
  base ??= hashBase(CHEST_STREAM_LABEL);
  return base;
}

export function chestStreamBaseHex(): string {
  return `0x${chestStreamBase().toString(16).padStart(16, '0')}`;
}

/** True when this stream's seed interval meets none of the streams A..E and not the human stream. */
export function chestStreamDisjoint(): boolean {
  const own = chestStreamBase();
  const others = [...STREAM_NAMES.map((name) => streamBase(name)), hashBase(HUMAN_STREAM_LABEL)];
  return others.every((other) => ((other - own) & MASK_64) >= STREAM_SPAN && ((own - other) & MASK_64) >= STREAM_SPAN);
}

/** First game index of a purpose for `seed`. */
export function chestFirstIndex(purpose: keyof typeof CHEST_PURPOSE_FIRST, seed: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 36 / CHEST_SEED_SPAN) {
    throw new RangeError(`seed must be an integer in 0 .. ${2 ** 36 / CHEST_SEED_SPAN - 1}, got ${seed}`);
  }
  return CHEST_PURPOSE_FIRST[purpose] + seed * CHEST_SEED_SPAN;
}

/** The 64-bit seed of maze `index` of a `w × h` grid on this stream. */
export function chestGameSeed(w: number, h: number, index: number): bigint {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 40) {
    throw new RangeError(`game index must be an integer in 0 .. 2^40 - 1, got ${index}`);
  }
  return (chestStreamBase() + (BigInt((w << 8) | h) << INDEX_BITS) + BigInt(index)) & MASK_64;
}

/** Yields maze `index` of one grid size. */
export class ChestFeed {
  open: Uint8Array = new Uint8Array(0);
  /** The maze generator after the maze was drawn (the certified bots draw their noise from it). */
  rng: Rng = fastRng(0n);

  constructor(
    readonly w: number,
    readonly h: number,
  ) {}

  load(index: number): void {
    const rng = fastRng(chestGameSeed(this.w, this.h, index));
    this.open = generateGridFromRng(rng, this.w, this.h).open;
    this.rng = rng;
  }
}

/** The synthetic final seed whose chest draws game `index` of a `w × h` grid uses. */
export function chestFinalSeed(w: number, h: number, index: number): Hex {
  return `0x${bytesToHex(sha256(utf8ToBytes(`maze-sim/chest/final-seed/v1/${w}x${h}/${index}`)))}`;
}

/** The production chest draws (rule v1) of `cell` in game `index`. */
export function chestOfGame(w: number, h: number, index: number, cell: number): ChestDraw {
  return chestDraw(chestFinalSeed(w, h, index), cell);
}

/**
 * The player who wants points, not money: it never cashes out, never steps onto the exit unless
 * that is the only way on, and at a fork takes the branch whose cell is farthest from the exit
 * (ties: the first in N, E, S, W order). Every game of a tree maze ends in the exit or in a dead
 * end, so walking away from the exit makes nearly every game end in a dead end, where a chest
 * may wait. Deterministic, so it plays every maze the same way.
 */
export class DeadEndSeeker implements Bot {
  begin(): void {}

  decide(g: Game): number {
    let best = -1;
    let bestDistance = -1;
    for (let i = 0; i < g.nc; i++) {
      const cell = g.childCell[i];
      if (cell === g.exit) continue;
      if (g.dist[cell] > bestDistance) {
        best = i;
        bestDistance = g.dist[cell];
      }
    }
    return best === -1 ? 0 : best;
  }
}
