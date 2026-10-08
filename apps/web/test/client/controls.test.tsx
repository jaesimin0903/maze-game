// The console controls and the keyboard: the D-pad and arrows/WASD move (only where the maze
// lets them), A (Space/Z) steps forward or picks the highlighted choice, START (Enter) opens the
// bet sheet, asks about a cash-out or starts a new game once nothing is left to do for the last
// one, Escape backs out (of the cash-out question, of the bet sheet), SELECT (R) flashes the
// leaderboard. Keys are left alone while the player types into a field or while the bet sheet is
// open.

import { createHash } from 'node:crypto';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DIR_BIT,
  deriveFinalSeed,
  generateMaze,
  refundWei,
  solve,
  type Dir,
  type Hex,
} from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { DIRS, DIR_NAMES, adjacent, legalMoves } from '../../src/client/board-view';
import type { ClientDeps } from '../../src/client/deps';
import { blockedReason } from '../../src/client/screen-model';
import type { WalletApi } from '../../src/client/wallet';
import { CLIENT_SEED, FakeWorld, SERVER_SEED, TABLE, firstGameId, planExit } from './helpers';

configure({ asyncUtilTimeout: 3000 });

/** The amount the dock starts with, which these games bet: 0.05. */
const BET = 5n * 10n ** 16n;
const N = TABLE.tiers[0].n;
const ARROW = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'] as const;
const WORD = ['north', 'east', 'south', 'west'] as const;

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

const attr = (testId: string, name: string): string | null =>
  screen.getByTestId(testId).getAttribute(name);
const step = (): number => Number(attr('board', 'data-step'));
/** The dock's highlighted choice carries the class `on`. */
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
  // The seed is a hidden field of the dock, set before START: the dock is inert behind the sheet.
  fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: clientSeed } });
  fireEvent.click(screen.getByTestId('bet-start'));
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

/**
 * A client seed for the first game of a `FakeWorld` whose 5×5 maze lets the hero walk straight
 * ahead twice from the start, the way it faces before the first move.
 */
function straightStart(): { clientSeed: Hex; dir: Dir } {
  for (let i = 0; i < 500; i++) {
    const clientSeed: Hex = `0x${createHash('sha256').update(`straight ${i}`, 'utf8').digest('hex')}`;
    const maze = generateMaze(deriveFinalSeed({ serverSeed: SERVER_SEED, clientSeed, gameId: firstGameId }), N);
    const dir: Dir = (maze.open[0] & DIR_BIT[2]) !== 0 ? 2 : 1;
    const next = adjacent(N, 0, dir);
    if (next === null || (maze.open[next] & DIR_BIT[dir]) === 0) continue;
    const after = adjacent(N, next, dir);
    if (after === null || after === N * N - 1) continue;
    // The second cell must leave a way on, so the game is still running after both steps.
    const ways = DIRS.filter((d) => (maze.open[after] & DIR_BIT[d]) !== 0 && adjacent(N, after, d) !== next);
    if (ways.length > 0) return { clientSeed, dir };
  }
  throw new Error('no such client seed among 500');
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
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('confirm'));
    expect(cell().getAttribute('data-enter')).not.toBeNull();
    fireEvent.click(cell());
    await settle();
    expect(step()).toBe(0);
    expect(attr('dock', 'data-mode')).toBe('confirm');
    expect(calls(world).slice(before)).toEqual([]);

    press('Escape');
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('play'));
    fireEvent.click(cell());
    await waitFor(() => expect(step()).toBe(1));
    expect(attr('dock', 'data-mode')).toBe('play');
    expect(calls(world).slice(before)).toEqual(['POST /api/games/:id/move']);
  });

  it('A (Space, Z or the A button) steps forward the way the hero faces', async () => {
    const { clientSeed, dir } = straightStart();
    const world = new FakeWorld();
    const gameId = await startGame(world, clientSeed);
    expect(gameId).toBe(firstGameId);

    // Before the first move the hero faces down when the start opens south, right otherwise.
    press('Space');
    await waitFor(() => expect(step()).toBe(1));
    expect(world.games.get(gameId)?.moves).toEqual([dir]);
    await waitFor(() => expect(attr(`move-${DIR_NAMES[dir]}`, 'data-legal')).toBe('true'));
    press('KeyZ');
    await waitFor(() => expect(step()).toBe(2));
    expect(world.games.get(gameId)?.moves).toEqual([dir, dir]);

    // A third press: forward again if the maze allows it, otherwise the reason on screen.
    const maze = world.mazeOf(gameId);
    const path = [0, adjacent(N, 0, dir)!, adjacent(N, adjacent(N, 0, dir)!, dir)!];
    const observations = path.map((cell, k) => ({ step: k, cell, open: maze.open[cell] }));
    const why = blockedReason(N, observations, dir);
    fireEvent.click(screen.getByTestId('btn-a'));
    if (why === null) {
      await waitFor(() => expect(world.games.get(gameId)?.moves).toEqual([dir, dir, dir]));
    } else {
      await waitFor(() => expect(screen.getByTestId('screen-msg').textContent).toBe(refusal(why, dir)));
      await settle();
      expect(world.games.get(gameId)?.moves).toEqual([dir, dir]);
    }
  });
});

