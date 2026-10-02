// Shared by the Node and the browser-environment runs of the fixed vectors (AC-M1).

import { expect } from 'vitest';
import {
  commitmentOf,
  deriveFinalSeed,
  generateMaze,
  isPerfect,
  MAZE_VERSION,
  seedRng,
  solve,
  wallsDigest,
  type Hex,
} from '../src';
import vectorsJson from './vectors/maze-v1.json';

export interface MazeVector {
  id: number;
  n: number;
  serverSeed: Hex;
  clientSeed: Hex;
  gameId: Hex;
  commitment: Hex;
  finalSeed: Hex;
  streamHead: number[];
  open: Hex;
  wallsDigest: Hex;
  solution: number[];
}

export const mazeVectors = vectorsJson.vectors as MazeVector[];
export const vectorsMazeVersion: number = vectorsJson.mazeVersion;

export function openHex(open: Uint8Array): Hex {
  return `0x${Array.from(open, (mask) => mask.toString(16).padStart(2, '0')).join('')}`;
}

/** Recomputes every field of a vector from its three seeds and compares. */
export function expectVector(v: MazeVector): void {
  expect(commitmentOf({ mazeVersion: MAZE_VERSION, n: v.n, serverSeed: v.serverSeed })).toBe(
    v.commitment,
  );
  const finalSeed = deriveFinalSeed(v);
  expect(finalSeed).toBe(v.finalSeed);

  const rng = seedRng(finalSeed);
  expect(v.streamHead.map(() => rng.nextU32())).toEqual(v.streamHead);

  const maze = generateMaze(finalSeed, v.n);
  expect([maze.w, maze.h]).toEqual([v.n, v.n]);
  expect(openHex(maze.open)).toBe(v.open);
  expect(wallsDigest(maze)).toBe(v.wallsDigest);
  expect(solve(maze)).toEqual(v.solution);
  expect(isPerfect(maze)).toBe(true);
}
