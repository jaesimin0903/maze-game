import { bearerToken, gameIdParam, json, readJsonObject, route } from '../../../../../src/server/http';

export const dynamic = 'force-dynamic';

/** `POST /api/games/:id/cashout` */
export const POST = route(async ({ container, request, params }) => {
  const body = await readJsonObject(request);
  return json(await container.service.cashout(gameIdParam(params), bearerToken(request), body));
});
