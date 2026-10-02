import { json, readJsonObject, route } from '../../../src/server/http';

export const dynamic = 'force-dynamic';

/** `POST /api/games`: issues a signed ticket. The server seed is fixed before any client seed exists. */
export const POST = route(async ({ container, request }) => {
  const body = await readJsonObject(request);
  return json(await container.service.issueTicket(body), 201);
});
