// Chain-decided seed reveal (plan §3.5, AC-S10).
//
// The server seed of a game is given out only when the CHAIN says the game can no longer be
// played: it was settled (the seed is then in the `GameSettled` log anyway), it was reclaimed,
// or it was never created and no longer can be. The server's own log is used for one thing
// only, to look up the seed and the ticket's expiry. It never decides: a game the watcher has
// not noticed is still `Active` on chain, and that is what counts.

import { ONCHAIN_STATUS, type Hex, type RevealResponse } from '@maze/shared';
import type { ChainPort } from './chain';
import { ApiError } from './errors';
import type { GameService } from './game-service';
import { toRevealResponse } from './serializer';

/** A ticket's seed is revealed once a block is this many seconds past the ticket's expiry. */
export const REVEAL_GRACE_SEC = 60;

export async function revealSeed(
  deps: { chain: ChainPort; service: GameService },
  gameId: Hex,
): Promise<RevealResponse> {
  const game = deps.service.get(gameId);
  if (game === undefined) throw new ApiError('NOT_FOUND');

  // The block's timestamp and the game's state are read from the same block.
  const head = await deps.chain.head();
  const onchain = await deps.chain.game(gameId, head.number);

  if (onchain.status === ONCHAIN_STATUS.None) {
    // `createGame` requires `block.timestamp <= expiry`, and block timestamps do not decrease:
    // once a block past the expiry shows no game, none can ever be created from this ticket.
    if (head.timestamp > game.expirySec + REVEAL_GRACE_SEC) {
      return toRevealResponse(game, 'ticket-expired');
    }
    throw new ApiError('NOT_REVEALABLE');
  }
  if (onchain.commitment.toLowerCase() !== game.commitment) throw new ApiError('NOT_REVEALABLE');
  if (onchain.status === ONCHAIN_STATUS.Settled) return toRevealResponse(game, 'settled');
  if (onchain.status === ONCHAIN_STATUS.Reclaimed) return toRevealResponse(game, 'reclaimed');
  throw new ApiError('NOT_REVEALABLE');
}
