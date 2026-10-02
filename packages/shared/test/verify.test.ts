import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  commitmentOf,
  deriveFinalSeed,
  exitPayoutWei,
  generateMaze,
  loadTuning,
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
  type TuningTable,
} from '../src';
import fixtureJson from './fixtures/tuning.fixture.json';
import { mazeVectors, openHex } from './vectors';

const table = parseTuning(fixtureJson);
const BET = 10n ** 16n;

interface Seeds {
  n: number;
  serverSeed: Hex;
  clientSeed: Hex;
  gameId: Hex;
}

const production = loadTuning();

/** The table a game of size `n` is played on: the test table, or the production table for a size only it has. */
const tableOf = (n: number): TuningTable => (table.tiers.some((tier) => tier.n === n) ? table : production);
const tierOf = (n: number): number => tableOf(n).tiers.findIndex((tier) => tier.n === n);
/** Every board size one of the two tables offers. */
const SIZES = [...new Set([...table.tiers, ...production.tiers].map((tier) => tier.n))].sort((a, b) => a - b);
const mazeOf = (seeds: Seeds): Maze => generateMaze(deriveFinalSeed(seeds), seeds.n);

function seedOf(label: string): Hex {
  return `0x${createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

function dirsOf(path: number[], w: number): Dir[] {
  return path.slice(1).map((cell, i) => {
    const delta = cell - path[i];
    return delta === -w ? 0 : delta === 1 ? 1 : delta === w ? 2 : 3;
  });
}

/** Moves into the first dead end whose path from the start does not run through the exit. */
function movesToDeadEnd(maze: Maze): Dir[] {
  const exit = maze.w * maze.h - 1;
  const parent = new Map<number, number>([[0, 0]]);
  const queue = [0];
  for (const cell of queue) {
    for (const dir of openDirs(maze, cell)) {
      const next = cell + [-maze.w, 1, maze.w, -1][dir];
      if (!parent.has(next)) {
        parent.set(next, cell);
        queue.push(next);
      }
    }
  }
  for (let leaf = 1; leaf < exit; leaf++) {
    if (openDirs(maze, leaf).length !== 1) continue;
    const path = [leaf];
    while (path[0] !== 0) path.unshift(parent.get(path[0])!);
    if (!path.includes(exit)) return dirsOf(path, maze.w);
  }
  throw new Error('this maze has no dead end before the exit');
}

/** The record an honest server would have produced for these moves, as verifier arguments. */
function game(
  seeds: Seeds,
  moves: Dir[],
  settled: { outcome: Outcome; steps: number; payoutWei: bigint },
): Parameters<typeof verifyGame>[0] {
  const maze = mazeOf(seeds);
  const observations: Observation[] = replayMoves(maze, moves).path.map((cell, step) => ({
    step,
    cell,
    open: maze.open[cell],
  }));
  return {
    table: tableOf(seeds.n),
    tier: tierOf(seeds.n),
    commitment: commitmentOf({ mazeVersion: tableOf(seeds.n).mazeVersion, n: seeds.n, serverSeed: seeds.serverSeed }),
    serverSeed: seeds.serverSeed,
    clientSeed: seeds.clientSeed,
    gameId: seeds.gameId,
    observations,
    moves,
    settled: { ...settled, betWei: BET },
  };
}

function exitGame(seeds: Seeds): Parameters<typeof verifyGame>[0] {
  const moves = dirsOf(solve(mazeOf(seeds)), seeds.n);
  return game(seeds, moves, {
    outcome: Outcome.Exit,
    steps: moves.length,
    payoutWei: exitPayoutWei(tableOf(seeds.n), BET, tierOf(seeds.n)),
  });
}

function cashOutGame(seeds: Seeds, k: number): Parameters<typeof verifyGame>[0] {
  const moves = dirsOf(solve(mazeOf(seeds)), seeds.n).slice(0, k);
  return game(seeds, moves, {
    outcome: Outcome.CashOut,
    steps: k,
    payoutWei: refundWei(tableOf(seeds.n), BET, tierOf(seeds.n), k),
  });
}

function lossGame(seeds: Seeds): Parameters<typeof verifyGame>[0] {
  const moves = movesToDeadEnd(mazeOf(seeds));
  return game(seeds, moves, { outcome: Outcome.Loss, steps: moves.length, payoutWei: 0n });
}

const flags = (report: ReturnType<typeof verifyGame>): boolean[] => [
  report.commitmentOk,
  report.outcomeOk,
  report.payoutOk,
  report.cells.every((cell) => cell.match),
];

const first = mazeVectors[0];
/** The fixed vectors of the sizes a table offers (a table switch can retire a size). */
const playableVectors = mazeVectors.filter((vector) => SIZES.includes(vector.n));

describe('verifyGame', () => {
  it.each(playableVectors)(
    'AC-M6 vector $id: an exit game verifies from the commitment, the client seed, the game id and the revealed server seed',
    (vector) => {
      const params = exitGame(vector);
      expect(params.commitment).toBe(vector.commitment);
      const report = verifyGame(params);
      expect(report.commitmentOk).toBe(true);
      expect(report.finalSeed).toBe(vector.finalSeed);
      expect(openHex(report.maze.open)).toBe(vector.open);
      expect(report.solution).toEqual(vector.solution);
      expect(report.cells).toHaveLength(vector.solution.length);
      expect(report.cells.map((cell) => cell.cell)).toEqual(vector.solution);
      expect(report.cells.every((cell) => cell.match && cell.observed === cell.actual)).toBe(true);
      expect(report.outcomeOk).toBe(true);
      expect(report.payoutOk).toBe(true);
    },
  );

  it('AC-M5 changing one wall of the record marks exactly that cell as a mismatch', () => {
    const honest = exitGame(first);
    for (let i = 0; i < honest.observations.length; i++) {
      for (const bit of [1, 2, 4, 8]) {
        const observations = honest.observations.map((observation, j) =>
          j === i ? { ...observation, open: observation.open ^ bit } : observation,
        );
        const report = verifyGame({ ...honest, observations });
        expect(report.cells.map((cell) => cell.match)).toEqual(honest.observations.map((_, j) => j !== i));
        expect(report.cells[i]).toEqual({
          cell: honest.observations[i].cell,
          observed: honest.observations[i].open ^ bit,
          actual: honest.observations[i].open,
          match: false,
        });
        expect([report.commitmentOk, report.outcomeOk, report.payoutOk]).toEqual([true, true, true]);
      }
    }
  });

  it('AC-M6 a server seed other than the committed one fails the commitment check', () => {
    const honest = exitGame(first);
    const report = verifyGame({ ...honest, serverSeed: seedOf('another server seed') });
    expect(report.commitmentOk).toBe(false);
    expect(openHex(report.maze.open)).not.toBe(first.open);
  });

  it('AC-M6 the commitment binds the size and the maze version', () => {
    const honest = exitGame(first);
    const otherSize = commitmentOf({ mazeVersion: table.mazeVersion, n: 7, serverSeed: first.serverSeed });
    const otherVersion = commitmentOf({ mazeVersion: 2, n: first.n, serverSeed: first.serverSeed });
    expect(verifyGame({ ...honest, commitment: otherSize }).commitmentOk).toBe(false);
    expect(verifyGame({ ...honest, commitment: otherVersion }).commitmentOk).toBe(false);
    const upper = `0x${honest.commitment.slice(2).toUpperCase()}` as Hex;
    expect(verifyGame({ ...honest, commitment: upper }).commitmentOk).toBe(true);
  });

  it('a cash-out game verifies, k = 0 included, and a wrong amount or step count does not', () => {
    for (const k of [0, 1, 3, 7]) {
      const honest = cashOutGame(first, k);
      expect(flags(verifyGame(honest))).toEqual([true, true, true, true]);

      const overpaid = { ...honest, settled: { ...honest.settled, payoutWei: honest.settled.payoutWei + 1n } };
      expect(flags(verifyGame(overpaid))).toEqual([true, true, false, true]);
    }
    expect(cashOutGame(first, 0).settled.payoutWei).toBe((BET * 9500n) / 10000n);

    // Three recorded moves but a settlement that claims two.
    const honest = cashOutGame(first, 3);
    const shortSteps = {
      ...honest,
      settled: { ...honest.settled, steps: 2, payoutWei: refundWei(table, BET, 0, 2) },
    };
    const report = verifyGame(shortSteps);
    expect(report.outcomeOk).toBe(false);
    expect(report.payoutOk).toBe(true); // the amount is right for the claimed step count
  });

  it('a loss verifies with a zero payout only', () => {
    const honest = lossGame(first);
    expect(honest.settled.steps).toBeGreaterThan(0);
    expect(flags(verifyGame(honest))).toEqual([true, true, true, true]);
    const paid = { ...honest, settled: { ...honest.settled, payoutWei: 1n } };
    expect(flags(verifyGame(paid))).toEqual([true, true, false, true]);
  });

  it('the settled outcome must be the one the moves lead to', () => {
    const exit = exitGame(first);
    const loss = lossGame(first);

    // Moves that reach the exit, settled as a loss.
    const robbed = { ...exit, settled: { ...exit.settled, outcome: Outcome.Loss, payoutWei: 0n } };
    expect(flags(verifyGame(robbed))).toEqual([true, false, true, true]);

    // Moves that end in a dead end, settled as an exit with the full payout.
    const gifted = { ...loss, settled: { ...loss.settled, outcome: Outcome.Exit, payoutWei: exit.settled.payoutWei } };
    expect(flags(verifyGame(gifted))).toEqual([true, false, true, true]);

    // A cash-out claimed at the step where the walk had already ended in a dead end.
    const late = {
      ...loss,
      settled: {
        ...loss.settled,
        outcome: Outcome.CashOut,
        payoutWei: refundWei(table, BET, 0, loss.settled.steps),
      },
    };
    expect(flags(verifyGame(late))).toEqual([true, false, true, true]);
  });

  it('tampered moves fail the outcome check and unseat the observations after them', () => {
    const honest = exitGame(first);
    // Vector 1 starts S, S, E; replacing the third move by W runs into the outer wall.
    const moves = [...honest.moves];
    moves[2] = 3;
    const report = verifyGame({ ...honest, moves });
    expect(report.outcomeOk).toBe(false);
    expect(report.cells.map((cell) => cell.match)).toEqual(honest.observations.map((_, j) => j <= 2));
  });

  it('true walls reported for a cell the moves do not lead to are a mismatch', () => {
    const honest = exitGame(first);
    const maze = mazeOf(first);
    const elsewhere = 12; // not on the solution of vector 1
    expect(first.solution).not.toContain(elsewhere);
    const observations = honest.observations.map((observation, j) =>
      j === 2 ? { step: 2, cell: elsewhere, open: maze.open[elsewhere] } : observation,
    );
    const report = verifyGame({ ...honest, observations });
    expect(report.cells[2]).toEqual({
      cell: elsewhere,
      observed: maze.open[elsewhere],
      actual: maze.open[elsewhere],
      match: false,
    });
    expect(report.cells.filter((cell) => !cell.match)).toHaveLength(1);
  });

  it('an observation of a cell outside the grid has no actual walls', () => {
    const honest = exitGame(first);
    for (const cell of [25, -1, 2.5]) {
      const observations = [...honest.observations, { step: 1, cell, open: 4 }];
      const report = verifyGame({ ...honest, observations });
      expect(report.cells.at(-1)).toEqual({ cell, observed: 4, actual: -1, match: false });
    }
  });

  it('a record without observations compares nothing, and says so instead of reporting a match', () => {
    const honest = exitGame(first);
    const empty = verifyGame({ ...honest, observations: [] });
    expect(empty.cells).toEqual([]);
    expect(empty.cellsOk).toBeNull();
    // The checks that do not depend on the observations are unaffected.
    expect([empty.commitmentOk, empty.outcomeOk, empty.payoutOk]).toEqual([true, true, true]);

    expect(verifyGame(honest).cellsOk).toBe(true);
    expect(verifyGame(cashOutGame(first, 0)).cellsOk).toBe(true);
    const observations = honest.observations.map((observation, j) =>
      j === 1 ? { ...observation, open: observation.open ^ 1 } : observation,
    );
    expect(verifyGame({ ...honest, observations }).cellsOk).toBe(false);
  });

  it('a settlement whose step count is not a step count never verifies and never throws', () => {
    const honest = cashOutGame(first, 3);
    for (const steps of [-1, 1.5, Number.NaN, 25, 1000]) {
      const report = verifyGame({ ...honest, settled: { ...honest.settled, steps } });
      expect([report.outcomeOk, report.payoutOk]).toEqual([false, false]);
    }
    const negativeBet = verifyGame({ ...honest, settled: { ...honest.settled, betWei: -1n } });
    expect(negativeBet.payoutOk).toBe(false);
    const unknownOutcome = verifyGame({ ...honest, settled: { ...honest.settled, outcome: 3 as Outcome } });
    expect([unknownOutcome.outcomeOk, unknownOutcome.payoutOk]).toEqual([false, false]);
  });

  it('throws when the tier or a seed cannot be used at all', () => {
    const honest = exitGame(first);
    for (const tier of [-1, 3, 0.5]) {
      expect(() => verifyGame({ ...honest, tier })).toThrow(RangeError);
    }
    expect(() => verifyGame({ ...honest, serverSeed: '0x12' })).toThrow(TypeError);
    expect(() => verifyGame({ ...honest, clientSeed: '0x12' })).toThrow(TypeError);
    expect(() => verifyGame({ ...honest, gameId: 'nope' as Hex })).toThrow(TypeError);
  });

  it('honest games of every kind verify on every tier', () => {
    const failures: string[] = [];
    for (let i = 0; i < 80 * SIZES.length; i++) {
      const n = SIZES[i % SIZES.length];
      const seeds: Seeds = {
        n,
        serverSeed: seedOf(`verify server ${i}`),
        clientSeed: seedOf(`verify client ${i}`),
        gameId: seedOf(`verify game ${i}`),
      };
      const pathLength = solve(mazeOf(seeds)).length - 1;
      const games = [exitGame(seeds), lossGame(seeds), cashOutGame(seeds, i % pathLength)];
      games.forEach((params, kind) => {
        if (flags(verifyGame(params)).includes(false)) failures.push(`game ${i} kind ${kind}`);
      });
    }
    expect(failures).toEqual([]);
  });
});
