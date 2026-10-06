// Shared by the Node and the browser-environment runs of the chest vectors (AC-P1), like
// vectors.ts for the maze vectors.

import { expect } from 'vitest';
import { chestAt, chestPoints, chestsOf, generateMaze, isChestSite, type Hex } from '../src';
import vectorsJson from './vectors/chest-v1.json';

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

/** Recomputes one vector game's sites, chests and points from its final seed and compares. */
export function expectChestGame(game: ChestGameVector): void {
  const maze = generateMaze(game.finalSeed, game.n);
  const sites: number[] = [];
  for (let cell = 0; cell < game.n * game.n; cell++) if (isChestSite(maze, cell)) sites.push(cell);
  expect(sites).toEqual(game.sites.map((site) => site.cell));
  for (const site of game.sites) {
    expect(chestAt(game.finalSeed, maze, site.cell)).toEqual(
      site.placed ? { cell: site.cell, rewardBps: site.rewardBps } : null,
    );
  }
  expect(chestsOf(game.finalSeed, maze)).toEqual(game.chests);
  for (const entry of game.points) {
    const chest = game.chests.find((candidate) => candidate.cell === entry.cell)!;
    expect(chestVectors.bets.map((bet) => chestPoints(BigInt(bet), chest.rewardBps).toString())).toEqual(entry.byBet);
  }
}
