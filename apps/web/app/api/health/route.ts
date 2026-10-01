import { MAZE_VERSION, type HealthResponse } from '@maze/shared';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const body: HealthResponse = { ok: true, mazeVersion: MAZE_VERSION };
  return Response.json(body);
}
