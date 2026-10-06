// The points ledger: every chest award, by wallet address, derived from the `chest-awarded`
// events of the event log and from nothing else. The game service feeds it from `apply`, live
// and when the log is replayed at boot, so a restarted server has the same ledger.
//
// Points have no cash value. The ledger is kept so that a later step (a utility coin) can
// convert points without rework: every award names the game, the cell, the bet, the reward,
// the chest rule version and the chain time, and anyone can check it against the game's seeds
// once they are revealed.

import type { Hex } from '@maze/shared';
import type { StoreEvent } from './store';

export type AwardEvent = Extract<StoreEvent, { type: 'chest-awarded' }>;

export interface LedgerAward {
  gameId: Hex;
  n: number;
  cell: number;
  betWei: bigint;
  rewardBps: number;
  points: bigint;
  chestRule: number;
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
  private readonly awarded = new Set<Hex>();

  /** Adds one award. A second award for the same game is an inconsistent log and throws. */
  add(event: AwardEvent): void {
    if (this.awarded.has(event.gameId)) {
      throw new Error(`event log: a second chest award for game ${event.gameId}`);
    }
    const points = BigInt(event.points);
    const key = event.player.toLowerCase();
    let account = this.accounts.get(key);
    if (account === undefined) {
      account = { address: event.player, totalPoints: 0n, awards: [] };
      this.accounts.set(key, account);
    }
    account.totalPoints += points;
    account.awards.push({
      gameId: event.gameId,
      n: event.n,
      cell: event.cell,
      betWei: BigInt(event.betWei),
      rewardBps: event.rewardBps,
      points,
      chestRule: event.chestRule,
      atSec: event.atSec,
    });
    this.awarded.add(event.gameId);
  }

  /** The account of an address in any letter case; `null` when it was never awarded anything. */
  account(address: string): LedgerAccount | null {
    return this.accounts.get(address.toLowerCase()) ?? null;
  }
}
