// The chain as the page names it: amounts in the network's own coin, links to its block explorer,
// and, on a server without a Privy app, a header without any of the Privy login.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exitPayoutWei, type Hex } from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { BET_GAS, betShortfall, betTicks, sliderPosition } from '../../src/client/bet-form';
import { createChainApi } from '../../src/client/chain';
import { HpRow, ScreenMenu, type PanelModel } from '../../src/client/components/Panel';
import { formatEth, formatEthFixed } from '../../src/client/format';
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
/** The bet the slider starts on: 0.05. */
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
    await screen.findByTestId('btn-a');

    expect(text('escape-payout')).toBe(`${formatEthFixed(exitPayoutWei(TABLE, START_BET, 0), 3)} MON at the exit`);
    expect(text('lcd')).toContain('0.050 MON');
    expect(text('hp-stake')).toContain('0.0500 MON');
    // The slider and its tick labels name the chain's coin.
    expect(screen.getByTestId('bet-slider').getAttribute('aria-valuetext')).toBe('0.050 MON');
    expect(screen.getByTestId('bet-slider').getAttribute('aria-label')).toBe('Bet in MON');
    expect(screen.getByRole('button', { name: 'Bet 0.05 MON' }).getAttribute('aria-pressed')).toBe('true');
    // Without a wallet the balance under the screen is a dash.
    expect(text('console-balance')).toBe('BALANCE —');
    await waitFor(() => expect(text('bankroll')).toContain('MON'));

    // The footer names the network and links to the contract.
    const chainInfo = screen.getByTestId('chain-info');
    expect(chainInfo.textContent).toBe('Monad Testnet');
    expect(chainInfo.getAttribute('data-chain-id')).toBe('10143');
    expect(chainInfo.querySelector('a')?.getAttribute('href')).toBe(
      `https://testnet.monadexplorer.com/address/${CONTRACT}`,
    );

    fireEvent.click(screen.getByTestId('bet-preset-.01'));

    fireEvent.click(screen.getByTestId('wallet-dev-option'));
    await waitFor(() => expect(text('wallet-balance')).toBe('10 MON'));
    await waitFor(() => expect(text('console-balance')).toBe('BALANCE 10 MON'));
    expect(screen.getByTestId('console-balance').getAttribute('data-wei')).toBe((10n ** 19n).toString());

    fireEvent.click(screen.getByTestId('btn-a'));
    expect((await screen.findByTestId('bet-submit')).textContent).toBe('Sign and bet 0.01 MON');
    expect(text('schedule-exit-payout')).toBe(`Reaching the exit pays ${formatEth(exitPayoutWei(TABLE, BET, 0))} MON.`);
    expect(screen.getByTestId('sign-sheet').textContent).not.toContain('ETH');
  });

  it('links the settlement of a finished game to the explorer', () => {
    const txHash: Hex = `0x${'5e'.repeat(32)}`;
    const noop = (): void => undefined;
    const model: PanelModel = {
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
    };
    render(
      <NetworkContext value={networkView({ network: MONAD })}>
        <HpRow model={model} />
        <ScreenMenu model={model} />
      </NetworkContext>,
    );
    const link = screen.getByTestId('settle-tx').querySelector('a');
    expect(link?.getAttribute('href')).toBe(`https://testnet.monadexplorer.com/tx/${txHash}`);
    expect(link?.textContent).toBe(`Settled · tx ${txHash.slice(0, 6)}…${txHash.slice(-4)}`);
    expect(text('result-payout')).toBe(`${formatEthFixed(2n * BET, 4)} MON`);
    expect(text('result-net')).toBe(`+${formatEthFixed(BET, 4)} vs BET`);
  });

  it('stops a bet the balance cannot pay with its fee on the slider, and points to the faucet', async () => {
    // 0.05 MON, the bet the slider starts on: the fee of the bet transaction does not fit.
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    world.balance = START_BET;
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    const short = await screen.findByTestId('bet-short');
    // 250,000 gas at the fake chain's fee bid of 1.2 gwei (its gas price of 1 gwei × 6/5).
    const fee = 250_000n * 1_200_000_000n;
    expect(short.getAttribute('data-wei')).toBe(fee.toString());
    // Rounded up to the slider's 0.001: 0.0003 is never shown as 0.000. The amount is not live;
    // a fixed alert inside says once that the bet is too much.
    expect(short.querySelector('.need')?.textContent).toBe('NEED 0.001');
    expect(short.textContent).toBe('NEED 0.001 MON more for the bet and its network feeNot enough MON for this bet');
    expect(short.getAttribute('role')).toBeNull();
    const alert = screen.getByTestId('bet-short-alert');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe('Not enough MON for this bet');
    expect(screen.getAllByRole('alert').filter((el) => short.contains(el))).toEqual([alert]);
    expect(short.className).toContain('red');
    expect(screen.getByTestId('bet-faucet').getAttribute('href')).toBe(MONAD.faucetUrl);
    // The slider turns red, and the track past what the wallet pays (the balance less the fee) is hatched.
    const slider = screen.getByTestId('bet-slider');
    expect(slider.getAttribute('data-short')).toBe('true');
    expect(slider.parentElement?.querySelector('.fill')?.classList.contains('red')).toBe(true);
    expect(slider.parentElement?.querySelector('.th')?.classList.contains('red')).toBe(true);
    const ticks = betTicks(BigInt(TABLE.limits.minBetWei), BigInt(TABLE.limits.maxBetWei));
    expect(screen.getByTestId('bet-hatch').getAttribute('data-from')).toBe(sliderPosition(ticks, START_BET - fee).toFixed(4));
    // The LCD still names the bet and what the exit pays.
    expect(text('escape-payout')).toContain(formatEthFixed(exitPayoutWei(TABLE, START_BET, 0), 3));

    // While short, A (the button, Enter, Space or Z) does not start: no sheet, nothing signed. It
    // says NEED again (a pulse), and the alert, said once, stays the same element.
    expect(short.querySelector('.need')?.classList.contains('pulse')).toBe(false);
    fireEvent.click(screen.getByTestId('btn-a'));
    for (const code of ['Enter', 'Space', 'KeyZ']) fireEvent.keyDown(window, { code });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByTestId('sign-sheet')).toBeNull();
    expect(world.signed).toEqual([]);
    expect(screen.getByTestId('bet-short').querySelector('.need')?.classList.contains('pulse')).toBe(true);
    expect(screen.getByTestId('bet-short-alert')).toBe(alert);
    // A bigger bet changes the amount, not the alert.
    fireEvent.keyDown(screen.getByTestId('bet-slider'), { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('bet-short').getAttribute('data-wei')).toBe((fee + 10n ** 15n).toString()));
    expect(screen.getByTestId('bet-short-alert')).toBe(alert);
    fireEvent.keyDown(screen.getByTestId('bet-slider'), { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByTestId('bet-short').getAttribute('data-wei')).toBe(fee.toString()));

    // A smaller bet fits: the message and the red go, the hatching stays, and A opens the sheet.
    fireEvent.click(screen.getByTestId('bet-preset-.01'));
    await waitFor(() => expect(screen.queryByTestId('bet-short')).toBeNull());
    expect(screen.queryByTestId('bet-faucet')).toBeNull();
    expect(slider.getAttribute('data-short')).toBe('false');
    expect(slider.parentElement?.querySelector('.fill')?.classList.contains('red')).toBe(false);
    expect(screen.getByTestId('bet-hatch')).toBeTruthy();
    fireEvent.click(screen.getByTestId('btn-a'));
    const submit = (await screen.findByTestId('bet-submit')) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(text('bet-submit')).toBe('Sign and bet 0.01 MON');
  });

  it('A while short looks at the balance again at once, so coins from the faucet count', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    world.balance = START_BET;
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('bet-short');
    // The faucet pays; without A the page would look again only after 15 seconds.
    world.balance = 10n ** 18n;
    fireEvent.click(screen.getByTestId('btn-a'));
    await waitFor(() => expect(screen.queryByTestId('bet-short')).toBeNull());
    expect(screen.queryByTestId('sign-sheet')).toBeNull();
    fireEvent.click(screen.getByTestId('btn-a'));
    expect(await screen.findByTestId('sign-sheet')).toBeTruthy();
  });

  it('turns red exactly past what the wallet pays, and rounds what it lacks up', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    const fee = 250_000n * 1_200_000_000n;
    // The wallet pays 0.032 with the fee reserved: the hatching starts at 0.032.
    world.balance = 32n * 10n ** 15n + fee;
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    const ticks = betTicks(BigInt(TABLE.limits.minBetWei), BigInt(TABLE.limits.maxBetWei));
    const hatch = await screen.findByTestId('bet-hatch');
    expect(hatch.getAttribute('data-from')).toBe(sliderPosition(ticks, 32n * 10n ** 15n).toFixed(4));
    // 0.05 lacks 0.018.
    expect((await screen.findByTestId('bet-short')).textContent).toContain('NEED 0.018 MON');
    const slider = screen.getByTestId('bet-slider');
    // On the boundary the bet is paid; a step past it is short, by 0.001.
    fireEvent.keyDown(slider, { key: 'PageDown' });
    await waitFor(() => expect(slider.getAttribute('data-wei')).toBe((10n ** 16n).toString()));
    for (let k = 0; k < 22; k++) fireEvent.keyDown(slider, { key: 'ArrowRight' });
    await waitFor(() => expect(slider.getAttribute('data-wei')).toBe((32n * 10n ** 15n).toString()));
    expect(screen.queryByTestId('bet-short')).toBeNull();
    expect(slider.getAttribute('data-short')).toBe('false');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    const short = await screen.findByTestId('bet-short');
    expect(short.getAttribute('data-wei')).toBe((10n ** 15n).toString());
    expect(short.textContent).toContain('NEED 0.001 MON');
    expect(slider.getAttribute('data-short')).toBe('true');
    // A wallet that cannot even pay the fee has the whole track hatched.
    cleanup();
    const empty = new FakeWorld({ network: MONAD, chainId: 10143 });
    empty.balance = fee - 1n;
    render(<GameApp deps={empty.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    expect((await screen.findByTestId('bet-hatch')).getAttribute('data-from')).toBe('0.0000');
  });

  it('reads the balance again before the signature', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
    fireEvent.click(screen.getByTestId('btn-a'));
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

  it('builds explorer links without a doubled slash', () => {
    const view = networkView({ network: MONAD });
    expect(view).toEqual({ symbol: 'MON', explorerUrl: 'https://testnet.monadexplorer.com' });
    expect(explorerLink(view.explorerUrl, 'tx', '0xabc')).toBe('https://testnet.monadexplorer.com/tx/0xabc');
    expect(networkView({})).toEqual({ symbol: 'ETH', explorerUrl: null });
    expect(explorerLink(null, 'address', CONTRACT)).toBeNull();
  });
});
