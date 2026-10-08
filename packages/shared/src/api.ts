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
  /** How the browser names the chain and links to it. Absent: a local Anvil, bets in ETH. */
  network?: NetworkInfo;
  /** Privy app id for email, social and passkey login. Absent or `null`: no Privy login. */
  privyAppId?: string | null;
}

/** `ConfigResponse.network`. */
export interface NetworkInfo {
  /** "Monad Testnet". */
  name: string;
  /** Symbol of the native currency bets are placed in: "MON". */
  symbol: string;
  /** Block explorer base URL without a trailing slash, or `null` when there is none. */
  explorerUrl: string | null;
  /** Where players get test currency, or `null` on a chain without a faucet. */
  faucetUrl: string | null;
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
   * The chest rule version the server applied to this game. Rule 1 games carry it only when they
   * ended in a dead end; rule 2 games carry it on every ending the server made itself.
   */
  chestRule?: number;
  /**
   * Only for a game that ended in a dead end and carries `chestRule`: the chest found in that dead
   * end, or `null` for none. Path chests are in `GameView.chests`.
   */
  chest?: ChestFound | null;
}

/** A chest the player found in this game, on a cell already entered. Points have no cash value. */
export interface FoundChest {
  cell: { x: number; y: number };
  kind: 'dead-end' | 'path';
  /** Reward in basis points of the bet. */
  rewardBps: number;
  /** Points awarded, decimal. */
  points: string;
  /** Moves made when it was found: the move that entered its cell. */
  step: number;
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
  /** The chest rule of this game (rule 2 also places chests on path cells). */
  chestRule?: number;
  /** Every chest found in this game so far, in the order found: cells already entered only. */
  chests?: FoundChest[];
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
  /** Rule 2: share of path cells (neither start, exit nor dead end) that hold a chest, in basis points. */
  pathRateBps?: number;
  /** Rule 2: reward range of a path chest in basis points of the bet, both ends included. */
  pathRewardMinBps?: number;
  pathRewardMaxBps?: number;
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
  /** Chain second at which the chest was found (the move into its cell). */
  atSec: number;
  /** A path chest (found during play) or the dead-end chest that ended the game. */
  kind: 'dead-end' | 'path';
  /** Moves made when it was found. */
  step: number;
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

// ---------------------------------------------------------------------------
// Recent games and leaderboards, derived from the server's event log (stats.ts).
// ---------------------------------------------------------------------------

/** Most entries `GET /api/feed` returns. */
export const FEED_LIMIT = 10;
/** Most rows a leaderboard returns (the requesting address's own row comes on top of these). */
export const LEADERBOARD_LIMIT = 10;

export type FeedOutcome = 'exit' | 'loss' | 'cashout' | 'auto-cashout' | 'reclaimed';

export interface FeedEntry {
  gameId: Hex;
  /** Checksummed. */
  player: Hex;
  /** Board size of the game. */
  n: number;
  betWei: string;
  /** What the game paid the player; for a reclaimed game, the amount reclaimed. Decimal. */
  payoutWei: string;
  outcome: FeedOutcome;
  /** Chain second at which the game ended (or was reclaimed). */
  endedAtSec: number;
}

/** `GET /api/feed`: the most recent ended games, newest first. */
export interface FeedResponse {
  games: FeedEntry[];
  chainNowSec: number;
}

export type LeaderboardBoard = 'today' | 'all' | 'points';

export interface LeaderboardRow {
  /** 1-based. */
  rank: number;
  /** Checksummed. */
  address: Hex;
  /** Decimal. Net profit in wei for 'today' and 'all' (may be negative); points for 'points'. */
  value: string;
}

/** `GET /api/leaderboard?board=today|all|points[&address=0x…]` */
export interface LeaderboardResponse {
  board: LeaderboardBoard;
  rows: LeaderboardRow[];
  /** The requesting address ranked among everyone, or null when no address was given or it has no entry. */
  me: LeaderboardRow | null;
  /** 'today' only: chain second of the next UTC midnight, when the board starts over. */
  resetsAtSec?: number;
  chainNowSec: number;
}
