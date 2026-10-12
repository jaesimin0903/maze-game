// What a bet costs in network fees: the guide on the lobby screen next to the bet (typical gas ×
// gas price), and on the end screen the fee the bet transaction really paid (its receipt) with the
// game's result net of it; the game's details list that fee too. The balance check before a bet
// counts the fee at the wallet's bid instead (bet-form.test.ts, network.test.tsx).

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exitPayoutWei, refundWei, type Hex } from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { DIR_NAMES } from '../../src/client/board-view';
import { endFee, type EndFigures } from '../../src/client/components/Console';
import type { ClientDeps } from '../../src/client/deps';
import { formatApprox, formatEth } from '../../src/client/format';
import { CLIENT_SEED, FakeWorld, TABLE, planExit } from './helpers';

const GWEI = 1_000_000_000n;
const MILLI = 10n ** 15n;
/** The bet transaction of the live game on Monad testnet: 173,824 gas at 102 gwei. */
const MONAD_FEE = 173_824n * 102n * GWEI;
const BET = 10n * MILLI;
const MONAD = {
  name: 'Monad Testnet',
  symbol: 'MON',
  explorerUrl: 'https://testnet.monadexplorer.com',
  faucetUrl: 'https://faucet.monad.xyz',
};

const attr = (testId: string, name: string): string | null => screen.getByTestId(testId).getAttribute(name);
const text = (testId: string): string => screen.getByTestId(testId).textContent ?? '';
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));
const figures = (payoutWei: bigint, feeWei: bigint | null, betWei: bigint | null = BET): EndFigures => ({
  payoutWei,
  betWei,
  feeWei,
  points: 0n,
});

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

/** Connects the dev wallet and bets 0.01 on the smallest maze. */
async function startGame(world: FakeWorld): Promise<Hex> {
  render(<GameApp deps={world.deps()} />);
  fireEvent.click(await screen.findByTestId('wallet-dev-option'));
  await screen.findByTestId('wallet-address');
  fireEvent.click(screen.getByTestId('tier-0'));
  fireEvent.click(screen.getByTestId('bet-preset-.01'));
  fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: CLIENT_SEED } });
  fireEvent.click(screen.getByTestId('btn-a'));
  await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
  return attr('board', 'data-game-id') as Hex;
}

/** A asks to cash out, "Take it" takes it. */
async function cashOut(): Promise<void> {
  await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
  fireEvent.click(screen.getByTestId('btn-a'));
  fireEvent.click(await screen.findByTestId('cashout-button'));
  await screen.findByTestId('end-effect');
}

describe('fee figures', () => {
  it('rounds an approximate fee to two significant digits', () => {
    expect(formatApprox(MONAD_FEE)).toBe('0.018');
    expect(formatApprox(175_000n * 102n * GWEI)).toBe('0.018');
    expect(formatApprox(175_000n * GWEI)).toBe('0.00018');
    expect(formatApprox(1_250n * MILLI)).toBe('1.3');
    expect(formatApprox(0n)).toBe('0');
  });

  it('a 5×5 win of 0.026088 on a 0.01 bet still loses once the fee is counted', () => {
    const payout = 26_088_000_000_000_000n;
    expect(endFee(figures(payout, MONAD_FEE), 'MON')).toEqual({
      feeWei: MONAD_FEE,
      netWei: payout - BET - MONAD_FEE,
      fee: 'fee -0.0177',
      net: 'net -0.0016 MON',
      tone: 'loss',
    });
    // A bet ten times as large comes out ahead.
    const big = endFee(figures(10n * payout, MONAD_FEE, 10n * BET), 'MON');
    expect(big?.net).toBe('net +0.1431 MON');
    expect(big?.tone).toBe('win');
  });

  it('a dead end loses the bet and the fee; a cash-out and a reclaim lose the fee and the dropped part', () => {
    expect(endFee(figures(0n, MONAD_FEE), 'MON')).toMatchObject({
      netWei: -BET - MONAD_FEE,
      net: 'net -0.0277 MON',
      tone: 'loss',
    });
    const refund = refundWei(TABLE, BET, 0, 0);
    expect(endFee(figures(refund, MONAD_FEE), 'ETH')).toMatchObject({
      netWei: refund - BET - MONAD_FEE,
      fee: 'fee -0.0177',
      net: 'net -0.0182 ETH',
    });
    // A reclaim hands the whole bet back: only the fee is lost.
    expect(endFee(figures(BET, MONAD_FEE), 'MON')).toMatchObject({ netWei: -MONAD_FEE, net: 'net -0.0177 MON' });
    expect(endFee(figures(BET, 0n), 'MON')).toMatchObject({ net: 'net +0 MON', tone: 'even' });
  });

  it('says nothing without the fee or the bet', () => {
    expect(endFee(figures(BET, null), 'MON')).toBeNull();
    expect(endFee(figures(BET, MONAD_FEE, null), 'MON')).toBeNull();
  });
});

