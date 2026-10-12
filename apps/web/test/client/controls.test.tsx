// The console controls and the keyboard: the D-pad and arrows/WASD move (only where the maze
// lets them); A (the button, Enter, Space or Z) places the bet the screen names, asks about a
// cash-out and takes the highlighted answer, or opens the highlighted choice once a game is over and
// nothing is left to do for it; A never moves. Escape backs out of the cash-out question, R and the
// side panel's RANK key flash the leaderboard. Keys are left alone while the player types into a
// field, while a dialog is open and while the bet is being placed.

import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  timing: { ...world.deps().timing, pollMs: 600_000 },
});

async function startGame(world: FakeWorld, clientSeed: Hex = CLIENT_SEED, deps = noPoll(world)): Promise<Hex> {
  render(<GameApp deps={deps} />);
  fireEvent.click(await screen.findByTestId('wallet-dev-option'));
  await screen.findByTestId('wallet-address');
  // The seed is a hidden field of the side panel, set before A, which bets at once.
  fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: clientSeed } });
  fireEvent.click(screen.getByTestId('btn-a'));
  await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
  expect(screen.queryByTestId('bet-loading')).toBeNull();
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
    // Enter in the field was not A: the screen does not ask for a login.
    expect(screen.queryByTestId('screen-msg')).toBeNull();
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

  it('A (Enter, Space, Z or the button) without a wallet asks for a login on the screen; Escape is not A', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('btn-a');
    expect(attr('btn-a', 'data-action')).toBe('start');
    // Escape is not A: in the lobby it does nothing.
    press('Escape');
    await settle();
    expect(screen.queryByTestId('screen-msg')).toBeNull();
    for (const a of [() => press('Enter'), () => press('Space'), () => press('KeyZ'), () => press('NumpadEnter'), () => fireEvent.click(screen.getByTestId('btn-a'))]) {
      a();
      await waitFor(() => expect(screen.getByTestId('screen-msg').textContent).toBe('Log in to bet'));
      expect(attr('console', 'data-mode')).toBe('ready');
      // The hint goes once the lobby changes.
      press('ArrowDown');
      await waitFor(() => expect(screen.queryByTestId('screen-msg')).toBeNull());
      press('ArrowUp');
    }
    expect(world.requests).toEqual(['GET /api/config']);
    expect(world.signed).toEqual([]);
  });

  it('A (Enter, Space, Z or the button) with a wallet bets at once: no dialog, the screen shows the steps, then the board', async () => {
    for (const a of [() => press('Enter'), () => press('Space'), () => press('KeyZ'), () => press('NumpadEnter'), () => fireEvent.click(screen.getByTestId('btn-a'))]) {
      const world = new FakeWorld();
      render(<GameApp deps={noPoll(world)} />);
      fireEvent.click(await screen.findByTestId('wallet-dev-option'));
      await screen.findByTestId('wallet-address');
      a();
      await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(world.signed).toHaveLength(1);
      expect(world.txs).toEqual(['createGame']);
      expect(attr('console', 'data-mode')).toBe('play');
      cleanup();
      window.localStorage.clear();
    }
  });

  it('while the bet is being placed the screen shows its steps and the keys do nothing, Escape included', async () => {
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
    await waitFor(() => expect(attr('bet-loading', 'data-step')).toBe('sign'));
    expect(attr('console', 'data-mode')).toBe('betting');
    expect(attr('bet-status', 'data-step')).toBe('sign');
    // The side panel says what holds it: the signature, not a game yet.
    expect(screen.getByTestId('lcd-odds').textContent).toBe('SIGNINGLOCKED');

    for (const code of ['Escape', 'Enter', 'Space', 'ArrowDown', 'ArrowRight']) press(code);
    fireEvent.click(screen.getByTestId('btn-a'));
    await settle();
    expect(attr('console', 'data-mode')).toBe('betting');
    expect(attr('tier-0', 'data-selected')).toBe('true');
    expect(attr('bet-preset-.05', 'aria-pressed')).toBe('true');

    release();
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    expect(screen.queryByTestId('bet-loading')).toBeNull();
    expect(screen.getByTestId('lcd-odds').textContent).toBe('IN GAMELOCKED');
    // One bet: the presses made while it was placed sent nothing more.
    expect(world.signed).toHaveLength(1);
    expect(world.txs).toEqual(['createGame']);
    expect(world.requests.filter((r) => r === 'POST /api/games')).toHaveLength(1);
  });

  it('a held Enter or Space is one press: its repeats never bet', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={noPoll(world)} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
    // The repeats of a held key are not presses of A.
    expect(fireEvent.keyDown(window, { code: 'Enter', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(window, { code: 'Space', repeat: true })).toBe(false);
    await settle();
    expect(world.signed).toEqual([]);
    expect(attr('console', 'data-mode')).toBe('ready');
    // The first press bets, and the held key's repeats after it add nothing.
    press('Enter');
    for (let k = 0; k < 5; k++) press('Enter', { repeat: true });
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    await settle();
    expect(world.signed).toHaveLength(1);
    expect(world.txs).toEqual(['createGame']);
  });

});

