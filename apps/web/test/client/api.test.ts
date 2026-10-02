import { describe, expect, it } from 'vitest';
import type { Hex } from '@maze/shared';
import { ApiError, ServerUnreachableError, apiMessage, createApi } from '../../src/client/api';

const GAME_ID: Hex = `0x${'a1'.repeat(32)}`;

function recording(response: () => Response | Promise<Response>) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const api = createApi(async (url, init) => {
    seen.push({ url, init });
    return response();
  });
  return { api, seen };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createApi', () => {
  it('sends moves to the route of plan §7.3 with the step, the direction and the session token', async () => {
    const { api, seen } = recording(() => json(200, { step: 1 }));
    await api.move(GAME_ID, 'secret', { step: 0, dir: 1 });
    expect(seen[0].url).toBe(`/api/games/${GAME_ID}/move`);
    expect(seen[0].init?.method).toBe('POST');
    expect(JSON.parse(seen[0].init?.body as string)).toEqual({ step: 0, dir: 1 });
    expect((seen[0].init?.headers as Record<string, string>).authorization).toBe('Bearer secret');
  });

  it('uses the documented method and path for every call', async () => {
    const { api, seen } = recording(() => json(200, {}));
    await api.config();
    await api.createTicket({ player: '0x00', tier: 0, sessionTokenHash: '0x00' });
    await api.start(GAME_ID, 't');
    await api.cashout(GAME_ID, 't', { step: 2 });
    await api.game(GAME_ID, 't');
    await api.reveal(GAME_ID);
    expect(seen.map((s) => `${s.init?.method} ${s.url}`)).toEqual([
      'GET /api/config',
      'POST /api/games',
      `POST /api/games/${GAME_ID}/start`,
      `POST /api/games/${GAME_ID}/cashout`,
      `GET /api/games/${GAME_ID}`,
      `GET /api/games/${GAME_ID}/reveal`,
    ]);
    expect(JSON.parse(seen[2].init?.body as string)).toEqual({});
    // Neither the config nor the reveal read carries a credential.
    expect((seen[0].init?.headers as Record<string, string>).authorization).toBeUndefined();
    expect((seen[5].init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('turns the server error body into an ApiError with its code and status', async () => {
    const { api } = recording(() => json(409, { error: { code: 'STALE_STEP', message: 'stale' } }));
    const error = await api.move(GAME_ID, 't', { step: 0, dir: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('STALE_STEP');
    expect((error as ApiError).status).toBe(409);
    expect(apiMessage(error as ApiError)).toContain('최신 상태');
  });

  it('reports a network failure and a non-JSON answer as an unreachable server', async () => {
    const down = createApi(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(down.config()).rejects.toBeInstanceOf(ServerUnreachableError);

    const proxy = recording(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    await expect(proxy.api.config()).rejects.toBeInstanceOf(ServerUnreachableError);

    const unknown = recording(() => json(500, { message: 'boom' }));
    await expect(unknown.api.config()).rejects.toBeInstanceOf(ServerUnreachableError);
  });

  it('accepts the empty 204 of the snapshot route', async () => {
    const { api, seen } = recording(() => new Response(null, { status: 204 }));
    await expect(
      api.postSnapshot({ url: 'http://localhost/', chainNowSec: 1, items: {} }),
    ).resolves.toBeUndefined();
    expect(seen[0].url).toBe('/api/test/ui-snapshot');
  });
});
