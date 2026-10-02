import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { EIP1193Provider } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameApp } from '../../src/client/GameApp';
import type { ClientDeps } from '../../src/client/deps';
import {
  DEV_ACCOUNT_INDEXES,
  connectDevWallet,
  connectInjectedWallet,
  walletOptions,
} from '../../src/client/wallet';
import { FakeWorld, PLAYER, makeConfig } from './helpers';

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe('dev wallet gating', () => {
  it('AC-A4: the option is decided by devWallet of /api/config alone', () => {
    expect(walletOptions({ devWallet: true }, false)).toEqual({ injected: false, dev: true });
    expect(walletOptions({ devWallet: false }, true)).toEqual({ injected: true, dev: false });
  });

  it('AC-A4: the dev wallet option is rendered when the server enables it', async () => {
    const world = new FakeWorld({ devWallet: true });
    render(<GameApp deps={world.deps()} />);
    expect(await screen.findByTestId('wallet-connect')).toBeTruthy();
    expect(screen.getByTestId('wallet-dev-option')).toBeTruthy();
  });

  it('AC-A4: the dev wallet option is absent when the server does not enable it', async () => {
    const world = new FakeWorld({ devWallet: false });
    render(<GameApp deps={world.deps()} />);
    expect(await screen.findByTestId('wallet-connect')).toBeTruthy();
    expect(screen.queryByTestId('wallet-dev-option')).toBeNull();
    expect(screen.queryByTestId('wallet-dev-account')).toBeNull();
  });

  it('AC-A4: the dev wallet itself refuses to connect without the server flag', async () => {
    await expect(connectDevWallet(makeConfig({ devWallet: false }), 2)).rejects.toThrow(/개발용 지갑/);
  });

  it('derives the Anvil player accounts and refuses the house and server accounts', async () => {
    expect(DEV_ACCOUNT_INDEXES).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    const wallet = await connectDevWallet(makeConfig(), 2);
    expect(wallet.kind).toBe('dev');
    // Anvil account #2 of the default mnemonic.
    expect(wallet.address).toBe(PLAYER);
    await expect(connectDevWallet(makeConfig(), 0)).rejects.toThrow();
    await expect(connectDevWallet(makeConfig(), 1)).rejects.toThrow();
  });
});

describe('wallet connection', () => {
  it('connects the dev wallet and shows its address', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    const address = await screen.findByTestId('wallet-address');
    expect(address.textContent).toBe(PLAYER);
    expect(address.getAttribute('data-kind')).toBe('dev');
    expect(screen.queryByTestId('wallet-connect')).toBeNull();
  });

  it('says so when there is no browser wallet, and connects nothing', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-connect'));
    expect((await screen.findByRole('alert')).textContent).toContain('지갑 확장');
    expect(screen.queryByTestId('wallet-address')).toBeNull();
  });

  it('connects through the injected provider when the browser has one', async () => {
    const world = new FakeWorld({ devWallet: false });
    const provider = { request: async () => null } as unknown as EIP1193Provider;
    const seen: unknown[] = [];
    const deps: ClientDeps = {
      ...world.deps(),
      injected: () => provider,
      connectInjected: async (_config, given) => {
        seen.push(given);
        return { ...world.wallet(), kind: 'injected' };
      },
    };
    render(<GameApp deps={deps} />);
    fireEvent.click(await screen.findByTestId('wallet-connect'));
    const address = await screen.findByTestId('wallet-address');
    expect(address.getAttribute('data-kind')).toBe('injected');
    expect(seen).toEqual([provider]);
  });

  it('asks an injected wallet on another chain to switch to the configured one', async () => {
    const config = makeConfig();
    const calls: string[] = [];
    let chainId = '0x1';
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        calls.push(method);
        if (method === 'eth_requestAccounts') return [PLAYER];
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_switchEthereumChain') {
          chainId = (params as { chainId: string }[])[0].chainId;
          return null;
        }
        throw new Error(`unexpected ${method}`);
      },
      on: () => undefined,
      removeListener: () => undefined,
    } as unknown as EIP1193Provider;

    const wallet = await connectInjectedWallet(config, provider);
    expect(wallet.kind).toBe('injected');
    expect(wallet.address.toLowerCase()).toBe(PLAYER.toLowerCase());
    expect(calls).toContain('wallet_switchEthereumChain');
    expect(chainId).toBe('0x7a69');
  });
});
