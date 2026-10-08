import type { LeaderboardBoard } from '@maze/shared';
import { getAddress, isAddress } from 'viem';
import { ApiError } from '../../../src/server/errors';
import { json, route } from '../../../src/server/http';
import { toLeaderboardResponse } from '../../../src/server/serializer';

export const dynamic = 'force-dynamic';

const BOARDS: readonly string[] = ['today', 'all', 'points'] satisfies LeaderboardBoard[];

/**
 * `GET /api/leaderboard?board=today|all|points[&address=0x…]`: the top players by net profit
 * today (UTC, on the chain clock) or over all time, or by points. `board` defaults to `today`.
 * With `address` (any letter case), that address's own row comes along, wherever it ranks.
 *
 * Public, like the points route: it is built from the endings, reclaims and chest awards of the
 * event log, every one of them of a finished game or of a cell already entered.
 */
export const GET = route(async ({ container, request }) => {
  const query = new URL(request.url).searchParams;
  const board = query.get('board') ?? 'today';
  if (!BOARDS.includes(board)) throw new ApiError('BAD_REQUEST');
  const address = query.get('address');
  if (
    address !== null &&
    (!/^0x[0-9a-fA-F]{40}$/.test(address) || !isAddress(address, { strict: false }))
  ) {
    throw new ApiError('BAD_REQUEST');
  }
  const nowSec = await container.clock.chainNow();
  const standings = container.service.leaderboard(
    board as LeaderboardBoard,
    address === null ? null : getAddress(address),
    nowSec,
  );
  return json(toLeaderboardResponse(board as LeaderboardBoard, standings, nowSec));
});
