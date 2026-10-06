// Treasure chests and points (chest rule version 1).
//
// A chest can sit only in a dead end: a cell with exactly one opening that is neither the start
// nor the exit. Walking into a dead end ends the game as a loss, so a chest is a consolation the
// player finds on losing. Its reward is points, a share of the bet; points have no cash value.
//
// Where the chests are and what each holds follows from the game's final seed alone, through a
// hash that is separate from the maze stream (domain tag `MazeBet.chest.v1`), so the maze of a
// game is the same with or without chests, and anyone can recompute every chest of a finished
// game once its server seed is revealed. Rule v1, for cell `c` of a game with final seed `F`:
//
//   h       = sha256( CHEST_TAG(32) ‖ F(32) ‖ uint16be(c) )            66 bytes hashed
//   placed  = uint128be(h[0..16])  mod 10000  <  CHEST_RATE_BPS (3000)  (about 30% of dead ends)
//   reward  = CHEST_REWARD_MIN_BPS + uint128be(h[16..32]) mod 2001      (1000 .. 3000 bps of the bet)
//
// A cell holds a chest when it is a dead end and `placed` is true. The points of a chest are
//
//   points  = floor( bet(wei) × reward / (10000 × POINT_UNIT_WEI) ),   POINT_UNIT_WEI = 10^12
//
// one division, rounded down: one point stands for 10^12 wei (0.000001 ETH) of bet, so a chest
// is worth 10% to 30% of the bet in points whatever the bet. A later rule gets a new version and
// a new tag; a game is always verified with the rule version its ending recorded.

import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { ChestConfig } from './api';
import { exitCell, START_CELL } from './maze';
import type { Hex, Maze } from './types';

/** The chest rule this code applies to new games. */
export const CHEST_RULE_VERSION = 1;
/** Share of dead ends that hold a chest, in basis points. */
export const CHEST_RATE_BPS = 3000;
/** Smallest and largest reward of a chest, in basis points of the bet (both included). */
export const CHEST_REWARD_MIN_BPS = 1000;
export const CHEST_REWARD_MAX_BPS = 3000;
/** Wei of bet that one point stands for. */
export const POINT_UNIT_WEI = 10n ** 12n;

const CHEST_TAG_BYTES = keccak_256(utf8ToBytes('MazeBet.chest.v1'));
/** `keccak256("MazeBet.chest.v1")` */
export const CHEST_TAG: Hex = `0x${bytesToHex(CHEST_TAG_BYTES)}`;

const REWARD_SPAN = BigInt(CHEST_REWARD_MAX_BPS - CHEST_REWARD_MIN_BPS + 1);

/** The draws of rule v1 for one cell, whether or not the cell is a dead end. */
export interface ChestDraw {
  /** True when a dead end at this cell holds a chest. */
  placed: boolean;
  /** What a chest at this cell is worth, in basis points of the bet. */
  rewardBps: number;
}

/** A chest of a maze: the cell (`y * n + x`) and its reward in basis points of the bet. */
export interface Chest {
  cell: number;
  rewardBps: number;
}

/** True for the chest rule versions this code can evaluate. */
export function isKnownChestRule(rule: number): boolean {
  return rule === 1;
}

function requireRule(rule: number): void {
  if (!isKnownChestRule(rule)) throw new RangeError(`unknown chest rule version ${rule}`);
}

function uint128(bytes: Uint8Array): bigint {
  return BigInt(`0x${bytesToHex(bytes)}`);
}

/**
 * The draws of `cell` for a game with `finalSeed` (rule v1, see the top of this file). Reads no
 * maze: the server asks this only for the dead end a move has just entered.
 */
export function chestDraw(finalSeed: Hex, cell: number, rule: number = CHEST_RULE_VERSION): ChestDraw {
  requireRule(rule);
  if (typeof finalSeed !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(finalSeed)) {
    throw new TypeError('chestDraw: finalSeed must be 32 bytes of 0x-prefixed hex');
  }
  if (!Number.isInteger(cell) || cell < 0 || cell > 0xffff) {
    throw new RangeError(`chestDraw: cell must be an integer in 0 .. 65535, got ${cell}`);
  }
  const input = new Uint8Array(66);
  input.set(CHEST_TAG_BYTES, 0);
  input.set(hexToBytes(finalSeed.slice(2)), 32);
  input[64] = cell >>> 8;
  input[65] = cell & 0xff;
  const h = sha256(input);
  return {
    placed: uint128(h.subarray(0, 16)) % 10_000n < BigInt(CHEST_RATE_BPS),
    rewardBps: CHEST_REWARD_MIN_BPS + Number(uint128(h.subarray(16, 32)) % REWARD_SPAN),
  };
}

/**
 * True when `cell` is a place a chest can be: exactly one opening, not the start, not the exit.
 * These are exactly the cells whose entry ends a game as a loss. Reads only `maze.open[cell]`.
 */
export function isChestSite(maze: Maze, cell: number): boolean {
  if (!Number.isInteger(cell) || cell < 0 || cell >= maze.w * maze.h) {
    throw new RangeError(`cell ${cell} is outside the ${maze.w}x${maze.h} grid`);
  }
  if (cell === START_CELL || cell === exitCell(maze)) return false;
  const mask = maze.open[cell];
  return mask === 1 || mask === 2 || mask === 4 || mask === 8;
}

/** The chest at `cell`, or `null`. Reads only `maze.open[cell]`. */
export function chestAt(
  finalSeed: Hex,
  maze: Maze,
  cell: number,
  rule: number = CHEST_RULE_VERSION,
): Chest | null {
  requireRule(rule);
  if (!isChestSite(maze, cell)) return null;
  const draw = chestDraw(finalSeed, cell, rule);
  return draw.placed ? { cell, rewardBps: draw.rewardBps } : null;
}

/** Every chest of the maze, in cell order. */
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
