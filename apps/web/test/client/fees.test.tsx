// What a bet costs in network fees: the guide in the dock (typical gas × gas price), and on the end
// screen the fee the bet transaction really paid (its receipt) with the game's result net of it.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exitPayoutWei, refundWei, type Hex } from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { DIR_NAMES } from '../../src/client/board-view';
import { endFee, type EndFigures } from '../../src/client/components/Console';
import { formatApprox } from '../../src/client/format';
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
const figures = (payoutWei: bigint, feeWei: bigint | null, betWei: bigint | null = BET): EndFigures => ({
  payoutWei,
  betWei,
  feeWei,
  points: 0n,
});

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

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

describe('the fee guide in the dock', () => {
  it('shows the typical fee of the bet transaction at the gas price, before any wallet is connected', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    render(<GameApp deps={world.deps()} />);
    const fee = await screen.findByTestId('dock-fee');
    // 175,000 gas at the fake chain's 1 gwei.
    expect(fee.getAttribute('data-wei')).toBe((175_000n * GWEI).toString());
    expect(fee.textContent).toBe('Network fee ~0.00018 MON');
    expect(screen.queryByTestId('wallet-address')).toBeNull();
  });

  it('names the coin of the chain: ETH on Anvil', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    expect((await screen.findByTestId('dock-fee')).textContent).toBe('Network fee ~0.00018 ETH');
  });
});

describe('the end screen', () => {
  /** Connects the dev wallet and bets 0.01 on the smallest maze. */
  async function startGame(world: FakeWorld): Promise<Hex> {
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
    fireEvent.click(screen.getByTestId('tier-0'));
    fireEvent.change(screen.getByTestId('bet-amount'), { target: { value: '0.01' } });
    fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: CLIENT_SEED } });
    fireEvent.click(screen.getByTestId('bet-start'));
    fireEvent.click(await screen.findByTestId('bet-submit'));
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    return attr('board', 'data-game-id') as Hex;
  }

  async function cashOut(): Promise<void> {
    await waitFor(() => expect((screen.getByTestId('cashout-open') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('cashout-open'));
    fireEvent.click(await screen.findByTestId('cashout-button'));
    await screen.findByTestId('end-effect');
  }

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
    await waitFor(() => expect(attr('end-fee', 'data-wei')).toBe(MONAD_FEE.toString()));
    expect(text('end-fee')).toBe('fee -0.0177');
    expect(attr('end-net', 'data-wei')).toBe((payout - BET - MONAD_FEE).toString());
    expect(text('end-net')).toBe(endFee(figures(payout, MONAD_FEE), 'MON')?.net);
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

  it('leaves the fee and net out when the receipt cannot be read', async () => {
    const world = new FakeWorld();
    world.txFeeWei = null;
    await startGame(world);
    await cashOut();
    expect(screen.getByTestId('end-amount')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByTestId('end-fee')).toBeNull();
    expect(screen.queryByTestId('end-net')).toBeNull();
  });
});
