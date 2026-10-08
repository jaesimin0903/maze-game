// The Privy login: the embedded wallet behind `connectPrivyWallet`, and the header's log-in and
// account panel with `@privy-io/react-auth` replaced by a small in-memory session. The page signs
// with the embedded wallet through its EIP-1193 provider; nothing here reaches Privy.

import { createElement, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { stringToHex, toFunctionSelector, type EIP1193Provider } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ticketRequestMessage, type ConfigResponse, type Hex } from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { stepText } from '../../src/client/bet-form';
import { AccountPanel, feeReserve, readTransfer, transferGasLimit } from '../../src/client/components/AccountPanel';
import { privyConfig } from '../../src/client/components/PrivyWallet';
import type { ClientDeps } from '../../src/client/deps';
import { formatEth } from '../../src/client/format';
import { connectPrivyWallet, type WalletApi } from '../../src/client/wallet';
import { CONTRACT, FakeWorld, PLAYER, anvilAccount, makeConfig } from './helpers';

/** The Privy session the mocked hooks read. Tests change it with `privy.set`. */
const privy = vi.hoisted(() => {
  const state = {
    ready: true,
    authenticated: false,
    user: null as { wallet?: { address: string; walletClientType?: string } } | null,
    wallets: [] as unknown[],
    walletsReady: true,
    error: null as Error | null,
  };
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    state,
    version: () => version,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(patch: Partial<typeof state>) {
      Object.assign(state, patch);
      version += 1;
      listeners.forEach((listener) => listener());
    },
    provider: null as { appId: string; config: unknown } | null,
    /** What the provider throws when it mounts, as the SDK does for an app id it rejects. */
    refuse: null as string | null,
    /** The account panel throws while rendering, as a bug in it would. */
    panelBreaks: false,
    /** The login's own UI throws while rendering (`usePrivy` throws), with the provider still up. */
    sessionBreaks: false,
    login: vi.fn(),
    logout: vi.fn(),
    exportWallet: vi.fn(),
    connectWallet: vi.fn(),
    createWallet: vi.fn(),
  };
});

vi.mock('../../src/client/components/AccountPanel', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/client/components/AccountPanel')>();
  return {
    ...real,
    AccountPanel: (props: ComponentProps<typeof real.AccountPanel>) => {
      if (privy.panelBreaks) throw new Error('the panel broke');
      return createElement(real.AccountPanel, props);
    },
  };
});

vi.mock('@privy-io/react-auth', async () => {
  const { useSyncExternalStore } = await import('react');
  const useSession = () => {
    useSyncExternalStore(privy.subscribe, privy.version);
    return privy.state;
  };
  return {
    PrivyProvider: ({ appId, config, children }: { appId: string; config: unknown; children: unknown }) => {
      if (privy.refuse !== null) throw new Error(privy.refuse);
      privy.provider = { appId, config };
      return children;
    },
    usePrivy: () => {
      const s = useSession();
      if (privy.sessionBreaks) throw new Error('the login UI broke');
      return {
        ready: s.ready,
        authenticated: s.authenticated,
        user: s.user,
        error: s.error,
        login: privy.login,
        connectWallet: privy.connectWallet,
      };
    },
    useWallets: () => {
      const s = useSession();
      return { wallets: s.wallets, ready: s.walletsReady };
    },
    useLogout: () => ({ logout: privy.logout }),
    useExportWallet: () => ({ exportWallet: privy.exportWallet }),
    useCreateWallet: () => ({ createWallet: privy.createWallet }),
  };
});

const MONAD = {
  name: 'Monad Testnet',
  symbol: 'MON',
  explorerUrl: 'https://testnet.monadexplorer.com',
  faucetUrl: 'https://faucet.monad.xyz',
};
const OTHER: Hex = anvilAccount(5).address;
/** `OTHER` with the case of one letter flipped: a typo its checksum catches. */
const TYPO = ((): string => {
  const i = OTHER.slice(2).search(/[a-fA-F]/) + 2;
  const c = OTHER[i];
  return `${OTHER.slice(0, i)}${c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()}${OTHER.slice(i + 1)}`;
})();
const provider = { request: async () => null } as unknown as EIP1193Provider;

/** A wallet as `useWallets` lists it. */
const connected = (walletClientType: string, address: Hex = PLAYER) => ({
  address,
  walletClientType,
  linked: true,
  getEthereumProvider: async () => provider,
});
const embeddedLogin = () => ({
  authenticated: true,
  user: { wallet: { address: PLAYER, walletClientType: 'privy' } },
  wallets: [connected('privy')],
});

