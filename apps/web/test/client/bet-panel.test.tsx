// The bet as the lobby sets it up: the dock (size, amount, the client seed and its reroll, escape
// payout, START) and the sheet START opens (the seed's code and start side, refund schedule,
// rules, wallet steps, "Sign and bet"). Nothing here reaches the server beyond the config.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { exitPayoutWei, markStartSide, refundWei, startSideOf, type Hex, type StartSide } from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { THEMES, dungeonOf } from '../../src/client/dungeon';
import { formatEth, formatPercent } from '../../src/client/format';
import { loadRecord } from '../../src/client/record';
import { CLIENT_SEED, FakeWorld, TABLE } from './helpers';

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

const BET = 10n ** 16n;

const attr = (testId: string, name: string): string | null =>
  screen.getByTestId(testId).getAttribute(name);
const text = (testId: string): string => screen.getByTestId(testId).textContent ?? '';
const amount = (value: string): void => {
  fireEvent.change(screen.getByTestId('bet-amount'), { target: { value } });
};

describe('bet panel: the dock', () => {
  it('AC-W6 AC-R1: starts at 0.01 ETH on the smallest maze, and the chosen size and amount drive the escape payout', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('bet-start');

    expect(attr('dock', 'data-mode')).toBe('ready');
    expect((screen.getByTestId('bet-amount') as HTMLInputElement).value).toBe('0.01');
    expect(attr('tier-0', 'data-selected')).toBe('true');
    expect(attr('tier-0', 'aria-pressed')).toBe('true');
    expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, BET, 0).toString());
    expect(text('escape-payout')).toBe(`${formatEth(exitPayoutWei(TABLE, BET, 0), 4)} ETH`);
    expect(screen.queryByTestId('bet-invalid')).toBeNull();
    // Before a game the board is the empty grid of the chosen size.
    expect(attr('board', 'data-game-id')).toBe('');
    expect(attr('board', 'data-n')).toBe(String(TABLE.tiers[0].n));

    // Every size names its maze and multiplier, and choosing it moves the payout and the board.
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
      expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, BET, index).toString());
      expect(attr('board', 'data-n')).toBe(String(TABLE.tiers[index].n));
    }

    // The chips are 0.001, 0.005 and 0.01 ETH; any other amount is typed. Both set the bet.
    const chips = [...document.querySelectorAll('[data-testid^="bet-preset-"]')].map((el) => el.getAttribute('data-testid'));
    expect(chips).toEqual(['bet-preset-.001', 'bet-preset-.005', 'bet-preset-.01']);
    expect(attr('bet-preset-.01', 'aria-pressed')).toBe('true');
    const larger = 5n * 10n ** 16n;
    amount('0.05');
    await waitFor(() => expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, larger, 2).toString()));
    for (const chip of chips) expect(attr(chip as string, 'aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('bet-preset-.005'));
    await waitFor(() => expect((screen.getByTestId('bet-amount') as HTMLInputElement).value).toBe('0.005'));
    expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, BET / 2n, 2).toString());
    expect(attr('bet-preset-.005', 'aria-pressed')).toBe('true');
    expect(attr('bet-preset-.01', 'aria-pressed')).toBe('false');

    // Nothing has been requested from the server beyond the config.
    expect(world.requests).toEqual(['GET /api/config']);
    expect(world.txs).toEqual([]);
  });

  it('the one size chip a phone shows (tier-cycle) steps through the sizes', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const cycle = await screen.findByTestId('tier-cycle');
    expect(cycle.textContent).toBe('5×5');
    expect(cycle.getAttribute('aria-label')).toBe('Maze size 5×5, tap for the next size');
    for (const index of [1, 2, 0, 1]) {
      fireEvent.click(cycle);
      const { n } = TABLE.tiers[index];
      await waitFor(() => expect(attr(`tier-${index}`, 'data-selected')).toBe('true'));
      expect(cycle.textContent).toBe(`${n}×${n}`);
      expect(attr('board', 'data-n')).toBe(String(n));
      expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, BET, index).toString());
    }
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('names an amount outside the limits or not a number instead of a payout', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('bet-start');

    amount('0.0001');
    expect((await screen.findByTestId('bet-invalid')).textContent).toBe(
      `The minimum bet is ${formatEth(BigInt(TABLE.limits.minBetWei))} ETH`,
    );
    expect(screen.queryByTestId('escape-payout')).toBeNull();
    expect(attr('bet-amount', 'aria-invalid')).toBe('true');

    amount('1');
    await waitFor(() =>
      expect(text('bet-invalid')).toBe(`The maximum bet is ${formatEth(BigInt(TABLE.limits.maxBetWei))} ETH`),
    );
    amount('abc');
    await waitFor(() => expect(text('bet-invalid')).toContain('Enter the bet in ETH'));
    expect(attr('bet-preset-.01', 'aria-pressed')).toBe('false');

    amount('0.02');
    await waitFor(() => expect(screen.queryByTestId('bet-invalid')).toBeNull());
    expect(attr('escape-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, 2n * BET, 0).toString());
    expect(attr('bet-amount', 'aria-invalid')).toBe('false');
    expect(world.requests).toEqual(['GET /api/config']);
  });
});

