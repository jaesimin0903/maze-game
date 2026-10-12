// The bet as the lobby sets it up: the device's side panel (difficulty keys, the bet slider and its
// tick labels, the client seed and MIX, the LCD with the escape payout), A, and the sheet A opens
// (the seed's code and start side, refund schedule, rules, wallet steps, "Sign and bet"). Nothing
// here reaches the server beyond the config.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { exitPayoutWei, markStartSide, refundWei, startSideOf, type Hex, type StartSide } from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { THEMES, dungeonOf } from '../../src/client/dungeon';
import { formatEth, formatEthFixed, formatPercent } from '../../src/client/format';
import { loadRecord } from '../../src/client/record';
import { CLIENT_SEED, FakeWorld, TABLE } from './helpers';

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

const BET = 10n ** 16n;
/** The bet the slider starts on: 0.05. */
const START_BET = 5n * 10n ** 16n;

const attr = (testId: string, name: string): string | null =>
  screen.getByTestId(testId).getAttribute(name);
const text = (testId: string): string => screen.getByTestId(testId).textContent ?? '';
/** Presses the slider's tick label `label` (".001", ".01", ".05", ".1"). */
const coin = (label: string): void => {
  fireEvent.click(screen.getByTestId(`bet-preset-${label}`));
};

