// After-the-fact verification of a finished game from public data only (plan §3.5, §7.1):
// the on-chain commitment, client seed and game id, the revealed server seed, and the player's
// own record of what the server showed.

import { chestAt, chestPoints, chestsOf, isKnownChestRule, type Chest, type ChestKind } from './chest';
import { exitPayoutWei, refundWei } from './economics';
import { commitmentOf, deriveFinalSeed } from './hash';
import { generateMaze, solve } from './maze';
import { replayMoves } from './replay';
import { Outcome, type Dir, type Hex, type Maze, type TuningTable } from './types';

/** A chest the server said the player found (`cell` is `y * n + x`). */
export interface ClaimedChest {
  cell: number;
  /** Optional for a rule 1 claim, where every chest is a dead-end chest. */
  kind?: ChestKind;
  rewardBps: number;
  points: string | bigint;
}

/** What the server said about the chests of a game (`GameTerminal`, `GameView.chests`). */
export interface ChestClaim {
  /** The chest rule version the server applied. */
  rule: number;
  /** The chest in the dead end the game ended in, or `null` for none (or no dead-end ending). */
  found: ClaimedChest | null;
  /**
   * Every chest the server said the player found in this game, path chests and the dead-end
   * chest, in any order. Required for rule 2 and later; absent for a rule 1 claim, whose only
   * possible chest is `found`.
   */
  awards?: ClaimedChest[];
}

/** What the server showed after `step` moves: the player's cell (`y * n + x`) and its open mask. */
export interface Observation {
  step: number;
  cell: number;
  open: number;
}

export interface VerifyReport {
  /** The revealed server seed hashes to the commitment recorded before the game. */
  commitmentOk: boolean;
  finalSeed: Hex;
  /** The maze recomputed from the seeds. */
  maze: Maze;
  /** The start-to-exit path of `maze`. */
  solution: number[];
  /**
   * One entry per observation, in the given order. `actual` is the recomputed open mask of the
   * observed cell (`-1` when there is no such cell). `match` is true when the observed mask
   * equals it and the cell is where the recorded moves put the player after `step` moves.
   */
  cells: { cell: number; observed: number; actual: number; match: boolean }[];
  /**
   * The verdict over `cells`: `true` when every entry matches, `false` when one does not, and
   * `null` when there were no observations, so nothing was compared. Use this rather than
   * `cells.every(...)`, which is also true for an empty record.
   */
  cellsOk: boolean | null;
  /** Replaying the recorded moves over `maze` ends with the settled outcome and step count. */
  outcomeOk: boolean;
  /** The settled payout is what the table prescribes for the settled outcome and step count. */
  payoutOk: boolean;
  /** The chest rule `chests` was computed with: the claim's, or the current one without a claim. */
  chestRule: number;
  /** Every chest of `maze` under `chestRule`, in cell order; `null` when that rule is unknown here. */
  chests: Chest[] | null;
  /**
   * The chest of the dead end the recorded moves end in, with its points for the settled bet
   * (0 when the bet is not known); `null` when the moves do not end the game in a chest.
   */
  expectedChest: (Chest & { points: bigint }) | null;
  /**
   * Every chest on a cell the recorded moves entered (path chests, and the dead-end chest when
   * the game ended in one), in the order entered, with points for the settled bet (0 when the
   * bet is not known). Empty when the rule is unknown or the moves do not replay.
   */
  expectedChests: (Chest & { points: bigint })[];
  /**
   * The server's chest claim against the recomputation. `true`: the chests the server awarded
   * are exactly the chests the seed puts on the cells the player entered (cell, kind, reward and,
   * with a known bet, points), none withheld and none invented. `false`: a chest was withheld,
   * invented, moved or misvalued. `null`: nothing to compare (a game with expected chests but no
   * claim in the record, an unknown rule, or moves that do not replay).
   */
  chestOk: boolean | null;
}

function claimedPointsOf(points: string | bigint): bigint | null {
  return typeof points === 'bigint' ? points : /^\d+$/.test(String(points)) ? BigInt(points) : null;
}

/** True when `claimed` is exactly `expected`, as sets keyed by cell (points compared only with a known bet). */
function sameChests(claimed: readonly ClaimedChest[], expected: readonly (Chest & { points: bigint })[], betKnown: boolean): boolean {
  if (claimed.length !== expected.length) return false;
  if (new Set(claimed.map((chest) => chest.cell)).size !== claimed.length) return false;
  return expected.every((want) => {
    const got = claimed.find((chest) => chest.cell === want.cell);
    if (got === undefined) return false;
    const points = claimedPointsOf(got.points);
    return (
      (got.kind === undefined || got.kind === want.kind) &&
      got.rewardBps === want.rewardBps &&
      points !== null &&
      (!betKnown || points === want.points)
    );
  });
}

