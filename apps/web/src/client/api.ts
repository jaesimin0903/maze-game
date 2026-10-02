// Typed HTTP client for the game server (plan §7.3). The browser talks to the server only
// through this module.

import {
  ERROR_STATUS,
  type CashoutRequest,
  type ConfigResponse,
  type CreateGameRequest,
  type ErrorCode,
  type GameView,
  type Hex,
  type MoveRequest,
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
 * game server produces (for example a proxy error page while the process is down).
 */
export class ServerUnreachableError extends Error {
  override readonly name = 'ServerUnreachableError';
}

const API_MESSAGES: Record<ErrorCode, string> = {
  BAD_REQUEST: '요청이 올바르지 않습니다',
  UNAUTHORIZED: '이 게임을 시작한 브라우저가 아닙니다',
  NOT_FOUND: '서버가 이 게임을 알지 못합니다',
  TICKET_EXPIRED: '티켓 유효 시간이 지났습니다. 다시 베팅해 주세요',
  NOT_ON_CHAIN: '서버가 베팅 트랜잭션을 아직 체인에서 확인하지 못했습니다',
  ALREADY_ACTIVE: '이 지갑으로 진행 중인 게임이 이미 있습니다. 그 게임이 끝난 뒤에 베팅하세요',
  GAME_NOT_ACTIVE: '게임이 이미 끝났습니다',
  STALE_STEP: '다른 곳에서 먼저 진행된 게임입니다. 최신 상태로 맞췄습니다',
  INVALID_MOVE_WALL: '벽으로는 갈 수 없습니다',
  INVALID_MOVE_VISITED: '지나온 칸으로는 돌아갈 수 없습니다',
  INVALID_MOVE_BOUNDS: '보드 밖으로는 갈 수 없습니다',
  DEADLINE_PASSED: '제한 시간이 지나 서버가 게임을 정산하고 있습니다',
  NOT_REVEALABLE: '이 게임의 서버 시드는 아직 공개할 수 없습니다',
  RATE_LIMITED: '요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요',
  NOT_CALIBRATED: '배당 표가 아직 인증되지 않아 게임을 열 수 없습니다',
  TABLE_MISMATCH: '서버와 컨트랙트의 배당 표가 달라 게임을 열 수 없습니다',
  CHAIN_UNAVAILABLE: '서버가 체인에 연결하지 못했습니다',
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
    postSnapshot: (body) => call('POST', '/api/test/ui-snapshot', { body, empty: true }),
  };
}
