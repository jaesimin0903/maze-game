import { json, route } from '../../../src/server/http';
import { toFeedResponse } from '../../../src/server/serializer';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/feed`: the most recent ended games, newest first, at most `FEED_LIMIT`.
 *
 * Public, like the points route: every entry is a game that is over, built from the event log
 * alone, and its player, bet and payout are on chain or about to be.
 */
export const GET = route(async ({ container }) => {
  const nowSec = await container.clock.chainNow();
  return json(toFeedResponse(container.service.recentGames(), nowSec));
});