describe('A in the lobby: the guards of a press that bets at once', () => {
  // The guard's real 300 ms, on a clock the tests move by hand: only `performance` is faked, so
  // the page's timers and the waits of the tests run as usual.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const later = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };
  const guarded = (world: FakeWorld, deps: ClientDeps = world.deps()): ClientDeps => ({
    ...deps,
    timing: { ...deps.timing, startGuardMs: 300 },
  });
  /** A balance read that waits for `open()` once `hold()` was called. */
  const heldBalance = (world: FakeWorld) => {
    let held: Promise<void> | null = null;
    let open = (): void => undefined;
    const deps: ClientDeps = {
      ...world.deps(),
      chain: () => ({
        ...world.chain,
        balanceOf: async () => {
          if (held !== null) await held;
          return world.balance;
        },
      }),
    };
    return {
      deps,
      hold: () => {
        held = new Promise<void>((resolve) => (open = resolve));
      },
      open: () => open(),
    };
  };
  const connect = async (): Promise<void> => {
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
  };

  it('A right after a wallet connects is not a bet; 300 ms later it is', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={guarded(world, noPoll(world))} />);
    await connect();
    press('Enter');
    fireEvent.click(screen.getByTestId('btn-a'));
    await settle();
    expect(world.signed).toEqual([]);
    expect(attr('console', 'data-mode')).toBe('ready');
    later(299);
    press('Enter');
    await settle();
    expect(world.signed).toEqual([]);
    later(1);
    press('Enter');
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    expect(world.signed).toHaveLength(1);
  });

  it('A right after New game is the press that left the game, not a bet; a later A bets', async () => {
    const world = new FakeWorld();
    // With the poll on, which brings the chain's settled status.
    render(<GameApp deps={guarded(world)} />);
    await connect();
    later(300);
    fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: CLIENT_SEED } });
    press('Enter');
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(screen.getByTestId('cashout-button'));
    await screen.findByTestId('result-outcome');
    await waitFor(() => expect(attr('settle-tx', 'data-confirmed')).toBe('true'));
    // A, A: the first leaves the game, the second comes too soon to be a decision.
    press('Enter');
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('ready'));
    press('Enter');
    await settle();
    expect(attr('console', 'data-mode')).toBe('ready');
    expect(world.signed).toHaveLength(1);
    // A later A is the player's decision: it bets.
    later(300);
    press('Enter');
    await waitFor(() => expect(world.signed).toHaveLength(2));
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    expect(world.txs).toEqual(['createGame', 'createGame']);
  });

  it('A right after a failed bet brings the lobby back is not a bet; the next A only clears the error, the one after bets', async () => {
    const world = new FakeWorld();
    world.rejectNext = 'sign';
    render(<GameApp deps={guarded(world, noPoll(world))} />);
    await connect();
    later(300);
    press('Enter');
    await waitFor(() => expect(screen.getByTestId('bet-error').textContent).toContain('signature was rejected'));
    expect(attr('console', 'data-mode')).toBe('ready');
    expect(attr('bet-prompt', 'data-ready')).toBe('false');
    expect(screen.getByTestId('bet-prompt-why').textContent).toBe('PRESS A TO DISMISS THE ERROR');

    // Mashing A as the lobby comes back: nothing, the error included, is touched.
    press('Enter');
    press('Space');
    fireEvent.click(screen.getByTestId('btn-a'));
    await settle();
    expect(screen.getByTestId('bet-error')).toBeTruthy();
    expect(world.requests.filter((r) => r.startsWith('POST'))).toEqual([]);

    // Past the guard, the first A clears the error and bets nothing; the next one bets.
    later(300);
    press('Enter');
    await waitFor(() => expect(screen.queryByTestId('bet-error')).toBeNull());
    expect(screen.queryByTestId('error-message')).toBeNull();
    expect(attr('bet-prompt', 'data-ready')).toBe('true');
    await settle();
    expect(world.signed).toEqual([]);
    expect(world.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
    press('Enter');
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    expect(world.signed).toHaveLength(1);
  });

  it('while the details are open A, Enter and the arrows do nothing, and A right after they close is not a bet', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={guarded(world, noPoll(world))} />);
    await connect();
    later(300);
    fireEvent.click(screen.getByTestId('tx-log-open'));
    await screen.findByTestId('game-details');
    later(1000);
    for (const code of ['Enter', 'NumpadEnter', 'Space', 'KeyZ', 'ArrowDown', 'ArrowRight']) press(code);
    fireEvent.click(screen.getByTestId('btn-a'));
    await settle();
    expect(screen.getByTestId('game-details')).toBeTruthy();
    expect(world.signed).toEqual([]);
    expect(attr('tier-0', 'data-selected')).toBe('true');
    expect(attr('bet-preset-.05', 'aria-pressed')).toBe('true');

    fireEvent.click(screen.getByTestId('details-close'));
    await waitFor(() => expect(screen.queryByTestId('game-details')).toBeNull());
    press('Enter');
    fireEvent.click(screen.getByTestId('btn-a'));
    await settle();
    expect(world.signed).toEqual([]);
    expect(attr('console', 'data-mode')).toBe('ready');
    later(300);
    press('Enter');
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    expect(world.signed).toHaveLength(1);
  });

  it('Enter on the bet slider is the slider\'s: it never bets; Enter elsewhere is still A', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={guarded(world, noPoll(world))} />);
    await connect();
    later(300);
    const slider = screen.getByTestId('bet-slider') as HTMLInputElement;
    slider.focus();
    for (const code of ['Enter', 'NumpadEnter']) fireEvent.keyDown(slider, { key: 'Enter', code });
    await settle();
    expect(world.signed).toEqual([]);
    expect(attr('console', 'data-mode')).toBe('ready');
    slider.blur();
    press('Enter');
    await waitFor(() => expect(world.signed).toHaveLength(1));
  });

  it('A shows the first step at once while the balance is read; A again, the lobby keys and the side panel wait, and one bet is placed', async () => {
    const world = new FakeWorld();
    const read = heldBalance(world);
    render(<GameApp deps={guarded(world, { ...read.deps, timing: noPoll(world).timing })} />);
    await connect();
    await waitFor(() => expect(screen.getByTestId('console-balance').textContent).toBe('BALANCE 10 ETH'));
    later(300);
    read.hold();
    fireEvent.click(screen.getByTestId('btn-a'));
    // At once, before the read answers: the loading screen on its first step.
    expect(attr('console', 'data-mode')).toBe('betting');
    expect(attr('bet-loading', 'data-step')).toBe('check');
    expect(attr('bet-step-check', 'data-state')).toBe('now');
    expect(attr('bet-step-sign', 'data-state')).toBe('todo');
    expect(attr('bet-status', 'data-step')).toBe('check');
    expect(screen.getByTestId('bet-status').textContent).toBe('Checking your balance before the bet');
    expect(screen.getByTestId('screen-tag').textContent).toBe('CHECKING...');
    expect(screen.getByTestId('lcd-odds').textContent).toBe('PLACING BETLOCKED');
    expect((screen.getByTestId('bet-slider') as HTMLInputElement).disabled).toBe(true);

    later(1000);
    for (let k = 0; k < 3; k++) {
      fireEvent.click(screen.getByTestId('btn-a'));
      press('Enter');
      press('Space');
    }
    press('ArrowDown');
    press('ArrowRight');
    await settle();
    expect(world.signed).toEqual([]);
    expect(attr('bet-loading', 'data-step')).toBe('check');

    read.open();
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    await settle();
    expect(world.signed).toHaveLength(1);
    expect(world.txs).toEqual(['createGame']);
    expect(world.requests.filter((r) => r === 'POST /api/games')).toHaveLength(1);
    expect(attr('tier-0', 'data-selected')).toBe('true');
    expect([...world.onchain.values()].map((g) => g.bet)).toEqual([BET]);
  });

  it('a change of the bet while the balance is read cancels it: nothing is signed, and the screen says why', async () => {
    const world = new FakeWorld();
    const read = heldBalance(world);
    render(<GameApp deps={guarded(world, { ...read.deps, timing: noPoll(world).timing })} />);
    await connect();
    await waitFor(() => expect(screen.getByTestId('console-balance').textContent).toBe('BALANCE 10 ETH'));
    later(300);
    read.hold();
    press('Enter');
    expect(attr('bet-loading', 'data-step')).toBe('check');
    // The side panel is locked; a script that moves the slider anyway changes the bet.
    fireEvent.change(screen.getByTestId('bet-slider'), { target: { value: '1000' } });
    await waitFor(() => expect(attr('bet-slider', 'data-wei')).toBe((10n ** 17n).toString()));

    read.open();
    await waitFor(() => expect(screen.getByTestId('screen-msg').textContent).toContain('The bet changed before it was placed'));
    expect(attr('console', 'data-mode')).toBe('ready');
    await settle();
    expect(world.signed).toEqual([]);
    expect(world.requests.filter((r) => r.startsWith('POST'))).toEqual([]);

    // A again bets the bet the screen names now.
    read.hold();
    press('Enter');
    read.open();
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    expect([...world.onchain.values()].map((g) => g.bet)).toEqual([10n ** 17n]);
  });

  it('a balance read that does not answer in time leaves the check to the wallet: the bet goes ahead', async () => {
    const world = new FakeWorld();
    const read = heldBalance(world);
    const deps = guarded(world, { ...read.deps, timing: { ...noPoll(world).timing, balanceCheckMs: 50 } });
    render(<GameApp deps={deps} />);
    await connect();
    await waitFor(() => expect(screen.getByTestId('console-balance').textContent).toBe('BALANCE 10 ETH'));
    later(300);
    read.hold();
    press('Enter');
    expect(attr('bet-loading', 'data-step')).toBe('check');
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    expect(world.signed).toHaveLength(1);
    expect(world.txs).toEqual(['createGame']);
    read.open();
  });

  it('a top-up takes the "not enough" message off the screen', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={guarded(world, noPoll(world))} />);
    await connect();
    await waitFor(() => expect(screen.getByTestId('console-balance').textContent).toBe('BALANCE 10 ETH'));
    later(300);
    // The wallet is emptied elsewhere after the page last looked: A reads the balance and says so.
    world.balance = 0n;
    press('Enter');
    await waitFor(() => expect(screen.getByTestId('screen-msg').textContent).toContain('Not enough ETH'));
    // The coins come back; the next read of the balance (A while short) takes the message away.
    world.balance = 10n ** 19n;
    press('Enter');
    await waitFor(() => expect(screen.queryByTestId('bet-short')).toBeNull());
    expect(screen.queryByTestId('screen-msg')).toBeNull();
    expect(world.signed).toEqual([]);
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
    // On a focused button, Enter and Space are the button's, not A (which would bet in the lobby,
    // or without a wallet ask for a login).
    fireEvent.keyDown(size, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(size, { key: ' ', code: 'Space' });
    await settle();
    expect(screen.queryByTestId('screen-msg')).toBeNull();

    // Pressed from the keyboard (no pointer, detail 0) it keeps the focus ...
    fireEvent.click(size, { detail: 0 });
    expect(document.activeElement).toBe(size);
    // ... clicked with a pointer it lets go, so Space and Enter mean A again.
    fireEvent.click(size, { detail: 1 });
    expect(document.activeElement).not.toBe(size);
  });
});
