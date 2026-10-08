// The chain as the page names it: amounts in the network's own coin, links to its block explorer,
// and, on a server without a Privy app, a header without any of the Privy login.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exitPayoutWei, type Hex } from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { BET_GAS, betShortfall, readAmount } from '../../src/client/bet-form';
import { createChainApi } from '../../src/client/chain';
import { Dock } from '../../src/client/components/Dock';
import { formatEth } from '../../src/client/format';
import { NetworkContext, explorerLink, networkView } from '../../src/client/network';
import { CONTRACT, FakeWorld, PLAYER, TABLE, makeConfig } from './helpers';

/** Counts loads of Privy's SDK: the page must not fetch it without a Privy app in its config. */
const privySdk = vi.hoisted(() => ({ loads: 0 }));
vi.mock('@privy-io/react-auth', () => {
  privySdk.loads += 1;
  return {};
});

const MONAD = {
  name: 'Monad Testnet',
  symbol: 'MON',
  explorerUrl: 'https://testnet.monadexplorer.com/',
  faucetUrl: 'https://faucet.monad.xyz',
};
const BET = 10n ** 16n;
/** The amount the dock starts with: 0.05. */
const START_BET = 5n * 10n ** 16n;

const text = (testId: string): string => screen.getByTestId(testId).textContent ?? '';

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('without a Privy app', () => {
  it('shows no log-in, keeps the wallet buttons as they were, and never loads the Privy SDK', async () => {
    const world = new FakeWorld({ privyAppId: null });
    render(<GameApp deps={world.deps()} />);
    expect((await screen.findByTestId('wallet-connect')).className).toBe('primary');
    expect(screen.queryByTestId('privy-login')).toBeNull();

    fireEvent.click(screen.getByTestId('wallet-dev-option'));
    const address = await screen.findByTestId('wallet-address');
    expect(address.textContent).toBe(PLAYER);
    expect(address.getAttribute('data-kind')).toBe('dev');
    expect(screen.queryByTestId('wallet-menu')).toBeNull();
    expect(screen.getByTestId('wallet-disconnect')).toBeTruthy();
    await waitFor(() => expect(text('wallet-balance')).toBe('10 ETH'));
    expect(privySdk.loads).toBe(0);
  });
});

