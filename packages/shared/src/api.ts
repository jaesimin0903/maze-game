// Frozen in Phase 0 (plan §7.3). Change only through the §8.1 modification procedure.
//
// Every time field is chain seconds (block `timestamp`, unix seconds).
// Every amount field is a decimal wei string.

import type { Dir, Hex, TierConfig } from './types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error code -> HTTP status. */
export const ERROR_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  TICKET_EXPIRED: 410,
  NOT_ON_CHAIN: 409,
  ALREADY_ACTIVE: 409,
  GAME_NOT_ACTIVE: 409,
  STALE_STEP: 409,
  INVALID_MOVE_WALL: 409,
  INVALID_MOVE_VISITED: 409,
  INVALID_MOVE_BOUNDS: 409,
  DEADLINE_PASSED: 409,
  NOT_REVEALABLE: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_CALIBRATED: 503,
  TABLE_MISMATCH: 503,
  CHAIN_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** Body of every error response. It never carries game state. */
export interface ErrorResponse {
  error: { code: ErrorCode; message: string };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** `POST /api/games` */
export interface CreateGameRequest {
  player: Hex;
  tier: number;
  /**
   * `sha256` of the UTF-8 bytes of the session token, as 0x-prefixed lowercase hex (32 bytes).
   * The token is the exact string later sent as `Authorization: Bearer <token>`.
   */
  sessionTokenHash: Hex;
  /**
   * EIP-191 `personal_sign` signature by `player` over `ticketRequestMessage(...)`.
   * It proves the requester controls `player`, so nobody else can hold that address's ticket slot.
   */
  signature: Hex;
}

/**
 * The exact UTF-8 string a player signs to request a ticket. Addresses are lowercased; `tier` is
 * its decimal form; `sessionTokenHash` is the 0x-prefixed lowercase hex sent in the request.
 */
export function ticketRequestMessage(args: {
  chainId: number;
  mazeBetAddress: Hex;
  player: Hex;
  tier: number;
  sessionTokenHash: Hex;
}): string {
  return [
    'maze-ticket',
    String(args.chainId),
    args.mazeBetAddress.toLowerCase(),
    args.player.toLowerCase(),
    String(args.tier),
    args.sessionTokenHash.toLowerCase(),
  ].join(':');
}

/** `POST /api/games/:id/start` (Bearer). The body is an empty object. */
export type StartGameRequest = Record<string, never>;

/** `POST /api/games/:id/move` (Bearer) */
export interface MoveRequest {
  /** The `GameView.step` the client last saw (moves made so far). Anything else is `STALE_STEP`. */
  step: number;
  dir: Dir;
}

/** `POST /api/games/:id/cashout` (Bearer) */
export interface CashoutRequest {
  /** The `GameView.step` the client last saw (moves made so far). Anything else is `STALE_STEP`. */
  step: number;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** `GET /api/health` */
export interface HealthResponse {
  ok: true;
  mazeVersion: number;
}

/** `GET /api/config` */
export interface ConfigResponse {
  chainId: number;
  rpcUrl: string;
  contract: Hex;
  mazeVersion: number;
  tableVersion: number;
  tableHash: Hex;
  calibrated: boolean;
  fixture: boolean;
  testHooks: boolean;
  tiers: TierConfig[];
  minBetWei: string;
  maxBetWei: string;
  idleTimeoutSec: number;
  maxGameSec: number;
  settleWindowSec: number;
  chainNowSec: number;
  devWallet: boolean;
  /** The treasure-chest rule of this server. Absent on a server without chests. */
  chest?: ChestConfig;
}

/** `POST /api/games` -> 201 */
export interface TicketResponse {
  gameId: Hex;
  player: Hex;
  tier: number;
  commitment: Hex;
  expirySec: number;
  /** Server signature over the EIP-712 `Ticket` message. */
  signature: Hex;
}

export type GameStatus = 'active' | 'won' | 'lost' | 'cashed_out';

export interface GameTerminal {
  serverSeed: Hex;
  clientSeed: Hex;
  /** 0 = Exit, 1 = CashOut, 2 = Loss. */
  outcome: 0 | 1 | 2;
  steps: number;
  payoutWei: string;
  /** Server signature over the EIP-712 `Settlement` message. */
  signature: Hex;
  settleTxHash: Hex | null;
  /**
   * Only for a game that ended in a dead end: the chest rule version the server applied to that
   * dead end. Absent for every other ending, and for a dead end no chest rule covered.
   */
  chestRule?: number;
  /** Present exactly when `chestRule` is: the chest found in the dead end, or `null` for none. */
  chest?: ChestFound | null;
}

/**
 * `start`, `move`, `cashout` and `GET /api/games/:id` all answer with this shape.
 * It is produced only by `toPublicView(game)`, which copies exactly these keys.
 */
export interface GameView {
  gameId: Hex;
  tier: number;
  n: number;
  status: GameStatus;
  /** True when the server ended the game itself (automatic cash-out). */
  auto: boolean;
  /** Moves made so far. */
  step: number;
  cell: { x: number; y: number };
  /** Open-direction bitmask of the current cell. The only wall information in the response. */
  open: number;
  betWei: string;
  refundableWei: string;
  exitPayoutWei: string;
  chainNowSec: number;
  idleDeadlineSec: number;
  gameDeadlineSec: number;
  settleDeadlineSec: number;
  /** Only on `GET /api/games/:id`. Visited cells only, in visiting order. */
  path?: { x: number; y: number; open: number }[];
  /** Never present while `status === 'active'`. */
  terminal?: GameTerminal;
}

export type RevealReason = 'settled' | 'reclaimed' | 'ticket-expired';

/** `GET /api/games/:id/reveal` */
export interface RevealResponse {
  gameId: Hex;
  commitment: Hex;
  serverSeed: Hex;
  reason: RevealReason;
}

/** `GET /api/test/ui-snapshot` (test hooks only, otherwise 404). */
export interface UiSnapshot {
  /** Incremented by the server on every accepted POST. */
  seq: number;
  url: string;
  chainNowSec: number;
  /** `data-testid` -> the real DOM text and attributes. */
  items: Record<string, { text: string; attrs: Record<string, string> }>;
}

/** Body of `POST /api/test/ui-snapshot` (test hooks only, otherwise 404). Answered with 204. */
export type UiSnapshotInput = Omit<UiSnapshot, 'seq'>;

// ---------------------------------------------------------------------------
// Treasure chests and points (chest.ts). Points have no cash value.
// ---------------------------------------------------------------------------

/** `ConfigResponse.chest`: the chest rule the server applies to dead ends. */
export interface ChestConfig {
  ruleVersion: number;
  /** Share of dead ends that hold a chest, in basis points. */
  rateBps: number;
  /** Reward range of a chest in basis points of the bet, both ends included. */
  rewardMinBps: number;
  rewardMaxBps: number;
  /** Wei of bet one point stands for, decimal: points = floor(bet × rewardBps / 10000 / pointUnitWei). */
  pointUnitWei: string;
  /** Points cannot be exchanged for money or for anything else. */
  cashValue: false;
}

/** The chest in the dead end that ended a game. */
export interface ChestFound {
  cell: { x: number; y: number };
  /** Reward in basis points of the bet. */
  rewardBps: number;
  /** Points awarded, decimal. No cash value. */
  points: string;
}

/** Most awards `GET /api/points/:address` lists. */
export const POINTS_RECENT_LIMIT = 20;

/** One entry of the points ledger: the game and the cell the points came from. */
export interface PointsAward {
  gameId: Hex;
  /** Board size of the game, so that `cell` can be read. */
  n: number;
  cell: { x: number; y: number };
  betWei: string;
  rewardBps: number;
  /** Decimal. */
  points: string;
  chestRule: number;
  /** Chain second at which the game ended. */
  atSec: number;
}

/** `GET /api/points/:address` */
export interface PointsResponse {
  /** Checksummed. */
  address: Hex;
  /** Decimal sum of every award of the address. */
  totalPoints: string;
  awardCount: number;
  /** The most recent awards, newest first, at most `POINTS_RECENT_LIMIT`. */
  awards: PointsAward[];
  /** Points cannot be exchanged for money or for anything else. */
  cashValue: false;
}
