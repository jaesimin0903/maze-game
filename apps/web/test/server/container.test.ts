// Plan §10: Next.js may load `instrumentation.ts` and each route handler as separate module
// instances. The server must still be ONE container. These tests load the server modules more
// than once, as separate bundles would, and check that they share state through `globalThis`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { uninstallContainer } from '../../src/server/container';
import { makeEnv } from './helpers';

afterEach(async () => {
  vi.restoreAllMocks();
  await uninstallContainer();
});

async function twoInstances<T>(load: () => Promise<T>): Promise<[T, T]> {
  vi.resetModules();
  const first = await load();
  vi.resetModules();
  const second = await load();
  return [first, second];
}

describe('one container per process', () => {
  it('a container installed by one module instance is the one every other instance gets', async () => {
    const [a, b] = await twoInstances(() => import('../../src/server/container'));
    expect(a.getContainer).not.toBe(b.getContainer);

    const env = await makeEnv({ install: false });
    a.installContainer(env.container);
    expect(await b.getContainer()).toBe(env.container);
    expect(await a.getContainer()).toBe(env.container);

    // A route handler loaded as yet another instance serves from the same container.
    vi.resetModules();
    const { GET } = await import('../../app/api/config/route');
    const response = await GET(new Request('http://localhost/api/config'), {
      params: Promise.resolve({}),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { contract: string }).contract).toBe(env.container.config.contract);
  });

  it('boot is single-flight across module instances', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const [a, b] = await twoInstances(() => import('../../src/server/container'));
    // An environment that cannot boot: the point is how many times boot runs.
    const [first, second, third] = await Promise.all([
      a.bootFromEnv({}),
      b.bootFromEnv({}),
      a.bootFromEnv({ RPC_URL: 'http://127.0.0.1:1' }),
    ]);
    expect(first.ok).toBe(false);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(lines.filter((line) => line.includes('boot-failed'))).toHaveLength(1);

    await expect(b.getContainer()).rejects.toMatchObject({ code: 'CHAIN_UNAVAILABLE' });
  });

  it('an ApiError is recognized across module instances, where instanceof would fail', async () => {
    const [a, b] = await twoInstances(() => import('../../src/server/errors'));
    const error = new a.ApiError('STALE_STEP');
    expect(error instanceof b.ApiError).toBe(false);
    expect(b.isApiError(error)).toBe(true);
    expect(b.isApiError(new Error('STALE_STEP'))).toBe(false);
    expect(b.isApiError({ code: 'STALE_STEP' })).toBe(false);

    // So a handler bundle turns an error thrown by the service bundle into the right response.
    const env = await makeEnv({ install: false });
    const [, container] = await twoInstances(() => import('../../src/server/container'));
    container.installContainer(env.container);
    vi.resetModules();
    const { GET } = await import('../../app/api/games/[id]/route');
    const response = await GET(new Request(`http://localhost/api/games/0x${'ab'.repeat(32)}`), {
      params: Promise.resolve({ id: `0x${'ab'.repeat(32)}` }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });

  it('an unexpected failure answers 500 with a body that says nothing', async () => {
    const env = await makeEnv();
    env.container.service.view = () => Promise.reject(new Error('disk on fire: /secret/path'));
    const { GET } = await import('../../app/api/games/[id]/route');
    const response = await GET(new Request(`http://localhost/api/games/0x${'ab'.repeat(32)}`), {
      params: Promise.resolve({ id: `0x${'ab'.repeat(32)}` }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal error.' } });
    expect(env.logs.at(-1)).toMatchObject({ level: 'error', event: 'request-failed' });
  });
});