describe('bet panel: the side panel', () => {
  it('AC-W6 AC-R1: starts at 0.05 ETH on the smallest maze, and the chosen difficulty and bet drive the escape payout', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');

    expect(attr('console', 'data-mode')).toBe('ready');
    expect(attr('bet-slider', 'data-wei')).toBe(START_BET.toString());
    expect(attr('bet-preset-.05', 'aria-pressed')).toBe('true');
    expect(attr('tier-0', 'data-selected')).toBe('true');
    expect(attr('tier-0', 'aria-pressed')).toBe('true');
    expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, START_BET, 0).toString());
    expect(text('escape-payout')).toBe(`${formatEthFixed(exitPayoutWei(TABLE, START_BET, 0), 3)} ETH at the exit`);
    // The stake fills the HP bar above the screen; it is not a meter before the game.
    expect(text('hp-stake')).toContain('0.0500 ETH');
    expect(screen.getByTestId('hp-stake').getAttribute('role')).toBeNull();
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByTestId('hp-stake').querySelector('.fill')?.getAttribute('style')).toContain('width: 100%');
    expect(text('screen-tag')).toBe('READY EASY');
    // Before a game the board is the empty grid of the chosen size.
    expect(attr('board', 'data-game-id')).toBe('');
    expect(attr('board', 'data-n')).toBe(String(TABLE.tiers[0].n));

    // Every key names its maze and multiplier, and choosing it moves the payout, the board and the LEDs.
    TABLE.tiers.forEach((tier, index) => {
      expect(attr(`tier-${index}`, 'data-n')).toBe(String(tier.n));
      expect(attr(`tier-${index}`, 'data-multiplier-bps')).toBe(String(tier.multiplierBps));
    });
    for (const index of [2, 1, 0, 2]) {
      fireEvent.click(screen.getByTestId(`tier-${index}`));
      await waitFor(() => expect(attr(`tier-${index}`, 'data-selected')).toBe('true'));
      for (const other of TABLE.tiers.keys()) {
        if (other !== index) {
          expect(attr(`tier-${other}`, 'data-selected')).toBe('false');
          expect(attr(`tier-${other}`, 'aria-pressed')).toBe('false');
        }
      }
      expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, START_BET, index).toString());
      expect(attr('board', 'data-n')).toBe(String(TABLE.tiers[index].n));
      expect(attr('difficulty-leds', 'data-tier')).toBe(String(index));
    }

    // The tick labels are .001, .01, .05 and .1 ETH, the table's limits and two marks between; each
    // sets the bet. There is no amount field.
    const chips = [...document.querySelectorAll('[data-testid^="bet-preset-"]')].map((el) => el.getAttribute('data-testid'));
    expect(chips).toEqual(['bet-preset-.001', 'bet-preset-.01', 'bet-preset-.05', 'bet-preset-.1']);
    expect(screen.queryByTestId('bet-amount')).toBeNull();
    expect(screen.getByTestId('bet-slider').getAttribute('type')).toBe('range');
    for (const [label, wei] of [
      ['.01', BET],
      ['.1', 10n ** 17n],
      ['.001', 10n ** 15n],
      ['.05', START_BET],
    ] as const) {
      coin(label);
      await waitFor(() => expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, wei, 2).toString()));
      for (const chip of chips) {
        expect(attr(chip as string, 'aria-pressed')).toBe(String(chip === `bet-preset-${label}`));
      }
      expect(attr('bet-slider', 'data-wei')).toBe(wei.toString());
      expect(text('lcd')).toContain(`${formatEthFixed(wei, 3)} ETH`);
      // On a tick the bubble shows it with a diamond.
      expect(text('bet-bubble')).toBe(`${formatEthFixed(wei, 3)} ◆`);
    }

    // Nothing has been requested from the server beyond the config.
    expect(world.requests).toEqual(['GET /api/config']);
    expect(world.txs).toEqual([]);
  });

  it('a value set into the slider by a script (an input event) is the bet, and never snaps', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const slider = (await screen.findByTestId('bet-slider')) as HTMLInputElement;
    // 0.02 sits a quarter of the way from .01 to .05: at 417 of 1000.
    fireEvent.change(slider, { target: { value: '417' } });
    await waitFor(() => expect(slider.getAttribute('data-wei')).toBe((2n * BET).toString()));
    expect(slider.getAttribute('aria-valuetext')).toBe('0.020 ETH');
    expect(text('bet-bubble')).toBe('0.020');
    expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, 2n * BET, 0).toString());
    for (const chip of ['.001', '.01', '.05', '.1']) expect(attr(`bet-preset-${chip}`, 'aria-pressed')).toBe('false');
    // The fill and the ticks below the bet are lit.
    const track = slider.parentElement as HTMLElement;
    expect(track.querySelector('.fill')?.getAttribute('style')).toBe('width: 41.66666666666667%;');
    expect([...track.querySelectorAll('.tk')].map((el) => el.classList.contains('on'))).toEqual([true, true, false, false]);
    // Next to a tick, without a pointer, the amount is what it says: 0.011 is not pulled onto .01.
    fireEvent.input(slider, { target: { value: '342' } });
    await waitFor(() => expect(slider.getAttribute('data-wei')).toBe((11n * 10n ** 15n).toString()));
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('every 0.001 written into the slider at its place, as the e2e helper does, is that bet, written once or twice', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const slider = (await screen.findByTestId('bet-slider')) as HTMLInputElement;
    /** slider_position of e2e/aside/lib.sh, written out again: ticks .001, .01, .05, .1, evenly spaced. */
    const place = (milli: number): number => {
      const t = [1, 10, 50, 100];
      if (milli <= t[0]) return 0;
      if (milli >= t[3]) return 1000;
      let i = 0;
      while (!(milli >= t[i] && milli <= t[i + 1])) i++;
      return Math.floor(((i + (milli - t[i]) / (t[i + 1] - t[i])) / 3) * 1000 + 0.5);
    };
    /** What the e2e helper's M.setValue does: the value, then an input and a change event. */
    const write = (value: number): void => {
      act(() => {
        slider.value = String(value);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    const bet = (milli: number): string => (BigInt(milli) * 10n ** 15n).toString();
    // Up the whole track, each place written twice: the second write is the same place again.
    for (let milli = 1; milli <= 100; milli++) {
      write(place(milli));
      await waitFor(() => expect(slider.getAttribute('data-wei'), `${milli} milli`).toBe(bet(milli)));
      write(place(milli));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(slider.getAttribute('data-wei'), `${milli} milli, again`).toBe(bet(milli));
      expect(slider.value, `${milli} milli`).toBe(String(place(milli)));
    }
    // And in no particular order, down as well as up.
    for (let k = 1; k <= 100; k++) {
      const milli = ((k * 37) % 100) + 1;
      write(place(milli));
      await waitFor(() => expect(slider.getAttribute('data-wei'), `${milli} milli`).toBe(bet(milli)));
    }
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('a pointer that lets go within 2% of a tick puts the bet on it, and gives the keys back to the game', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const slider = (await screen.findByTestId('bet-slider')) as HTMLInputElement;
    slider.focus();
    fireEvent.pointerDown(slider);
    // 0.65 is within 2% of .05 at two thirds: it snaps, and the input goes back onto the tick.
    fireEvent.input(slider, { target: { value: '650' } });
    await waitFor(() => expect(slider.getAttribute('data-wei')).toBe(START_BET.toString()));
    expect(slider.value).toBe('667');
    expect(text('bet-bubble')).toBe('0.050 ◆');
    // A move that leaves the bet where it was still puts the input back on the bet's place.
    fireEvent.input(slider, { target: { value: '660' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slider.getAttribute('data-wei')).toBe(START_BET.toString());
    expect(slider.value).toBe('667');
    // 0.64 is more than 2% away: the amount on the line.
    fireEvent.input(slider, { target: { value: '640' } });
    await waitFor(() => expect(slider.getAttribute('data-wei')).toBe((47n * 10n ** 15n).toString()));
    expect(text('bet-bubble')).toBe('0.047');
    // Letting go gives the focus back, so Space, Z and the arrows are the game's keys again.
    expect(document.activeElement).toBe(slider);
    fireEvent.pointerUp(slider);
    expect(document.activeElement).not.toBe(slider);
    fireEvent.keyDown(window, { code: 'ArrowDown' });
    await waitFor(() => expect(attr('tier-1', 'aria-pressed')).toBe('true'));
  });

  it('the change a browser sends after a drag is let go does not move a snapped bet', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const slider = (await screen.findByTestId('bet-slider')) as HTMLInputElement;
    const wei = (): string | null => slider.getAttribute('data-wei');
    for (const [drag, place, tick, later] of [
      ['650', '667', START_BET, false],
      ['340', '333', BET, false],
      ['650', '667', START_BET, true],
      ['340', '333', BET, true],
    ] as const) {
      // From 0.02, a drag that lets go near the tick snaps onto it.
      fireEvent.input(slider, { target: { value: '417' } });
      await waitFor(() => expect(wei()).toBe((2n * BET).toString()));
      fireEvent.pointerDown(slider);
      fireEvent.input(slider, { target: { value: drag } });
      await waitFor(() => expect(wei()).toBe(tick.toString()));
      expect(slider.value).toBe(place);
      fireEvent.pointerUp(slider);
      // The release's change, at once or after the pointer is forgotten: the bet stays on the tick.
      if (later) await new Promise((resolve) => setTimeout(resolve, 10));
      fireEvent.change(slider, { target: { value: place } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(wei(), `${drag} ${later}`).toBe(tick.toString());
      expect(text('bet-bubble')).toBe(`${formatEthFixed(tick, 3)} ◆`);
    }
    // And the e2e helper's 0.02 lands exactly, set once or twice.
    for (let k = 0; k < 2; k++) {
      fireEvent.input(slider, { target: { value: '417' } });
      fireEvent.change(slider, { target: { value: '417' } });
      await waitFor(() => expect(wei()).toBe('20000000000000000'));
    }
  });

  it('a one-unit step from assistive technology moves the bet by 0.001 at least, and never back onto a tick', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const slider = (await screen.findByTestId('bet-slider')) as HTMLInputElement;
    // One unit of the input from .05 is less than 0.001 of bet: it still moves the bet a step.
    fireEvent.input(slider, { target: { value: '668' } });
    await waitFor(() => expect(slider.getAttribute('data-wei')).toBe((51n * 10n ** 15n).toString()));
    fireEvent.input(slider, { target: { value: String(Number(slider.value) - 1) } });
    await waitFor(() => expect(slider.getAttribute('data-wei')).toBe(START_BET.toString()));
    fireEvent.input(slider, { target: { value: String(Number(slider.value) - 1) } });
    await waitFor(() => expect(slider.getAttribute('data-wei')).toBe((49n * 10n ** 15n).toString()));
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('the slider\'s keys: arrows step 0.001, PageUp and PageDown jump between ticks, Home and End go to the limits', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const slider = (await screen.findByTestId('bet-slider')) as HTMLInputElement;
    const wei = (): string | null => slider.getAttribute('data-wei');
    const press = (key: string): void => {
      fireEvent.keyDown(slider, { key });
    };
    press('ArrowLeft');
    await waitFor(() => expect(wei()).toBe((49n * 10n ** 15n).toString()));
    press('ArrowDown');
    await waitFor(() => expect(wei()).toBe((48n * 10n ** 15n).toString()));
    press('ArrowRight');
    press('ArrowUp');
    press('ArrowUp');
    await waitFor(() => expect(wei()).toBe((51n * 10n ** 15n).toString()));
    press('PageDown');
    await waitFor(() => expect(wei()).toBe(START_BET.toString()));
    press('PageDown');
    await waitFor(() => expect(wei()).toBe(BET.toString()));
    press('PageUp');
    press('PageUp');
    await waitFor(() => expect(wei()).toBe((10n ** 17n).toString()));
    press('ArrowRight');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(wei()).toBe((10n ** 17n).toString());
    press('Home');
    await waitFor(() => expect(wei()).toBe((10n ** 15n).toString()));
    press('ArrowLeft');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(wei()).toBe((10n ** 15n).toString());
    press('End');
    await waitFor(() => expect(wei()).toBe((10n ** 17n).toString()));
    // The slider's keys stay its own: the difficulty does not move, and no sheet opens.
    expect(attr('tier-0', 'aria-pressed')).toBe('true');
    // Enter on the slider is A: the sheet opens.
    fireEvent.keyDown(slider, { key: 'Enter', code: 'Enter' });
    await screen.findByTestId('sign-sheet');
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('keeps the bet within the table\'s limits, which are the ends of the track', async () => {
    const narrow = new FakeWorld({ minBetWei: (2n * BET).toString(), maxBetWei: (10n ** 18n).toString() });
    render(<GameApp deps={narrow.deps()} />);
    await screen.findByTestId('btn-a');
    let chips = [...document.querySelectorAll('[data-testid^="bet-preset-"]')].map((el) => el.getAttribute('data-testid'));
    expect(chips).toEqual(['bet-preset-.02', 'bet-preset-.05', 'bet-preset-1']);
    expect(attr('bet-slider', 'data-wei')).toBe(START_BET.toString());
    fireEvent.keyDown(screen.getByTestId('bet-slider'), { key: 'Home' });
    await waitFor(() => expect(attr('bet-slider', 'data-wei')).toBe((2n * BET).toString()));
    fireEvent.change(screen.getByTestId('bet-slider'), { target: { value: '1000' } });
    await waitFor(() => expect(attr('bet-slider', 'data-wei')).toBe((10n ** 18n).toString()));
    cleanup();
    window.localStorage.clear();

    // 0.05 lies outside these limits: the bet starts at the nearest one.
    const limits = new FakeWorld({ minBetWei: (6n * BET).toString(), maxBetWei: (9n * BET).toString() });
    render(<GameApp deps={limits.deps()} />);
    await screen.findByTestId('btn-a');
    chips = [...document.querySelectorAll('[data-testid^="bet-preset-"]')].map((el) => el.getAttribute('data-testid'));
    expect(chips).toEqual(['bet-preset-.06', 'bet-preset-.09']);
    expect(attr('bet-preset-.06', 'aria-pressed')).toBe('true');
    expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, 6n * BET, 0).toString());
    coin('.09');
    await waitFor(() => expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, 9n * BET, 0).toString()));
  });
});

describe('bet panel: the sheet', () => {
  const openSheet = async (): Promise<HTMLButtonElement> => {
    fireEvent.click(screen.getByTestId('btn-a'));
    return (await screen.findByTestId('bet-submit')) as HTMLButtonElement;
  };
  const closeSheet = async (): Promise<void> => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
  };
  const inert = (testId: string): boolean => screen.getByTestId(testId).closest('[inert]') !== null;

  it('A opens the sheet with a random 32-byte client seed, the bet and the rules; Cancel closes it', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const start = (await screen.findByTestId('btn-a')) as HTMLButtonElement;
    expect(screen.queryByTestId('sign-sheet')).toBeNull();
    start.focus();
    await openSheet();

    const sheet = screen.getByTestId('sign-sheet');
    // The seed is set on the side panel; the sheet names it and the start side it picks.
    const seed = (screen.getByTestId('client-seed-input') as HTMLInputElement).value as Hex;
    expect(seed).toMatch(/^0x[0-9a-f]{64}$/);
    expect(text('sheet-seed-code')).toBe(`SEED ${seed.slice(2, 6).toUpperCase()}`);
    expect(attr('sheet-start-side', 'data-side')).toBe(startSideOf(seed));
    expect(within(sheet).queryByTestId('client-seed-input')).toBeNull();
    expect(within(sheet).queryByRole('button', { name: /seed/i })).toBeNull();
    expect(sheet.textContent).toContain(`${formatEth(exitPayoutWei(TABLE, START_BET, 0), 4)} ETH`);
    expect(text('bet-submit')).toBe('Sign and bet 0.05 ETH');
    expect(text('bet-rules')).toContain(`If you do not move for ${TABLE.timing.idleTimeoutSec}s`);
    expect(text('bet-rules')).toContain(`${TABLE.timing.maxGameSec}s after the start`);
    // AC-W6: the drop at bet time and after the first move, in words, for the chosen size.
    const [atBet, afterOne] = TABLE.tiers[0].refundBps;
    expect(text('bet-rules')).toContain(`Right after the bet you get back ${formatPercent(atBet)}`);
    expect(text('bet-rules')).toContain(`after the first step ${formatPercent(afterOne)}`);

    // The sheet takes the focus (its bet button is disabled without a wallet, so its first
    // control that can take it), and everything behind it but the header is inert.
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(inert('side-panel')).toBe(true);
    expect(inert('board')).toBe(true);
    expect(inert('btn-a')).toBe(true);
    expect(inert('wallet-connect')).toBe(false);
    expect(inert('sign-sheet')).toBe(false);

    // Closed, the page is live again and the focus is back where it was.
    await closeSheet();
    expect(attr('console', 'data-mode')).toBe('ready');
    expect(inert('side-panel')).toBe(false);
    expect(inert('board')).toBe(false);
    expect(document.activeElement).toBe(start);
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('AC-W6 AC-R1: shows the refund after every step and the exit payout for the difficulty and bet chosen on the side panel', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');

    for (const [tier, value] of [
      [0, '0.01'],
      [1, '0.05'],
      [2, '0.1'],
    ] as const) {
      fireEvent.click(screen.getByTestId(`tier-${tier}`));
      coin(value.slice(1));
      const bet = parseEther(value);
      await waitFor(() => expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, bet, tier).toString()));
      await openSheet();

      const { refundBps, multiplierBps } = TABLE.tiers[tier];
      expect(attr('refund-schedule', 'data-tier')).toBe(String(tier));
      expect(attr('refund-schedule', 'data-bet-wei')).toBe(bet.toString());
      refundBps.forEach((bps, k) => {
        expect(attr(`schedule-row-${k}`, 'data-step')).toBe(String(k));
        expect(attr(`schedule-row-${k}`, 'data-bps')).toBe(String(bps));
        expect(attr(`schedule-row-${k}`, 'data-wei')).toBe(refundWei(TABLE, bet, tier, k).toString());
      });
      expect(screen.queryByTestId(`schedule-row-${refundBps.length}`)).toBeNull();
      expect(attr('schedule-exit-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, bet, tier).toString());
      expect(attr('schedule-exit-payout', 'data-multiplier-bps')).toBe(String(multiplierBps));
      await closeSheet();
    }

    // In words and figures: the drop at bet time and after the first move, and the exit.
    fireEvent.click(screen.getByTestId('tier-0'));
    coin('.01');
    await waitFor(() => expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, BET, 0).toString()));
    await openSheet();
    expect(text('schedule-row-0')).toContain('At bet');
    expect(text('schedule-row-0')).toContain('95.00%');
    expect(text('schedule-row-0')).toContain('0.0095 ETH');
    expect(text('schedule-row-1')).toContain('Step 1');
    expect(text('schedule-row-1')).toContain('73.00%');
    expect(text('schedule-row-1')).toContain('0.0073 ETH');
    expect(text('schedule-exit-payout')).toContain(`Reaching the exit pays ${formatEth(exitPayoutWei(TABLE, BET, 0))} ETH`);
    await closeSheet();

    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('does not let a bet through without a wallet or with a malformed seed', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    let submit = await openSheet();
    expect(submit.disabled).toBe(true);
    expect(text('bet-status')).toBe('Connect a wallet first');
    expect(attr('bet-status', 'data-blocked')).toBe('true');
    expect(attr('bet-status', 'data-step')).toBe('');

    // The header stays reachable behind the sheet: the wallet connects from there.
    expect(inert('wallet-dev-option')).toBe(false);
    fireEvent.click(screen.getByTestId('wallet-dev-option'));
    await waitFor(() => expect(submit.disabled).toBe(false));
    expect(text('bet-status')).toBe('');
    expect(attr('bet-status', 'data-blocked')).toBe('false');
    await closeSheet();

    submit = await openSheet();
    expect(submit.disabled).toBe(false);
    // With the bet ready, the sheet puts the focus on its bet button.
    expect(document.activeElement).toBe(submit);
    expect(text('bet-submit')).toBe('Sign and bet 0.05 ETH');
    await closeSheet();

    // A malformed seed in the side panel's hidden field blocks the bet, and the sheet says why.
    fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: '0x1234' } });
    // It names no dungeon: the screen shows no seed tag and no start side.
    await waitFor(() => expect(screen.queryByTestId('seed-tag')).toBeNull());
    expect(attr('board', 'data-start-side')).toBe('');
    submit = await openSheet();
    expect(submit.disabled).toBe(true);
    expect(text('bet-status')).toBe('The client seed must be 0x followed by 64 hex digits');
    expect(text('sheet-seed-code')).toBe('—');
    // Pressing it anyway sends nothing.
    fireEvent.click(submit);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await closeSheet();

    fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: `0x${'AB'.repeat(32)}` } });
    submit = await openSheet();
    expect(submit.disabled).toBe(false);
    expect(text('sheet-seed-code')).toBe('SEED ABAB');

    expect(world.requests).toEqual(['GET /api/config']);
    expect(world.signed).toEqual([]);
    expect(world.txs).toEqual([]);
  });
});

