// AC-P1: chest rule v1 (fixed vectors from an independent implementation, the draws, the
// sites, the points) and AC-P2: the verifier lists every chest after the reveal and checks the
// server's chest claim against the seed.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHEST_RATE_BPS,
  CHEST_REWARD_MAX_BPS,
  CHEST_REWARD_MIN_BPS,
  CHEST_RULE_VERSION,
  CHEST_TAG,
  POINT_UNIT_WEI,
  chestAt,
  chestConfig,
  chestDraw,
  chestPoints,
  chestsOf,
  commitmentOf,
  deriveFinalSeed,
  exitCell,
  generateMaze,
  isChestSite,
  isKnownChestRule,
  neighbor,
  openDirs,
  Outcome,
  parseTuning,
  refundWei,
  replayMoves,
  solve,
  verifyGame,
  type Dir,
  type Hex,
  type Maze,
  type Observation,
} from '../src';
import fixtureJson from './fixtures/tuning.fixture.json';
import { chestGames, chestVectors, expectChestGame } from './chest-vectors';
import { mazeVectors } from './vectors';

const table = parseTuning(fixtureJson);
const BET = 10n ** 16n;

function seedOf(label: string): Hex {
  return `0x${createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

/** Rule v1 written again from its description, with node:crypto; shares no code with the module. */
function referenceDraw(finalSeed: Hex, cell: number): { placed: boolean; rewardBps: number } {
  const counter = Buffer.alloc(2);
  counter.writeUInt16BE(cell);
  const digest = createHash('sha256')
    .update(Buffer.from(chestVectors.chestTag.slice(2), 'hex'))
    .update(Buffer.from(finalSeed.slice(2), 'hex'))
    .update(counter)
    .digest();
  const first = BigInt(`0x${digest.subarray(0, 16).toString('hex')}`);
  const second = BigInt(`0x${digest.subarray(16, 32).toString('hex')}`);
  return { placed: first % 10000n < 3000n, rewardBps: 1000 + Number(second % 2001n) };
}

/** Cells of the path from the start to `target` (the maze is a tree), both ends included. */
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

describe('AC-P1: chest rule v1', () => {
  it('AC-P1 the tag is keccak256("MazeBet.chest.v1") as Foundry computes it, and the constants are the approved design', () => {
    expect(CHEST_TAG).toBe(chestVectors.chestTag);
    expect(CHEST_RULE_VERSION).toBe(chestVectors.chestRule);
    expect([CHEST_RATE_BPS, CHEST_REWARD_MIN_BPS, CHEST_REWARD_MAX_BPS]).toEqual([3000, 1000, 3000]);
    expect(POINT_UNIT_WEI).toBe(10n ** 12n);
    expect(chestConfig()).toEqual({
      ruleVersion: 1,
      rateBps: 3000,
      rewardMinBps: 1000,
      rewardMaxBps: 3000,
      pointUnitWei: '1000000000000',
      cashValue: false,
    });
    expect(isKnownChestRule(1)).toBe(true);
    expect(isKnownChestRule(2)).toBe(false);
    expect(() => chestDraw(mazeVectors[0].finalSeed, 1, 2)).toThrow(RangeError);
  });

  it('AC-P1 the raw draws of the vectors pin the uint16be encoding of the cell', () => {
    for (const vector of chestVectors.raw) {
      expect(chestDraw(vector.finalSeed, vector.cell)).toEqual({ placed: vector.placed, rewardBps: vector.rewardBps });
    }
    expect(() => chestDraw(mazeVectors[0].finalSeed, 65536)).toThrow(RangeError);
    expect(() => chestDraw('0x1234' as Hex, 1)).toThrow(TypeError);
  });

  it('AC-P1 there is a vector game for every maze vector, and every size has one with chests', () => {
    expect(chestGames.map((game) => game.mazeVector)).toEqual(mazeVectors.map((vector) => vector.id));
    for (const n of new Set(mazeVectors.map((vector) => vector.n))) {
      expect(chestGames.some((game) => game.n === n && game.chests.length > 0)).toBe(true);
    }
  });

  it.each(chestGames)('AC-P1 vector game $mazeVector (n = $n): sites, chests and points are reproduced in Node', (game) => {
    expectChestGame(game);
  });

  it('AC-P1 matches an independent reference implementation on 3,000 draws', () => {
    const mismatches: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const finalSeed = seedOf(`chest reference #${i}`);
      const cell = (i * 37) % 400;
      const ours = chestDraw(finalSeed, cell);
      const theirs = referenceDraw(finalSeed, cell);
      if (ours.placed !== theirs.placed || ours.rewardBps !== theirs.rewardBps) mismatches.push(`#${i}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('AC-P1 about 30% of the draws place a chest, and rewards cover 1000 .. 3000 bps evenly', () => {
    const draws = 100_000;
    let placed = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < draws; i++) {
      const draw = chestDraw(seedOf(`chest rate ${i >> 6}`), i & 63);
      if (draw.placed) placed += 1;
      sum += draw.rewardBps;
      min = Math.min(min, draw.rewardBps);
      max = Math.max(max, draw.rewardBps);
    }
    // Six standard deviations of slack: sd = sqrt(0.3 × 0.7 / 100000) = 0.00145.
    expect(Math.abs(placed / draws - 0.3)).toBeLessThan(0.0087);
    // The mean reward of 1000 .. 3000 uniform is 2000, sd 577 / sqrt(100000) = 1.8.
    expect(Math.abs(sum / draws - 2000)).toBeLessThan(11);
    expect([min, max]).toEqual([1000, 3000]);
  });

  it('AC-P1 the chest sites are exactly the cells whose entry ends a game as a loss', () => {
    for (const n of [5, 7, 9, 10]) {
      for (let i = 0; i < 40; i++) {
        const maze = generateMaze(seedOf(`sites ${n} ${i}`), n);
        const exit = exitCell(maze);
        for (let cell = 1; cell < n * n; cell++) {
          const path = pathTo(maze, cell);
          if (path.slice(0, -1).includes(exit)) continue;
          const outcome = replayMoves(maze, dirsOf(path, n)).outcome;
          expect(isChestSite(maze, cell)).toBe(outcome === Outcome.Loss);
        }
        expect(isChestSite(maze, 0)).toBe(false);
        expect(isChestSite(maze, exit)).toBe(false);
      }
    }
  });

  it('AC-P1 chestAt reads the open mask of the asked cell and nothing else of the maze', () => {
    const base = generateMaze(mazeVectors[3].finalSeed, mazeVectors[3].n);
    const reads: string[] = [];
    const open = new Proxy(base.open, {
      get(target, property) {
        reads.push(String(property));
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const maze: Maze = { w: base.w, h: base.h, open };
    for (let cell = 0; cell < base.w * base.h; cell++) {
      reads.length = 0;
      chestAt(mazeVectors[3].finalSeed, maze, cell);
      expect(reads.filter((read) => read !== String(cell))).toEqual([]);
    }
  });

  it('AC-P1 points are the bet times the reward over 10^16, rounded down once, and proportional to the bet', () => {
    expect(chestPoints(10n ** 15n, 1000)).toBe(100n);
    expect(chestPoints(10n ** 15n, 1005)).toBe(100n);
    expect(chestPoints(10n ** 15n, 3000)).toBe(300n);
    expect(chestPoints(10n ** 15n - 1n, 3000)).toBe(299n);
    expect(chestPoints(10n ** 17n, 3000)).toBe(30_000n);
    expect(chestPoints(12_345_678_901_234_567n, 1999)).toBe(2_467n);
    expect(chestPoints(0n, 3000)).toBe(0n);
    // One floor of the exact product, not a floor per step.
    expect(chestPoints(3n * 10n ** 12n, 3333)).toBe(0n);
    expect(chestPoints(3n * 10n ** 16n, 3333)).toBe(9999n);
    // At the minimum bet a chest is worth bps / 10 points rounded down, at the maximum bps × 10:
    // the same share of the bet, so a small bet is not paid more per wei.
    for (const bps of [1000, 1517, 2999, 3000]) {
      expect(chestPoints(10n ** 15n, bps)).toBe(BigInt(Math.floor(bps / 10)));
      expect(chestPoints(10n ** 17n, bps)).toBe(BigInt(bps) * 10n);
    }
    expect(() => chestPoints(-1n, 1000)).toThrow(RangeError);
    expect(() => chestPoints(10n ** 15n, 10_001)).toThrow(RangeError);
  });
});

// ----- the verifier -----

interface Seeds {
  serverSeed: Hex;
  clientSeed: Hex;
  gameId: Hex;
}

interface Planned {
  seeds: Seeds;
  maze: Maze;
  finalSeed: Hex;
  moves: Dir[];
  cell: number;
}

/** The first seeds (by label) whose 5×5 maze has a dead end, reachable before the exit, that does (or does not) hold a chest. */
function deadEndGame(withChest: boolean): Planned {
  for (let i = 0; i < 500; i++) {
    const seeds = {
      serverSeed: seedOf(`chest verify ${i} server`),
      clientSeed: seedOf(`chest verify ${i} client`),
      gameId: seedOf(`chest verify ${i} game`),
    };
    const finalSeed = deriveFinalSeed(seeds);
    const maze = generateMaze(finalSeed, 5);
    for (let cell = 1; cell < 24; cell++) {
      if (!isChestSite(maze, cell)) continue;
      const path = pathTo(maze, cell);
      if (path.includes(24)) continue;
      if ((chestAt(finalSeed, maze, cell) !== null) === withChest) {
        return { seeds, maze, finalSeed, moves: dirsOf(path, 5), cell };
      }
    }
  }
  throw new Error('no such game among 500 seeds');
}

function args(
  planned: Planned,
  settled: { outcome: Outcome; steps: number; payoutWei: bigint },
  moves: Dir[] = planned.moves,
): Parameters<typeof verifyGame>[0] {
  const { maze } = planned;
  const observations: Observation[] = replayMoves(maze, moves).path.map((cell, step) => ({
    step,
    cell,
    open: maze.open[cell],
  }));
  return {
    table,
    tier: 0,
    commitment: commitmentOf({ mazeVersion: table.mazeVersion, n: 5, serverSeed: planned.seeds.serverSeed }),
    ...planned.seeds,
    observations,
    moves,
    settled: { ...settled, betWei: BET },
  };
}

const lossOf = (planned: Planned) => ({ outcome: Outcome.Loss, steps: planned.moves.length, payoutWei: 0n });

describe('AC-P2: the verifier and chests', () => {
  const rich = deadEndGame(true);
  const empty = deadEndGame(false);
  const chest = chestAt(rich.finalSeed, rich.maze, rich.cell)!;
  const honestFound = {
    cell: chest.cell,
    rewardBps: chest.rewardBps,
    points: chestPoints(BET, chest.rewardBps).toString(),
  };

  it('AC-P2 lists every chest of the revealed maze and confirms an awarded chest that matches the seed', () => {
    const report = verifyGame({ ...args(rich, lossOf(rich)), chest: { rule: 1, found: honestFound } });
    expect(report.outcomeOk).toBe(true);
    expect(report.chestRule).toBe(1);
    expect(report.chests).toEqual(chestsOf(rich.finalSeed, rich.maze));
    expect(report.chests).toContainEqual(chest);
    expect(report.expectedChest).toEqual({ ...chest, points: chestPoints(BET, chest.rewardBps) });
    expect(report.chestOk).toBe(true);
  });

  it('AC-P2 a chest hidden from a player who entered a chest cell is a mismatch', () => {
    const report = verifyGame({ ...args(rich, lossOf(rich)), chest: { rule: 1, found: null } });
    expect(report.chestOk).toBe(false);
    expect(report.expectedChest).not.toBeNull();
  });

  it('AC-P2 a moved, misvalued or invented chest is a mismatch; an empty dead end called empty is not', () => {
    const base = args(rich, lossOf(rich));
    const wrong = [
      { ...honestFound, rewardBps: honestFound.rewardBps === 3000 ? 2999 : honestFound.rewardBps + 1 },
      { ...honestFound, points: (BigInt(honestFound.points) + 1n).toString() },
      { ...honestFound, cell: (honestFound.cell + 1) % 25 },
      { ...honestFound, points: 'many' },
    ];
    for (const found of wrong) expect(verifyGame({ ...base, chest: { rule: 1, found } }).chestOk).toBe(false);

    const emptyArgs = args(empty, lossOf(empty));
    expect(verifyGame({ ...emptyArgs, chest: { rule: 1, found: null } }).chestOk).toBe(true);
    expect(verifyGame({ ...emptyArgs, chest: { rule: 1, found: null } }).expectedChest).toBeNull();
    const invented = { cell: empty.cell, rewardBps: 2000, points: chestPoints(BET, 2000).toString() };
    expect(verifyGame({ ...emptyArgs, chest: { rule: 1, found: invented } }).chestOk).toBe(false);
  });

  it('AC-P2 a game that did not end in a dead end has no chest to award', () => {
    const exitMoves = dirsOf(solve(rich.maze), 5);
    const exit = args(rich, { outcome: Outcome.Exit, steps: exitMoves.length, payoutWei: 0n }, exitMoves);
    expect(verifyGame(exit).chestOk).toBe(true);
    expect(verifyGame(exit).expectedChest).toBeNull();
    const cash = args(
      rich,
      { outcome: Outcome.CashOut, steps: 1, payoutWei: refundWei(table, BET, 0, 1) },
      rich.moves.slice(0, 1),
    );
    expect(verifyGame(cash).chestOk).toBe(true);
    expect(verifyGame({ ...cash, chest: { rule: 1, found: honestFound } }).chestOk).toBe(false);
  });

  it('AC-P2 nothing is compared without a claim for a dead end, with an unknown rule, or for moves that do not replay', () => {
    expect(verifyGame(args(rich, lossOf(rich))).chestOk).toBeNull();
    const unknown = verifyGame({ ...args(rich, lossOf(rich)), chest: { rule: 2, found: honestFound } });
    expect(unknown.chestOk).toBeNull();
    expect(unknown.chests).toBeNull();
    expect(unknown.chestRule).toBe(2);
    const broken = args(rich, lossOf(rich));
    broken.moves = [...rich.moves, 0];
    expect(verifyGame({ ...broken, chest: { rule: 1, found: honestFound } }).chestOk).toBeNull();
  });

  it('AC-P2 without a known bet the points are not compared', () => {
    const base = args(rich, lossOf(rich));
    const unknownBet = { ...base, settled: { ...base.settled, betWei: 0n } };
    const report = verifyGame({ ...unknownBet, chest: { rule: 1, found: { ...honestFound, points: '1' } } });
    expect(report.chestOk).toBe(true);
    expect(report.expectedChest?.points).toBe(0n);
  });
});
