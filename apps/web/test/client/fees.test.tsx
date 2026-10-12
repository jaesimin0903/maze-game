// Network fees on the page: none are shown. The lobby has no fee guide and the end screen names what
// the game paid (end-amount) without a fee or net line. The balance check before a bet still counts
// the fee (bet-form.test.ts, network.test.tsx).

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exitPayoutWei, refundWei, type Hex } from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { DIR_NAMES } from '../../src/client/board-view';
import { formatEth } from '../../src/client/format';
import { CLIENT_SEED, FakeWorld, TABLE, planExit } from './helpers';

const BET = 10n ** 16n;
const MONAD = {
  name: 'Monad Testnet',
  symbol: 'MON',
  explorerUrl: 'https://testnet.monadexplorer.com',
  faucetUrl: 'https://faucet.monad.xyz',
};

const attr = (testId: string, name: string): string | null => screen.getByTestId(testId).getAttribute(name);
const text = (testId: string): string => screen.getByTestId(testId).textContent ?? '';
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

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
  fireEvent.click(await screen.findByTestId('bet-submit'));
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

describe('no fee figures', () => {
  it('the lobby shows no fee guide, wallet or not', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('escape-payout');
    await settle();
    expect(screen.queryByTestId('dock-fee')).toBeNull();
    expect(screen.getByTestId('console').textContent).not.toMatch(/fee/i);
    fireEvent.click(screen.getByTestId('wallet-dev-option'));
    await waitFor(() => expect(attr('console-balance', 'data-wei')).not.toBe(''));
    expect(screen.queryByTestId('dock-fee')).toBeNull();
    expect(screen.getByTestId('console').textContent).not.toMatch(/fee/i);
  });

  it('an escape shows the payout and no fee or net line', async () => {
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
    await settle();
    expect(screen.queryByTestId('end-fee')).toBeNull();
    expect(screen.queryByTestId('end-net')).toBeNull();
    expect(screen.getByTestId('end-effect').textContent).not.toMatch(/fee|net/i);
  });

  it('a cash-out shows what came back and no fee line', async () => {
    const world = new FakeWorld();
    await startGame(world);
    await cashOut();
    const refund = refundWei(TABLE, BET, 0, 0);
    expect(attr('end-amount', 'data-wei')).toBe(refund.toString());
    expect(text('end-amount')).toBe(`${formatEth(refund, 4)} ETH BACK`);
    await settle();
    expect(screen.queryByTestId('end-fee')).toBeNull();
    expect(screen.queryByTestId('end-net')).toBeNull();
  });
});