describe('cash-out question', () => {
  it('START (Enter) asks, arrows pick, A (Space) answers: "Keep going" sends nothing, "Take it" cashes out', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    const [first] = planExit(world.mazeOf(gameId));
    press(ARROW[first]);
    await waitFor(() => expect(step()).toBe(1));
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('play'));
    const before = calls(world).length;

    // Enter toggles the question.
    press('Enter');
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('confirm'));
    expect(highlighted('cashout-button')).toBe(true);
    expect(highlighted('cashout-cancel')).toBe(false);
    press('Enter');
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('play'));

    // While asking, the arrows move the highlight and not the hero; Space keeps going.
    press('NumpadEnter');
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('confirm'));
    press('ArrowRight');
    await waitFor(() => expect(highlighted('cashout-cancel')).toBe(true));
    expect(highlighted('cashout-button')).toBe(false);
    press('Space');
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('play'));

    // The dock's own buttons do the same.
    fireEvent.click(screen.getByTestId('cashout-open'));
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('confirm'));
    fireEvent.click(screen.getByTestId('cashout-cancel'));
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('play'));
    // The START pill asks as well, and Escape backs out of the question.
    fireEvent.click(screen.getByTestId('btn-start'));
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('confirm'));
    press('Escape');
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('play'));
    // Escape with no question open does nothing.
    press('Escape');
    await settle();
    expect(attr('dock', 'data-mode')).toBe('play');
    expect(calls(world).slice(before)).toEqual([]);
    expect(step()).toBe(1);

    // Asked again, the highlight is back on "Take it", and Space takes it.
    press('Enter');
    await waitFor(() => expect(highlighted('cashout-button')).toBe(true));
    press('Space');
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('cashout');
    expect(attr('result-payout', 'data-wei')).toBe(refundWei(TABLE, BET, 0, 1).toString());
    expect(calls(world).slice(before)).toEqual(['POST /api/games/:id/cashout']);
  });

  it('after the end the arrows pick New game or Verify, A opens the pick (the verify dialog, or a new game) and START starts a new game; Escape does not', async () => {
    const world = new FakeWorld();
    // With the poll on, which brings the chain's settled status.
    const gameId = await startGame(world, CLIENT_SEED, world.deps());
    fireEvent.click(screen.getByTestId('cashout-open'));
    fireEvent.click(screen.getByTestId('cashout-button'));
    await screen.findByTestId('result-outcome');
    expect(attr('dock', 'data-mode')).toBe('ended');
    // The keys wait until the chain shows the game settled.
    await waitFor(() => expect(attr('settle-tx', 'data-confirmed')).toBe('true'));
    expect(highlighted('new-game')).toBe(true);

    press('ArrowRight');
    await waitFor(() => expect(highlighted('verify-link')).toBe(true));
    expect(highlighted('new-game')).toBe(false);
    expect(attr('verify-link', 'href')).toBe(`/?verify=${gameId}`);
    // A on Verify opens the fairness check of this game over the page; Escape closes it again.
    press('Space');
    await screen.findByTestId('verify-modal');
    await waitFor(() => expect(attr('verify-game', 'data-game-id')).toBe(gameId));
    press('Escape');
    await waitFor(() => expect(screen.queryByTestId('verify-modal')).toBeNull());
    expect(attr('dock', 'data-mode')).toBe('ended');
    expect(highlighted('verify-link')).toBe(true);
    press('ArrowLeft');
    await waitFor(() => expect(highlighted('new-game')).toBe(true));
    // Up and down do nothing here, and Escape does not leave the game.
    press('ArrowDown');
    press('Escape');
    await settle();
    expect(highlighted('new-game')).toBe(true);
    expect(attr('dock', 'data-mode')).toBe('ended');

    press('Space');
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('ready'));
    expect(attr('board', 'data-game-id')).toBe('');

    // START from the end of a second game does the same.
    cleanup();
    window.localStorage.clear();
    const again = new FakeWorld();
    await startGame(again, CLIENT_SEED, again.deps());
    fireEvent.click(screen.getByTestId('cashout-open'));
    fireEvent.click(screen.getByTestId('cashout-button'));
    await screen.findByTestId('result-outcome');
    await waitFor(() => expect(attr('settle-tx', 'data-confirmed')).toBe('true'));
    press('Enter');
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('ready'));
  });

  it('while something is left to do for a finished game (the player\'s own settle), the keys do not leave it; the New game button does', async () => {
    const world = new FakeWorld();
    world.autoSettle = false;
    await startGame(world);
    fireEvent.click(screen.getByTestId('cashout-open'));
    fireEvent.click(screen.getByTestId('cashout-button'));
    await screen.findByTestId('result-outcome');
    // Right after the end, before the page offers anything, a stray tap does not leave the game.
    expect(highlighted('new-game')).toBe(false);
    press('Space');
    press('Enter');
    await settle();
    expect(attr('dock', 'data-mode')).toBe('ended');
    // The relayer has not settled; once the page offers the signed settlement, it is the player's
    // to send, and the dock highlights no choice.
    world.chainNow += 11;
    await screen.findByTestId('settle-self');
    expect(highlighted('new-game')).toBe(false);
    expect(highlighted('verify-link')).toBe(false);

    for (const code of ['Enter', 'NumpadEnter', 'Space', 'KeyZ', 'ArrowRight', 'Escape']) press(code);
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(screen.getByTestId('btn-start'));
    await settle();
    expect(attr('dock', 'data-mode')).toBe('ended');
    expect(highlighted('new-game')).toBe(false);
    expect(highlighted('verify-link')).toBe(false);
    expect(world.txs).toEqual(['createGame']);

    fireEvent.click(screen.getByTestId('new-game'));
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('ready'));
    expect(attr('board', 'data-game-id')).toBe('');
  });
});

