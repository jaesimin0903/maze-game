import { bearerToken, gameIdParam, json, route } from '../../../../src/server/http';

export const dynamic = 'force-dynamic';

/** `GET /api/games/:id`: the resume and polling read. The only response with `path`. */
export const GET = route(async ({ container, request, params }) =>
  json(await container.service.view(gameIdParam(params), bearerToken(request))),
);
