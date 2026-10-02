import { bearerToken, gameIdParam, json, readJsonObject, route } from '../../../../../src/server/http';

export const dynamic = 'force-dynamic';

/** `POST /api/games/:id/move` */
export const POST = route(async ({ container, request, params }) => {
  const body = await readJsonObject(request);
  return json(await container.service.move(gameIdParam(params), bearerToken(request), body));
});
