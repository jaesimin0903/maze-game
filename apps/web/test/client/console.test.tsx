// The device: the name engraved under A for each moment of a game, the HP meter above the screen
// (what a cash-out pays now, read from the table with the server's refund function), its colours,
// the side panel's LCD and the console's LEDs for each difficulty, the side panel locked during a
// game, the result row after it, and the wallet's balance under the screen.

import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exitPayoutWei, refundBps, refundWei, type GameView, type Hex, type TuningTable } from '@maze/shared';
import production from '@maze/shared/tuning.json';
import { GameApp } from '../../src/client/GameApp';
import { createApi } from '../../src/client/api';
import { DIR_NAMES } from '../../src/client/board-view';
import { HpMeter, HpRow, hpTone, panelMode, type PanelModel } from '../../src/client/components/Panel';
import { ESCAPE_RATES, escapeOdds } from '../../src/client/config';
import { formatEthFixed, formatMultiplier, formatMultiplierShort } from '../../src/client/format';
import { CLIENT_SEED, FakeWorld, TABLE, planExit } from './helpers';

configure({ asyncUtilTimeout: 3000 });

/** The coin the pad starts on, which these games bet: 0.05. */
const BET = 5n * 10n ** 16n;

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

const attr = (testId: string, name: string): string | null => screen.getByTestId(testId).getAttribute(name);
const text = (testId: string): string => screen.getByTestId(testId).textContent ?? '';
const step = (): number => Number(attr('board', 'data-step'));
/** The name engraved under A. */
const aLabel = (): string => screen.getByTestId('btn-a').parentElement?.querySelector('.ctl-label')?.textContent ?? '';

async function startGame(world: FakeWorld): Promise<Hex> {
  render(<GameApp deps={world.deps()} />);
  fireEvent.click(await screen.findByTestId('wallet-dev-option'));
  await screen.findByTestId('wallet-address');
  fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: CLIENT_SEED } });
  fireEvent.click(screen.getByTestId('btn-a'));
  fireEvent.click(await screen.findByTestId('bet-submit'));
  await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
  await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
  return attr('board', 'data-game-id') as Hex;
}

async function walkOne(dir: number): Promise<void> {
  const before = step();
  const id = `move-${DIR_NAMES[dir as 0 | 1 | 2 | 3]}`;
  await waitFor(() => expect(attr(id, 'data-legal')).toBe('true'));
  fireEvent.click(screen.getByTestId(id));
  await waitFor(() => expect(step()).toBe(before + 1));
}

describe('A', () => {
  it('is named for what it does: START in the lobby, CASH OUT in a game, NEW GAME (or VERIFY) after it', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    expect(attr('btn-a', 'data-action')).toBe('start');
    expect(attr('btn-a', 'aria-label')).toBe('A: start');
    expect(aLabel()).toBe('START');
    cleanup();

    await startGame(world);
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    expect(attr('btn-a', 'data-action')).toBe('cashout');
    expect(attr('btn-a', 'aria-label')).toBe('A: cash out');
    expect(aLabel()).toBe('CASH OUT');
    // Asking keeps the name. The question opens on "Keep going"; the D-pad moves to "Take it",
    // and A, once the press that asked has passed, takes it.
    fireEvent.click(screen.getByTestId('btn-a'));
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('confirm'));
    expect(aLabel()).toBe('CASH OUT');
    fireEvent.keyDown(window, { code: 'ArrowRight' });
    await new Promise((resolve) => setTimeout(resolve, 320));
    fireEvent.click(screen.getByTestId('btn-a'));

    await screen.findByTestId('result-outcome');
    await waitFor(() => expect(attr('settle-tx', 'data-confirmed')).toBe('true'));
    expect(attr('btn-a', 'data-action')).toBe('new-game');
    expect(attr('btn-a', 'aria-label')).toBe('A: new game');
    expect(aLabel()).toBe('NEW GAME');
    fireEvent.keyDown(window, { code: 'ArrowRight' });
    await waitFor(() => expect(attr('btn-a', 'data-action')).toBe('verify'));
    expect(aLabel()).toBe('VERIFY');
    fireEvent.keyDown(window, { code: 'ArrowLeft' });
    await waitFor(() => expect(aLabel()).toBe('NEW GAME'));
    fireEvent.click(screen.getByTestId('btn-a'));
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('ready'));
    expect(aLabel()).toBe('START');
  });
});

