// The one place that produces error responses (plan §7.3).
//
// Every code has one fixed sentence. A message never depends on a game, so an error body cannot
// carry game state: two requests that fail with the same code get byte-identical bodies.

import { ERROR_STATUS, type ErrorCode } from '@maze/shared';

const MESSAGES: Record<ErrorCode, string> = {
  BAD_REQUEST: 'The request is malformed.',
  UNAUTHORIZED: 'The session token is missing or does not belong to this game.',
  NOT_FOUND: 'Not found.',
  TICKET_EXPIRED: 'The ticket expired before the game was created on chain.',
  NOT_ON_CHAIN: 'The server has not seen this game on chain yet.',
  ALREADY_ACTIVE: 'This address already has an active game.',
  GAME_NOT_ACTIVE: 'The game has ended.',
  STALE_STEP: 'The step does not match the current state of the game.',
  INVALID_MOVE_WALL: 'There is a wall in that direction.',
  INVALID_MOVE_VISITED: 'That cell was already visited.',
  INVALID_MOVE_BOUNDS: 'That direction leaves the board.',
  DEADLINE_PASSED: 'The time limit of the game has passed.',
  NOT_REVEALABLE: 'The server seed of this game cannot be revealed yet.',
  RATE_LIMITED: 'Too many requests.',
  NOT_CALIBRATED: 'The tuning table is not certified for play.',
  TABLE_MISMATCH: 'The tuning table does not match the deployed contract.',
  CHAIN_UNAVAILABLE: 'The chain is unavailable.',
};

// Route handlers and the instrumentation hook can be bundled separately by Next.js, so the same
// class may exist twice in one process. A registered symbol identifies an `ApiError` across those
// copies where `instanceof` would not.
const BRAND = Symbol.for('maze.server.ApiError');

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly [BRAND] = true;

  /** `options.cause` is kept for the server's logs only; it never reaches a response. */
  constructor(
    readonly code: ErrorCode,
    options?: { cause?: unknown },
  ) {
    super(MESSAGES[code], options);
  }
}

export function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[BRAND] === true &&
    Object.hasOwn(ERROR_STATUS, (value as { code?: unknown }).code as string)
  );
}

/** Why the server refused to boot. Every game route answers with this code (503) afterwards. */
export type BootFailureCode = 'NOT_CALIBRATED' | 'TABLE_MISMATCH' | 'CHAIN_UNAVAILABLE';

export class BootError extends Error {
  override readonly name = 'BootError';

  constructor(
    readonly code: BootFailureCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The response for `code`. `INTERNAL` (500) is not part of the public error-code list: it is the
 * answer to an unexpected exception, and its body says nothing about what went wrong.
 */
export function errorResponse(code: ErrorCode | 'INTERNAL'): Response {
  const body =
    code === 'INTERNAL'
      ? { error: { code, message: 'Internal error.' } }
      : { error: { code, message: MESSAGES[code] } };
  return Response.json(body, {
    status: code === 'INTERNAL' ? 500 : ERROR_STATUS[code],
    headers: { 'cache-control': 'no-store' },
  });
}
