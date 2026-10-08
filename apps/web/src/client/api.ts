// Typed HTTP client for the game server (plan §7.3). The browser talks to the server only
// through this module.

import {
  ERROR_STATUS,
  type CashoutRequest,
  type ConfigResponse,
  type CreateGameRequest,
  type ErrorCode,
  type FeedResponse,
  type GameView,
  type Hex,
  type LeaderboardBoard,
  type LeaderboardResponse,
  type MoveRequest,
  type PointsResponse,
  type RevealResponse,
  type TicketResponse,
  type UiSnapshotInput,
} from '@maze/shared';

/** The server answered with its error body: `{ error: { code, message } }`. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * No usable answer: the request failed at the network level, or the response was not one the
 * game server produces (for example a proxy error page while the process is down). A 500 that
 * carries the server's own `INTERNAL` error body is an `ApiError`, not this: the server answered.
 */
export class ServerUnreachableError extends Error {
  override readonly name = 'ServerUnreachableError';
}

const API_MESSAGES: Record<ErrorCode, string> = {
  BAD_REQUEST: 'The request was not valid',
  UNAUTHORIZED: 'This browser did not start this game',
  NOT_FOUND: 'The server does not know this game',
  TICKET_EXPIRED: 'The ticket has expired. Place your bet again',
  NOT_ON_CHAIN: 'The server has not seen the bet transaction on chain yet',
  ALREADY_ACTIVE: 'This wallet already has a game in progress. Bet again once that game is over',
  GAME_NOT_ACTIVE: 'The game is already over',
  STALE_STEP: 'This game moved on elsewhere. The page is up to date now',
  INVALID_MOVE_WALL: 'You cannot walk through a wall',
  INVALID_MOVE_VISITED: 'You cannot go back to a cell you already visited',
  INVALID_MOVE_BOUNDS: 'You cannot leave the board',
  DEADLINE_PASSED: 'Time is up. The server is settling the game',
  NOT_REVEALABLE: 'The server seed for this game cannot be revealed yet',
  RATE_LIMITED: 'Too many requests. Try again in a moment',
  INTERNAL: 'The game server hit an internal error. It is still up; try again shortly',
  NOT_CALIBRATED: 'The payout table is not certified yet, so games cannot open',
  TABLE_MISMATCH: 'The server and the contract have different payout tables, so games cannot open',
  CHAIN_UNAVAILABLE: 'The server cannot reach the chain',
};

/** A sentence for the player about a server error. */
export function apiMessage(error: ApiError): string {
  return API_MESSAGES[error.code];
}

export interface ApiClient {
  config(): Promise<ConfigResponse>;
  createTicket(body: CreateGameRequest): Promise<TicketResponse>;
  start(gameId: Hex, token: string): Promise<GameView>;
  move(gameId: Hex, token: string, body: MoveRequest): Promise<GameView>;
  cashout(gameId: Hex, token: string, body: CashoutRequest): Promise<GameView>;
  /** Resume and polling read. The only response that carries `path`. */
  game(gameId: Hex, token: string): Promise<GameView>;
  reveal(gameId: Hex): Promise<RevealResponse>;
  /** The points balance and recent chest awards of a wallet address. Points have no cash value. */
  points(address: Hex): Promise<PointsResponse>;
  /** The most recent ended games of every player, newest first. */
  feed(): Promise<FeedResponse>;
  /** One leaderboard; with `address`, that wallet's own row as well. */
  leaderboard(board: LeaderboardBoard, address: Hex | null): Promise<LeaderboardResponse>;
  postSnapshot(body: UiSnapshotInput): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_STATUS, value);
}

export function createApi(
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
): ApiClient {
  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { token?: string; body?: unknown; empty?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetchImpl(path, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: 'no-store',
      });
    } catch (cause) {
      throw new ServerUnreachableError(`${method} ${path} failed`, { cause });
    }

    if (response.ok && options.empty) return undefined as T;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new ServerUnreachableError(`${method} ${path} answered ${response.status} without JSON`, {
        cause,
      });
    }

    if (response.ok) return payload as T;

    const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    if (error && isErrorCode(error.code)) {
      throw new ApiError(error.code, response.status, String(error.message ?? error.code));
    }
    throw new ServerUnreachableError(`${method} ${path} answered ${response.status}`);
  }

  const gamePath = (gameId: Hex, suffix = ''): string => `/api/games/${gameId}${suffix}`;

  return {
    config: () => call('GET', '/api/config'),
    createTicket: (body) => call('POST', '/api/games', { body }),
    start: (gameId, token) => call('POST', gamePath(gameId, '/start'), { token, body: {} }),
    move: (gameId, token, body) => call('POST', gamePath(gameId, '/move'), { token, body }),
    cashout: (gameId, token, body) => call('POST', gamePath(gameId, '/cashout'), { token, body }),
    game: (gameId, token) => call('GET', gamePath(gameId), { token }),
    reveal: (gameId) => call('GET', gamePath(gameId, '/reveal')),
    points: (address) => call('GET', `/api/points/${address}`),
    feed: () => call('GET', '/api/feed'),
    leaderboard: (board, address) => {
      const query = new URLSearchParams({ board });
      if (address !== null) query.set('address', address);
      return call('GET', `/api/leaderboard?${query.toString()}`);
    },
    postSnapshot: (body) => call('POST', '/api/test/ui-snapshot', { body, empty: true }),
  };
}