describe('A after a game that is not settled yet', () => {
  it('is named SETTLING and does nothing until the chain shows the game settled', async () => {
    const world = new FakeWorld();
    world.autoSettle = false;
    const gameId = await startGame(world);
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(await screen.findByTestId('cashout-button'));
    await screen.findByTestId('result-outcome');
    expect(attr('btn-a', 'data-action')).toBe('settling');
    expect(attr('btn-a', 'aria-label')).toBe('A: waits while the game settles');
    expect(aLabel()).toBe('SETTLING');
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.keyDown(window, { code: 'Enter' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(attr('console', 'data-mode')).toBe('ended');
    expect(attr('board', 'data-game-id')).toBe(gameId);
    // Once the relayer settles it, A starts a new game again.
    world.autoSettle = true;
    await waitFor(() => expect(attr('btn-a', 'data-action')).toBe('new-game'));
    expect(aLabel()).toBe('NEW GAME');
  });
});

describe('the cash-out question', () => {
  it('opens on "Keep going": A, A asks and puts it away, and sends nothing', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    await walkOne(planExit(world.mazeOf(gameId))[0]);
    const before = world.requests.filter((r) => r !== 'GET /api/games/:id').length;
    const highlighted = (id: string): boolean => screen.getByTestId(id).classList.contains('on');

    // Two quick presses: the second is the first one bouncing, and is ignored.
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(screen.getByTestId('btn-a'));
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('confirm'));
    expect(highlighted('cashout-cancel')).toBe(true);
    expect(highlighted('cashout-button')).toBe(false);
    // A second press after a beat answers the highlighted choice: "Keep going".
    await new Promise((resolve) => setTimeout(resolve, 320));
    fireEvent.keyDown(window, { code: 'Enter' });
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    // The same with the keys: Space, Space.
    fireEvent.keyDown(window, { code: 'Space' });
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('confirm'));
    await new Promise((resolve) => setTimeout(resolve, 320));
    fireEvent.keyDown(window, { code: 'Space' });
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByTestId('result-outcome')).toBeNull();
    expect(world.games.get(gameId)?.status).toBe('active');
    expect(world.requests.filter((r) => r !== 'GET /api/games/:id').slice(before)).toEqual([]);

    // A tap on "Take it" takes it at once, whatever is highlighted.
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(await screen.findByTestId('cashout-button'));
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('cashout');
  });
});

