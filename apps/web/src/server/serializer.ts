// Allow-list serialization of every response body (plan §7.3).
//
// Each function builds a fresh object key by key; nothing is spread or copied wholesale from
// server state. `toPublicView` is the only producer of a `GameView`. Its input type has no
// maze: the only wall information it can emit is what the game record already holds, which is
// the open masks of the cells the player has stood in. The server seed is read in exactly one
// place, behind the check that the game has ended.

import {
  exitPayoutWei,
  refundWei,
  type ConfigResponse,
  type GameStatus,
  type GameView,
  type Hex,
  type RevealReason,
  type RevealResponse,
  type TicketResponse,
  type TuningTable,
} from '@maze/shared';
import type { Game } from './game-service';

const STATUS_OF_OUTCOME: readonly GameStatus[] = ['won', 'cashed_out', 'lost'];

export function toPublicView(p: {
  table: TuningTable;
  game: Game;
  nowSec: number;
  idleTimeoutSec: number;
  maxGameSec: number;
  /** True only for `GET /api/games/:id`. */
  withPath: boolean;
}): GameView {
  const { table, game } = p;
  const chain = game.chain;
  if (chain === null) throw new Error('toPublicView: the game is not on chain');

  const n = game.n;
  const xy = (cell: number): { x: number; y: number } => ({ x: cell % n, y: Math.floor(cell / n) });
  const here = game.path[game.path.length - 1];
  const step = game.moves.length;
  const ended = game.ended;

  const view: GameView = {
    gameId: game.gameId,
    tier: game.tier,
    n,
    status: ended === null ? 'active' : STATUS_OF_OUTCOME[ended.outcome],
    auto: ended === null ? false : ended.auto,
    step,
    cell: xy(here.cell),
    open: here.open,
    betWei: chain.betWei.toString(),
    // A function of (table, tier, step, bet) only.
    refundableWei: refundWei(table, chain.betWei, game.tier, step).toString(),
    exitPayoutWei: exitPayoutWei(table, chain.betWei, game.tier).toString(),
    chainNowSec: p.nowSec,
    idleDeadlineSec: game.lastActivitySec + p.idleTimeoutSec,
    gameDeadlineSec: chain.createdAtSec + p.maxGameSec,
    settleDeadlineSec: chain.settleDeadlineSec,
  };
  if (p.withPath) {
    view.path = game.path.map((visited) => ({ ...xy(visited.cell), open: visited.open }));
  }
  if (ended !== null) {
    view.terminal = {
      serverSeed: game.serverSeed,
      clientSeed: chain.clientSeed,
      outcome: ended.outcome,
      steps: ended.steps,
      payoutWei: ended.payoutWei.toString(),
      signature: ended.signature,
      settleTxHash: game.settle.minedTxHash ?? game.settle.lastTxHash,
    };
  }
  return view;
}

export function toTicketResponse(game: Game, signature: Hex): TicketResponse {
  return {
    gameId: game.gameId,
    player: game.player,
    tier: game.tier,
    commitment: game.commitment,
    expirySec: game.expirySec,
    signature,
  };
}

export function toRevealResponse(game: Game, reason: RevealReason): RevealResponse {
  return {
    gameId: game.gameId,
    commitment: game.commitment,
    serverSeed: game.serverSeed,
    reason,
  };
}

export function toConfigResponse(p: {
  chainId: number;
  rpcUrl: string;
  contract: Hex;
  table: TuningTable;
  tableHash: Hex;
  testHooks: boolean;
  devWallet: boolean;
  idleTimeoutSec: number;
  maxGameSec: number;
  nowSec: number;
}): ConfigResponse {
  const { table } = p;
  return {
    chainId: p.chainId,
    rpcUrl: p.rpcUrl,
    contract: p.contract,
    mazeVersion: table.mazeVersion,
    tableVersion: table.tableVersion,
    tableHash: p.tableHash,
    calibrated: table.calibration.calibrated,
    fixture: table.fixture === true,
    testHooks: p.testHooks,
    tiers: table.tiers.map((tier) => ({
      id: tier.id,
      n: tier.n,
      curve: { ...tier.curve },
      multiplierBps: tier.multiplierBps,
      refundBps: [...tier.refundBps],
    })),
    minBetWei: table.limits.minBetWei,
    maxBetWei: table.limits.maxBetWei,
    idleTimeoutSec: p.idleTimeoutSec,
    maxGameSec: p.maxGameSec,
    settleWindowSec: table.timing.settleWindowSec,
    chainNowSec: p.nowSec,
    devWallet: p.devWallet,
  };
}
