import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exitPayoutWei, refundWei } from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { chainOf } from '../../src/client/chain';
import { assertConfig, tableFromConfig } from '../../src/client/config';
import { FakeWorld, TABLE, makeConfig } from './helpers';

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

const WEB_ROOT = resolve(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [path] : [];
  });
}

describe('runtime configuration', () => {
  it('AC-T8: the chain connection is built from /api/config at runtime', async () => {
    const world = new FakeWorld({
      chainId: 31337,
      rpcUrl: 'http://127.0.0.1:8557',
      contract: '0x00000000000000000000000000000000000000AA',
    });
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    expect(world.requests[0]).toBe('GET /api/config');
    expect(world.chainConfigs).toHaveLength(1);
    expect(world.chainConfigs[0].rpcUrl).toBe('http://127.0.0.1:8557');
    expect(world.chainConfigs[0].contract).toBe('0x00000000000000000000000000000000000000AA');
    expect(screen.getByTestId('chain-info').getAttribute('data-chain-id')).toBe('31337');
    // The footer names the chain; the contract address is in its title.
    expect(screen.getByTestId('chain-info').textContent).toBe('Chain 31337');
    expect(screen.getByTestId('chain-info').getAttribute('title')).toBe('Contract 0x00000000000000000000000000000000000000AA');

    const chain = chainOf(world.chainConfigs[0]);
    expect(chain.id).toBe(31337);
    expect(chain.rpcUrls.default.http).toEqual(['http://127.0.0.1:8557']);
  });

  it('AC-T8: no client source reads a build-time environment value', () => {
    const files = [
      ...sourceFiles(join(WEB_ROOT, 'src/client')),
      ...sourceFiles(join(WEB_ROOT, 'app/verify')),
      join(WEB_ROOT, 'app/layout.tsx'),
      join(WEB_ROOT, 'app/page.tsx'),
    ];
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/process\.env|NEXT_PUBLIC_|import\.meta\.env/);
    }
  });

  it('AC-T8: the UI figures come from the tiers of /api/config', () => {
    const table = tableFromConfig(makeConfig());
    expect(table.tiers).toBe(TABLE.tiers);
    expect(table.mazeVersion).toBe(TABLE.mazeVersion);
    expect(refundWei(table, 10n ** 16n, 0, 3)).toBe(refundWei(TABLE, 10n ** 16n, 0, 3));
    expect(exitPayoutWei(table, 10n ** 16n, 2)).toBe(exitPayoutWei(TABLE, 10n ** 16n, 2));
  });

  it('rejects a config that cannot drive the client', () => {
    expect(() => assertConfig(null)).toThrow(/body/);
    expect(() => assertConfig({ ...makeConfig(), rpcUrl: '' })).toThrow(/rpcUrl/);
    expect(() => assertConfig({ ...makeConfig(), contract: '0x12' })).toThrow(/contract/);
    expect(() => assertConfig({ ...makeConfig(), tiers: [] })).toThrow(/tiers/);
    expect(assertConfig(makeConfig())).toEqual(makeConfig());
  });

  it('shows the fixture banner only for a test table', async () => {
    const fixture = new FakeWorld({ fixture: true });
    render(<GameApp deps={fixture.deps()} />);
    expect(await screen.findByTestId('fixture-banner')).toBeTruthy();
    cleanup();

    const production = new FakeWorld({ fixture: false, calibrated: true });
    render(<GameApp deps={production.deps()} />);
    await screen.findByTestId('btn-a');
    expect(screen.queryByTestId('fixture-banner')).toBeNull();
  });

  it('warns on screen whenever the server runs with test hooks, whichever table it uses', async () => {
    // The calibrated production table with test hooks on: no fixture banner, and still a warning.
    const hooked = new FakeWorld({ testHooks: true, fixture: false, calibrated: true });
    render(<GameApp deps={hooked.deps()} />);
    const banner = await screen.findByTestId('test-hooks-banner');
    expect(banner.textContent).toContain('Test hooks are on.');
    expect(banner.textContent).toContain('known in advance');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(screen.queryByTestId('fixture-banner')).toBeNull();
    cleanup();

    const both = new FakeWorld({ testHooks: true, fixture: true });
    render(<GameApp deps={both.deps()} />);
    expect(await screen.findByTestId('test-hooks-banner')).toBeTruthy();
    expect(screen.getByTestId('fixture-banner')).toBeTruthy();
    expect(screen.getByTestId('fixture-banner')).not.toBe(screen.getByTestId('test-hooks-banner'));
    cleanup();

    const plain = new FakeWorld({ testHooks: false, fixture: true });
    render(<GameApp deps={plain.deps()} />);
    await screen.findByTestId('fixture-banner');
    expect(screen.queryByTestId('test-hooks-banner')).toBeNull();
  });

  it('tells the player what the idle and maximum-time rules are, from the config', async () => {
    const world = new FakeWorld({ idleTimeoutSec: 77, maxGameSec: 555 });
    render(<GameApp deps={world.deps()} />);
    // The rules come with the bet sheet that A opens.
    fireEvent.click(await screen.findByTestId('btn-a'));
    const rules = (await screen.findByTestId('bet-rules')).textContent;
    expect(rules).toContain('If you do not move for 77s');
    expect(rules).toContain('555s after the start');
  });

  it('shows server-unreachable when the config cannot be loaded, and recovers on retry', async () => {
    const world = new FakeWorld();
    world.serverUp = false;
    render(<GameApp deps={world.deps()} />);
    const banner = await screen.findByTestId('server-unreachable');
    expect(screen.queryByTestId('btn-a')).toBeNull();
    expect(screen.queryByTestId('board')).toBeNull();

    world.serverUp = true;
    fireEvent.click(banner.querySelector('button') as HTMLButtonElement);
    await screen.findByTestId('btn-a');
    await waitFor(() => expect(screen.queryByTestId('server-unreachable')).toBeNull());
  });
});
