// Treasure chests and points (chest rules v1 and v2).
//
// A chest's reward is points, a share of the bet; points have no cash value. Where the chests are
// and what each holds follows from the game's final seed alone, through hashes that are separate
// from the maze stream, so the maze of a game is the same with or without chests, and anyone can
// recompute every chest of a finished game once its server seed is revealed. A game is always
// verified with the rule version the server recorded for it.
//
// Rule v1 (dead ends only). A dead end is a cell with exactly one opening that is neither the
// start nor the exit; walking into one ends the game as a loss, so its chest is a consolation.
// For cell `c` of a game with final seed `F`:
//
//   h       = sha256( CHEST_TAG(32) ‖ F(32) ‖ uint16be(c) )            CHEST_TAG = keccak256("MazeBet.chest.v1")
//   placed  = uint128be(h[0..16])  mod 10000  <  3000                     (about 30% of dead ends)
//   reward  = 1000 + uint128be(h[16..32]) mod 2001                        (10% .. 30% of the bet)
//
// Rule v2 (dead ends as in v1, plus path chests). A dead end draws exactly as in v1, with the v1
// tag. Every other cell except the start and the exit (a "path cell": two or more openings) draws
// with its own tag:
//
//   h       = sha256( PATH_CHEST_TAG(32) ‖ F(32) ‖ uint16be(c) )       PATH_CHEST_TAG = keccak256("MazeBet.chest.v2")
//   placed  = uint128be(h[0..16])  mod 10000  <  1000                     (about 10% of path cells)
//   reward  = 200 + uint128be(h[16..32]) mod 301                          (2% .. 5% of the bet)
//
// A path chest is found the moment the player enters its cell and its points are kept whatever
// the ending. Which of the two draws applies to a cell depends on that cell's own openings only,
// which the player sees on entering it; the draw itself depends on the final seed and the cell
// number only, never on another cell. So finding a chest, or not, tells nothing about any cell the
// player has not entered.
//
// Points, for either kind:
//
//   points  = floor( bet(wei) × reward / (10000 × POINT_UNIT_WEI) ),   POINT_UNIT_WEI = 10^12
//
// one division, rounded down: one point stands for 10^12 wei (0.000001 ETH) of bet.

import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { ChestConfig } from './api';
import { exitCell, START_CELL } from './maze';
import type { Hex, Maze } from './types';

/** The chest rule this code applies to new games. */
export const CHEST_RULE_VERSION = 2;
/** Every chest rule version this code can evaluate, oldest first. */
export const CHEST_RULE_VERSIONS: readonly number[] = [1, 2];

/** Share of dead ends that hold a chest, in basis points (rules v1 and v2). */
export const CHEST_RATE_BPS = 3000;
/** Smallest and largest reward of a dead-end chest, in basis points of the bet (both included). */
export const CHEST_REWARD_MIN_BPS = 1000;
export const CHEST_REWARD_MAX_BPS = 3000;
/** Share of path cells that hold a chest, in basis points (rule v2). */
export const PATH_CHEST_RATE_BPS = 1000;
/** Smallest and largest reward of a path chest, in basis points of the bet (both included). */
export const PATH_CHEST_REWARD_MIN_BPS = 200;
export const PATH_CHEST_REWARD_MAX_BPS = 500;
/** Wei of bet that one point stands for. */
export const POINT_UNIT_WEI = 10n ** 12n;

const CHEST_TAG_BYTES = keccak_256(utf8ToBytes('MazeBet.chest.v1'));
const PATH_CHEST_TAG_BYTES = keccak_256(utf8ToBytes('MazeBet.chest.v2'));
/** `keccak256("MazeBet.chest.v1")`: the dead-end draws (rules v1 and v2). */
export const CHEST_TAG: Hex = `0x${bytesToHex(CHEST_TAG_BYTES)}`;
/** `keccak256("MazeBet.chest.v2")`: the path-cell draws (rule v2). */
export const PATH_CHEST_TAG: Hex = `0x${bytesToHex(PATH_CHEST_TAG_BYTES)}`;

/** A dead end (one opening, the game ends there as a loss) or a path cell (two or more openings). */
export type ChestKind = 'dead-end' | 'path';

/** The draws of one cell for one kind, whether or not a chest is placed. */
export interface ChestDraw {
  /** True when the cell holds a chest of that kind. */
  placed: boolean;
  /** What that chest is worth, in basis points of the bet (0 when the rule has no such chest). */
  rewardBps: number;
}

/** A chest of a maze: the cell (`y * n + x`), its kind and its reward in basis points of the bet. */
export interface Chest {
  cell: number;
  kind: ChestKind;
  rewardBps: number;
}

/** True for the chest rule versions this code can evaluate. */
export function isKnownChestRule(rule: number): boolean {
  return CHEST_RULE_VERSIONS.includes(rule);
}

function requireRule(rule: number): void {
  if (!isKnownChestRule(rule)) throw new RangeError(`unknown chest rule version ${rule}`);
}

function uint128(bytes: Uint8Array): bigint {
  return BigInt(`0x${bytesToHex(bytes)}`);
}

