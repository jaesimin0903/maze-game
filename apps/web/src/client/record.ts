// The player's own record of a game (plan §7.6): what the server showed, in the order it was
// shown. It is the evidence the verify screen checks against the revealed maze, so an
// observation is never overwritten once recorded.

import type { ChestFound, Dir, FoundChest, GameTerminal, GameView, Hex, Observation } from '@maze/shared';
import { isHex32 } from './seed';

export interface PlayRecord {
  gameId: Hex;
  tier: number;
  n: number;
  commitment: Hex;
  clientSeed: Hex;
  /** Session token, the Bearer credential of this game's requests. */
  token: string;
  /** `observations[k]` is what the server showed after `k` moves. */
  observations: Observation[];
  /** `moves[k]` is the direction of move `k + 1`. */
  moves: Dir[];
  terminal?: GameTerminal;

  // Additions to the §7.6 shape. All optional, so a record with only the fields above imports.
  betWei?: string;
  player?: Hex;
  /** The server ended the game itself (idle or maximum time). */
  auto?: boolean;
  createTxHash?: Hex;
  /** The bet was returned on chain by `reclaim`. `txHash` is null when someone else sent it. */
  reclaimed?: { txHash: Hex | null; amountWei: string };
  /** The chest rule the server named for this game (rule 2 also puts chests on path cells). */
  chestRule?: number;
  /**
   * Every chest the server showed in this game, in the order found. Evidence for the verify
   * screen like the observations: a chest once recorded is never overwritten.
   */
  chests?: FoundChest[];
}

const RECORD_PREFIX = 'maze:record:';
const ACTIVE_KEY = 'maze:active';

