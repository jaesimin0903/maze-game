// Recent games and leaderboards, derived from the `ended`, `reclaimed` and `chest-awarded` events
// of the event log and from nothing else. The game service feeds it from `apply`, next to the
// points ledger, live and when the log is replayed at boot, so a restarted server gives the same
// answers.
//
// A game counts once it has ended: with its `ended` event, or with its `reclaimed` event. A game
// that has both (the server signed an ending that nobody settled, then the bet was reclaimed)
// counts as reclaimed only: its ending is taken back and the reclaim counted in its place.
//
// Memory is bounded by the number of players, not of games: one running total per player for all
// time, one for the newest chain day an ending was counted in, one for points, and the
// `FEED_LIMIT` newest endings. No record of an older game is kept.

import {
  FEED_LIMIT,
  LEADERBOARD_LIMIT,
  type FeedOutcome,
  type Hex,
  type LeaderboardBoard,
} from '@maze/shared';

/** Chain seconds per UTC day. Chain time is unix seconds, so day `d` starts at `d * DAY_SEC`. */
export const DAY_SEC = 86_400;

function dayOf(sec: number): number {
  return Math.floor(sec / DAY_SEC);
}

/** What the stats need to know of a game: from its ticket and its `GameCreated`. */
export interface StatsGame {
  gameId: Hex;
  /** Checksummed address the ticket was issued to. */
  player: Hex;
  n: number;
  betWei: bigint;
}

/** One ended game as the feed lists it. */
export interface FeedGame {
  gameId: Hex;
  player: Hex;
  n: number;
  betWei: bigint;
  /** For a reclaimed game, the amount reclaimed. */
  payoutWei: bigint;
  outcome: FeedOutcome;
  endedAtSec: number;
}

/** One row of a leaderboard. */
export interface RankedRow {
  /** 1-based position in the order of the board. */
  rank: number;
  /** Checksummed. */
  address: Hex;
  /** Net profit in wei, or points. */
  value: bigint;
}

export interface Standings {
  /** The top `LEADERBOARD_LIMIT` rows. */
  rows: RankedRow[];
  /** The asked-for address's row among everyone, or `null`. */
  me: RankedRow | null;
  /** 'today' only: chain second of the next UTC midnight, when the board starts over. */
  resetsAtSec: number | null;
}

interface Total {
  /** Checksummed, as the first counted event carried it. */
  address: Hex;
  value: bigint;
  /** Games (or awards) counted in `value`. A total that counts nothing is dropped. */
  count: number;
}

const OUTCOME_NAMES = ['exit', 'cashout', 'loss'] as const;

export class GameStats {
  private readonly allTime = new Map<string, Total>();
  /** Totals of the games that ended in chain day `day`, the newest day an ending was counted in. */
  private readonly today = new Map<string, Total>();
  private day = Number.NEGATIVE_INFINITY;
  private readonly points = new Map<string, Total>();
  /** Newest first: by ending time, then by log order. At most `FEED_LIMIT`. */
  private recent: FeedGame[] = [];

  /** A game's `ended` event: 0 = Exit, 1 = CashOut (`auto` when the server ended it), 2 = Loss. */
  ended(game: StatsGame, ending: { outcome: 0 | 1 | 2; auto: boolean; payoutWei: bigint; atSec: number }): void {
    const outcome: FeedOutcome =
      ending.outcome === 1 && ending.auto ? 'auto-cashout' : OUTCOME_NAMES[ending.outcome];
    this.count(game, outcome, ending.payoutWei, ending.atSec);
  }

  /**
   * A game's `reclaimed` event. `previous` is the game's earlier `ended` event, if it has one:
   * that ending was never settled, so it stops counting and the reclaim counts instead.
   */
  reclaimed(
    game: StatsGame,
    previous: { payoutWei: bigint; atSec: number } | null,
    amountWei: bigint,
    atSec: number,
  ): void {
    if (previous !== null) {
      const net = previous.payoutWei - game.betWei;
      add(this.allTime, game.player, -net, -1);
      if (dayOf(previous.atSec) === this.day) add(this.today, game.player, -net, -1);
      this.recent = this.recent.filter((kept) => kept.gameId !== game.gameId);
    }
    this.count(game, 'reclaimed', amountWei, atSec);
  }

  /** A `chest-awarded` event. Points have no cash value. */
  awarded(player: Hex, points: bigint): void {
    add(this.points, player, points, 1);
  }

  /** The most recent ended games, newest first, at most `FEED_LIMIT`. */
  recentGames(): readonly FeedGame[] {
    return this.recent;
  }

  /**
   * A leaderboard at chain second `nowSec`: value descending, ties by lower-case address
   * ascending. `address` (any letter case) asks for that address's own row as well.
   */
  standings(board: LeaderboardBoard, address: string | null, nowSec: number): Standings {
    const totals =
      board === 'all'
        ? this.allTime
        : board === 'points'
          ? this.points
          : dayOf(nowSec) === this.day
            ? this.today
            : new Map<string, Total>();
    const ranked = [...totals]
      .sort(([keyA, a], [keyB, b]) =>
        a.value !== b.value ? (a.value > b.value ? -1 : 1) : keyA < keyB ? -1 : keyA > keyB ? 1 : 0,
      )
      .map(([key, total], index) => ({
        key,
        row: { rank: index + 1, address: total.address, value: total.value },
      }));
    const wanted = address?.toLowerCase();
    return {
      rows: ranked.slice(0, LEADERBOARD_LIMIT).map((entry) => entry.row),
      me: wanted === undefined ? null : (ranked.find((entry) => entry.key === wanted)?.row ?? null),
      resetsAtSec: board === 'today' ? (dayOf(nowSec) + 1) * DAY_SEC : null,
    };
  }

  private count(game: StatsGame, outcome: FeedOutcome, payoutWei: bigint, atSec: number): void {
    const net = payoutWei - game.betWei;
    add(this.allTime, game.player, net, 1);
    const day = dayOf(atSec);
    if (day > this.day) {
      this.day = day;
      this.today.clear();
    }
    // An ending stored late with the time of a day already over counts for all time only.
    if (day === this.day) add(this.today, game.player, net, 1);

    // Later in the log than every entry kept, so it goes before every entry that did not end later.
    const at = this.recent.findIndex((kept) => kept.endedAtSec <= atSec);
    this.recent.splice(at === -1 ? this.recent.length : at, 0, {
      gameId: game.gameId,
      player: game.player,
      n: game.n,
      betWei: game.betWei,
      payoutWei,
      outcome,
      endedAtSec: atSec,
    });
    if (this.recent.length > FEED_LIMIT) this.recent.pop();
  }
}

function add(totals: Map<string, Total>, address: Hex, value: bigint, count: number): void {
  const key = address.toLowerCase();
  const total = totals.get(key) ?? { address, value: 0n, count: 0 };
  total.value += value;
  total.count += count;
  if (total.count <= 0) totals.delete(key);
  else totals.set(key, total);
}
