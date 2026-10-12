// The console controls and the keyboard: the D-pad and arrows/WASD move (only where the maze
// lets them); A (the button, Enter, Space or Z) opens the bet sheet, asks about a cash-out and
// takes the highlighted answer, or opens the highlighted choice once a game is over and nothing is
// left to do for it; A never moves. Escape backs out (of the cash-out question, of the bet sheet),
// R and the side panel's RANK key flash the leaderboard. Keys are left alone while the player types
// into a field or while the bet sheet is open.

import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refundWei, solve, type Dir, type Hex } from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { DIRS, DIR_NAMES, legalMoves } from '../../src/client/board-view';
import type { ClientDeps } from '../../src/client/deps';
import { blockedReason } from '../../src/client/screen-model';
import type { WalletApi } from '../../src/client/wallet';
import { CLIENT_SEED, FakeWorld, TABLE, planExit } from './helpers';

configure({ asyncUtilTimeout: 3000 });

/** The bet the slider starts on, which these games bet: 0.05. */
const BET = 5n * 10n ** 16n;
const N = TABLE.tiers[0].n;
const ARROW = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'] as const;
const WORD = ['north', 'east', 'south', 'west'] as const;

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

const attr = (testId: string, name: string): string | null =>
  screen.getByTestId(testId).getAttribute(name);
const step = (): number => Number(attr('board', 'data-step'));
/** The screen menu's highlighted choice carries the class `on`. */
const highlighted = (testId: string): boolean => screen.getByTestId(testId).classList.contains('on');
const press = (code: string, init: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(window, { code, ...init });
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));
/** Requests other than the polling read. */
const calls = (world: FakeWorld): string[] => world.requests.filter((r) => r !== 'GET /api/games/:id');

/** Without the periodic poll, so that only the controls can reach the server. */
const noPoll = (world: FakeWorld): ClientDeps => ({
  ...world.deps(),
  timing: { pollMs: 600_000, clockMs: 15, startRetryMs: 15 },
});

async function startGame(world: FakeWorld, clientSeed: Hex = CLIENT_SEED, deps = noPoll(world)): Promise<Hex> {
  render(<GameApp deps={deps} />);
  fireEvent.click(await screen.findByTestId('wallet-dev-option'));
  await screen.findByTestId('wallet-address');
  // The seed is a hidden field of the side panel, set before A: it is inert behind the sheet.
  fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: clientSeed } });
  fireEvent.click(screen.getByTestId('btn-a'));
  fireEvent.click(await screen.findByTestId('bet-submit'));
  await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
  await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
  return attr('board', 'data-game-id') as Hex;
}

/** What the screen says when `dir` is refused. */
function refusal(reason: 'wall' | 'visited' | 'edge', dir: Dir): string {
  if (reason === 'wall') return `A wall to the ${WORD[dir]}.`;
  if (reason === 'visited') return 'You came from there. No going back.';
  return "That's the edge of the maze.";
}

