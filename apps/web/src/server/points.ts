// The points ledger: every chest award, by wallet address, derived from the `chest-awarded`
// events of the event log and from nothing else. The game service feeds it from `apply`, live
// and when the log is replayed at boot, so a restarted server has the same ledger.
//
// Points have no cash value. The ledger is kept so that a later step (a utility coin) can
// convert points without rework: every award names the game, the cell, the kind of chest, the
// bet, the reward, the chest rule version, the move and the chain time, and anyone can check it
// against the game's seeds once they are revealed.

import type { Hex } from '@maze/shared';
import type { StoreEvent } from './store';

export type AwardEvent = Extract<StoreEvent, { type: 'chest-awarded' }>;

export interface LedgerAward {
  gameId: Hex;
  n: number;
  cell: number;
  kind: 'dead-end' | 'path';
  betWei: bigint;
  rewardBps: number;
  points: bigint;
  chestRule: number;
  /** Moves made when the chest was found. */
  step: number;
  atSec: number;
}

export interface LedgerAccount {
  /** Checksummed address, as the tickets of its games carry it. */
  address: Hex;
  totalPoints: bigint;
  /** In the order they were awarded (log order). */
  awards: LedgerAward[];
}

export class PointsLedger {
  private readonly accounts = new Map<string, LedgerAccount>();
  /** `gameId:cell` of every award: a cell of a game is awarded once at most. */
  private readonly awarded = new Set<string>();

  /**
   * Adds one award, found after `step` moves. A second award for the same cell of the same game
   * is an inconsistent log and throws.
   */
  add(event: AwardEvent, step: number): void {
    const key = `${event.gameId}:${event.cell}`;
    if (this.awarded.has(key)) {
      throw new Error(`event log: a second chest award for cell ${event.cell} of game ${event.gameId}`);
    }
    const points = BigInt(event.points);
    const address = event.player.toLowerCase();
    let account = this.accounts.get(address);
    if (account === undefined) {
      account = { address: event.player, totalPoints: 0n, awards: [] };
      this.accounts.set(address, account);
    }
    account.totalPoints += points;
    account.awards.push({
      gameId: event.gameId,
      n: event.n,
      cell: event.cell,
      kind: event.kind ?? 'dead-end',
      betWei: BigInt(event.betWei),
      rewardBps: event.rewardBps,
      points,
      chestRule: event.chestRule,
      step,
      atSec: event.atSec,
    });
    this.awarded.add(key);
  }

  /** The account of an address in any letter case; `null` when it was never awarded anything. */
  account(address: string): LedgerAccount | null {
    return this.accounts.get(address.toLowerCase()) ?? null;
  }
}