describe('bet panel: the client seed', () => {
  const seedOf = (): Hex => (screen.getByTestId('client-seed-input') as HTMLInputElement).value as Hex;
  const setSeed = (seed: Hex): void => {
    fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: seed } });
  };
  /** The ring of tiles around the start cell, as the lobby screen draws it (columns 0..2, rows 0..2). */
  const startRing = (n: number): Record<'E' | 'S' | 'N' | 'W', string> => {
    const tiles = [...(document.querySelector('[data-testid="board"] [role="list"]')?.children ?? [])];
    const kind = (tx: number, ty: number): string =>
      (tiles[ty * (2 * n + 1) + tx]?.className.match(/\bt-([a-z]+)\b/) ?? [])[1] ?? '';
    return { E: kind(2, 1), S: kind(1, 2), N: kind(1, 0), W: kind(0, 1) };
  };
  const heroFacing = (): string | undefined =>
    document.querySelector('[data-testid="board"] .hero .f0')?.className.match(/\bs-([URDL])0\b/)?.[1];

  it('the lobby starts from a random seed that picks a start side, and the screen, the reroll button and the sheet show it', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    const seed = seedOf();
    // 28 random bytes, then the mark "MZ>E" or "MZ>S".
    expect(seed).toMatch(/^0x[0-9a-f]{56}4d5a3e(45|53)$/);
    const side = startSideOf(seed) as StartSide;
    const look = dungeonOf(seed);
    expect(attr('board', 'data-start-side')).toBe(side);
    expect(attr('reroll', 'data-start-side')).toBe(side);
    expect(attr('board', 'data-theme')).toBe(look.theme);
    expect(THEMES).toContain(look.theme);
    expect(text('seed-tag')).toBe(`SEED ${seed.slice(2, 6).toUpperCase()}`);
    // The start cell is walled in but for the picked side, and the hero faces that way.
    const ring = startRing(5);
    expect(ring[side]).toBe('floor');
    expect(ring[side === 'E' ? 'S' : 'E']).toBe('wall');
    expect([ring.N, ring.W]).toEqual(['wall', 'wall']);
    expect(heroFacing()).toBe(side === 'E' ? 'R' : 'D');

    fireEvent.click(screen.getByTestId('btn-a'));
    await screen.findByTestId('sign-sheet');
    expect(text('sheet-seed-code')).toBe(`SEED ${look.code}`);
    expect(attr('sheet-start-side', 'data-side')).toBe(side);
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('reroll draws a new marked seed in the lobby, and does nothing behind the bet sheet or the verify dialog', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    const sides = new Set<string>();
    let seed = seedOf();
    for (let k = 0; k < 12; k++) {
      fireEvent.click(screen.getByTestId('reroll'));
      await waitFor(() => expect(seedOf()).not.toBe(seed));
      seed = seedOf();
      expect(seed).toMatch(/^0x[0-9a-f]{56}4d5a3e(45|53)$/);
      expect(text('seed-tag')).toBe(`SEED ${seed.slice(2, 6).toUpperCase()}`);
      expect(attr('board', 'data-start-side')).toBe(startSideOf(seed));
      expect(attr('reroll', 'data-start-side')).toBe(startSideOf(seed));
      expect(attr('board', 'data-theme')).toBe(dungeonOf(seed).theme);
      sides.add(startSideOf(seed) as string);
    }
    // Both sides come up (each reroll picks one at random: 2^-11 to miss one in 12).
    expect(sides).toEqual(new Set(['E', 'S']));

    fireEvent.click(screen.getByTestId('btn-a'));
    await screen.findByTestId('sign-sheet');
    fireEvent.click(screen.getByTestId('reroll'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seedOf()).toBe(seed);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());

    fireEvent.click(screen.getByTestId('fairness-link'));
    await screen.findByTestId('verify-modal');
    fireEvent.click(screen.getByTestId('reroll'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seedOf()).toBe(seed);
    fireEvent.click(screen.getByTestId('verify-close'));
    await waitFor(() => expect(screen.queryByTestId('verify-modal')).toBeNull());
    // The dialog reads the config for itself; nothing else reached the server.
    expect(new Set(world.requests)).toEqual(new Set(['GET /api/config']));
  });

  it('a seed set into the hidden field is the one the bet uses, and a marked seed opens the maze to its side', async () => {
    for (const side of ['S', 'E'] as const) {
      const world = new FakeWorld();
      render(<GameApp deps={world.deps()} />);
      fireEvent.click(await screen.findByTestId('wallet-dev-option'));
      await screen.findByTestId('wallet-address');
      const seed = markStartSide(CLIENT_SEED, side);
      setSeed(seed);
      await waitFor(() => expect(attr('board', 'data-start-side')).toBe(side));
      expect(attr('reroll', 'data-start-side')).toBe(side);
      expect(startRing(5)[side]).toBe('floor');
      fireEvent.click(screen.getByTestId('btn-a'));
      await screen.findByTestId('sign-sheet');
      expect(attr('sheet-start-side', 'data-side')).toBe(side);
      fireEvent.click(screen.getByTestId('bet-submit'));

      await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
      const gameId = attr('board', 'data-game-id') as Hex;
      // The start cell opens to the picked side and nowhere else.
      expect(attr('cell-0-0', 'data-open')).toBe(side === 'S' ? '4' : '2');
      expect(world.mazeOf(gameId).open[0]).toBe(side === 'S' ? 4 : 2);
      expect(loadRecord(gameId)?.clientSeed).toBe(seed);
      expect(world.onchain.get(gameId)?.clientSeed).toBe(seed);
      expect(heroFacing()).toBe(side === 'E' ? 'R' : 'D');
      // Once the game runs, the seed is the game's: MIX is locked with the whole side panel, and
      // there is no seed tag and no seed field.
      expect((screen.getByTestId('reroll') as HTMLButtonElement).disabled).toBe(true);
      expect(attr('side-panel', 'data-locked')).toBe('true');
      expect(screen.queryByTestId('client-seed-input')).toBeNull();
      expect(screen.queryByTestId('seed-tag')).toBeNull();
      expect(attr('board', 'data-start-side')).toBe(side);
      cleanup();
      window.localStorage.clear();
    }
  });

  it('an unmarked seed picks no side, and the bet reads the field as the page holds it when it is sent', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
    setSeed(CLIENT_SEED);
    await waitFor(() => expect(attr('board', 'data-start-side')).toBe(''));
    expect(attr('reroll', 'data-start-side')).toBe('');
    expect(text('seed-tag')).toBe(`SEED ${CLIENT_SEED.slice(2, 6).toUpperCase()}`);
    // No ring around the start: nothing is known about its walls.
    expect(Object.values(startRing(5))).toEqual(['void', 'void', 'void', 'void']);
    fireEvent.click(screen.getByTestId('btn-a'));
    await screen.findByTestId('sign-sheet');
    expect(screen.queryByTestId('sheet-start-side')).toBeNull();

    // A script that writes the field without an event (the side panel is inert now) is still honoured.
    const scripted: Hex = `0x${'5c'.repeat(32)}`;
    (screen.getByTestId('client-seed-input') as HTMLInputElement).value = scripted;
    fireEvent.click(screen.getByTestId('bet-submit'));
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    const gameId = attr('board', 'data-game-id') as Hex;
    expect(loadRecord(gameId)?.clientSeed).toBe(scripted);
    expect(world.onchain.get(gameId)?.clientSeed).toBe(scripted);
  });

  it('the sheet takes a seed of the player, keeping the picked start side; a malformed one is refused and changes nothing', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
    for (const side of ['S', 'E'] as const) {
      const start = markStartSide(`0x${'21'.repeat(32)}`, side);
      setSeed(start);
      await waitFor(() => expect(attr('board', 'data-start-side')).toBe(side));
      fireEvent.click(screen.getByTestId('btn-a'));
      await screen.findByTestId('sign-sheet');
      expect(screen.getByTestId('sheet-own-seed').tagName).toBe('DETAILS');
      expect(text('sheet-full-seed')).toBe(start);

      // Not 32 bytes of hex: refused, with the reason, and the seed stays.
      for (const bad of ['0x12', 'abc', `0x${'zz'.repeat(32)}`, `${'ab'.repeat(32)}`]) {
        fireEvent.change(screen.getByTestId('own-seed-input'), { target: { value: bad } });
        fireEvent.click(screen.getByTestId('own-seed-apply'));
        await waitFor(() => expect(text('own-seed-note')).toBe('Enter 0x followed by 64 hex digits'));
        expect(attr('own-seed-note', 'role'), bad).toBe('alert');
        expect(text('sheet-full-seed'), bad).toBe(start);
        expect(seedOf(), bad).toBe(start);
      }

      // A good one: its last four bytes become the mark of the side already picked.
      const own: Hex = `0x${'ab'.repeat(30)}cdef`;
      fireEvent.change(screen.getByTestId('own-seed-input'), { target: { value: `  ${own}  ` } });
      fireEvent.click(screen.getByTestId('own-seed-apply'));
      const expected = markStartSide(own, side);
      await waitFor(() => expect(text('sheet-full-seed')).toBe(expected));
      expect(expected.slice(0, 58)).toBe(own.slice(0, 58));
      expect(seedOf()).toBe(expected);
      expect(text('sheet-seed-code')).toBe('SEED ABAB');
      expect(attr('sheet-start-side', 'data-side')).toBe(side);
      expect(attr('board', 'data-start-side')).toBe(side);
      expect(attr('own-seed-note', 'role')).toBeNull();
      expect(text('own-seed-note')).not.toContain('Enter 0x');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
    }

    // The own seed is the one the bet uses.
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(await screen.findByTestId('bet-submit'));
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    const gameId = attr('board', 'data-game-id') as Hex;
    expect(loadRecord(gameId)?.clientSeed).toBe(markStartSide(`0x${'ab'.repeat(30)}cdef`, 'E'));
    expect(attr('cell-0-0', 'data-open')).toBe('2');
  });

  it('an own seed over a seed that picks no side is marked east', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    setSeed(CLIENT_SEED);
    await waitFor(() => expect(attr('board', 'data-start-side')).toBe(''));
    fireEvent.click(screen.getByTestId('btn-a'));
    await screen.findByTestId('sign-sheet');
    const own: Hex = `0x${'0f'.repeat(32)}`;
    fireEvent.change(screen.getByTestId('own-seed-input'), { target: { value: own } });
    fireEvent.click(screen.getByTestId('own-seed-apply'));
    await waitFor(() => expect(text('sheet-full-seed')).toBe(markStartSide(own, 'E')));
    expect(attr('sheet-start-side', 'data-side')).toBe('E');
  });

  it('A picks up a seed a script wrote into the field without an event: the sheet and the screen show it', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    const before = seedOf();
    const scripted = markStartSide(`0x${'7a'.repeat(32)}`, startSideOf(before) === 'E' ? 'S' : 'E');
    (screen.getByTestId('client-seed-input') as HTMLInputElement).value = scripted;
    // Nothing on the page knows of it yet.
    expect(text('seed-tag')).toBe(`SEED ${before.slice(2, 6).toUpperCase()}`);

    fireEvent.click(screen.getByTestId('btn-a'));
    await screen.findByTestId('sign-sheet');
    expect(text('sheet-full-seed')).toBe(scripted);
    expect(text('sheet-seed-code')).toBe('SEED 7A7A');
    expect(attr('sheet-start-side', 'data-side')).toBe(startSideOf(scripted));
    expect(attr('board', 'data-start-side')).toBe(startSideOf(scripted));

    // A malformed value written that way is not taken over.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
    (screen.getByTestId('client-seed-input') as HTMLInputElement).value = '0xnot-a-seed';
    fireEvent.click(screen.getByTestId('btn-a'));
    await screen.findByTestId('sign-sheet');
    expect(text('sheet-full-seed')).toBe(scripted);
  });
});