describe('on Monad', () => {
  it('prints every amount in MON and links the chain to its explorer', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('bet-start');

    expect(text('escape-payout')).toBe(`${formatEth(exitPayoutWei(TABLE, START_BET, 0), 4)} MON`);
    expect(screen.getByLabelText('Custom bet in MON')).toBe(screen.getByTestId('bet-amount'));
    expect(screen.getByRole('group', { name: 'Bet presets in MON' })).toBeTruthy();
    await waitFor(() => expect(text('bankroll')).toContain('MON'));

    // The footer names the network and links to the contract.
    const chainInfo = screen.getByTestId('chain-info');
    expect(chainInfo.textContent).toBe('Monad Testnet');
    expect(chainInfo.getAttribute('data-chain-id')).toBe('10143');
    expect(chainInfo.querySelector('a')?.getAttribute('href')).toBe(
      `https://testnet.monadexplorer.com/address/${CONTRACT}`,
    );

    fireEvent.change(screen.getByTestId('bet-amount'), { target: { value: 'abc' } });
    await waitFor(() => expect(text('bet-invalid')).toBe('Enter the bet in MON, for example 0.01'));
    fireEvent.change(screen.getByTestId('bet-amount'), { target: { value: '0.01' } });

    fireEvent.click(screen.getByTestId('wallet-dev-option'));
    await waitFor(() => expect(text('wallet-balance')).toBe('10 MON'));
    await waitFor(() => expect(text('dock-balance')).toContain('MON in the wallet'));

    fireEvent.click(screen.getByTestId('bet-start'));
    expect((await screen.findByTestId('bet-submit')).textContent).toBe('Sign and bet 0.01 MON');
    expect(text('schedule-exit-payout')).toBe(`Reaching the exit pays ${formatEth(exitPayoutWei(TABLE, BET, 0))} MON.`);
    expect(screen.getByTestId('sign-sheet').textContent).not.toContain('ETH');
  });

  it('links the settlement of a finished game to the explorer', () => {
    const txHash: Hex = `0x${'5e'.repeat(32)}`;
    const noop = (): void => undefined;
    render(
      <NetworkContext value={networkView({ network: MONAD })}>
        <Dock
          model={{
            kind: 'ended',
            gameId: `0x${'01'.repeat(32)}`,
            result: { outcome: 'exit', payoutWei: 2n * BET, txHash },
            betWei: BET,
            confirmed: true,
            canSelfSettle: false,
            walletConnected: true,
            busy: false,
            choice: 0,
            reclaim: null,
            onSettleSelf: noop,
            onNewGame: noop,
            onVerify: noop,
          }}
        />
      </NetworkContext>,
    );
    const link = screen.getByTestId('settle-tx').querySelector('a');
    expect(link?.getAttribute('href')).toBe(`https://testnet.monadexplorer.com/tx/${txHash}`);
    expect(link?.textContent).toBe(`Settled · tx ${txHash.slice(0, 6)}…${txHash.slice(-4)}`);
    expect(text('result-net')).toBe(`Net +${formatEth(BET, 4)} MON`);
  });

  it('stops a bet the balance cannot pay with its fee, and points to the faucet', async () => {
    // 0.05 MON, the bet the dock starts with: the fee of the bet transaction does not fit.
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    world.balance = START_BET;
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    const short = await screen.findByTestId('bet-short');
    // 250,000 gas at the fake chain's fee bid of 1.2 gwei (its gas price of 1 gwei × 6/5).
    expect(short.getAttribute('data-wei')).toBe((250_000n * 1_200_000_000n).toString());
    expect(short.textContent).toContain('Need 0.0003 MON more for the bet and its fee');
    expect(screen.getByTestId('dock-faucet').getAttribute('href')).toBe(MONAD.faucetUrl);

    fireEvent.click(screen.getByTestId('bet-start'));
    const submit = (await screen.findByTestId('bet-submit')) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(text('bet-status')).toBe('Not enough MON: the bet and its network fee need 0.0003 MON more');
    expect(world.signed).toEqual([]);
  });

  it('reads the balance again before the signature', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
    fireEvent.click(screen.getByTestId('bet-start'));
    const submit = (await screen.findByTestId('bet-submit')) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    // The wallet is emptied elsewhere after the page last looked.
    world.balance = 0n;
    fireEvent.click(submit);
    await waitFor(() => expect(text('bet-status')).toContain('Not enough MON'));
    expect(world.signed).toEqual([]);
    expect(world.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('counts the bet fee at the bid the wallet makes, never below what the chain wants up front', async () => {
    // A chain at a base fee of 100 gwei that suggests a 2 gwei tip, as its RPC answers them.
    const GWEI = 1_000_000_000n;
    let eip1559 = true;
    const answer: Record<string, () => unknown> = {
      eth_getBlockByNumber: () => ({
        number: '0x10',
        hash: `0x${'11'.repeat(32)}`,
        timestamp: '0x1',
        transactions: [],
        ...(eip1559 ? { baseFeePerGas: `0x${(100n * GWEI).toString(16)}` } : {}),
      }),
      eth_maxPriorityFeePerGas: () => `0x${(2n * GWEI).toString(16)}`,
      eth_gasPrice: () => `0x${(102n * GWEI).toString(16)}`,
    };
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      const call = JSON.parse(init.body) as { id: number; method: string };
      const result = answer[call.method];
      return new Response(
        JSON.stringify(
          result
            ? { jsonrpc: '2.0', id: call.id, result: result() }
            : { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: call.method } },
        ),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    const chain = createChainApi(makeConfig({ chainId: 10143, rpcUrl: 'http://rpc.test' }));

    // viem's rule, which Privy's embedded wallet bids with: base fee × 1.2 plus the tip.
    const bid = await chain.maxFeePerGas();
    expect(bid).toBe(122n * GWEI);
    expect(bid).toBeGreaterThan(await chain.gasPrice());
    // The pre-check asks for the bet plus 250,000 gas at that bid: just enough is enough, a wei less is short.
    const need = BET + BET_GAS * bid;
    expect(betShortfall(need, BET, bid)).toBeNull();
    expect(betShortfall(need - 1n, BET, bid)).toBe(1n);

    // A chain without EIP-1559 fees: the gas price × 6/5.
    eip1559 = false;
    expect(await chain.maxFeePerGas()).toBe((102n * GWEI * 6n) / 5n);
  });

  it('names the coin in the amount checks and builds explorer links without a doubled slash', () => {
    expect(readAmount('1', BET, BET, 'MON')).toEqual({ reason: `The maximum bet is ${formatEth(BET)} MON` });
    expect(readAmount('x', BET, BET)).toEqual({ reason: 'Enter the bet in ETH, for example 0.01' });
    const view = networkView({ network: MONAD });
    expect(view).toEqual({ symbol: 'MON', explorerUrl: 'https://testnet.monadexplorer.com' });
    expect(explorerLink(view.explorerUrl, 'tx', '0xabc')).toBe('https://testnet.monadexplorer.com/tx/0xabc');
    expect(networkView({})).toEqual({ symbol: 'ETH', explorerUrl: null });
    expect(explorerLink(null, 'address', CONTRACT)).toBeNull();
  });
});
