// Shared by the Node and the browser-environment runs of the chest vectors (AC-P1), like
// vectors.ts for the maze vectors. Rule v1 vectors (chest-v1.json) and rule v2 vectors
// (chest-v2.json) are checked against their own rule version.

import { expect } from 'vitest';
import { chestAt, chestDraw, chestKindOf, chestPoints, chestsOf, generateMaze, isChestSite, type ChestKind, type Hex } from '../src';
import vectorsJson from './vectors/chest-v1.json';
import v2Json from './vectors/chest-v2.json';

export interface ChestGameVector {
  mazeVector: number;
  n: number;
  finalSeed: Hex;
  sites: { cell: number; placed: boolean; rewardBps: number }[];
  chests: { cell: number; rewardBps: number }[];
  points: { cell: number; byBet: string[] }[];
}

export const chestVectors = vectorsJson as unknown as {
  chestRule: number;
  chestTag: Hex;
  bets: string[];
  raw: { finalSeed: Hex; cell: number; placed: boolean; rewardBps: number }[];
  games: ChestGameVector[];
};

export const chestGames: ChestGameVector[] = chestVectors.games;

/** Recomputes one v1 vector game's sites, chests and points from its final seed (rule 1) and compares. */
export function expectChestGame(game: ChestGameVector): void {
  const maze = generateMaze(game.finalSeed, game.n);
  const sites: number[] = [];
  for (let cell = 0; cell < game.n * game.n; cell++) if (isChestSite(maze, cell)) sites.push(cell);
  expect(sites).toEqual(game.sites.map((site) => site.cell));
  for (const site of game.sites) {
    const chest = chestAt(game.finalSeed, maze, site.cell, 1);
    expect(chest === null ? null : { cell: chest.cell, rewardBps: chest.rewardBps }).toEqual(
      site.placed ? { cell: site.cell, rewardBps: site.rewardBps } : null,
    );
    if (chest !== null) expect(chest.kind).toBe('dead-end');
  }
  expect(chestsOf(game.finalSeed, maze, 1).map(({ cell, rewardBps }) => ({ cell, rewardBps }))).toEqual(game.chests);
  for (const entry of game.points) {
    const chest = game.chests.find((candidate) => candidate.cell === entry.cell)!;
    expect(chestVectors.bets.map((bet) => chestPoints(BigInt(bet), chest.rewardBps).toString())).toEqual(entry.byBet);
  }
}

export interface ChestGameVectorV2 {
  mazeVector: number;
  n: number;
  finalSeed: Hex;
  /** Every cell but the start and the exit, with its kind and its draws under rule 2. */
  cells: { cell: number; kind: ChestKind; placed: boolean; rewardBps: number }[];
  chests: { cell: number; kind: ChestKind; rewardBps: number }[];
  points: { cell: number; byBet: string[] }[];
}

export const chestVectorsV2 = v2Json as unknown as {
  chestRule: number;
  deadEndTag: Hex;
  pathTag: Hex;
  bets: string[];
  raw: { finalSeed: Hex; cell: number; kind: ChestKind; placed: boolean; rewardBps: number }[];
  games: ChestGameVectorV2[];
};

export const chestGamesV2: ChestGameVectorV2[] = chestVectorsV2.games;

/** Recomputes one v2 vector game's cell kinds, draws, chests and points (rule 2) and compares. */
export function expectChestGameV2(game: ChestGameVectorV2): void {
  const maze = generateMaze(game.finalSeed, game.n);
  const kinds: { cell: number; kind: ChestKind }[] = [];
  for (let cell = 0; cell < game.n * game.n; cell++) {
    const kind = chestKindOf(maze, cell);
    if (kind !== null) kinds.push({ cell, kind });
  }
  expect(kinds).toEqual(game.cells.map(({ cell, kind }) => ({ cell, kind })));
  for (const entry of game.cells) {
    expect(chestDraw(game.finalSeed, entry.cell, 2, entry.kind)).toEqual({ placed: entry.placed, rewardBps: entry.rewardBps });
  }
  expect(chestsOf(game.finalSeed, maze, 2)).toEqual(game.chests);
  for (const entry of game.points) {
    const chest = game.chests.find((candidate) => candidate.cell === entry.cell)!;
    expect(chestVectorsV2.bets.map((bet) => chestPoints(BigInt(bet), chest.rewardBps).toString())).toEqual(entry.byBet);
  }
}
