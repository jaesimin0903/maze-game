import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exitPayoutWei, refundWei } from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { RefundSchedule } from '../../src/client/components/RefundSchedule';
import { FakeWorld, TABLE } from './helpers';

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

const attr = (testId: string, name: string): string | null =>
  screen.getByTestId(testId).getAttribute(name);

describe('RefundSchedule', () => {
  it('AC-W6: shows the refund after every step and the exit payout for the given tier and bet', () => {
    const bet = 5n * 10n ** 16n;
    render(<RefundSchedule table={TABLE} tier={1} betWei={bet} />);
    const { refundBps } = TABLE.tiers[1];
    expect(refundBps).toHaveLength(49);
    refundBps.forEach((bps, k) => {
      expect(attr(`schedule-row-${k}`, 'data-bps')).toBe(String(bps));
      expect(attr(`schedule-row-${k}`, 'data-wei')).toBe(refundWei(TABLE, bet, 1, k).toString());
    });
    expect(screen.queryByTestId('schedule-row-49')).toBeNull();
    expect(attr('schedule-exit-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, bet, 1).toString());
  });

  it('AC-W6: puts the drop at bet time and after the first move into words and figures', () => {
    render(<RefundSchedule table={TABLE} tier={0} betWei={10n ** 16n} />);
    expect(screen.getByTestId('schedule-row-0').textContent).toContain('베팅 직후');
    expect(screen.getByTestId('schedule-row-0').textContent).toContain('95.00%');
    expect(screen.getByTestId('schedule-row-0').textContent).toContain('0.0095 ETH');
    expect(screen.getByTestId('schedule-row-1').textContent).toContain('1걸음 뒤');
    expect(screen.getByTestId('schedule-row-1').textContent).toContain('73.00%');
    expect(screen.getByTestId('schedule-row-1').textContent).toContain('0.0073 ETH');
    expect(screen.getByTestId('refund-schedule').textContent).toContain('95.00%');
    expect(screen.getByTestId('refund-schedule').textContent).toContain('73.00%');
  });

  it('keeps the percentages when there is no usable bet', () => {
    render(<RefundSchedule table={TABLE} tier={0} betWei={null} />);
    expect(attr('schedule-row-0', 'data-bps')).toBe('9500');
    expect(attr('schedule-row-0', 'data-wei')).toBe('');
  });
});

describe('bet panel', () => {
  it('AC-W6 AC-R1: before any bet, the chosen size and amount drive the schedule and every exit payout', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('refund-schedule');

    // Default amount 0.01 ETH, default size S.
    const bet = 10n ** 16n;
    for (const tier of [0, 1, 2]) {
      expect(attr(`tier-payout-${tier}`, 'data-wei')).toBe(exitPayoutWei(TABLE, bet, tier).toString());
    }
    expect(attr('refund-schedule', 'data-tier')).toBe('0');
    expect(attr('schedule-row-1', 'data-wei')).toBe(refundWei(TABLE, bet, 0, 1).toString());
    expect(screen.queryByTestId('schedule-row-24')).not.toBeNull();
    expect(screen.queryByTestId('schedule-row-25')).toBeNull();

    fireEvent.click(screen.getByTestId('tier-2'));
    fireEvent.change(screen.getByTestId('bet-amount'), { target: { value: '0.05' } });
    const larger = 5n * 10n ** 16n;
    await waitFor(() => expect(attr('refund-schedule', 'data-bet-wei')).toBe(larger.toString()));
    expect(attr('refund-schedule', 'data-tier')).toBe('2');
    expect(attr('tier-2', 'data-selected')).toBe('true');
    expect(attr('tier-0', 'data-selected')).toBe('false');
    expect(attr('tier-payout-2', 'data-wei')).toBe(exitPayoutWei(TABLE, larger, 2).toString());
    expect(attr('schedule-row-0', 'data-wei')).toBe(refundWei(TABLE, larger, 2, 0).toString());
    expect(attr('schedule-row-99', 'data-wei')).toBe(refundWei(TABLE, larger, 2, 99).toString());
    // Nothing has been requested from the server beyond the config.
    expect(world.requests).toEqual(['GET /api/config']);
    expect(world.txs).toEqual([]);
  });

  it('does not let a bet through without a wallet, outside the limits, or with a malformed seed', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const submit = (await screen.findByTestId('bet-submit')) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('wallet-dev-option'));
    await waitFor(() => expect(submit.disabled).toBe(false));

    fireEvent.change(screen.getByTestId('bet-amount'), { target: { value: '0.0001' } });
    await waitFor(() => expect(submit.disabled).toBe(true));
    expect(screen.getByTestId('bet-status').textContent).toContain('최소');
    fireEvent.change(screen.getByTestId('bet-amount'), { target: { value: '1' } });
    await waitFor(() => expect(screen.getByTestId('bet-status').textContent).toContain('최대'));
    fireEvent.change(screen.getByTestId('bet-amount'), { target: { value: 'abc' } });
    await waitFor(() => expect(attr('refund-schedule', 'data-bet-wei')).toBe(''));

    fireEvent.change(screen.getByTestId('bet-amount'), { target: { value: '0.01' } });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: '0x1234' } });
    await waitFor(() => expect(submit.disabled).toBe(true));
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('pre-fills a random 32-byte client seed', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const seed = (await screen.findByTestId('client-seed-input')) as HTMLInputElement;
    expect(seed.value).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
