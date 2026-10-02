import { bearerToken, gameIdParam, json, readJsonObject, route } from '../../../../../src/server/http';
import { ApiError } from '../../../../../src/server/errors';

export const dynamic = 'force-dynamic';

/** `POST /api/games/:id/start`: the first cell, once the server has seen the game on chain. */
export const POST = route(async ({ container, request, params }) => {
  const body = await readJsonObject(request, { allowEmpty: true });
  if (Object.keys(body).length !== 0) throw new ApiError('BAD_REQUEST');
  return json(await container.service.start(gameIdParam(params), bearerToken(request)));
});