describe('the HP meter', () => {
  it('shows bet × refundBps[step] at every step, as refundWei computes it, with the part each step lost', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    const moves = planExit(world.mazeOf(gameId));
    const steps = Math.min(4, moves.length - 1);

    for (let k = 0; k <= steps; k++) {
      if (k > 0) await walkOne(moves[k - 1]);
      await waitFor(() => expect(attr('refundable-amount', 'data-step')).toBe(String(k)));
      const bps = refundBps(TABLE, 0, k);
      const wei = refundWei(TABLE, BET, 0, k);
      const meter = screen.getByTestId('refundable-amount');
      expect(meter.getAttribute('role')).toBe('meter');
      expect(meter.getAttribute('aria-valuemin')).toBe('0');
      expect(meter.getAttribute('aria-valuemax')).toBe('100');
      expect(meter.getAttribute('aria-valuenow')).toBe(String(bps / 100));
      expect(meter.getAttribute('aria-valuetext')).toBe(`${formatEthFixed(wei, 4)} ETH, ${bps / 100}% of the bet`);
      // The server's figure and the table's agree.
      expect(meter.getAttribute('data-wei')).toBe(wei.toString());
      expect(attr('hp-bar', 'data-bps')).toBe(String(bps));
      expect(attr('hp-bar', 'data-wei')).toBe(wei.toString());
      expect(attr('hp-bar', 'data-tone')).toBe(hpTone(bps));
      expect(text('hp-text')).toBe(`${formatEthFixed(wei, 4)} ETH`);
      const fill = screen.getByTestId('hp-bar').querySelector('.fill') as HTMLElement;
      expect(fill.style.width).toBe(`${bps / 100}%`);
      expect(fill.classList.contains(hpTone(bps))).toBe(true);
      const ghost = screen.getByTestId('hp-bar').querySelector('.ghost') as HTMLElement | null;
      if (k === 0) {
        // Nothing lost yet.
        expect(ghost).toBeNull();
        expect(screen.queryByTestId('hp-damage')).toBeNull();
      } else {
        const lost = refundWei(TABLE, BET, 0, k - 1) - wei;
        expect(ghost?.style.left).toBe(`${bps / 100}%`);
        expect(ghost?.style.width).toBe(`${(refundBps(TABLE, 0, k - 1) - bps) / 100}%`);
        expect(attr('hp-damage', 'data-wei')).toBe(lost.toString());
        expect(text('hp-damage')).toBe(`−${formatEthFixed(lost, 4)}`);
        expect(attr('hp-damage', 'aria-hidden')).toBe('true');
      }
    }
  });

  it('is green from 60% of the bet, yellow from 40% and red below', () => {
    expect([10_000, 6_000, 5_999, 4_000, 3_999, 0].map(hpTone)).toEqual(['g', 'g', 'y', 'y', 'r', 'r']);

    const schedule = [9_500, 6_000, 5_999, 4_000, 3_999, 1];
    const table: TuningTable = { ...TABLE, tiers: [{ ...TABLE.tiers[0], refundBps: schedule }] };
    const tones = schedule.map((_, k) => {
      render(<HpMeter table={table} betWei={BET} tier={0} step={k} refundableWei="0" />);
      const bar = screen.getByTestId('hp-bar');
      const tone = bar.getAttribute('data-tone');
      expect(bar.querySelector('.fill')?.classList.contains(tone as string)).toBe(true);
      cleanup();
      return tone;
    });
    expect(tones).toEqual(['g', 'g', 'y', 'y', 'r', 'r']);
  });

  it('draws nothing for a step outside the table', () => {
    render(<HpMeter table={TABLE} betWei={BET} tier={0} step={TABLE.tiers[0].refundBps.length} refundableWei="0" />);
    expect(screen.queryByTestId('hp-bar')).toBeNull();
  });

  it('gives way to the result once the game is over: no bar is left behind', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    await walkOne(planExit(world.mazeOf(gameId))[0]);
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(await screen.findByTestId('cashout-button'));
    await screen.findByTestId('result-outcome');
    expect(screen.queryByTestId('hp-bar')).toBeNull();
    expect(screen.queryByTestId('refundable-amount')).toBeNull();
    const refund = refundWei(TABLE, BET, 0, 1);
    expect(text('result-payout')).toBe(`${formatEthFixed(refund, 4)} ETH`);
    // What it paid against the bet: not called a net result, which would count the fee.
    expect(text('result-net')).toBe(`-${formatEthFixed(BET - refund, 4)} vs BET`);
    expect(attr('result-net', 'data-wei')).toBe((refund - BET).toString());
    expect(screen.getByTestId('result-net').closest('.hp')?.textContent).not.toMatch(/net/i);
    expect((screen.getByTestId('result-payout').closest('.hp') as HTMLElement).textContent).toContain('END');
  });

  it('names the mode of the console, with the cash-out question as its own', () => {
    const view = { betWei: '1', tier: 0, step: 0 } as GameView;
    const play = { kind: 'play', view, table: TABLE, confirm: null } as unknown as PanelModel;
    expect(panelMode(play)).toBe('play');
    expect(panelMode({ ...play, confirm: { choice: 0, onTake: () => undefined, onKeep: () => undefined } } as PanelModel)).toBe(
      'confirm',
    );
    render(<HpRow model={{ kind: 'waiting', betWei: BET }} />);
    expect(screen.getByTestId('hp-stake').getAttribute('data-wei')).toBe(BET.toString());
  });
});

