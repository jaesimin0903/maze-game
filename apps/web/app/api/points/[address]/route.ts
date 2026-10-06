import { getAddress, isAddress } from 'viem';
import { ApiError } from '../../../../src/server/errors';
import { json, route } from '../../../../src/server/http';
import { toPointsResponse } from '../../../../src/server/serializer';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/points/:address`: the address's points balance and its most recent chest awards.
 * Points have no cash value.
 *
 * Public, like a balance on a block explorer, for three reasons. Every award is of a finished
 * game, written together with its ending, so the ledger never says anything about a game in
 * progress. Every award can be recomputed by anyone from public data once the game is over (the
 * players and the revealed seeds are on chain, the chest rule is public). And the session token
 * is per game, not per wallet, so it could not guard a per-wallet read anyway; a read that needs
 * proof of the wallet would need a wallet signature on every header refresh. Points are bound to
 * the address by the ticket, which only that address could request (it signs the request).
 */
export const GET = route(async ({ container, params }) => {
  const { address } = params;
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address) || !isAddress(address, { strict: false })) {
    throw new ApiError('BAD_REQUEST');
  }
  const checksummed = getAddress(address);
  return json(toPointsResponse(checksummed, container.service.pointsOf(checksummed)));
});