describe('moving', () => {
  it('arrows move only in a legal direction; a refused press sends nothing and says why; a held key does not repeat', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    const maze = world.mazeOf(gameId);
    const moves = planExit(maze);
    const start = [{ step: 0, cell: 0, open: maze.open[0] }];
    const legal = legalMoves(N, start);
    expect(legal).toContain(moves[0]);

    const before = calls(world).length;
    for (const dir of DIRS.filter((d) => !legal.includes(d))) {
      expect(attr(`move-${DIR_NAMES[dir]}`, 'data-legal')).toBe('false');
      press(ARROW[dir]);
      await waitFor(() =>
        expect(screen.getByTestId('screen-msg').textContent).toBe(refusal(blockedReason(N, start, dir)!, dir)),
      );
    }
    await settle();
    expect(calls(world).slice(before)).toEqual([]);
    expect(step()).toBe(0);

    // A key held down repeats; only the first press counts, and the repeats do not scroll the
    // page either. Modifier chords are not moves, and are left to the browser.
    expect(fireEvent.keyDown(window, { code: ARROW[moves[0]], repeat: true })).toBe(false);
    expect(fireEvent.keyDown(window, { code: 'Space', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(window, { code: ARROW[moves[0]], ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(window, { code: ARROW[moves[0]], metaKey: true })).toBe(true);
    await settle();
    expect(calls(world).slice(before)).toEqual([]);
    expect(step()).toBe(0);

    press(ARROW[moves[0]]);
    await waitFor(() => expect(step()).toBe(1));
    expect(world.games.get(gameId)?.moves).toEqual([moves[0]]);
    expect(calls(world).slice(before)).toEqual(['POST /api/games/:id/move']);

    // Back the way it came: the D-pad button is pressable, but the move is refused on the page.
    const back = ((moves[0] + 2) % 4) as Dir;
    await waitFor(() => expect(attr(`move-${DIR_NAMES[back]}`, 'data-legal')).toBe('false'));
    expect((screen.getByTestId(`move-${DIR_NAMES[back]}`) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId(`move-${DIR_NAMES[back]}`));
    await waitFor(() => expect(screen.getByTestId('screen-msg').textContent).toBe(refusal('visited', back)));
    await settle();
    expect(step()).toBe(1);
    expect(world.games.get(gameId)?.moves).toEqual([moves[0]]);
  });

  it('tapping the cell one may enter steps there, and never answers the cash-out question', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    const [, next] = solve(world.mazeOf(gameId));
    const cell = (): HTMLElement => screen.getByTestId(`cell-${next % N}-${Math.floor(next / N)}`);
    const before = calls(world).length;

    press('Enter');
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('confirm'));
    expect(cell().getAttribute('data-enter')).not.toBeNull();
    fireEvent.click(cell());
    await settle();
    expect(step()).toBe(0);
    expect(attr('console', 'data-mode')).toBe('confirm');
    expect(calls(world).slice(before)).toEqual([]);

    press('Escape');
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    fireEvent.click(cell());
    await waitFor(() => expect(step()).toBe(1));
    expect(attr('console', 'data-mode')).toBe('play');
    expect(calls(world).slice(before)).toEqual(['POST /api/games/:id/move']);
  });

  it('A (the button, Enter, Space or Z) never moves: it asks about a cash-out, and only the D-pad walks', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    const [first] = planExit(world.mazeOf(gameId));
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    const before = calls(world).length;

    for (const ask of [() => press('Space'), () => press('KeyZ'), () => press('Enter'), () => fireEvent.click(screen.getByTestId('btn-a'))]) {
      ask();
      await waitFor(() => expect(attr('console', 'data-mode')).toBe('confirm'));
      expect(step()).toBe(0);
      press('Escape');
      await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    }
    await settle();
    expect(step()).toBe(0);
    expect(world.games.get(gameId)?.moves).toEqual([]);
    expect(calls(world).slice(before)).toEqual([]);

    // The D-pad walks.
    fireEvent.click(screen.getByTestId(`move-${DIR_NAMES[first]}`));
    await waitFor(() => expect(step()).toBe(1));
    expect(world.games.get(gameId)?.moves).toEqual([first]);
  });
});

describe('cash-out question', () => {
  it('A (Enter) asks on "Keep going", right picks "Take it", A again answers: "Keep going" sends nothing, "Take it" cashes out', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    const [first] = planExit(world.mazeOf(gameId));
    press(ARROW[first]);
    await waitFor(() => expect(step()).toBe(1));
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    const before = calls(world).length;
    /** Past the moment after asking when A is taken for the press that asked. */
    const beat = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 320));

    // Enter asks, with "Keep going" highlighted; Escape backs out of the question.
    press('Enter');
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('confirm'));
    expect(highlighted('cashout-cancel')).toBe(true);
    expect(highlighted('cashout-button')).toBe(false);
    expect(attr('btn-a', 'data-action')).toBe('cashout');
    press('Escape');
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));

    // While asking, the arrows move the highlight and not the hero: right is "Take it", left is
    // "Keep going". A on "Keep going" keeps going.
    press('NumpadEnter');
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('confirm'));
    press('ArrowRight');
    await waitFor(() => expect(highlighted('cashout-button')).toBe(true));
    expect(highlighted('cashout-cancel')).toBe(false);
    press('ArrowRight');
    await settle();
    expect(highlighted('cashout-button')).toBe(true);
    press('ArrowLeft');
    await waitFor(() => expect(highlighted('cashout-cancel')).toBe(true));
    await beat();
    press('Space');
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    press('KeyZ');
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('confirm'));
    expect(highlighted('cashout-cancel')).toBe(true);
    await beat();
    fireEvent.click(screen.getByTestId('btn-a'));
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));

    // The question's own buttons do the same.
    fireEvent.click(screen.getByTestId('btn-a'));
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('confirm'));
    fireEvent.click(screen.getByTestId('cashout-cancel'));
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    // Escape with no question open does nothing.
    press('Escape');
    await settle();
    expect(attr('console', 'data-mode')).toBe('play');
    expect(calls(world).slice(before)).toEqual([]);
    expect(step()).toBe(1);

    // Asked again, the highlight is back on "Keep going"; right, then A (Enter), takes it.
    press('Enter');
    await waitFor(() => expect(highlighted('cashout-cancel')).toBe(true));
    press('ArrowRight');
    await waitFor(() => expect(highlighted('cashout-button')).toBe(true));
    await beat();
    press('Enter');
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('cashout');
    expect(attr('result-payout', 'data-wei')).toBe(refundWei(TABLE, BET, 0, 1).toString());
    expect(calls(world).slice(before)).toEqual(['POST /api/games/:id/cashout']);
  });

  it('A held down, or pressed twice fast, never cashes out', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    const before = calls(world).length;
    // Held: the repeats are not presses.
    press('Enter');
    for (let k = 0; k < 5; k++) press('Enter', { repeat: true });
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('confirm'));
    expect(highlighted('cashout-cancel')).toBe(true);
    // Even on "Take it", a second press right after asking is ignored.
    press('Escape');
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    press('Space');
    press('ArrowRight');
    press('Space');
    await settle();
    expect(attr('console', 'data-mode')).toBe('confirm');
    expect(screen.queryByTestId('result-outcome')).toBeNull();
    expect(world.games.get(gameId)?.status).toBe('active');
    expect(calls(world).slice(before)).toEqual([]);
  });

  it('after the end the arrows pick New game or Verify and A (Space or Enter) opens the pick (the verify dialog, or a new game); Escape does not', async () => {
    const world = new FakeWorld();
    // With the poll on, which brings the chain's settled status.
    const gameId = await startGame(world, CLIENT_SEED, world.deps());
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(screen.getByTestId('cashout-button'));
    await screen.findByTestId('result-outcome');
    expect(attr('console', 'data-mode')).toBe('ended');
    // The keys wait until the chain shows the game settled.
    await waitFor(() => expect(attr('settle-tx', 'data-confirmed')).toBe('true'));
    expect(highlighted('new-game')).toBe(true);
    expect(attr('btn-a', 'data-action')).toBe('new-game');

    press('ArrowRight');
    await waitFor(() => expect(highlighted('verify-link')).toBe(true));
    expect(highlighted('new-game')).toBe(false);
    // The name under A follows the pick.
    expect(attr('btn-a', 'data-action')).toBe('verify');
    expect(attr('verify-link', 'href')).toBe(`/?verify=${gameId}`);
    // A on Verify opens the fairness check of this game over the page; Escape closes it again.
    press('Space');
    await screen.findByTestId('verify-modal');
    await waitFor(() => expect(attr('verify-game', 'data-game-id')).toBe(gameId));
    press('Escape');
    await waitFor(() => expect(screen.queryByTestId('verify-modal')).toBeNull());
    expect(attr('console', 'data-mode')).toBe('ended');
    expect(highlighted('verify-link')).toBe(true);
    press('ArrowLeft');
    await waitFor(() => expect(highlighted('new-game')).toBe(true));
    // Up and down do nothing here, and Escape does not leave the game.
    press('ArrowDown');
    press('Escape');
    await settle();
    expect(highlighted('new-game')).toBe(true);
    expect(attr('console', 'data-mode')).toBe('ended');

    press('Space');
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('ready'));
    expect(attr('board', 'data-game-id')).toBe('');

    // Enter at the end of a second game does the same.
    cleanup();
    window.localStorage.clear();
    const again = new FakeWorld();
    await startGame(again, CLIENT_SEED, again.deps());
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(screen.getByTestId('cashout-button'));
    await screen.findByTestId('result-outcome');
    await waitFor(() => expect(attr('settle-tx', 'data-confirmed')).toBe('true'));
    press('Enter');
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('ready'));
  });

  it('while something is left to do for a finished game (the player\'s own settle), the keys do not leave it; the New game button does', async () => {
    const world = new FakeWorld();
    world.autoSettle = false;
    await startGame(world);
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(screen.getByTestId('cashout-button'));
    await screen.findByTestId('result-outcome');
    // Right after the end, before the page offers anything, a stray tap does not leave the game.
    expect(highlighted('new-game')).toBe(false);
    press('Space');
    press('Enter');
    await settle();
    expect(attr('console', 'data-mode')).toBe('ended');
    // The relayer has not settled; once the page offers the signed settlement, it is the player's
    // to send, and the menu highlights no choice.
    world.chainNow += 11;
    await screen.findByTestId('settle-self');
    expect(highlighted('new-game')).toBe(false);
    expect(highlighted('verify-link')).toBe(false);

    for (const code of ['Enter', 'NumpadEnter', 'Space', 'KeyZ', 'ArrowRight', 'Escape']) press(code);
    fireEvent.click(screen.getByTestId('btn-a'));
    await settle();
    expect(attr('console', 'data-mode')).toBe('ended');
    expect(highlighted('new-game')).toBe(false);
    expect(highlighted('verify-link')).toBe(false);
    expect(world.txs).toEqual(['createGame']);

    fireEvent.click(screen.getByTestId('new-game'));
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('ready'));
    expect(attr('board', 'data-game-id')).toBe('');
  });
});