describe('the LCD and the LEDs', () => {
  /** The production table: 5×5 ×2.6088, 7×7 ×6.6112, 9×9 ×18.4695. */
  const tiers = (production as unknown as { tiers: TuningTable['tiers'] }).tiers;
  const lines = (): string[] =>
    [...screen.getByTestId('lcd').querySelectorAll('.lr')].map((el) =>
      [...el.children]
        .filter((c) => !c.classList.contains('sr-only'))
        .map((c) => c.textContent)
        .join(' | '),
    );

  it('rounds every short multiplier down, so none shows more than the contract pays', () => {
    expect(tiers.map((t) => formatMultiplierShort(t.multiplierBps))).toEqual(['×2.60', '×6.61', '×18.4']);
    expect(tiers.map((t) => formatMultiplier(t.multiplierBps))).toEqual(['×2.6088', '×6.6112', '×18.4695']);
    expect([10_000, 20_000, 26_099, 99_999, 100_000, 184_699, 999_999, 1_234_567].map(formatMultiplierShort)).toEqual([
      '×1.00',
      '×2.00',
      '×2.60',
      '×9.99',
      '×10.0',
      '×18.4',
      '×99.9',
      '×123',
    ]);
  });

  it('names the difficulty, its multiplier, the bet, the exit payout (rounded down) and the odds of each tier', async () => {
    const world = new FakeWorld({ fixture: false, calibrated: true, tiers });
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    // The slider speaks its own value: the LCD is not a live region.
    expect(screen.getByTestId('lcd').getAttribute('aria-live')).toBeNull();
    // A custom 0.032, as on the board.
    fireEvent.change(screen.getByTestId('bet-slider'), { target: { value: '517' } });
    await waitFor(() => expect(attr('bet-slider', 'data-wei')).toBe((32n * 10n ** 15n).toString()));
    const expected = [
      ['EASY 5×5 | ×2.60', '0.032 ETH | → 0.083 ETH at the exit', 'WIN ~33% | ~1 IN 3'],
      ['NORMAL 7×7 | ×6.61', '0.032 ETH | → 0.211 ETH at the exit', 'WIN ~13% | ~1 IN 8'],
      ['HARD 9×9 | ×18.4', '0.032 ETH | → 0.591 ETH at the exit', 'WIN ~4.5% | ~1 IN 22'],
    ];
    for (const [index, [first, second, third]] of expected.entries()) {
      fireEvent.click(screen.getByTestId(`tier-${index}`));
      await waitFor(() => expect(attr('lcd', 'data-tier')).toBe(String(index)));
      expect(lines()).toEqual([first, second, third]);
      // The payout in the LCD is the table's, rounded down to three decimals.
      const exit = exitPayoutWei(world.table, 32n * 10n ** 15n, index);
      expect(attr('escape-payout', 'data-wei')).toBe(exit.toString());
      expect(text('escape-payout')).toBe(`${formatEthFixed(exit, 3)} ETH at the exit`);
      // The tier's colour on the first line, the key and the lit LED.
      const tone = ['easy', 'norm', 'hard'][index];
      expect(screen.getByTestId('lcd').querySelector('.lr span')?.className).toBe(`t-${tone}`);
      expect(screen.getByTestId(`tier-${index}`).className).toContain(`dk-${tone}`);
      const leds = screen.getByTestId('difficulty-leds');
      expect(leds.getAttribute('role')).toBe('img');
      expect(leds.getAttribute('aria-label')).toBe(`Difficulty ${['EASY', 'NORMAL', 'HARD'][index]}`);
      expect([...leds.children].map((led) => led.classList.contains('on'))).toEqual([0, 1, 2].map((k) => k === index));
      // The key says it all in its label, and only its name on its face.
      expect(attr(`tier-${index}`, 'aria-label')).toBe(
        `${['EASY', 'NORMAL', 'HARD'][index]}, ${tiers[index].n}×${tiers[index].n}, ${formatMultiplierShort(tiers[index].multiplierBps)}`,
      );
      expect(text(`tier-${index}`)).toBe(['EASY', 'NORMAL', 'HARD'][index]);
      expect(text('screen-tag')).toBe(`READY ${['EASY', 'NORMAL', 'HARD'][index]}`);
    }
    // The odds come from the escape report, in one place, and say where from.
    expect(ESCAPE_RATES).toEqual({ 5: 0.3318, 7: 0.1316, 9: 0.0452 });
    expect(attr('lcd-odds', 'title')).toBe('Exit-seeking player, simulated (docs/escape-report.md)');
    expect(text('lcd-odds')).toContain('for a player who heads for the exit, simulated');
  });

  it('rounds both odds to the nearest, so "~33%" sits next to "~1 IN 3"', () => {
    expect(escapeOdds(5)).toEqual({ percent: '33%', oneIn: 3 });
    expect(escapeOdds(7)).toEqual({ percent: '13%', oneIn: 8 });
    expect(escapeOdds(9)).toEqual({ percent: '4.5%', oneIn: 22 });
    for (const n of [5, 7, 9]) {
      const odds = escapeOdds(n)!;
      // "1 IN N" is the rate's reciprocal to the nearest whole number, and the percentage the rate
      // to the nearest shown digit: they name the same odds.
      expect(Math.abs(odds.oneIn - 1 / ESCAPE_RATES[n])).toBeLessThanOrEqual(0.5);
      expect(Math.abs(parseFloat(odds.percent) - ESCAPE_RATES[n] * 100)).toBeLessThanOrEqual(0.5);
    }
    expect(escapeOdds(10)).toBeNull();
  });

  it('shows no odds for a size the escape report does not cover', async () => {
    // The test table's third size is 10×10.
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('tier-2'));
    await waitFor(() => expect(attr('lcd', 'data-tier')).toBe('2'));
    expect(lines()[0]).toBe(`HARD 10×10 | ${formatMultiplierShort(TABLE.tiers[2].multiplierBps)}`);
    expect(text('lcd-odds')).toBe('WIN —');
  });
});

