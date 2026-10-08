import { describe, expect, it } from 'vitest';
import { ERROR_STATUS, type ErrorCode, type Hex } from '@maze/shared';
import { ApiError, ServerUnreachableError, apiMessage, createApi } from '../../src/client/api';
import { FakeWorld, PLAYER } from './helpers';

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
    await api.createTicket({ player: '0x00', tier: 0, sessionTokenHash: '0x00', signature: '0x00' });
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
    expect(apiMessage(error as ApiError)).toBe('This game moved on elsewhere. The page is up to date now');
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

  it('sends the signed ticket request as given', async () => {
    const { api, seen } = recording(() => json(201, {}));
    const request = {
      player: `0x${'aa'.repeat(20)}`,
      tier: 1,
      sessionTokenHash: `0x${'bb'.repeat(32)}`,
      signature: `0x${'cc'.repeat(65)}`,
    } as const;
    await api.createTicket(request);
    expect(seen[0].url).toBe('/api/games');
    expect(JSON.parse(seen[0].init?.body as string)).toEqual(request);
  });

  it('an INTERNAL answer is a server error with its own message, not an unreachable server', async () => {
    const { api } = recording(() => json(500, { error: { code: 'INTERNAL', message: 'boom' } }));
    const error = await api.config().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ServerUnreachableError);
    expect((error as ApiError).code).toBe('INTERNAL');
    expect((error as ApiError).status).toBe(500);
    expect(apiMessage(error as ApiError)).toContain('internal error');

    // A 500 whose body names no known code is still "no usable answer".
    const unknown = recording(() => json(500, { error: { code: 'EXPLODED', message: 'boom' } }));
    await expect(unknown.api.config()).rejects.toBeInstanceOf(ServerUnreachableError);
  });

  it('reads the feed and the leaderboards without a credential, the address in the query only when given', async () => {
    const { api, seen } = recording(() => json(200, {}));
    const address = PLAYER;
    await api.feed();
    await api.leaderboard('today', null);
    await api.leaderboard('all', address);
    await api.leaderboard('points', address);
    expect(seen.map((s) => `${s.init?.method} ${s.url}`)).toEqual([
      'GET /api/feed',
      'GET /api/leaderboard?board=today',
      `GET /api/leaderboard?board=all&address=${address}`,
      `GET /api/leaderboard?board=points&address=${address}`,
    ]);
    for (const request of seen) {
      expect((request.init?.headers as Record<string, string>).authorization).toBeUndefined();
      expect(request.init?.body).toBeUndefined();
    }
  });

  it('hands back the feed and leaderboard bodies as the server sent them', async () => {
    const body = { board: 'all', rows: [{ rank: 1, address: '0xab', value: '-5' }], me: null, chainNowSec: 7 };
    const { api } = recording(() => json(200, body));
    await expect(api.leaderboard('all', null)).resolves.toEqual(body);
    const bad = recording(() => json(400, { error: { code: 'BAD_REQUEST', message: 'bad' } }));
    const error = await bad.api.feed().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('BAD_REQUEST');
  });

  it('the fake server of the client tests answers both panels with empty results, outside the request log', async () => {
    const world = new FakeWorld();
    const api = createApi(world.fetch);
    await expect(api.feed()).resolves.toEqual({ games: [], chainNowSec: world.chainNow });
    await expect(api.leaderboard('points', PLAYER)).resolves.toEqual({
      board: 'points',
      rows: [],
      me: null,
      chainNowSec: world.chainNow,
    });
    const today = await api.leaderboard('today', null);
    expect(today.resetsAtSec! > world.chainNow && today.resetsAtSec! % 86_400 === 0).toBe(true);
    expect(world.requests).toEqual([]);
  });

  it('every server error has a short English sentence', () => {
    for (const code of Object.keys(ERROR_STATUS) as ErrorCode[]) {
      const message = apiMessage(new ApiError(code, ERROR_STATUS[code], code));
      expect(message, code).toMatch(/^[\x20-\x7e]+$/);
      expect(message.length, code).toBeLessThanOrEqual(90);
    }
    expect(apiMessage(new ApiError('NOT_REVEALABLE', 409, 'x'))).toBe('The server seed for this game cannot be revealed yet');
    expect(apiMessage(new ApiError('UNAUTHORIZED', 401, 'x'))).toBe('This browser did not start this game');
  });

  it('accepts the empty 204 of the snapshot route', async () => {
    const { api, seen } = recording(() => new Response(null, { status: 204 }));
    await expect(
      api.postSnapshot({ url: 'http://localhost/', chainNowSec: 1, items: {} }),
    ).resolves.toBeUndefined();
    expect(seen[0].url).toBe('/api/test/ui-snapshot');
  });
});