describe('lobby keys', () => {
  /** The tick label the bet sits on. */
  const coin = (): string | undefined =>
    [...document.querySelectorAll('[data-testid^="bet-preset-"]')]
      .find((el) => el.getAttribute('aria-pressed') === 'true')
      ?.getAttribute('data-testid')
      ?.slice('bet-preset-'.length);

  it('up and down change the difficulty, left and right jump between the bet ticks; keys typed into a field stay there', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    const tier = (): number => [0, 1, 2].findIndex((i) => attr(`tier-${i}`, 'data-selected') === 'true');

    // Typing in a field on the page: the arrows and Enter belong to the field.
    const input = (document.querySelector('.app') as HTMLElement).appendChild(document.createElement('input'));
    fireEvent.keyDown(input, { code: 'ArrowDown' });
    fireEvent.keyDown(input, { code: 'ArrowRight' });
    fireEvent.keyDown(input, { code: 'Enter' });
    await settle();
    expect(tier()).toBe(0);
    expect(coin()).toBe('.05');
    expect(screen.queryByTestId('sign-sheet')).toBeNull();
    input.remove();

    press('ArrowDown');
    await waitFor(() => expect(tier()).toBe(1));
    expect(attr('board', 'data-n')).toBe(String(TABLE.tiers[1].n));
    press('KeyS');
    await waitFor(() => expect(tier()).toBe(2));
    press('ArrowDown');
    await settle();
    expect(tier()).toBe(2);
    press('ArrowUp');
    await waitFor(() => expect(tier()).toBe(1));
    press('KeyW');
    press('ArrowUp');
    await waitFor(() => expect(tier()).toBe(0));

    // The ticks are 0.001, 0.01, 0.05 and 0.1, and the bet starts on 0.05: right from the largest
    // stays there, left from the smallest too.
    press('ArrowRight');
    await waitFor(() => expect(coin()).toBe('.1'));
    press('ArrowRight');
    await settle();
    expect(coin()).toBe('.1');
    press('ArrowLeft');
    await waitFor(() => expect(coin()).toBe('.05'));
    press('KeyA');
    await waitFor(() => expect(coin()).toBe('.01'));
    press('ArrowLeft');
    await waitFor(() => expect(coin()).toBe('.001'));
    press('ArrowLeft');
    await settle();
    expect(coin()).toBe('.001');
    press('KeyD');
    await waitFor(() => expect(coin()).toBe('.01'));
    press('KeyD');
    await waitFor(() => expect(coin()).toBe('.05'));
    // Between two ticks, left goes to the one below.
    fireEvent.change(screen.getByTestId('bet-slider'), { target: { value: '517' } });
    await waitFor(() => expect(attr('bet-slider', 'data-wei')).toBe((32n * 10n ** 15n).toString()));
    expect(coin()).toBeUndefined();
    press('ArrowLeft');
    await waitFor(() => expect(coin()).toBe('.01'));
    press('ArrowRight');
    await waitFor(() => expect(coin()).toBe('.05'));
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('A (Enter, Space, Z or the button) opens the bet sheet; while it is open the keys are its own, and Escape closes it', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    expect(attr('btn-a', 'data-action')).toBe('start');
    // Escape is not A: in the lobby it opens nothing.
    press('Escape');
    await settle();
    expect(screen.queryByTestId('sign-sheet')).toBeNull();
    press('Enter');
    await screen.findByTestId('sign-sheet');

    // The lobby keys do nothing behind the sheet.
    press('ArrowDown');
    press('ArrowRight');
    press('Space');
    press('Enter');
    await settle();
    expect(attr('tier-0', 'data-selected')).toBe('true');
    expect(attr('bet-preset-.05', 'aria-pressed')).toBe('true');
    expect(screen.getByTestId('sign-sheet')).toBeTruthy();
    // Escape closes the sheet from anywhere in it, a focused control of it included.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());

    for (const open of [() => press('Space'), () => press('KeyZ'), () => press('NumpadEnter'), () => fireEvent.click(screen.getByTestId('btn-a'))]) {
      open();
      await screen.findByTestId('sign-sheet');
      press('Escape');
      await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
    }
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('Escape does not close the sheet while the bet is being placed', async () => {
    const world = new FakeWorld();
    const real = world.wallet();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const wallet: WalletApi = {
      ...real,
      signMessage: async (message) => {
        await held;
        return real.signMessage(message);
      },
    };
    render(<GameApp deps={{ ...noPoll(world), connectDev: async () => wallet }} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
    press('Enter');
    fireEvent.click(await screen.findByTestId('bet-submit'));
    await waitFor(() => expect(attr('bet-status', 'data-step')).toBe('sign'));
    // The side panel says what holds it: the signature, not a game yet.
    expect(screen.getByTestId('lcd-odds').textContent).toBe('SIGNINGLOCKED');

    press('Escape');
    fireEvent.keyDown(document.activeElement ?? screen.getByTestId('sign-sheet'), { key: 'Escape', code: 'Escape' });
    fireEvent.keyDown(screen.getByTestId('sign-sheet'), { key: 'Escape', code: 'Escape' });
    await settle();
    expect(screen.getByTestId('sign-sheet')).toBeTruthy();
    expect(attr('console', 'data-mode')).toBe('betting');

    release();
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
    expect(screen.getByTestId('lcd-odds').textContent).toBe('IN GAMELOCKED');
  });

  it('a held Enter or Space opens the sheet once and never presses "Sign and bet"', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={noPoll(world)} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
    // The repeats of a held key are not presses of A.
    press('Enter', { repeat: true });
    press('Space', { repeat: true });
    await settle();
    expect(screen.queryByTestId('sign-sheet')).toBeNull();
    press('Enter');
    const submit = (await screen.findByTestId('bet-submit')) as HTMLButtonElement;
    // The sheet puts the focus on its bet button: the key, still held, must not press it.
    await waitFor(() => expect(document.activeElement).toBe(submit));
    expect(fireEvent.keyDown(submit, { key: 'Enter', code: 'Enter', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(submit, { key: ' ', code: 'Space', repeat: true })).toBe(false);
    // A fresh press right on top of the one that opened the sheet is not a decision either ...
    expect(fireEvent.keyDown(submit, { key: 'Enter', code: 'Enter' })).toBe(false);
    expect(fireEvent.keyUp(submit, { key: ' ', code: 'Space' })).toBe(false);
    // ... a press after a beat is the button's own.
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(fireEvent.keyDown(submit, { key: 'Enter', code: 'Enter' })).toBe(true);
    expect(fireEvent.keyUp(submit, { key: ' ', code: 'Space' })).toBe(true);
    await settle();
    expect(world.signed).toEqual([]);
    expect(world.txs).toEqual([]);
  });

  it('Enter, Enter opens the sheet and does not bet; a later Enter on "Sign and bet" does', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={noPoll(world)} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
    /** Enter on a focused button, as a browser presses it: a click unless the keydown was stopped. */
    const enterOn = (el: HTMLElement): void => {
      if (fireEvent.keyDown(el, { key: 'Enter', code: 'Enter' })) fireEvent.click(el);
    };
    press('Enter');
    const submit = (await screen.findByTestId('bet-submit')) as HTMLButtonElement;
    await waitFor(() => expect(document.activeElement).toBe(submit));
    // The second Enter, quickly: nothing is signed.
    enterOn(submit);
    await settle();
    expect(world.signed).toEqual([]);
    expect(world.txs).toEqual([]);
    expect(screen.getByTestId('sign-sheet')).toBeTruthy();
    // Later, Enter on "Sign and bet" is the player's decision: it bets.
    await new Promise((resolve) => setTimeout(resolve, 320));
    enterOn(submit);
    await waitFor(() => expect(world.signed).toHaveLength(1));
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    expect(world.txs).toEqual(['createGame']);
  });
});

describe('leaderboard and focus', () => {
  it('R and the side panel\'s RANK key flash the leaderboard', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const board = await screen.findByTestId('side-leaderboard');
    expect(board.className).not.toMatch(/flash/);
    expect(screen.queryByTestId('btn-select')).toBeNull();
    expect(screen.queryByTestId('btn-start')).toBeNull();
    press('KeyR');
    await waitFor(() => expect(screen.getByTestId('side-leaderboard').className).toContain('flashA'));
    const rank = screen.getByTestId('rank-open');
    expect(rank.closest('[data-testid="side-panel"]')).not.toBeNull();
    expect(rank.textContent).toBe('RANK');
    // The header has no leaderboard button of its own.
    expect(document.querySelector('header [data-testid="rank-open"]')).toBeNull();
    expect(rank.getAttribute('aria-label')).toBe('Show the leaderboard');
    fireEvent.click(rank);
    await waitFor(() => expect(screen.getByTestId('side-leaderboard').className).toContain('flashB'));
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('a focused button keeps its own Enter and Space; a console button gives its focus back only after a pointer click', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const size = (await screen.findByTestId('tier-1')) as HTMLButtonElement;
    size.focus();
    expect(document.activeElement).toBe(size);
    // On a focused button, Enter and Space are the button's, not A (which would open the bet
    // sheet in the lobby).
    fireEvent.keyDown(size, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(size, { key: ' ', code: 'Space' });
    await settle();
    expect(screen.queryByTestId('sign-sheet')).toBeNull();

    // Pressed from the keyboard (no pointer, detail 0) it keeps the focus ...
    fireEvent.click(size, { detail: 0 });
    expect(document.activeElement).toBe(size);
    // ... clicked with a pointer it lets go, so Space and Enter mean A again.
    fireEvent.click(size, { detail: 1 });
    expect(document.activeElement).not.toBe(size);
  });
});
