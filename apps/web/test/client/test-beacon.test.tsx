import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exitPayoutWei } from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { collectSnapshot } from '../../src/client/components/TestBeacon';
import { FakeWorld, TABLE } from './helpers';

/** The coin the pad starts on: 0.05. */
const BET = 5n * 10n ** 16n;

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe('TestBeacon', () => {
  it('AC-A5: is not rendered and sends nothing when testHooks is off', async () => {
    const world = new FakeWorld({ testHooks: false });
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(screen.queryByTestId('test-beacon')).toBeNull();
    expect(world.requests.filter((r) => r.includes('/api/test/'))).toEqual([]);
    expect(world.snapshots).toEqual([]);
  });

  it('AC-A5: when testHooks is on, posts the real DOM text and attributes of the data-testid elements', async () => {
    const world = new FakeWorld({ testHooks: true });
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('test-beacon');
    await waitFor(() => expect(world.snapshots.length).toBeGreaterThan(0));

    const first = world.snapshots[world.snapshots.length - 1];
    expect(first.url).toBe(window.location.href);
    expect(first.chainNowSec).toBe(world.chainNow);
    expect(first.items['bet-preset-.05'].attrs['aria-pressed']).toBe('true');
    expect(first.items['bet-preset-.01'].attrs['aria-pressed']).toBe('false');
    expect(first.items['tier-0'].attrs['data-selected']).toBe('true');
    expect(first.items['escape-payout'].attrs['data-wei']).toBe(exitPayoutWei(TABLE, BET, 0).toString());
    expect(first.items['escape-payout'].text).toBe(
      screen.getByTestId('escape-payout').textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(first.items['btn-a'].attrs['data-action']).toBe('start');
    expect(first.items['console'].attrs['data-mode']).toBe('ready');
    expect(first.items['fixture-banner']).toBeDefined();

    // A change on the page reaches the server as a new snapshot.
    const before = world.snapshots.length;
    fireEvent.click(screen.getByTestId('tier-1'));
    await waitFor(() => {
      const latest = world.snapshots[world.snapshots.length - 1];
      expect(world.snapshots.length).toBeGreaterThan(before);
      expect(latest.items['tier-1'].attrs['data-selected']).toBe('true');
      expect(latest.items['escape-payout'].attrs['data-wei']).toBe(exitPayoutWei(TABLE, BET, 1).toString());
    });

    // The bet sheet: its button, disabled without a wallet, is reported with its attribute, and
    // its refund schedule for the chosen size with the rows' text as the DOM has it.
    fireEvent.click(screen.getByTestId('btn-a'));
    await waitFor(() => {
      const latest = world.snapshots[world.snapshots.length - 1];
      expect(latest.items['bet-submit'].attrs).toHaveProperty('disabled');
      expect(latest.items['bet-status'].text).toBe('Connect a wallet first');
      expect(latest.items['refund-schedule'].attrs['data-tier']).toBe('1');
      expect(latest.items['schedule-row-1'].attrs['data-bps']).toBe('7300');
      expect(latest.items['schedule-row-1'].text).toBe(
        screen.getByTestId('schedule-row-1').textContent?.replace(/\s+/g, ' ').trim(),
      );
    });
  });

  it('keeps sending while nothing changes, so the sequence number keeps rising', async () => {
    const world = new FakeWorld({ testHooks: true });
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('test-beacon');
    await waitFor(() => expect(world.snapshots.length).toBeGreaterThan(0));
    const before = world.snapshots.length;
    await waitFor(() => expect(world.snapshots.length).toBeGreaterThan(before), { timeout: 3000 });
  });
});

describe('collectSnapshot', () => {
  it('reads text, form values and attributes straight from the DOM', () => {
    document.body.innerHTML = `
      <div data-testid="result-outcome" data-outcome="exit" class="x" style="color: red">  You
        escaped </div>
      <input data-testid="bet-amount" value="0.02" />
      <button data-testid="cashout-button" disabled>Take it</button>
      <span>no test id</span>`;
    const items = collectSnapshot(document);
    expect(Object.keys(items).sort()).toEqual(['bet-amount', 'cashout-button', 'result-outcome']);
    expect(items['result-outcome']).toEqual({
      text: 'You escaped',
      attrs: { 'data-outcome': 'exit' },
    });
    expect(items['bet-amount'].text).toBe('0.02');
    expect(items['cashout-button'].attrs).toHaveProperty('disabled');
    document.body.innerHTML = '';
  });
});
