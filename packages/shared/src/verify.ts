// After-the-fact verification of a finished game from public data only (plan §3.5, §7.1):
// the on-chain commitment, client seed and game id, the revealed server seed, and the player's
// own record of what the server showed.

import { chestAt, chestPoints, chestsOf, CHEST_RULE_VERSION, isKnownChestRule, type Chest } from './chest';
import { exitPayoutWei, refundWei } from './economics';
import { commitmentOf, deriveFinalSeed } from './hash';
import { generateMaze, solve } from './maze';
import { replayMoves } from './replay';
import { Outcome, type Dir, type Hex, type Maze, type TuningTable } from './types';

/** What the server said about the chest of a game that ended in a dead end (`GameTerminal`). */
export interface ChestClaim {
  /** The chest rule version the server applied. */
  rule: number;
  /** The chest the server said the player found (`cell` is `y * n + x`), or `null` for none. */
  found: { cell: number; rewardBps: number; points: string | bigint } | null;
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
   * The server's chest claim against the recomputation. `true`: a chest the server awarded is the
   * one the seed puts in that dead end (cell, reward and, with a known bet, points), a dead end it
   * called empty is empty, and a game that did not end in a dead end has no award. `false`: a
   * chest was hidden, invented, moved or misvalued. `null`: nothing to compare (a game that ended
   * in a dead end without a claim in the record, an unknown rule, or moves that do not replay).
   */
  chestOk: boolean | null;
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
  /** The server's chest claim, when the record holds one (endings in a dead end only). */
  chest?: ChestClaim;
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

  const chestRule = p.chest?.rule ?? CHEST_RULE_VERSION;
  const knownRule = isKnownChestRule(chestRule);
  const replayed = replay.invalidAt === null;
  const endedInDeadEnd = replayed && replay.outcome === Outcome.Loss;
  const endChest =
    knownRule && endedInDeadEnd ? chestAt(finalSeed, maze, replay.path[replay.path.length - 1], chestRule) : null;
  const betKnown = betWei > 0n;
  const expectedChest =
    endChest === null ? null : { ...endChest, points: betKnown ? chestPoints(betWei, endChest.rewardBps) : 0n };

  let chestOk: boolean | null;
  if (!knownRule || !replayed) chestOk = null;
  else if (p.chest === undefined) chestOk = endedInDeadEnd ? null : true;
  else if (p.chest.found === null) chestOk = expectedChest === null;
  else {
    const { cell, rewardBps, points } = p.chest.found;
    const claimedPoints =
      typeof points === 'bigint' ? points : /^\d+$/.test(String(points)) ? BigInt(points) : null;
    chestOk =
      expectedChest !== null &&
      cell === expectedChest.cell &&
      rewardBps === expectedChest.rewardBps &&
      claimedPoints !== null &&
      (!betKnown || claimedPoints === expectedChest.points);
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
    chestOk,
  };
}