export function recordKey(gameId: Hex): string {
  return `${RECORD_PREFIX}${gameId}`;
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function saveRecord(record: PlayRecord): void {
  try {
    storage()?.setItem(recordKey(record.gameId), JSON.stringify(record));
  } catch {
    // A full or disabled store must not stop the game; the record stays in memory.
  }
}

export function loadRecord(gameId: Hex): PlayRecord | null {
  try {
    const raw = storage()?.getItem(recordKey(gameId));
    return raw ? parseRecord(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** The game this browser should resume on load, if any. */
export function activeGameId(): Hex | null {
  try {
    const value = storage()?.getItem(ACTIVE_KEY);
    return isHex32(value) ? value : null;
  } catch {
    return null;
  }
}

export function setActiveGameId(gameId: Hex | null): void {
  try {
    if (gameId === null) storage()?.removeItem(ACTIVE_KEY);
    else storage()?.setItem(ACTIVE_KEY, gameId);
  } catch {
    // See saveRecord.
  }
}

const isInt = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/**
 * Validates an untrusted value (storage content or a pasted record) and returns a fresh record.
 * Throws an `Error` whose message says, for the player, what is wrong.
 */
export function parseRecord(raw: unknown): PlayRecord {
  const fail = (message: string): never => {
    throw new Error(`플레이 기록을 읽을 수 없습니다: ${message}`);
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('JSON 객체가 아닙니다');
  const r = raw as Record<string, unknown>;

  if (!isHex32(r.gameId)) fail('gameId가 32바이트 hex가 아닙니다');
  if (!isHex32(r.commitment)) fail('commitment가 32바이트 hex가 아닙니다');
  if (!isHex32(r.clientSeed)) fail('clientSeed가 32바이트 hex가 아닙니다');
  if (!isInt(r.tier, 0, 255)) fail('tier가 정수가 아닙니다');
  if (!isInt(r.n, 2, 255)) fail('n이 정수가 아닙니다');
  if (!Array.isArray(r.observations)) fail('observations가 배열이 아닙니다');
  if (!Array.isArray(r.moves)) fail('moves가 배열이 아닙니다');

  const observations = (r.observations as unknown[]).map((entry, index) => {
    const o = entry as Partial<Observation> | null;
    if (!o || !isInt(o.step, 0, 65535) || !isInt(o.cell, 0, 65535) || !isInt(o.open, 0, 15)) {
      fail(`observations[${index}]의 step, cell, open이 올바르지 않습니다`);
    }
    return { step: o!.step!, cell: o!.cell!, open: o!.open! };
  });
  const moves = (r.moves as unknown[]).map((entry, index) => {
    if (!isInt(entry, 0, 3)) fail(`moves[${index}]가 0~3이 아닙니다`);
    return entry as Dir;
  });

  const record: PlayRecord = {
    gameId: r.gameId as Hex,
    tier: r.tier as number,
    n: r.n as number,
    commitment: r.commitment as Hex,
    clientSeed: r.clientSeed as Hex,
    token: typeof r.token === 'string' ? r.token : '',
    observations,
    moves,
  };

  if (r.terminal !== undefined) {
    const t = r.terminal as Partial<GameTerminal> | null;
    if (
      !t ||
      !isHex32(t.serverSeed) ||
      !isHex32(t.clientSeed) ||
      !isInt(t.outcome, 0, 2) ||
      !isInt(t.steps, 0, 65535) ||
      typeof t.payoutWei !== 'string' ||
      !/^\d+$/.test(t.payoutWei) ||
      typeof t.signature !== 'string'
    ) {
      fail('terminal의 형식이 올바르지 않습니다');
    }
    record.terminal = {
      serverSeed: t!.serverSeed!,
      clientSeed: t!.clientSeed!,
      outcome: t!.outcome!,
      steps: t!.steps!,
      payoutWei: t!.payoutWei!,
      signature: t!.signature!,
      settleTxHash: isHex32(t!.settleTxHash) ? t!.settleTxHash : null,
    };
    // The server's word on the chest of a dead-end ending. It is evidence for the verify screen,
    // so a malformed one is refused rather than dropped. Under rule 2 every ending names the
    // rule, and only an ending in a dead end names that dead end's chest.
    if (t!.chestRule !== undefined) {
      if (!isInt(t!.chestRule, 1, 65535)) fail('terminal.chestRule이 올바르지 않습니다');
      const chest = t!.chest as Partial<ChestFound> | null | undefined;
      if (chest === undefined && t!.chestRule >= 2) {
        record.terminal.chestRule = t!.chestRule;
      } else if (chest === null) {
        record.terminal.chestRule = t!.chestRule;
        record.terminal.chest = null;
      } else if (
        chest &&
        chest.cell &&
        isInt(chest.cell.x, 0, 254) &&
        isInt(chest.cell.y, 0, 254) &&
        isInt(chest.rewardBps, 0, 10_000) &&
        typeof chest.points === 'string' &&
        /^\d+$/.test(chest.points)
      ) {
        record.terminal.chestRule = t!.chestRule;
        record.terminal.chest = {
          cell: { x: chest.cell.x, y: chest.cell.y },
          rewardBps: chest.rewardBps,
          points: chest.points,
        };
      } else {
        fail('terminal.chest의 형식이 올바르지 않습니다');
      }
    }
  }

  if (typeof r.betWei === 'string' && /^\d+$/.test(r.betWei)) record.betWei = r.betWei;
  if (typeof r.player === 'string' && /^0x[0-9a-fA-F]{40}$/.test(r.player)) {
    record.player = r.player as Hex;
  }
  if (typeof r.auto === 'boolean') record.auto = r.auto;
  if (isHex32(r.createTxHash)) record.createTxHash = r.createTxHash;
  if (r.chestRule !== undefined) {
    if (!isInt(r.chestRule, 1, 65535)) fail('chestRule이 올바르지 않습니다');
    record.chestRule = r.chestRule as number;
  }
  if (r.chests !== undefined) {
    if (!Array.isArray(r.chests)) fail('chests가 배열이 아닙니다');
    record.chests = (r.chests as unknown[]).map((entry, index) => {
      const c = entry as Partial<FoundChest> | null;
      if (
        !c ||
        !c.cell ||
        !isInt(c.cell.x, 0, 254) ||
        !isInt(c.cell.y, 0, 254) ||
        (c.kind !== 'path' && c.kind !== 'dead-end') ||
        !isInt(c.rewardBps, 0, 10_000) ||
        typeof c.points !== 'string' ||
        !/^\d+$/.test(c.points) ||
        !isInt(c.step, 1, 65535)
      ) {
        fail(`chests[${index}]의 형식이 올바르지 않습니다`);
      }
      return { cell: { x: c!.cell!.x, y: c!.cell!.y }, kind: c!.kind!, rewardBps: c!.rewardBps!, points: c!.points!, step: c!.step! };
    });
  }
  const reclaimed = r.reclaimed as { txHash?: unknown; amountWei?: unknown } | undefined;
  if (reclaimed && typeof reclaimed.amountWei === 'string' && /^\d+$/.test(reclaimed.amountWei)) {
    record.reclaimed = {
      txHash: isHex32(reclaimed.txHash) ? reclaimed.txHash : null,
      amountWei: reclaimed.amountWei,
    };
  }
  return record;
}

/** The direction that leads from `from` to the adjacent cell `to`, or `null`. */
export function dirBetween(n: number, from: number, to: number): Dir | null {
  const dx = (to % n) - (from % n);
  const dy = Math.floor(to / n) - Math.floor(from / n);
  if (dx === 0 && dy === -1) return 0;
  if (dx === 1 && dy === 0) return 1;
  if (dx === 0 && dy === 1) return 2;
  if (dx === -1 && dy === 0) return 3;
  return null;
}

/**
 * The record after the server answered with `view`. `dir` is the move that produced it, when
 * it answers a move. Steps already recorded keep what was recorded first; only new steps are
 * appended, from the response's current cell or, on a resume read, from its `path`.
 */
export function withView(record: PlayRecord, view: GameView, dir?: Dir): PlayRecord {
  const { n } = record;
  const observations = record.observations.slice();
  const moves = record.moves.slice();
  const cellOf = (p: { x: number; y: number }): number => p.y * n + p.x;

  const append = (step: number, cell: number, open: number, via: Dir | null): void => {
    if (step !== observations.length) return;
    if (step > 0) {
      const move = via ?? dirBetween(n, observations[step - 1].cell, cell);
      if (move === null) return;
      moves[step - 1] = move;
    }
    observations.push({ step, cell, open });
  };

  view.path?.forEach((p, step) => append(step, cellOf(p), p.open, null));
  append(view.step, cellOf(view.cell), view.open, dir ?? null);

  const next: PlayRecord = { ...record, observations, moves };
  if (view.chestRule !== undefined && next.chestRule === undefined) next.chestRule = view.chestRule;
  if (view.chests !== undefined) {
    // Chests already recorded stay as they were; only chests on cells not yet listed are added.
    const chests = (record.chests ?? []).slice();
    for (const chest of view.chests) {
      if (!chests.some((known) => known.cell.x === chest.cell.x && known.cell.y === chest.cell.y)) {
        chests.push({ ...chest, cell: { x: chest.cell.x, y: chest.cell.y } });
      }
    }
    next.chests = chests;
  }
  if (view.terminal) {
    next.terminal = view.terminal;
    next.auto = view.auto;
  }
  return next;
}
