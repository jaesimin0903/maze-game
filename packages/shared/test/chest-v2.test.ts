// AC-P9: chest rule v2 (dead ends as in v1, plus chests on path cells) and its verification.
// Fixed vectors from an independent implementation, the draws, the independence of a cell's
// chest from every other cell, and the verifier: every chest on an entered cell must have been
// awarded, nothing else may have been, and rule 1 records verify exactly as before.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHEST_RULE_VERSION,
  CHEST_TAG,
  PATH_CHEST_RATE_BPS,
  PATH_CHEST_REWARD_MAX_BPS,
  PATH_CHEST_REWARD_MIN_BPS,
  PATH_CHEST_TAG,
  chestAt,
  chestConfig,
  chestDraw,
  chestKindOf,
  chestPoints,
  chestsOf,
  commitmentOf,
  deriveFinalSeed,
  exitCell,
  generateMaze,
  isKnownChestRule,
  neighbor,
  openDirs,
  Outcome,
  parseTuning,
  refundWei,
  replayMoves,
  solve,
  verifyGame,
  type Chest,
  type Dir,
  type Hex,
  type Maze,
  type Observation,
} from '../src';
import fixtureJson from './fixtures/tuning.fixture.json';
import { chestGamesV2, chestVectorsV2, expectChestGameV2 } from './chest-vectors';
import { mazeVectors } from './vectors';

const table = parseTuning(fixtureJson);
const BET = 10n ** 16n;
/** The fixture table's middle size. */
const TIER = 1;
const N = table.tiers[TIER].n;