describe('bet panel: the sheet', () => {
  const openSheet = async (): Promise<HTMLButtonElement> => {
    fireEvent.click(screen.getByTestId('bet-start'));
    return (await screen.findByTestId('bet-submit')) as HTMLButtonElement;
  };
  const closeSheet = async (): Promise<void> => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
  };
  const inert = (testId: string): boolean => screen.getByTestId(testId).closest('[inert]') !== null;

  it('START opens the sheet with a random 32-byte client seed, the bet and the rules; Cancel closes it', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const start = (await screen.findByTestId('bet-start')) as HTMLButtonElement;
    expect(screen.queryByTestId('sign-sheet')).toBeNull();
    start.focus();
    await openSheet();

    const sheet = screen.getByTestId('sign-sheet');
    // The seed is set in the dock; the sheet names it and the start side it picks.
    const seed = (screen.getByTestId('client-seed-input') as HTMLInputElement).value as Hex;
    expect(seed).toMatch(/^0x[0-9a-f]{64}$/);
    expect(text('sheet-seed-code')).toBe(`SEED ${seed.slice(2, 6).toUpperCase()}`);
    expect(attr('sheet-start-side', 'data-side')).toBe(startSideOf(seed));
    expect(within(sheet).queryByTestId('client-seed-input')).toBeNull();
    expect(within(sheet).queryByRole('button', { name: /seed/i })).toBeNull();
    expect(sheet.textContent).toContain(`${formatEth(exitPayoutWei(TABLE, BET, 0), 4)} ETH`);
    expect(text('bet-submit')).toBe('Sign and bet 0.01 ETH');
    expect(text('bet-rules')).toContain(`If you do not move for ${TABLE.timing.idleTimeoutSec}s`);
    expect(text('bet-rules')).toContain(`${TABLE.timing.maxGameSec}s after the start`);
    // AC-W6: the drop at bet time and after the first move, in words, for the chosen size.
    const [atBet, afterOne] = TABLE.tiers[0].refundBps;
    expect(text('bet-rules')).toContain(`Right after the bet you get back ${formatPercent(atBet)}`);
    expect(text('bet-rules')).toContain(`after the first step ${formatPercent(afterOne)}`);

    // The sheet takes the focus (its bet button is disabled without a wallet, so its first
    // control that can take it), and everything behind it but the header is inert.
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(inert('dock')).toBe(true);
    expect(inert('board')).toBe(true);
    expect(inert('btn-a')).toBe(true);
    expect(inert('wallet-connect')).toBe(false);
    expect(inert('sign-sheet')).toBe(false);

    // Closed, the page is live again and the focus is back where it was.
    await closeSheet();
    expect(attr('dock', 'data-mode')).toBe('ready');
    expect(inert('dock')).toBe(false);
    expect(inert('board')).toBe(false);
    expect(document.activeElement).toBe(start);
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('AC-W6 AC-R1: shows the refund after every step and the exit payout for the size and amount chosen in the dock', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('bet-start');

    for (const [tier, value] of [
      [0, '0.01'],
      [1, '0.05'],
      [2, '0.02'],
    ] as const) {
      fireEvent.click(screen.getByTestId(`tier-${tier}`));
      amount(value);
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
    amount('0.01');
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

    // Without a usable amount the percentages stay and no amount is made up.
    amount('abc');
    await waitFor(() => expect(screen.queryByTestId('escape-payout')).toBeNull());
    await openSheet();
    expect(attr('refund-schedule', 'data-bet-wei')).toBe('');
    expect(attr('schedule-row-0', 'data-bps')).toBe('9500');
    expect(attr('schedule-row-0', 'data-wei')).toBe('');
    expect(text('schedule-row-0')).toContain('—');
    expect(attr('schedule-exit-payout', 'data-wei')).toBe('');
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('does not let a bet through without a wallet, outside the limits, or with a malformed seed', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('bet-start');
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

    // An amount the dock refuses is refused by the sheet as well, with the same reason.
    for (const [value, reason] of [
      ['0.0001', `The minimum bet is ${formatEth(BigInt(TABLE.limits.minBetWei))} ETH`],
      ['1', `The maximum bet is ${formatEth(BigInt(TABLE.limits.maxBetWei))} ETH`],
      ['abc', 'Enter the bet in ETH, for example 0.01'],
    ] as const) {
      amount(value);
      await waitFor(() => expect(text('bet-invalid')).toBe(reason));
      submit = await openSheet();
      expect(submit.disabled, value).toBe(true);
      expect(text('bet-status'), value).toBe(reason);
      expect(attr('bet-status', 'data-blocked'), value).toBe('true');
      expect(text('bet-submit'), value).toBe('Sign and bet');
      await closeSheet();
    }

    amount('0.01');
    await waitFor(() => expect(screen.queryByTestId('bet-invalid')).toBeNull());
    submit = await openSheet();
    expect(submit.disabled).toBe(false);
    // With the bet ready, the sheet puts the focus on its bet button.
    expect(document.activeElement).toBe(submit);
    await closeSheet();

    // A malformed seed in the dock's hidden field blocks the bet, and the sheet says why.
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
    await screen.findByTestId('bet-start');
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

    fireEvent.click(screen.getByTestId('bet-start'));
    await screen.findByTestId('sign-sheet');
    expect(text('sheet-seed-code')).toBe(`SEED ${look.code}`);
    expect(attr('sheet-start-side', 'data-side')).toBe(side);
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('reroll draws a new marked seed in the lobby, and does nothing behind the bet sheet or the verify dialog', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('bet-start');
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

    fireEvent.click(screen.getByTestId('bet-start'));
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
      fireEvent.click(screen.getByTestId('bet-start'));
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
      // Once the game runs, the seed is the game's: no reroll, no seed tag.
      expect(screen.queryByTestId('reroll')).toBeNull();
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
    fireEvent.click(screen.getByTestId('bet-start'));
    await screen.findByTestId('sign-sheet');
    expect(screen.queryByTestId('sheet-start-side')).toBeNull();

    // A script that writes the field without an event (the dock is inert now) is still honoured.
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
      fireEvent.click(screen.getByTestId('bet-start'));
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
    fireEvent.click(screen.getByTestId('bet-start'));
    fireEvent.click(await screen.findByTestId('bet-submit'));
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    const gameId = attr('board', 'data-game-id') as Hex;
    expect(loadRecord(gameId)?.clientSeed).toBe(markStartSide(`0x${'ab'.repeat(30)}cdef`, 'E'));
    expect(attr('cell-0-0', 'data-open')).toBe('2');
  });

  it('an own seed over a seed that picks no side is marked east', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('bet-start');
    setSeed(CLIENT_SEED);
    await waitFor(() => expect(attr('board', 'data-start-side')).toBe(''));
    fireEvent.click(screen.getByTestId('bet-start'));
    await screen.findByTestId('sign-sheet');
    const own: Hex = `0x${'0f'.repeat(32)}`;
    fireEvent.change(screen.getByTestId('own-seed-input'), { target: { value: own } });
    fireEvent.click(screen.getByTestId('own-seed-apply'));
    await waitFor(() => expect(text('sheet-full-seed')).toBe(markStartSide(own, 'E')));
    expect(attr('sheet-start-side', 'data-side')).toBe('E');
  });

  it('START picks up a seed a script wrote into the field without an event: the sheet and the screen show it', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('bet-start');
    const before = seedOf();
    const scripted = markStartSide(`0x${'7a'.repeat(32)}`, startSideOf(before) === 'E' ? 'S' : 'E');
    (screen.getByTestId('client-seed-input') as HTMLInputElement).value = scripted;
    // Nothing on the page knows of it yet.
    expect(text('seed-tag')).toBe(`SEED ${before.slice(2, 6).toUpperCase()}`);

    fireEvent.click(screen.getByTestId('bet-start'));
    await screen.findByTestId('sign-sheet');
    expect(text('sheet-full-seed')).toBe(scripted);
    expect(text('sheet-seed-code')).toBe('SEED 7A7A');
    expect(attr('sheet-start-side', 'data-side')).toBe(startSideOf(scripted));
    expect(attr('board', 'data-start-side')).toBe(startSideOf(scripted));

    // A malformed value written that way is not taken over.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
    (screen.getByTestId('client-seed-input') as HTMLInputElement).value = '0xnot-a-seed';
    fireEvent.click(screen.getByTestId('bet-start'));
    await screen.findByTestId('sign-sheet');
    expect(text('sheet-full-seed')).toBe(scripted);
  });
});
