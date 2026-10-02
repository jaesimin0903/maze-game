import { gameIdParam, json, route } from '../../../../../src/server/http';
import { revealSeed } from '../../../../../src/server/reveal';

export const dynamic = 'force-dynamic';

/** `GET /api/games/:id/reveal`: the server seed, once the chain says the game is over or void. */
export const GET = route(async ({ container, params }) =>
  json(await revealSeed(container, gameIdParam(params))),
);