function seedOf(label: string): Hex {
  return `0x${createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

/** The path draw of rule v2 written again from its description, with node:crypto. */
function referencePathDraw(finalSeed: Hex, cell: number): { placed: boolean; rewardBps: number } {
  const counter = Buffer.alloc(2);
  counter.writeUInt16BE(cell);
  const digest = createHash('sha256')
    .update(Buffer.from(chestVectorsV2.pathTag.slice(2), 'hex'))
    .update(Buffer.from(finalSeed.slice(2), 'hex'))
    .update(counter)
    .digest();
  const first = BigInt(`0x${digest.subarray(0, 16).toString('hex')}`);
  const second = BigInt(`0x${digest.subarray(16, 32).toString('hex')}`);
  return { placed: first % 10000n < 1000n, rewardBps: 200 + Number(second % 301n) };
}

function pathTo(maze: Maze, target: number): number[] {
  const parent = new Map<number, number>([[0, 0]]);
  const queue = [0];
  for (let head = 0; head < queue.length; head++) {
    for (const dir of openDirs(maze, queue[head])) {
      const next = neighbor(maze, queue[head], dir)!;
      if (!parent.has(next)) {
        parent.set(next, queue[head]);
        queue.push(next);
      }
    }
  }
  const path = [target];
  while (path[0] !== 0) path.unshift(parent.get(path[0])!);
  return path;
}

function dirsOf(path: number[], w: number): Dir[] {
  return path.slice(1).map((cell, i) => {
    const delta = cell - path[i];
    return delta === -w ? 0 : delta === 1 ? 1 : delta === w ? 2 : 3;
  });
}

describe('AC-P9: chest rule v2', () => {
  it('AC-P9 the path tag is keccak256("MazeBet.chest.v2") as Foundry computes it, dead ends keep the v1 tag, and new games use rule 2', () => {
    expect(PATH_CHEST_TAG).toBe(chestVectorsV2.pathTag);
    expect(CHEST_TAG).toBe(chestVectorsV2.deadEndTag);
    expect(chestVectorsV2.chestRule).toBe(2);
    expect(CHEST_RULE_VERSION).toBe(2);
    expect(isKnownChestRule(2)).toBe(true);
    expect([PATH_CHEST_RATE_BPS, PATH_CHEST_REWARD_MIN_BPS, PATH_CHEST_REWARD_MAX_BPS]).toEqual([1000, 200, 500]);
    expect(chestConfig()).toEqual({
      ruleVersion: 2,
      rateBps: 3000,
      rewardMinBps: 1000,
      rewardMaxBps: 3000,
      pointUnitWei: '1000000000000',
      cashValue: false,
      pathRateBps: 1000,
      pathRewardMinBps: 200,
      pathRewardMaxBps: 500,
    });
  });

  it('AC-P9 the raw path draws of the vectors pin the uint16be encoding of the cell', () => {
    for (const vector of chestVectorsV2.raw) {
      expect(chestDraw(vector.finalSeed, vector.cell, 2, 'path')).toEqual({ placed: vector.placed, rewardBps: vector.rewardBps });
    }
  });

  it('AC-P9 there is a v2 vector game for every maze vector, with path chests in every size', () => {
    expect(chestGamesV2.map((game) => game.mazeVector)).toEqual(mazeVectors.map((vector) => vector.id));
    for (const n of new Set(mazeVectors.map((vector) => vector.n))) {
      expect(chestGamesV2.some((game) => game.n === n && game.chests.some((chest) => chest.kind === 'path'))).toBe(true);
    }
  });

  it.each(chestGamesV2)('AC-P9 vector game $mazeVector (n = $n): kinds, draws, chests and points are reproduced in Node', (game) => {
    expectChestGameV2(game);
  });

  it('AC-P9 dead ends draw exactly as in rule v1, and the path draw matches an independent reference on 3,000 draws', () => {
    const mismatches: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const finalSeed = seedOf(`chest v2 reference #${i}`);
      const cell = (i * 41) % 400;
      const ours = chestDraw(finalSeed, cell, 2, 'path');
      const theirs = referencePathDraw(finalSeed, cell);
      if (ours.placed !== theirs.placed || ours.rewardBps !== theirs.rewardBps) mismatches.push(`path #${i}`);
      const v1 = chestDraw(finalSeed, cell, 1, 'dead-end');
      const v2 = chestDraw(finalSeed, cell, 2, 'dead-end');
      if (v1.placed !== v2.placed || v1.rewardBps !== v2.rewardBps) mismatches.push(`dead end #${i}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('AC-P9 about 10% of path cells hold a chest, and path rewards cover 200 .. 500 bps evenly', () => {
    const draws = 100_000;
    let placed = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < draws; i++) {
      const draw = chestDraw(seedOf(`path rate ${i >> 6}`), i & 63, 2, 'path');
      if (draw.placed) placed += 1;
      sum += draw.rewardBps;
      min = Math.min(min, draw.rewardBps);
      max = Math.max(max, draw.rewardBps);
    }
    // Six standard deviations: sd = sqrt(0.1 × 0.9 / 100000) = 0.00095.
    expect(Math.abs(placed / draws - 0.1)).toBeLessThan(0.0057);
    // Mean of 200 .. 500 uniform is 350, sd 87 / sqrt(100000) = 0.28.
    expect(Math.abs(sum / draws - 350)).toBeLessThan(2);
    expect([min, max]).toEqual([200, 500]);
  });

  it("AC-P9 a cell's kind comes from its own openings: start and exit hold nothing, one opening is a dead end, more is a path cell", () => {
    for (const vector of mazeVectors) {
      const maze = generateMaze(vector.finalSeed, vector.n);
      for (let cell = 0; cell < maze.w * maze.h; cell++) {
        const openings = openDirs(maze, cell).length;
        const expected = cell === 0 || cell === exitCell(maze) ? null : openings === 1 ? 'dead-end' : 'path';
        expect(chestKindOf(maze, cell)).toBe(expected);
      }
    }
  });

  it("AC-P9 a cell's chest depends on no other cell: changing every other cell leaves it unchanged, and path cells on and off the solution hold chests at the same rate", () => {
    // Deterministic part: rewrite every other cell's walls; the chest of the cell stays the same.
    for (const vector of mazeVectors) {
      const maze = generateMaze(vector.finalSeed, vector.n);
      for (let cell = 0; cell < maze.w * maze.h; cell++) {
        const scrambled: Maze = {
          w: maze.w,
          h: maze.h,
          open: Uint8Array.from(maze.open, (mask, at) => (at === cell ? mask : (mask * 7 + at) & 15)),
        };
        expect(chestAt(vector.finalSeed, scrambled, cell, 2)).toEqual(chestAt(vector.finalSeed, maze, cell, 2));
      }
    }
    // Statistical part: on the solution path or not, a path cell holds a chest 10% of the time, so a
    // chest found says nothing about where the exit is.
    const count = { on: 0, onChests: 0, off: 0, offChests: 0 };
    for (let i = 0; i < 3000; i++) {
      const finalSeed = seedOf(`independence ${i}`);
      const maze = generateMaze(finalSeed, 7);
      const solution = new Set(solve(maze));
      for (let cell = 0; cell < 49; cell++) {
        if (chestKindOf(maze, cell) !== 'path') continue;
        const has = chestAt(finalSeed, maze, cell, 2) !== null;
        if (solution.has(cell)) {
          count.on += 1;
          if (has) count.onChests += 1;
        } else {
          count.off += 1;
          if (has) count.offChests += 1;
        }
      }
    }
    const on = count.onChests / count.on;
    const off = count.offChests / count.off;
    const se = Math.sqrt(0.09 / count.on + 0.09 / count.off);
    expect(Math.abs(on - off)).toBeLessThan(5 * se);
    expect(Math.abs(on - 0.1)).toBeLessThan(0.01);
  });
});

// ----- the verifier -----

interface Planned {
  seeds: { serverSeed: Hex; clientSeed: Hex; gameId: Hex };
  maze: Maze;
  finalSeed: Hex;
  moves: Dir[];
  cells: number[];
}

/** The first seeds (by label) whose 7×7 maze has a route of the asked shape through at least one path chest. */
function plan(shape: 'exit' | 'dead-end', label: string): Planned {
  for (let i = 0; i < 2000; i++) {
    const seeds = {
      serverSeed: seedOf(`${label} ${i} server`),
      clientSeed: seedOf(`${label} ${i} client`),
      gameId: seedOf(`${label} ${i} game`),
    };
    const finalSeed = deriveFinalSeed(seeds);
    const maze = generateMaze(finalSeed, N);
    const exit = exitCell(maze);
    const candidates: number[][] =
      shape === 'exit'
        ? [solve(maze)]
        : Array.from({ length: N * N }, (_, cell) => cell)
            .filter((cell) => chestKindOf(maze, cell) === 'dead-end' && chestAt(finalSeed, maze, cell, 2) !== null)
            .map((cell) => pathTo(maze, cell))
            .filter((cells) => !cells.includes(exit));
    for (const cells of candidates) {
      const paths = cells.slice(1).filter((cell) => chestAt(finalSeed, maze, cell, 2)?.kind === 'path');
      if (paths.length >= 1) return { seeds, maze, finalSeed, moves: dirsOf(cells, N), cells };
    }
  }
  throw new Error(`no ${shape} route with a path chest among 2000 seeds`);
}

function args(
  planned: Planned,
  settled: { outcome: Outcome; steps: number; payoutWei: bigint },
  moves: Dir[] = planned.moves,
): Parameters<typeof verifyGame>[0] {
  const { maze } = planned;
  const observations: Observation[] = replayMoves(maze, moves).path.map((cell, step) => ({ step, cell, open: maze.open[cell] }));
  return {
    table,
    tier: TIER,
    commitment: commitmentOf({ mazeVersion: table.mazeVersion, n: N, serverSeed: planned.seeds.serverSeed }),
    ...planned.seeds,
    observations,
    moves,
    settled: { ...settled, betWei: BET },
  };
}

const claimOf = (chest: Chest) => ({
  cell: chest.cell,
  kind: chest.kind,
  rewardBps: chest.rewardBps,
  points: chestPoints(BET, chest.rewardBps).toString(),
});

describe('AC-P9: the verifier and rule v2', () => {
  const exitGame = plan('exit', 'v2 verify exit');
  const lossGame = plan('dead-end', 'v2 verify loss');
  const visitedChests = (planned: Planned): Chest[] =>
    planned.cells
      .slice(1)
      .map((cell) => chestAt(planned.finalSeed, planned.maze, cell, 2))
      .filter((chest): chest is Chest => chest !== null);

  it('AC-P9 an exit game with path chests on its way verifies when every one of them was awarded', () => {
    const awarded = visitedChests(exitGame);
    expect(awarded.every((chest) => chest.kind === 'path')).toBe(true);
    const base = args(exitGame, { outcome: Outcome.Exit, steps: exitGame.moves.length, payoutWei: 0n });
    const report = verifyGame({ ...base, chest: { rule: 2, found: null, awards: awarded.map(claimOf) } });
    expect(report.chestRule).toBe(2);
    expect(report.chests).toEqual(chestsOf(exitGame.finalSeed, exitGame.maze, 2));
    expect(report.expectedChests.map((chest) => chest.cell)).toEqual(awarded.map((chest) => chest.cell));
    expect(report.expectedChest).toBeNull();
    expect(report.chestOk).toBe(true);
  });

  it('AC-P9 a withheld, invented, moved or misvalued path chest is a mismatch', () => {
    const awarded = visitedChests(exitGame).map(claimOf);
    const base = args(exitGame, { outcome: Outcome.Exit, steps: exitGame.moves.length, payoutWei: 0n });
    const check = (awards: typeof awarded): boolean | null => verifyGame({ ...base, chest: { rule: 2, found: null, awards } }).chestOk;
    expect(check(awarded.slice(1))).toBe(false);
    const emptyVisited = exitGame.cells.slice(1, -1).find((cell) => chestAt(exitGame.finalSeed, exitGame.maze, cell, 2) === null)!;
    expect(check([...awarded, { cell: emptyVisited, kind: 'path', rewardBps: 300, points: chestPoints(BET, 300).toString() }])).toBe(false);
    const unvisited = Array.from({ length: N * N }, (_, cell) => cell).find((cell) => !exitGame.cells.includes(cell))!;
    expect(check([...awarded, { cell: unvisited, kind: 'path', rewardBps: 300, points: '0' }])).toBe(false);
    expect(check([{ ...awarded[0], rewardBps: awarded[0].rewardBps === 500 ? 499 : awarded[0].rewardBps + 1 }, ...awarded.slice(1)])).toBe(false);
    expect(check([{ ...awarded[0], points: (BigInt(awarded[0].points) + 1n).toString() }, ...awarded.slice(1)])).toBe(false);
    expect(check([{ ...awarded[0], kind: 'dead-end' }, ...awarded.slice(1)])).toBe(false);
    expect(check([...awarded, awarded[0]])).toBe(false);
    // A rule 2 claim that names no path chests withholds them.
    expect(verifyGame({ ...base, chest: { rule: 2, found: null } }).chestOk).toBe(false);
  });

  it('AC-P9 a game that walked past path chests into a dead-end chest verifies with all of them, and the dead-end chest named on its own', () => {
    const awarded = visitedChests(lossGame).map(claimOf);
    const dead = awarded.find((chest) => chest.kind === 'dead-end')!;
    expect(dead.cell).toBe(lossGame.cells.at(-1));
    expect(awarded.filter((chest) => chest.kind === 'path').length).toBeGreaterThan(0);
    const base = args(lossGame, { outcome: Outcome.Loss, steps: lossGame.moves.length, payoutWei: 0n });
    expect(verifyGame({ ...base, chest: { rule: 2, found: dead, awards: awarded } }).chestOk).toBe(true);
    expect(verifyGame({ ...base, chest: { rule: 2, found: null, awards: awarded } }).chestOk).toBe(false);
    expect(
      verifyGame({ ...base, chest: { rule: 2, found: dead, awards: awarded.filter((chest) => chest.kind === 'dead-end') } }).chestOk,
    ).toBe(false);
  });

  it('AC-P9 a cash-out keeps the path chests found before it, and an unfinished record lists rule 2 chests when told the rule', () => {
    const k = Math.max(
      ...exitGame.cells.slice(1, -1).map((cell, i) => (chestAt(exitGame.finalSeed, exitGame.maze, cell, 2) === null ? 0 : i + 1)),
    );
    const moves = exitGame.moves.slice(0, k);
    const base = args(exitGame, { outcome: Outcome.CashOut, steps: k, payoutWei: refundWei(table, BET, TIER, k) }, moves);
    const awarded = exitGame.cells
      .slice(1, k + 1)
      .map((cell) => chestAt(exitGame.finalSeed, exitGame.maze, cell, 2))
      .filter((chest): chest is Chest => chest !== null)
      .map(claimOf);
    expect(awarded.length).toBeGreaterThan(0);
    expect(verifyGame({ ...base, chest: { rule: 2, found: null, awards: awarded } }).chestOk).toBe(true);
    const unclaimed = verifyGame({ ...base, chestRule: 2 });
    expect(unclaimed.chestOk).toBeNull();
    expect(unclaimed.chests).toEqual(chestsOf(exitGame.finalSeed, exitGame.maze, 2));
  });

  it('AC-P9 a rule 1 record of the same game verifies exactly as before: dead ends only, path cells hold nothing', () => {
    const base = args(lossGame, { outcome: Outcome.Loss, steps: lossGame.moves.length, payoutWei: 0n });
    const dead = chestAt(lossGame.finalSeed, lossGame.maze, lossGame.cells.at(-1)!, 1)!;
    const found = { cell: dead.cell, rewardBps: dead.rewardBps, points: chestPoints(BET, dead.rewardBps).toString() };
    const report = verifyGame({ ...base, chest: { rule: 1, found } });
    expect(report.chestOk).toBe(true);
    expect(report.chests!.every((chest) => chest.kind === 'dead-end')).toBe(true);
    expect(report.expectedChests).toEqual([{ ...dead, points: chestPoints(BET, dead.rewardBps) }]);
    expect(verifyGame({ ...base, chest: { rule: 1, found: null } }).chestOk).toBe(false);
    // Without a claim and without a rule, a record is read as rule 1.
    expect(verifyGame(base).chestRule).toBe(1);
  });
});