const text = (testId: string): string => screen.getByTestId(testId).textContent ?? '';

beforeEach(() => {
  window.localStorage.clear();
  privy.set({ ready: true, authenticated: false, user: null, wallets: [], walletsReady: true, error: null });
  privy.provider = null;
  privy.refuse = null;
  privy.panelBreaks = false;
  privy.sessionBreaks = false;
  privy.login.mockReset();
  privy.logout.mockReset();
  privy.exportWallet.mockReset();
  privy.connectWallet.mockReset();
  privy.createWallet.mockReset();
  // Logging in through the modal: the session gets its embedded wallet.
  privy.login.mockImplementation(() => privy.set(embeddedLogin()));
  privy.logout.mockImplementation(async () => privy.set({ authenticated: false, user: null, wallets: [] }));
  privy.exportWallet.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

/** The page with a Privy app and Monad in its config; the connectors record the provider they get. */
function setup(overrides: Partial<ConfigResponse> = {}) {
  const world = new FakeWorld({ privyAppId: 'privy-app-1', network: MONAD, devWallet: false, ...overrides });
  const providers: unknown[] = [];
  const deps: ClientDeps = {
    ...world.deps(),
    connectPrivy: async (_config, given) => {
      providers.push(given);
      return { ...world.wallet(), kind: 'privy' };
    },
    connectInjected: async (_config, given) => {
      providers.push(given);
      return { ...world.wallet(), kind: 'injected' };
    },
  };
  render(<GameApp deps={deps} />);
  return { world, providers };
}

/** The Log in button once Privy's code has loaded (until then a disabled stand-in shows). */
async function loginButton(): Promise<HTMLElement> {
  await waitFor(() => expect(privy.provider).not.toBeNull());
  const button = await screen.findByTestId('privy-login');
  expect((button as HTMLButtonElement).disabled).toBe(false);
  return button;
}

async function logIn(): Promise<void> {
  fireEvent.click(await loginButton());
  await screen.findByTestId('wallet-menu');
}

describe('connectPrivyWallet', () => {
  const config = makeConfig({ chainId: 10143, network: MONAD, privyAppId: 'privy-app-1' });

  /** The embedded wallet's provider: it starts on `chainId` and answers what the page asks. */
  function embedded(chainId = '0x1', switches = true) {
    const calls: { method: string; params?: unknown }[] = [];
    let current = chainId;
    const request = async (call: { method: string; params?: unknown }) => {
      calls.push(call);
      switch (call.method) {
        case 'eth_requestAccounts':
          return [PLAYER];
        case 'eth_chainId':
          return current;
        case 'wallet_switchEthereumChain':
          if (switches) current = (call.params as { chainId: string }[])[0].chainId;
          return null;
        case 'personal_sign':
          return `0x${'5a'.repeat(65)}`;
        case 'eth_sendTransaction':
          return `0x${'7e'.repeat(32)}`;
        default:
          throw new Error(`unexpected ${call.method}`);
      }
    };
    const provider = { request, on: () => undefined, removeListener: () => undefined } as unknown as EIP1193Provider;
    return { provider, calls };
  }

  it('moves the wallet to the configured chain and routes signatures and transactions to its provider', async () => {
    const { provider, calls } = embedded();
    const wallet = await connectPrivyWallet(config, provider);
    expect(wallet.kind).toBe('privy');
    expect(wallet.address).toBe(PLAYER);
    expect(calls.find((c) => c.method === 'wallet_switchEthereumChain')?.params).toEqual([{ chainId: '0x279f' }]);
    // Privy's only supported chain is the game's: nothing tries to add another one.
    expect(calls.some((c) => c.method === 'wallet_addEthereumChain')).toBe(false);

    const message = ticketRequestMessage({
      chainId: 10143,
      mazeBetAddress: CONTRACT,
      player: PLAYER,
      tier: 0,
      sessionTokenHash: `0x${'ab'.repeat(32)}`,
    });
    expect(await wallet.signMessage(message)).toBe(`0x${'5a'.repeat(65)}`);
    expect(calls.filter((c) => c.method === 'personal_sign').map((c) => c.params)).toEqual([
      [stringToHex(message), PLAYER],
    ]);

    const hash = await wallet.createGame({
      ticket: {
        gameId: `0x${'01'.repeat(32)}`,
        player: PLAYER,
        tier: 0,
        commitment: `0x${'02'.repeat(32)}`,
        expirySec: 1_700_000_600,
        signature: `0x${'03'.repeat(65)}`,
      },
      clientSeed: `0x${'c1'.repeat(32)}`,
      betWei: 10n ** 16n,
    });
    expect(hash).toBe(`0x${'7e'.repeat(32)}`);
    await wallet.transfer({ to: OTHER, valueWei: 5n * 10n ** 17n });

    const sent = calls
      .filter((c) => c.method === 'eth_sendTransaction')
      .map((c) => (c.params as Record<string, string>[])[0]);
    expect(sent).toHaveLength(2);
    expect(sent[0].from.toLowerCase()).toBe(PLAYER.toLowerCase());
    expect(sent[0].to.toLowerCase()).toBe(CONTRACT.toLowerCase());
    expect(BigInt(sent[0].value)).toBe(10n ** 16n);
    expect(sent[0].data.startsWith(toFunctionSelector('createGame(bytes32,uint8,bytes32,uint64,bytes32,bytes)'))).toBe(
      true,
    );
    expect(sent[1].to.toLowerCase()).toBe(OTHER.toLowerCase());
    expect(BigInt(sent[1].value)).toBe(5n * 10n ** 17n);
  });

  it('asks for no switch when the wallet is already on the chain, and fails when it cannot get there', async () => {
    const on = embedded('0x279f');
    await connectPrivyWallet(config, on.provider);
    expect(on.calls.some((c) => c.method === 'wallet_switchEthereumChain')).toBe(false);

    const stuck = embedded('0x1', false);
    await expect(connectPrivyWallet(config, stuck.provider)).rejects.toThrow(/chain 10143/);
  });
});

describe('Privy settings', () => {
  it('turns the embedded wallet screens off and makes the game chain the only one', () => {
    const settings = privyConfig(makeConfig({ chainId: 10143, rpcUrl: 'https://rpc.example', network: MONAD }));
    expect(settings.embeddedWallets).toEqual({
      ethereum: { createOnLogin: 'users-without-wallets' },
      showWalletUIs: false,
    });
    expect(settings.loginMethods).toEqual(['email', 'google', 'passkey', 'wallet']);
    expect(settings.defaultChain?.id).toBe(10143);
    expect(settings.defaultChain?.nativeCurrency.symbol).toBe('MON');
    expect(settings.defaultChain?.rpcUrls.default.http).toEqual(['https://rpc.example']);
    expect(settings.supportedChains?.map((c) => c.id)).toEqual([10143]);
    expect(settings.appearance?.walletChainType).toBe('ethereum-only');
  });

  it('a bet with the embedded wallet waits for no wallet prompt', () => {
    expect(stepText('sign', 'privy')).toBe('Signing the ticket request with your account wallet');
    expect(stepText('tx', 'privy')).toBe('Sending the bet transaction from your account wallet');
    expect(stepText('sign', 'injected')).toContain('Wallet 1 of 2');
  });
});

describe('log in', () => {
  it('opens the Privy modal from Log in and connects the embedded wallet once the login has it', async () => {
    const { providers } = setup();
    const login = await loginButton();
    expect(login.className).toBe('primary');
    expect(privy.provider?.appId).toBe('privy-app-1');
    // The other ways stay, behind the login.
    expect(screen.getByTestId('wallet-connect').className).toBe('quiet');
    expect(screen.queryByTestId('wallet-dev-option')).toBeNull();

    fireEvent.click(login);
    expect(privy.login).toHaveBeenCalledTimes(1);
    const address = await screen.findByTestId('wallet-address');
    expect(address.getAttribute('data-kind')).toBe('privy');
    expect(address.getAttribute('data-address')).toBe(PLAYER);
    expect(providers).toEqual([provider]);
    expect(screen.queryByTestId('privy-login')).toBeNull();
    expect(screen.queryByTestId('wallet-connect')).toBeNull();
    await waitFor(() => expect(text('wallet-balance')).toBe('10 MON'));
  });

  it('reconnects by itself when Privy restores the session after a reload', async () => {
    privy.set(embeddedLogin());
    setup();
    expect((await screen.findByTestId('wallet-address')).getAttribute('data-kind')).toBe('privy');
    expect(privy.login).not.toHaveBeenCalled();
  });

  it('plays with the external wallet a player logged in with, which asks as a browser wallet does', async () => {
    privy.login.mockImplementation(() =>
      privy.set({
        authenticated: true,
        user: { wallet: { address: PLAYER, walletClientType: 'metamask' } },
        wallets: [connected('metamask')],
      }),
    );
    const { providers } = setup();
    await logIn();
    expect(screen.getByTestId('wallet-address').getAttribute('data-kind')).toBe('injected');
    expect(providers).toEqual([provider]);
    fireEvent.click(screen.getByTestId('wallet-menu'));
    // Privy holds no key of an external wallet, so there is nothing to export.
    expect(screen.queryByTestId('wallet-export')).toBeNull();
    expect(screen.getByTestId('privy-logout')).toBeTruthy();
  });

  it('keeps the page and the other wallets when the Privy SDK refuses to start, and retries on request', async () => {
    privy.refuse = 'Cannot initialize the Privy provider with an invalid Privy app ID';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const world = new FakeWorld({ privyAppId: 'privy-app-1', network: MONAD });
    render(<GameApp deps={world.deps()} />);
    await waitFor(() => expect(screen.getByTestId('wallet-connect').className).toBe('primary'));
    expect(screen.queryByTestId('privy-login')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Log in failed to load.');
    expect(text('privy-retry')).toBe('Retry log in');
    expect(logged).toHaveBeenCalledWith('Privy failed', expect.any(Error));
    expect(screen.getByTestId('bet-start')).toBeTruthy();

    // A transient failure: Retry mounts the login again.
    privy.refuse = null;
    fireEvent.click(screen.getByTestId('privy-retry'));
    await loginButton();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('wallet-connect').className).toBe('quiet');
    fireEvent.click(screen.getByTestId('wallet-dev-option'));
    expect((await screen.findByTestId('wallet-address')).getAttribute('data-kind')).toBe('dev');
    logged.mockRestore();
  });

  it('drops the embedded wallet when Privy itself goes down, and reconnects it on Retry log in', async () => {
    const { providers } = setup();
    await logIn();
    // The SDK reports that it cannot run: the embedded wallet signs through it, so it goes too.
    act(() => privy.set({ ready: false, error: new Error('Invalid Privy app ID') }));
    await screen.findByTestId('privy-retry');
    expect(screen.queryByTestId('wallet-address')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Log in failed to load.');

    act(() => privy.set({ ready: true, error: null }));
    fireEvent.click(screen.getByTestId('privy-retry'));
    // The session is still there: the wallet connects again by itself.
    expect((await screen.findByTestId('wallet-address')).getAttribute('data-kind')).toBe('privy');
    expect(providers).toHaveLength(2);
  });

  it('keeps an external wallet the login connected when Privy itself goes down', async () => {
    privy.login.mockImplementation(() =>
      privy.set({
        authenticated: true,
        user: { wallet: { address: PLAYER, walletClientType: 'metamask' } },
        wallets: [connected('metamask')],
      }),
    );
    setup();
    await logIn();
    act(() => privy.set({ ready: false, error: new Error('Invalid Privy app ID') }));
    await screen.findByTestId('privy-retry');
    // MetaMask's provider does not need Privy: the wallet stays, as a browser wallet.
    const address = screen.getByTestId('wallet-address');
    expect(address.getAttribute('data-kind')).toBe('injected');
    expect(address.closest('.stat-chip')?.getAttribute('title')).toBe('Browser wallet');
    expect(screen.getByTestId('wallet-disconnect')).toBeTruthy();
  });

  it('keeps the embedded wallet when only the login UI fails, as an account wallet chip', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { providers } = setup();
    await logIn();
    privy.sessionBreaks = true;
    act(() => privy.set({}));
    const retry = await screen.findByTestId('privy-retry');
    expect(retry.textContent).toBe('Retry log in');
    expect(screen.getByRole('alert').textContent).toBe('Log in failed to load.');
    expect(logged).toHaveBeenCalledWith('Privy login failed', expect.any(Error));
    // Privy keeps running under the failed UI: the wallet stays connected, named as the account wallet.
    const address = screen.getByTestId('wallet-address');
    expect(address.getAttribute('data-kind')).toBe('privy');
    expect(address.closest('.stat-chip')?.textContent).toContain('Account wallet');
    expect(screen.queryByTestId('wallet-disconnect')).toBeNull();

    privy.sessionBreaks = false;
    fireEvent.click(retry);
    expect(await screen.findByTestId('wallet-menu')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    // The same wallet: nothing was connected again.
    expect(providers).toHaveLength(1);
    logged.mockRestore();
  });

  it('takes the log-in away when Privy cannot load the app', async () => {
    privy.set({ ready: false });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const world = new FakeWorld({ privyAppId: 'privy-app-1', network: MONAD });
    render(<GameApp deps={world.deps()} />);
    await waitFor(() => expect(privy.provider).not.toBeNull());
    expect((screen.getByTestId('privy-login') as HTMLButtonElement).disabled).toBe(true);
    act(() => privy.set({ error: new Error('Invalid Privy app ID') }));
    await waitFor(() => expect(screen.queryByTestId('privy-login')).toBeNull());
    expect(screen.getByTestId('wallet-connect').className).toBe('primary');
    expect(screen.getByRole('alert').textContent).toBe('Log in failed to load.');
    expect(screen.getByTestId('privy-retry')).toBeTruthy();
    vi.mocked(console.error).mockRestore();
  });

  it('keeps a failed connection on screen and lets the player try again', async () => {
    const world = new FakeWorld({ privyAppId: 'privy-app-1', network: MONAD });
    let fail = true;
    const deps: ClientDeps = {
      ...world.deps(),
      connectPrivy: async () => {
        if (fail) throw new Error('The account wallet could not switch to chain 10143');
        return { ...world.wallet(), kind: 'privy' };
      },
    };
    render(<GameApp deps={deps} />);
    fireEvent.click(await loginButton());
    expect((await screen.findByRole('alert')).textContent).toContain('could not switch');
    const retry = await screen.findByTestId('privy-connect');
    expect(retry.textContent).toBe('Connect');
    fail = false;
    fireEvent.click(retry);
    expect((await screen.findByTestId('wallet-address')).getAttribute('data-kind')).toBe('privy');
  });
});

describe('a login whose wallet does not come', () => {
  it('gives up connecting after the wait, keeps Log out at hand, and connects on Connect', async () => {
    const world = new FakeWorld({ privyAppId: 'privy-app-1', network: MONAD });
    let answer = false;
    privy.login.mockImplementation(() =>
      privy.set({
        ...embeddedLogin(),
        // Privy's iframe does not answer until `answer` is set.
        wallets: [{ ...connected('privy'), getEthereumProvider: () => (answer ? Promise.resolve(provider) : new Promise(() => undefined)) }],
      }),
    );
    const deps: ClientDeps = {
      ...world.deps(),
      connectPrivy: async () => ({ ...world.wallet(), kind: 'privy' }),
      timing: { ...world.deps().timing, walletWaitMs: 60 },
    };
    render(<GameApp deps={deps} />);
    fireEvent.click(await loginButton());
    const connecting = await screen.findByTestId('privy-connect');
    expect(connecting.textContent).toBe('Connecting...');
    expect((screen.getByTestId('privy-logout') as HTMLButtonElement).disabled).toBe(false);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('did not answer within'));
    expect(text('privy-connect')).toBe('Connect');
    answer = true;
    fireEvent.click(screen.getByTestId('privy-connect'));
    expect((await screen.findByTestId('wallet-address')).getAttribute('data-kind')).toBe('privy');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not time out an external wallet while it may be showing the player a prompt', async () => {
    const world = new FakeWorld({ privyAppId: 'privy-app-1', network: MONAD });
    privy.login.mockImplementation(() =>
      privy.set({
        authenticated: true,
        user: { wallet: { address: PLAYER, walletClientType: 'metamask' } },
        wallets: [connected('metamask')],
      }),
    );
    const deps: ClientDeps = {
      ...world.deps(),
      // The player takes longer than the wait to approve the chain switch in MetaMask.
      connectInjected: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { ...world.wallet(), kind: 'injected' };
      },
      timing: { ...world.deps().timing, walletWaitMs: 40 },
    };
    render(<GameApp deps={deps} />);
    fireEvent.click(await loginButton());
    expect((await screen.findByTestId('wallet-address')).getAttribute('data-kind')).toBe('injected');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('logs out while the wallet is still connecting', async () => {
    const world = new FakeWorld({ privyAppId: 'privy-app-1', network: MONAD });
    privy.login.mockImplementation(() =>
      privy.set({ ...embeddedLogin(), wallets: [{ ...connected('privy'), getEthereumProvider: () => new Promise(() => undefined) }] }),
    );
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await loginButton());
    await screen.findByText('Connecting...');
    fireEvent.click(screen.getByTestId('privy-logout'));
    await loginButton();
    expect(privy.logout).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('wallet-address')).toBeNull();
  });

  it('says so when no wallet appears, and creates one on request', async () => {
    const world = new FakeWorld({ privyAppId: 'privy-app-1', network: MONAD });
    // The login succeeds but the embedded wallet is never created.
    privy.login.mockImplementation(() => privy.set({ authenticated: true, user: {}, wallets: [] }));
    privy.createWallet.mockImplementation(async () => privy.set(embeddedLogin()));
    const deps: ClientDeps = { ...world.deps(), timing: { ...world.deps().timing, walletWaitMs: 60 } };
    render(<GameApp deps={deps} />);
    fireEvent.click(await loginButton());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No account wallet was created'));
    expect(text('privy-connect')).toBe('Create wallet');
    expect(screen.getByTestId('privy-logout')).toBeTruthy();
    fireEvent.click(screen.getByTestId('privy-connect'));
    expect(privy.createWallet).toHaveBeenCalledTimes(1);
    expect((await screen.findByTestId('wallet-address')).getAttribute('data-kind')).toBe('privy');
  });
});

describe('the account panel', () => {
  it('a fault in the panel keeps the game wallet and can be reloaded', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setup();
    await logIn();
    privy.panelBreaks = true;
    act(() => privy.set({ walletsReady: true }));
    await screen.findByTestId('account-retry');
    expect(logged).toHaveBeenCalledWith('Account panel failed', expect.any(Error));
    // The wallet stays connected; the log-in is not offered again.
    expect(screen.getByTestId('wallet-address').getAttribute('data-kind')).toBe('privy');
    expect(screen.queryByTestId('privy-login')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    privy.panelBreaks = false;
    fireEvent.click(screen.getByTestId('account-retry'));
    expect(await screen.findByTestId('wallet-menu')).toBeTruthy();
    logged.mockRestore();
  });

  it('moves the focus with every withdrawal step, and keeps the keys away from the game', async () => {
    const world = new FakeWorld({ privyAppId: 'privy-app-1', network: MONAD });
    let release = (): void => undefined;
    const deps: ClientDeps = {
      ...world.deps(),
      connectPrivy: async (): Promise<WalletApi> => ({
        ...world.wallet(),
        kind: 'privy',
        transfer: () =>
          new Promise<Hex>((resolve) => {
            release = () => resolve(`0x${'7e'.repeat(32)}`);
          }),
      }),
    };
    render(<GameApp deps={deps} />);
    await logIn();
    fireEvent.click(screen.getByTestId('wallet-menu'));
    const panel = screen.getByTestId('wallet-panel');
    fireEvent.click(screen.getByTestId('wallet-send-open'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('send-to')));

    fireEvent.change(screen.getByTestId('send-to'), { target: { value: OTHER } });
    fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '0.5' } });
    await waitFor(() => expect((screen.getByTestId('send-max') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('send-review'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('send-confirm')));

    fireEvent.click(screen.getByTestId('send-confirm'));
    // While sending, the confirm button is disabled and the panel itself holds the focus.
    await waitFor(() => expect(document.activeElement).toBe(panel));
    fireEvent.keyDown(panel, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(panel, { key: 'ArrowDown', code: 'ArrowDown' });
    expect(screen.queryByTestId('sign-sheet')).toBeNull();
    expect(screen.getByTestId('tier-0').getAttribute('data-selected')).toBe('true');

    act(() => release());
    const done = await screen.findByTestId('send-done');
    await waitFor(() => expect(document.activeElement).toBe(within(done).getByRole('button', { name: 'Done' })));
    fireEvent.click(within(done).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('wallet-send-open')));

    // Escape closes the panel from any step.
    fireEvent.click(screen.getByTestId('wallet-send-open'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('send-to')));
    fireEvent.keyDown(screen.getByTestId('send-to'), { key: 'Escape', code: 'Escape' });
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('wallet-menu'));
  });

  it('prices a transfer to a contract from its gas estimate and sends it with that gas limit', async () => {
    const world = new FakeWorld({ privyAppId: 'privy-app-1', network: MONAD });
    const sent: { gas?: bigint }[] = [];
    const deps: ClientDeps = {
      ...world.deps(),
      chain: (config) => ({ ...world.deps().chain(config), estimateTransferGas: async () => 50_000n }),
      connectPrivy: async (): Promise<WalletApi> => ({
        ...world.wallet(),
        kind: 'privy',
        transfer: async (p) => {
          sent.push(p);
          return `0x${'7e'.repeat(32)}`;
        },
      }),
    };
    render(<GameApp deps={deps} />);
    await logIn();
    fireEvent.click(screen.getByTestId('wallet-menu'));
    fireEvent.click(screen.getByTestId('wallet-send-open'));
    await waitFor(() => expect((screen.getByTestId('send-max') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByTestId('send-to'), { target: { value: OTHER } });
    fireEvent.click(screen.getByTestId('send-max'));
    // 50,000 gas estimated, sent with 57,500; the fee kept back is that at twice 1 gwei.
    const fee = feeReserve(57_500n, 1_000_000_000n);
    await waitFor(() =>
      expect((screen.getByTestId('send-amount') as HTMLInputElement).value).toBe(formatEth(world.balance - fee, 18)),
    );
    fireEvent.click(screen.getByTestId('send-review'));
    const review = await screen.findByTestId('send-review-step');
    expect(within(review).getByTestId('send-fee').getAttribute('data-gas')).toBe('57500');
    expect(within(review).getByTestId('send-fee').getAttribute('data-wei')).toBe(fee.toString());
    fireEvent.click(screen.getByTestId('send-confirm'));
    await screen.findByTestId('send-done');
    expect(sent).toEqual([{ to: OTHER, valueWei: world.balance - fee, gas: 57_500n }]);
  });

  it('offers to read the gas price again when the read failed', async () => {
    const world = new FakeWorld({ privyAppId: 'privy-app-1', network: MONAD });
    let down = false;
    const deps: ClientDeps = {
      ...world.deps(),
      chain: (config) => ({
        ...world.deps().chain(config),
        gasPrice: async () => {
          if (down) throw new Error('rpc down');
          return 1_000_000_000n;
        },
      }),
    };
    render(<GameApp deps={deps} />);
    await logIn();
    fireEvent.click(screen.getByTestId('wallet-menu'));
    down = true;
    fireEvent.click(screen.getByTestId('wallet-send-open'));
    expect((await screen.findByTestId('fee-error')).textContent).toContain('could not be read');
    expect((screen.getByTestId('send-max') as HTMLButtonElement).disabled).toBe(true);
    down = false;
    fireEvent.click(screen.getByTestId('fee-retry'));
    await waitFor(() => expect((screen.getByTestId('send-max') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId('fee-error')).toBeNull();
  });

  it('shows the address with a copy button, the balance in MON, the faucet and the explorer', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup();
    await logIn();
    const panel = screen.getByTestId('wallet-panel');
    expect(panel.hidden).toBe(true);
    fireEvent.click(screen.getByTestId('wallet-menu'));
    expect(panel.hidden).toBe(false);
    expect(screen.getByTestId('wallet-menu').getAttribute('aria-expanded')).toBe('true');

    expect(text('account-address')).toBe(PLAYER);
    await waitFor(() => expect(text('account-balance')).toBe('10 MON'));
    expect(screen.getByTestId('wallet-faucet').getAttribute('href')).toBe(MONAD.faucetUrl);
    expect(screen.getByTestId('wallet-explorer').getAttribute('href')).toBe(`${MONAD.explorerUrl}/address/${PLAYER}`);
    fireEvent.click(screen.getByTestId('wallet-copy'));
    await waitFor(() => expect(text('wallet-copy')).toBe('Copied'));
    expect(writeText).toHaveBeenCalledWith(PLAYER);

    // Escape closes it and gives the focus back to the chip.
    fireEvent.keyDown(screen.getByTestId('wallet-copy'), { key: 'Escape', code: 'Escape' });
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('wallet-menu'));
  });

  it('validates a withdrawal, asks for a confirmation with the amount and destination, then sends it', async () => {
    const { world } = setup();
    await logIn();
    fireEvent.click(screen.getByTestId('wallet-menu'));
    fireEvent.click(screen.getByTestId('wallet-send-open'));
    await waitFor(() => expect((screen.getByTestId('send-max') as HTMLButtonElement).disabled).toBe(false));

    const to = (value: string): void => void fireEvent.change(screen.getByTestId('send-to'), { target: { value } });
    const amount = (value: string): void =>
      void fireEvent.change(screen.getByTestId('send-amount'), { target: { value } });
    const reviewSays = async (expected: string): Promise<void> => {
      fireEvent.click(screen.getByTestId('send-review'));
      await waitFor(() => expect(text('account-error')).toContain(expected));
      expect(screen.queryByTestId('send-review-step')).toBeNull();
    };

    amount('1');
    to('0x1234');
    await reviewSays('0x followed by 40 hex digits');
    to(PLAYER);
    await reviewSays('own address');
    to(CONTRACT);
    await reviewSays('game contract');
    to(TYPO);
    await reviewSays('checksum');
    to(OTHER.toLowerCase());
    amount('abc');
    await reviewSays('Enter the amount in MON');
    amount('0');
    await reviewSays('above 0');
    amount('10');
    await reviewSays('more than the balance leaves after the network fee');

    // MAX leaves the fee of the transfer's estimated gas at twice the gas price (1 gwei here).
    const most = world.balance - feeReserve(21_000n, 1_000_000_000n);
    fireEvent.click(screen.getByTestId('send-max'));
    await waitFor(() => expect((screen.getByTestId('send-amount') as HTMLInputElement).value).toBe(formatEth(most, 18)));
    amount('0.5');
    fireEvent.click(screen.getByTestId('send-review'));

    const review = await screen.findByTestId('send-review-step');
    expect(within(review).getByTestId('send-confirm-amount').textContent).toBe('0.5 MON');
    expect(within(review).getByTestId('send-confirm-to').textContent).toBe(OTHER.toLowerCase());
    expect(within(review).getByTestId('send-fee').textContent).toContain('at most 0.000042 MON');
    expect(world.txs).toEqual([]);
    fireEvent.click(screen.getByTestId('send-confirm'));
    const done = await screen.findByTestId('send-done');
    expect(world.txs).toEqual(['transfer']);
    expect(world.balance).toBe(10n ** 19n - 5n * 10n ** 17n);
    expect(done.querySelector('a')?.getAttribute('href')).toBe(`${MONAD.explorerUrl}/tx/${done.getAttribute('data-tx')}`);
  });

  it('explains a withdrawal Monad refused right after a bet', async () => {
    const world = new FakeWorld({ privyAppId: 'privy-app-1', network: MONAD, chainId: 10143 });
    const deps: ClientDeps = {
      ...world.deps(),
      connectPrivy: async (): Promise<WalletApi> => ({
        ...world.wallet(),
        kind: 'privy',
        transfer: async () => {
          throw new Error('The withdrawal transaction was reverted');
        },
      }),
    };
    render(<GameApp deps={deps} />);
    await logIn();
    fireEvent.click(screen.getByTestId('wallet-menu'));
    fireEvent.click(screen.getByTestId('wallet-send-open'));
    await waitFor(() => expect((screen.getByTestId('send-max') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByTestId('send-to'), { target: { value: OTHER } });
    fireEvent.click(screen.getByTestId('send-max'));
    await waitFor(() => expect((screen.getByTestId('send-amount') as HTMLInputElement).value).not.toBe(''));
    fireEvent.click(screen.getByTestId('send-review'));
    fireEvent.click(await screen.findByTestId('send-confirm'));
    await waitFor(() => expect(text('account-error')).toContain('10 MON reserve'));
    // The confirmation stays, to send again a few seconds later.
    expect(screen.getByTestId('send-review-step')).toBeTruthy();
  });

  it('exports the embedded key through Privy and logs out', async () => {
    setup();
    await logIn();
    fireEvent.click(screen.getByTestId('wallet-menu'));
    fireEvent.click(screen.getByTestId('wallet-export'));
    await waitFor(() => expect(privy.exportWallet).toHaveBeenCalledWith({ address: PLAYER }));

    fireEvent.click(screen.getByTestId('privy-logout'));
    await screen.findByTestId('privy-login');
    expect(privy.logout).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('wallet-address')).toBeNull();
  });

  it('lets go of the wallet when the session ends elsewhere', async () => {
    setup();
    await logIn();
    act(() => privy.set({ authenticated: false, user: null, wallets: [] }));
    await screen.findByTestId('privy-login');
    expect(screen.queryByTestId('wallet-address')).toBeNull();
  });
});

describe('withdrawal checks', () => {
  it('sends a plain transfer with its exact gas and pads a contract call by 15%', () => {
    expect(transferGasLimit(21_000n)).toBe(21_000n);
    expect(transferGasLimit(50_000n)).toBe(57_500n);
    expect(transferGasLimit(30_001n)).toBe(34_502n);
    expect(feeReserve(21_000n, 100_000_000_000n)).toBe(4_200_000_000_000_000n);
  });

  const base = { balanceWei: 10n ** 18n, reserveWei: 0n, self: PLAYER, contract: CONTRACT, symbol: 'MON' };

  it('accepts a lowercase or checksummed address and an amount the balance covers', () => {
    expect(readTransfer({ ...base, to: OTHER, amount: '1' })).toEqual({ to: OTHER, valueWei: 10n ** 18n });
    expect(readTransfer({ ...base, to: ` ${OTHER.toLowerCase()} `, amount: '0.25' })).toEqual({
      to: OTHER.toLowerCase(),
      valueWei: 25n * 10n ** 16n,
    });
  });

  it('refuses the zero address, an unknown balance and a balance the fee alone takes', () => {
    expect(readTransfer({ ...base, to: `0x${'00'.repeat(20)}`, amount: '1' })).toEqual({
      reason: 'That is the zero address: coins sent there are lost',
    });
    expect(readTransfer({ ...base, balanceWei: null, to: OTHER, amount: '1' })).toEqual({
      reason: 'The balance has not been read yet',
    });
    expect(readTransfer({ ...base, reserveWei: 10n ** 18n, to: OTHER, amount: '0.1' })).toEqual({
      reason: 'The balance does not cover the network fee',
    });
  });
});