describe('the fee on the lobby screen', () => {
  it('names the typical fee of the bet transaction next to the bet: 175,000 gas at the gas price, before any wallet', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    world.gasPriceWei = 102n * GWEI;
    render(<GameApp deps={world.deps()} />);
    await waitFor(() => expect(attr('bet-fee', 'data-wei')).toBe((175_000n * 102n * GWEI).toString()));
    expect(text('bet-fee')).toBe('FEE ~0.018');
    expect(text('bet-prompt')).toContain('A: BET 0.050 MON · FEE ~0.018');
    expect(screen.queryByTestId('wallet-address')).toBeNull();
    // The bet changes, the fee guide does not.
    fireEvent.click(screen.getByTestId('bet-preset-.01'));
    await waitFor(() => expect(text('bet-prompt')).toContain('A: BET 0.010 MON · FEE ~0.018'));
  });

  it('reads the gas price, not the wallet\'s fee bid, and names the coin of the chain: ETH on Anvil', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    // 175,000 gas at the fake chain's 1 gwei; its bid of 1.2 gwei is for the balance check only.
    await waitFor(() => expect(attr('bet-fee', 'data-wei')).toBe((175_000n * GWEI).toString()));
    expect(text('bet-prompt')).toContain('A: BET 0.050 ETH · FEE ~0.00018');
  });

  it('shows FEE — while the gas price is not known', async () => {
    const world = new FakeWorld();
    const deps: ClientDeps = {
      ...world.deps(),
      chain: () => ({ ...world.chain, gasPrice: () => Promise.reject(new Error('rpc down')) }),
    };
    render(<GameApp deps={deps} />);
    await screen.findByTestId('bet-prompt');
    await settle();
    expect(text('bet-fee')).toBe('FEE —');
    expect(attr('bet-fee', 'data-wei')).toBe('');
    expect(text('bet-prompt')).toContain('A: BET 0.050 ETH · FEE —');
  });
});

describe('the end screen', () => {
  it('an escape shows the payout, the fee the bet transaction paid and the net result', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    const gameId = await startGame(world);
    for (const dir of planExit(world.mazeOf(gameId))) {
      const id = `move-${DIR_NAMES[dir]}`;
      const before = Number(attr('board', 'data-step'));
      await waitFor(() => expect(attr(id, 'data-legal')).toBe('true'));
      fireEvent.click(screen.getByTestId(id));
      await waitFor(() => expect(Number(attr('board', 'data-step'))).toBe(before + 1));
    }
    const payout = exitPayoutWei(TABLE, BET, 0);
    await waitFor(() => expect(attr('end-effect', 'data-outcome')).toBe('exit'));
    expect(attr('end-amount', 'data-wei')).toBe(payout.toString());
    expect(text('end-amount')).toBe(`+${formatEth(payout, 4)} MON`);
    await waitFor(() => expect(attr('end-fee', 'data-wei')).toBe(MONAD_FEE.toString()));
    expect(text('end-fee')).toBe('fee -0.0177');
    expect(attr('end-net', 'data-wei')).toBe((payout - BET - MONAD_FEE).toString());
    expect(text('end-net')).toBe(endFee(figures(payout, MONAD_FEE), 'MON')?.net);
    // The line sits under the money, on the console's screen.
    expect(screen.getByTestId('end-fee').closest('[data-testid="end-effect"]')).not.toBeNull();
  });

  it('a cash-out counts the fee against what came back', async () => {
    const world = new FakeWorld();
    await startGame(world);
    await cashOut();
    const refund = refundWei(TABLE, BET, 0, 0);
    expect(attr('end-amount', 'data-wei')).toBe(refund.toString());
    await waitFor(() => expect(attr('end-net', 'data-wei')).toBe((refund - BET - MONAD_FEE).toString()));
    expect(text('end-net')).toBe('net -0.0182 ETH');
  });

  it('leaves the fee and net out when the receipt cannot be read, or there is none', async () => {
    for (const fee of [new Error('rpc down'), null]) {
      const world = new FakeWorld();
      world.txFeeWei = fee;
      await startGame(world);
      await cashOut();
      expect(screen.getByTestId('end-amount')).toBeTruthy();
      await settle();
      expect(screen.queryByTestId('end-fee')).toBeNull();
      expect(screen.queryByTestId('end-net')).toBeNull();
      expect(screen.getByTestId('end-effect').textContent).not.toMatch(/fee|net/i);
      cleanup();
      window.localStorage.clear();
    }
  });
});

describe('the game\'s details', () => {
  it('list the fee the bet transaction paid, once its receipt is read', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    await startGame(world);
    fireEvent.click(screen.getByTestId('tx-log-open'));
    await waitFor(() => expect(attr('details-bet-fee', 'data-wei')).toBe(MONAD_FEE.toString()));
    expect(text('details-bet-fee')).toBe(`${formatEth(MONAD_FEE)} MON`);
  });

  it('leave the fee out when the receipt cannot be read', async () => {
    const world = new FakeWorld();
    world.txFeeWei = new Error('rpc down');
    await startGame(world);
    fireEvent.click(screen.getByTestId('tx-log-open'));
    await screen.findByTestId('game-details');
    await settle();
    expect(screen.queryByTestId('details-bet-fee')).toBeNull();
    expect(attr('details-bet-tx', 'data-confirmed')).toBe('true');
  });
});