describe('lobby keys', () => {
  it('up and down change the size, left and right step through the bet chips; keys typed into a field stay there', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const input = (await screen.findByTestId('bet-amount')) as HTMLInputElement;
    const tier = (): number => [0, 1, 2].findIndex((i) => attr(`tier-${i}`, 'data-selected') === 'true');

    // Typing in the amount: the arrows and Enter belong to the field.
    fireEvent.keyDown(input, { code: 'ArrowDown' });
    fireEvent.keyDown(input, { code: 'ArrowRight' });
    fireEvent.keyDown(input, { code: 'Enter' });
    await settle();
    expect(tier()).toBe(0);
    expect(input.value).toBe('0.05');
    expect(screen.queryByTestId('sign-sheet')).toBeNull();

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

    // The chips are 0.01, 0.05 and 0.1, and the field starts on 0.05: right from the largest stays there.
    press('ArrowRight');
    await waitFor(() => expect(input.value).toBe('0.1'));
    press('ArrowRight');
    await settle();
    expect(input.value).toBe('0.1');
    press('ArrowLeft');
    await waitFor(() => expect(input.value).toBe('0.05'));
    press('KeyA');
    await waitFor(() => expect(input.value).toBe('0.01'));
    press('ArrowLeft');
    await settle();
    expect(input.value).toBe('0.01');
    press('KeyD');
    await waitFor(() => expect(input.value).toBe('0.05'));
    press('ArrowRight');
    await waitFor(() => expect(input.value).toBe('0.1'));
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('START (Enter) opens the bet sheet; while it is open the keys are its own, and Escape closes it', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('bet-start');
    // Escape is not START: in the lobby it opens nothing.
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
    expect((screen.getByTestId('bet-amount') as HTMLInputElement).value).toBe('0.05');
    expect(screen.getByTestId('sign-sheet')).toBeTruthy();
    // Escape closes the sheet from anywhere in it, a focused control of it included.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());

    fireEvent.click(screen.getByTestId('bet-start'));
    await screen.findByTestId('sign-sheet');
    press('Escape');
    await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
    // The A button and the START pill open it too.
    fireEvent.click(screen.getByTestId('btn-a'));
    await screen.findByTestId('sign-sheet');
    press('Escape');
    await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
    fireEvent.click(screen.getByTestId('btn-start'));
    await screen.findByTestId('sign-sheet');
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

    press('Escape');
    fireEvent.keyDown(document.activeElement ?? screen.getByTestId('sign-sheet'), { key: 'Escape', code: 'Escape' });
    fireEvent.keyDown(screen.getByTestId('sign-sheet'), { key: 'Escape', code: 'Escape' });
    await settle();
    expect(screen.getByTestId('sign-sheet')).toBeTruthy();
    expect(attr('dock', 'data-mode')).toBe('betting');

    release();
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
  });
});

describe('SELECT and focus', () => {
  it('R and the SELECT pill flash the leaderboard', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const board = await screen.findByTestId('side-leaderboard');
    expect(board.className).not.toMatch(/flash/);
    press('KeyR');
    await waitFor(() => expect(screen.getByTestId('side-leaderboard').className).toContain('flashA'));
    fireEvent.click(screen.getByTestId('btn-select'));
    await waitFor(() => expect(screen.getByTestId('side-leaderboard').className).toContain('flashB'));
    expect(world.requests).toEqual(['GET /api/config']);
  });

  it('a focused button keeps its own Enter and Space; a console button gives its focus back only after a pointer click', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const select = (await screen.findByTestId('btn-select')) as HTMLButtonElement;
    select.focus();
    expect(document.activeElement).toBe(select);
    // On a focused button, Enter and Space are the button's, not START or A (which would open
    // the bet sheet in the lobby).
    fireEvent.keyDown(select, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(select, { key: ' ', code: 'Space' });
    await settle();
    expect(screen.queryByTestId('sign-sheet')).toBeNull();

    // Pressed from the keyboard (no pointer, detail 0) it keeps the focus ...
    fireEvent.click(select, { detail: 0 });
    expect(document.activeElement).toBe(select);
    // ... clicked with a pointer it lets go, so Space and Enter mean A and START again.
    fireEvent.click(select, { detail: 1 });
    expect(document.activeElement).not.toBe(select);
  });
});