/**
 * Recomputes everything a player can check about a finished game. Throws when `tier` is not in
 * the table or a seed is not 32 bytes of hex; every other inconsistency is reported in the
 * result rather than thrown.
 */
export function verifyGame(p: {
  table: TuningTable;
  commitment: Hex;
  serverSeed: Hex;
  clientSeed: Hex;
  gameId: Hex;
  tier: number;
  observations: Observation[];
  moves: Dir[];
  settled: { outcome: Outcome; steps: number; payoutWei: bigint; betWei: bigint };
  /** The server's chest claim, when the record holds one. */
  chest?: ChestClaim;
  /**
   * The chest rule to list chests with when there is no claim. Default 1: a record without a
   * claim is a rule 1 game that did not end in a dead end, or a game from before chests.
   */
  chestRule?: number;
}): VerifyReport {
  const { table, tier, serverSeed, clientSeed, gameId } = p;
  if (!Number.isInteger(tier) || tier < 0 || tier >= table.tiers.length) {
    throw new RangeError(`tier ${tier} is not in the tuning table`);
  }
  const { n, refundBps } = table.tiers[tier];

  const commitment = commitmentOf({ mazeVersion: table.mazeVersion, n, serverSeed });
  const commitmentOk = commitment === String(p.commitment).toLowerCase();
  const finalSeed = deriveFinalSeed({ serverSeed, clientSeed, gameId });
  const maze = generateMaze(finalSeed, n);

  const { outcome, steps, payoutWei, betWei } = p.settled;
  const stepsValid = Number.isInteger(steps) && steps >= 0;
  const replay = replayMoves(
    maze,
    p.moves,
    stepsValid && outcome === Outcome.CashOut ? steps : undefined,
  );
  const outcomeOk =
    stepsValid && replay.invalidAt === null && replay.outcome === outcome && replay.steps === steps;

  const cells = p.observations.map(({ step, cell, open }) => {
    const known = Number.isInteger(cell) && cell >= 0 && cell < maze.open.length;
    const actual = known ? maze.open[cell] : -1;
    return { cell, observed: open, actual, match: open === actual && replay.path[step] === cell };
  });

  let expectedWei: bigint | null = null;
  if (betWei >= 0n) {
    if (outcome === Outcome.Exit) expectedWei = exitPayoutWei(table, betWei, tier);
    else if (outcome === Outcome.Loss) expectedWei = 0n;
    else if (outcome === Outcome.CashOut && stepsValid && steps < refundBps.length) {
      expectedWei = refundWei(table, betWei, tier, steps);
    }
  }

  const chestRule = p.chest?.rule ?? p.chestRule ?? 1;
  const knownRule = isKnownChestRule(chestRule);
  const replayed = replay.invalidAt === null;
  const betKnown = betWei > 0n;
  // Every chest on a cell the player entered. A dead end can only be the last cell entered: the
  // game ends there. Under rule 1 only that dead end can hold a chest.
  const expectedChests =
    knownRule && replayed
      ? replay.path
          .slice(1)
          .map((cell) => chestAt(finalSeed, maze, cell, chestRule))
          .filter((chest): chest is Chest => chest !== null)
          .map((chest) => ({ ...chest, points: betKnown ? chestPoints(betWei, chest.rewardBps) : 0n }))
      : [];
  const expectedChest = expectedChests.find((chest) => chest.kind === 'dead-end') ?? null;

  let chestOk: boolean | null;
  if (!knownRule || !replayed) chestOk = null;
  else if (p.chest === undefined) chestOk = expectedChests.length === 0 ? true : null;
  else {
    const { found } = p.chest;
    const claimed = p.chest.awards ?? (found === null ? [] : [{ ...found, kind: found.kind ?? 'dead-end' }]);
    // The dead-end chest named on its own must be the dead-end entry of the full list too.
    const foundOk = found === null ? expectedChest === null : sameChests([found], expectedChest === null ? [] : [expectedChest], betKnown);
    chestOk = foundOk && sameChests(claimed, expectedChests, betKnown);
  }

  return {
    commitmentOk,
    finalSeed,
    maze,
    solution: solve(maze),
    cells,
    cellsOk: cells.length === 0 ? null : cells.every((cell) => cell.match),
    outcomeOk,
    payoutOk: expectedWei !== null && payoutWei === expectedWei,
    chestRule,
    chests: knownRule ? chestsOf(finalSeed, maze, chestRule) : null,
    expectedChest,
    expectedChests,
    chestOk,
  };
}