describe('the side panel during a game', () => {
  it('is locked but for RANK, shows the difficulty and bet of the game, and keeps the slider\'s value after it', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
    fireEvent.click(screen.getByTestId('tier-1'));
    fireEvent.click(screen.getByTestId('bet-preset-.01'));
    // 0.032: twenty-two 0.001 steps up from 0.01.
    const slider = screen.getByTestId('bet-slider') as HTMLInputElement;
    for (let k = 0; k < 22; k++) fireEvent.keyDown(slider, { key: 'ArrowRight' });
    await waitFor(() => expect(slider.getAttribute('data-wei')).toBe((32n * 10n ** 15n).toString()));
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(await screen.findByTestId('bet-submit'));
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
    const gameId = attr('board', 'data-game-id') as Hex;
    expect(world.onchain.get(gameId)?.bet).toBe(32n * 10n ** 15n);

    const panel = screen.getByTestId('side-panel');
    expect(panel.getAttribute('data-locked')).toBe('true');
    const disabled = (id: string): boolean => (screen.getByTestId(id) as HTMLButtonElement | HTMLInputElement).disabled;
    for (const id of ['tier-0', 'tier-1', 'tier-2', 'bet-slider', 'bet-preset-.001', 'bet-preset-.01', 'bet-preset-.05', 'bet-preset-.1', 'reroll']) {
      expect(disabled(id), id).toBe(true);
    }
    // RANK still works during the game.
    expect(disabled('rank-open')).toBe(false);
    fireEvent.click(screen.getByTestId('rank-open'));
    await waitFor(() => expect(screen.getByTestId('side-leaderboard').className).toContain('flashA'));
    expect(slider.closest('.sl')?.classList.contains('dimmed')).toBe(true);
    expect(attr('tier-1', 'aria-pressed')).toBe('true');
    expect(text('lcd-odds')).toBe('IN GAMELOCKED');
    expect(text('lcd')).toContain('0.032 ETH');
    expect(attr('difficulty-leds', 'aria-label')).toBe('Difficulty NORMAL');
    // The lobby keys do not reach it either: up and down do not change the difficulty.
    fireEvent.keyDown(window, { code: 'ArrowUp' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(attr('tier-1', 'aria-pressed')).toBe('true');

    // A reload shows the game's difficulty and bet, not the lobby's defaults.
    cleanup();
    render(<GameApp deps={world.deps()} />);
    await waitFor(() => expect(attr('board', 'data-game-id')).toBe(gameId));
    expect(attr('tier-1', 'aria-pressed')).toBe('true');
    expect(attr('tier-0', 'aria-pressed')).toBe('false');
    expect(attr('bet-slider', 'data-wei')).toBe((32n * 10n ** 15n).toString());
    expect(attr('side-panel', 'data-locked')).toBe('true');

    // After the game the slider keeps its value.
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(await screen.findByTestId('cashout-button'));
    await screen.findByTestId('result-outcome');
    expect(text('lcd-odds')).toBe('GAME OVERLOCKED');
    fireEvent.click(screen.getByTestId('new-game'));
    await waitFor(() => expect(attr('side-panel', 'data-locked')).toBe('false'));
    expect(text('lcd-odds')).toContain('WIN ~13%~1 IN 8');
    expect(attr('tier-1', 'aria-pressed')).toBe('true');
    expect(attr('bet-slider', 'data-wei')).toBe((32n * 10n ** 15n).toString());
    cleanup();
    window.localStorage.clear();
    const again = new FakeWorld();
    render(<GameApp deps={again.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
    fireEvent.click(screen.getByTestId('bet-preset-.1'));
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(await screen.findByTestId('bet-submit'));
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(await screen.findByTestId('cashout-button'));
    await screen.findByTestId('result-outcome');
    fireEvent.click(screen.getByTestId('new-game'));
    await waitFor(() => expect(attr('side-panel', 'data-locked')).toBe('false'));
    expect(attr('bet-slider', 'data-wei')).toBe((10n ** 17n).toString());
    expect((screen.getByTestId('bet-slider') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('the lobby\'s choice', () => {
  it('lasts over a reload, and anything stored that does not fit the table is put right', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    // Nothing is stored until the player chooses.
    expect(window.localStorage.getItem('maze:lobby')).toBeNull();
    fireEvent.click(screen.getByTestId('tier-2'));
    fireEvent.change(screen.getByTestId('bet-slider'), { target: { value: '517' } });
    await waitFor(() => expect(attr('bet-slider', 'data-wei')).toBe((32n * 10n ** 15n).toString()));
    expect(JSON.parse(window.localStorage.getItem('maze:lobby') as string)).toEqual({
      tier: 2,
      betWei: (32n * 10n ** 15n).toString(),
    });
    cleanup();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    expect(attr('tier-2', 'aria-pressed')).toBe('true');
    expect(attr('bet-slider', 'data-wei')).toBe((32n * 10n ** 15n).toString());
    cleanup();

    for (const [stored, tier, bet] of [
      [JSON.stringify({ tier: 1, betWei: '12500000000000000' }), '1', 12n * 10n ** 15n],
      [JSON.stringify({ tier: 1, betWei: '0' }), '1', 10n ** 15n],
      [JSON.stringify({ tier: 1, betWei: '900000000000000000000' }), '1', 10n ** 17n],
      [JSON.stringify({ tier: 9, betWei: '-5' }), '0', BET],
      [JSON.stringify({ tier: 1.5, betWei: 32 }), '0', BET],
      ['not json', '0', BET],
    ] as const) {
      window.localStorage.setItem('maze:lobby', stored);
      render(<GameApp deps={world.deps()} />);
      await screen.findByTestId('btn-a');
      expect(attr('lcd', 'data-tier'), stored).toBe(tier);
      expect(attr('bet-slider', 'data-wei'), stored).toBe(bet.toString());
      cleanup();
    }
  });

  it('a stored game naming a tier the table does not have still draws, from the lobby\'s tier', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    cleanup();
    const key = `maze:record:${gameId}`;
    const stored = JSON.parse(window.localStorage.getItem(key) as string) as { tier: number };
    window.localStorage.setItem(key, JSON.stringify({ ...stored, tier: 99 }));
    // The server answers with the config only: the page has nothing but the stored record.
    const deps = {
      ...world.deps(),
      api: createApi((input, init) =>
        input === '/api/config' ? world.fetch(input, init) : Promise.reject(new TypeError('fetch failed')),
      ),
    };
    render(<GameApp deps={deps} />);
    await waitFor(() => expect(attr('board', 'data-game-id')).toBe(gameId));
    expect(attr('lcd', 'data-tier')).toBe('0');
    expect(attr('difficulty-leds', 'data-tier')).toBe('0');
    expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, BET, 0).toString());
  });
});

describe('reduced motion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('scrolls without animation when the player asked for reduced motion', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    for (const reduce of [false, true]) {
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce'), media: query }));
      const world = new FakeWorld();
      render(<GameApp deps={world.deps()} />);
      fireEvent.click(await screen.findByTestId('rank-open'));
      expect(scroll).toHaveBeenLastCalledWith({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
      cleanup();
    }
  });
});

describe('the balance under the screen', () => {
  it('is a dash without a wallet, the wallet balance in the chain coin with one, and gives way to a message', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    expect(text('console-balance')).toBe('BALANCE —');
    expect(attr('console-balance', 'data-wei')).toBe('');
    expect(screen.queryByText('MAZE BET', { selector: '.bezel-foot *' })).toBeNull();

    fireEvent.click(screen.getByTestId('wallet-dev-option'));
    await waitFor(() => expect(text('console-balance')).toBe('BALANCE 10 ETH'));
    expect(attr('console-balance', 'data-wei')).toBe((10n ** 19n).toString());
    expect(screen.getByTestId('console-balance').closest('.bezel-foot')).not.toBeNull();

    // At the start of a game the hint takes its place under the screen.
    fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: CLIENT_SEED } });
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(await screen.findByTestId('bet-submit'));
    await screen.findByTestId('screen-msg');
    expect(screen.queryByTestId('console-balance')).toBeNull();
  });
});
