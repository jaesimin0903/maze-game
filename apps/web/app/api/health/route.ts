import { MAZE_VERSION, type HealthResponse } from '@maze/shared';
import { ApiError } from '../../../src/server/errors';
import { json, route } from '../../../src/server/http';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/health`: 200 only while the server can do its job. It answers with an error when the
 * boot was refused (503, the boot's code), when the event log can no longer be written (500),
 * and when the worker has not completed a pass recently (503): in each of those states games
 * are not being cashed out and settled.
 */
export const GET = route(async ({ container }) => {
  const problem = container.health();
  if (problem === 'store-failed') throw new ApiError('INTERNAL');
  if (problem === 'worker-stalled') throw new ApiError('CHAIN_UNAVAILABLE');
  const body: HealthResponse = { ok: true, mazeVersion: MAZE_VERSION };
  return json(body);
});
