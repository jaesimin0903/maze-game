import { ApiError } from '../../../../src/server/errors';
import { json, readJsonObject, route, type RouteContext } from '../../../../src/server/http';
import { parseUiSnapshot } from '../../../../src/server/test-hooks';

export const dynamic = 'force-dynamic';

const MAX_SNAPSHOT_BYTES = 1_000_000;

/** Both methods exist only while test hooks are on; otherwise the route answers 404. */
function requireTestHooks({ container }: RouteContext): void {
  if (!container.testHooks) throw new ApiError('NOT_FOUND');
}

/** `POST /api/test/ui-snapshot`: stores what the page's `TestBeacon` read from the DOM. */
export const POST = route(async (context) => {
  requireTestHooks(context);
  const body = await readJsonObject(context.request, { maxBytes: MAX_SNAPSHOT_BYTES });
  context.container.snapshots.put(parseUiSnapshot(body));
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
});

/** `GET /api/test/ui-snapshot`: the latest snapshot, with its sequence number. */
export const GET = route(async (context) => {
  requireTestHooks(context);
  const latest = context.container.snapshots.get();
  if (latest === null) throw new ApiError('NOT_FOUND');
  return json(latest);
});