function hashDraw(tag: Uint8Array, finalSeed: Hex, cell: number, rateBps: number, minBps: number, maxBps: number): ChestDraw {
  if (typeof finalSeed !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(finalSeed)) {
    throw new TypeError('chestDraw: finalSeed must be 32 bytes of 0x-prefixed hex');
  }
  if (!Number.isInteger(cell) || cell < 0 || cell > 0xffff) {
    throw new RangeError(`chestDraw: cell must be an integer in 0 .. 65535, got ${cell}`);
  }
  const input = new Uint8Array(66);
  input.set(tag, 0);
  input.set(hexToBytes(finalSeed.slice(2)), 32);
  input[64] = cell >>> 8;
  input[65] = cell & 0xff;
  const h = sha256(input);
  return {
    placed: uint128(h.subarray(0, 16)) % 10_000n < BigInt(rateBps),
    rewardBps: minBps + Number(uint128(h.subarray(16, 32)) % BigInt(maxBps - minBps + 1)),
  };
}

/**
 * The draws of `cell` for a game with `finalSeed` under `rule`, for a cell of `kind` (see the top
 * of this file). Reads no maze: the caller says what kind of cell it is. A dead end draws the
 * same in v1 and v2; rule v1 has no path chests.
 */
export function chestDraw(
  finalSeed: Hex,
  cell: number,
  rule: number = CHEST_RULE_VERSION,
  kind: ChestKind = 'dead-end',
): ChestDraw {
  requireRule(rule);
  if (kind === 'dead-end') {
    return hashDraw(CHEST_TAG_BYTES, finalSeed, cell, CHEST_RATE_BPS, CHEST_REWARD_MIN_BPS, CHEST_REWARD_MAX_BPS);
  }
  if (rule === 1) return { placed: false, rewardBps: 0 };
  return hashDraw(PATH_CHEST_TAG_BYTES, finalSeed, cell, PATH_CHEST_RATE_BPS, PATH_CHEST_REWARD_MIN_BPS, PATH_CHEST_REWARD_MAX_BPS);
}

/**
 * What kind of chest `cell` could hold, from its own openings only: `'dead-end'` for exactly one
 * opening, `'path'` for two or more, `null` for the start and the exit. Reads only `maze.open[cell]`.
 */
export function chestKindOf(maze: Maze, cell: number): ChestKind | null {
  if (!Number.isInteger(cell) || cell < 0 || cell >= maze.w * maze.h) {
    throw new RangeError(`cell ${cell} is outside the ${maze.w}x${maze.h} grid`);
  }
  if (cell === START_CELL || cell === exitCell(maze)) return null;
  const mask = maze.open[cell];
  return mask === 1 || mask === 2 || mask === 4 || mask === 8 ? 'dead-end' : 'path';
}

/**
 * True when `cell` is a dead end: exactly one opening, not the start, not the exit. These are
 * exactly the cells whose entry ends a game as a loss. Reads only `maze.open[cell]`.
 */
export function isChestSite(maze: Maze, cell: number): boolean {
  return chestKindOf(maze, cell) === 'dead-end';
}

/** The chest at `cell` under `rule`, or `null`. Reads only `maze.open[cell]`. */
export function chestAt(finalSeed: Hex, maze: Maze, cell: number, rule: number = CHEST_RULE_VERSION): Chest | null {
  requireRule(rule);
  const kind = chestKindOf(maze, cell);
  if (kind === null) return null;
  const draw = chestDraw(finalSeed, cell, rule, kind);
  return draw.placed ? { cell, kind, rewardBps: draw.rewardBps } : null;
}

/** Every chest of the maze under `rule`, in cell order. */
export function chestsOf(finalSeed: Hex, maze: Maze, rule: number = CHEST_RULE_VERSION): Chest[] {
  requireRule(rule);
  const chests: Chest[] = [];
  for (let cell = 0; cell < maze.w * maze.h; cell++) {
    const chest = chestAt(finalSeed, maze, cell, rule);
    if (chest !== null) chests.push(chest);
  }
  return chests;
}

/** What `GET /api/config` reports about the chest rule this code applies. */
export function chestConfig(): ChestConfig {
  return {
    ruleVersion: CHEST_RULE_VERSION,
    rateBps: CHEST_RATE_BPS,
    rewardMinBps: CHEST_REWARD_MIN_BPS,
    rewardMaxBps: CHEST_REWARD_MAX_BPS,
    pointUnitWei: POINT_UNIT_WEI.toString(),
    cashValue: false,
    pathRateBps: PATH_CHEST_RATE_BPS,
    pathRewardMinBps: PATH_CHEST_REWARD_MIN_BPS,
    pathRewardMaxBps: PATH_CHEST_REWARD_MAX_BPS,
  };
}

/** `floor(bet × rewardBps / (10000 × POINT_UNIT_WEI))`: the points of a chest for a bet. */
export function chestPoints(betWei: bigint, rewardBps: number): bigint {
  if (betWei < 0n) throw new RangeError('chestPoints: the bet must not be negative');
  if (!Number.isInteger(rewardBps) || rewardBps < 0 || rewardBps > 10_000) {
    throw new RangeError(`chestPoints: rewardBps must be an integer in 0 .. 10000, got ${rewardBps}`);
  }
  return (betWei * BigInt(rewardBps)) / (10_000n * POINT_UNIT_WEI);
}
