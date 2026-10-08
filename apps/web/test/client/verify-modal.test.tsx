// The fairness check as a dialog over the game: opened from the footer link, the end-of-game
// Verify link or choice, and a `?verify=<gameId|import>` query (where the old /verify pages now
// redirect). Escape, the close button and a click outside close it; closing drops the query.

import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hex } from '@maze/shared';
import VerifyImportPage from '../../app/verify/page';
import VerifyGamePage from '../../app/verify/[gameId]/page';
import { GameApp } from '../../src/client/GameApp';
import { FakeWorld, planExit } from './helpers';

configure({ asyncUtilTimeout: 3000 });

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const attr = (testId: string, name: string): string | null => screen.getByTestId(testId).getAttribute(name);
const inert = (testId: string): boolean => screen.getByTestId(testId).closest('[inert]') !== null;
const press = (code: string): void => {
  fireEvent.keyDown(window, { key: code, code });
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));
const closed = (): Promise<void> => waitFor(() => expect(screen.queryByTestId('verify-modal')).toBeNull());

/** Plays the first game of `world` to the exit through the page, and waits for the settlement. */
async function playToExit(world: FakeWorld): Promise<Hex> {
  render(<GameApp deps={world.deps()} />);
  fireEvent.click(await screen.findByTestId('wallet-dev-option'));
  await screen.findByTestId('wallet-address');
  fireEvent.click(screen.getByTestId('bet-start'));
  fireEvent.click(await screen.findByTestId('bet-submit'));
  await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
  const gameId = attr('board', 'data-game-id') as Hex;
  for (const dir of planExit(world.mazeOf(gameId))) {
    const id = `move-${'NESW'[dir]}`;
    const before = Number(attr('board', 'data-step'));
    await waitFor(() => expect(attr(id, 'data-legal')).toBe('true'));
    fireEvent.click(screen.getByTestId(id));
    await waitFor(() => expect(Number(attr('board', 'data-step'))).toBe(before + 1));
  }
  await screen.findByTestId('result-outcome');
  await waitFor(() => expect(attr('settle-tx', 'data-confirmed')).toBe('true'));
  return gameId;
}

describe('verify dialog', () => {
  it('the fairness link opens it over the lobby to import a record; Escape, the close button and a click outside close it', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const link = await screen.findByTestId('fairness-link');
    expect(link.getAttribute('href')).toBe('/?verify=import');

    fireEvent.click(link);
    await screen.findByTestId('verify-modal');
    expect(await screen.findByTestId('verify-empty')).toBeTruthy();
    expect(screen.getByTestId('verify-import')).toBeTruthy();
    // It takes the focus and leaves nothing behind it reachable, the header included (the bet
    // sheet leaves the header live for the wallet; this dialog has no use for it).
    expect(document.activeElement).toBe(screen.getByTestId('verify-close'));
    expect(inert('board')).toBe(true);
    expect(inert('dock')).toBe(true);
    expect(inert('wallet-connect')).toBe(true);
    expect(inert('verify-modal')).toBe(false);
    // The game's keys do nothing behind it.
    press('ArrowDown');
    press('Enter');
    await settle();
    expect(attr('tier-0', 'data-selected')).toBe('true');
    expect(screen.queryByTestId('sign-sheet')).toBeNull();
    // Opening it changed no address: it is not a page of its own.
    expect(window.location.pathname + window.location.search).toBe('/');

    // Escape in the paste box keeps a record being pasted; with the box empty it closes.
    const box = screen.getByTestId('verify-import') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '{"half": "a record' } });
    fireEvent.keyDown(box, { key: 'Escape', code: 'Escape' });
    await settle();
    expect(screen.getByTestId('verify-modal')).toBeTruthy();
    expect(box.value).toBe('{"half": "a record');
    // Elsewhere in the dialog Escape still closes it.
    fireEvent.keyDown(screen.getByTestId('verify-close'), { key: 'Escape', code: 'Escape' });
    await closed();
    expect(inert('board')).toBe(false);
    expect(inert('wallet-connect')).toBe(false);
    fireEvent.click(screen.getByTestId('fairness-link'));
    await screen.findByTestId('verify-modal');
    fireEvent.keyDown(screen.getByTestId('verify-import'), { key: 'Escape', code: 'Escape' });
    await closed();
    // Escape with the focus outside it.
    fireEvent.click(screen.getByTestId('fairness-link'));
    await screen.findByTestId('verify-modal');
    (document.activeElement as HTMLElement | null)?.blur();
    press('Escape');
    await closed();
    // The close button.
    fireEvent.click(screen.getByTestId('fairness-link'));
    fireEvent.click(await screen.findByTestId('verify-close'));
    await closed();
    // A click on the backdrop, outside the dialog; a click inside it does not close it.
    fireEvent.click(screen.getByTestId('fairness-link'));
    const dialog = await screen.findByTestId('verify-modal');
    fireEvent.click(dialog);
    await settle();
    expect(screen.getByTestId('verify-modal')).toBeTruthy();
    fireEvent.click(dialog.parentElement as HTMLElement);
    await closed();
    expect(attr('dock', 'data-mode')).toBe('ready');
  });

  it('after a game, the Verify link and the footer link open it for that game; closing it keeps the game on screen', async () => {
    const world = new FakeWorld();
    const gameId = await playToExit(world);

    expect(attr('verify-link', 'href')).toBe(`/?verify=${gameId}`);
    fireEvent.click(screen.getByTestId('verify-link'));
    await screen.findByTestId('verify-modal');
    await waitFor(() => expect(attr('verify-game', 'data-game-id')).toBe(gameId));
    await waitFor(() => expect(attr('verify-hash-match', 'data-match')).toBe('true'));
    await waitFor(() => expect(attr('verify-cells-match', 'data-match')).toBe('true'));
    expect(window.location.search).toBe('');
    fireEvent.click(screen.getByTestId('verify-close'));
    await closed();
    expect(attr('dock', 'data-mode')).toBe('ended');
    expect(attr('result-outcome', 'data-outcome')).toBe('exit');

    expect(attr('fairness-link', 'href')).toBe(`/?verify=${gameId}`);
    fireEvent.click(screen.getByTestId('fairness-link'));
    await waitFor(() => expect(attr('verify-game', 'data-game-id')).toBe(gameId));
    press('Escape');
    await closed();
    expect(attr('board', 'data-game-id')).toBe(gameId);
  });

  it('a ?verify= query opens it on load, for a game or for an import; closing drops the query; anything else opens nothing', async () => {
    const world = new FakeWorld();
    const gameId = await playToExit(world);
    cleanup();

    // The reloaded page shows the finished game, with its fairness check over it.
    window.history.replaceState(null, '', `/?verify=${gameId}`);
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('verify-modal');
    await waitFor(() => expect(attr('verify-game', 'data-game-id')).toBe(gameId));
    await waitFor(() => expect(attr('verify-hash-match', 'data-match')).toBe('true'));
    expect(attr('board', 'data-game-id')).toBe(gameId);
    fireEvent.click(screen.getByTestId('verify-close'));
    await closed();
    // A reload now would not open it again.
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/');
    cleanup();

    window.history.replaceState(null, '', '/?verify=import');
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('verify-modal');
    expect(await screen.findByTestId('verify-empty')).toBeTruthy();
    press('Escape');
    await closed();
    expect(window.location.search).toBe('');
    cleanup();

    // Closing removes `verify` only: other query values and the hash stay.
    window.history.replaceState(null, '', '/?lang=en&verify=import&x=1#top');
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('verify-modal');
    fireEvent.click(screen.getByTestId('verify-close'));
    await closed();
    expect(window.location.search).toBe('?lang=en&x=1');
    expect(window.location.hash).toBe('#top');
    cleanup();

    // A value that names no game opens nothing and is dropped from the address on load.
    for (const [junk, left] of [
      ['?verify=0x1234', ''],
      ['?verify=', ''],
      ['?verify=..%2Fetc', ''],
      ['?a=1&verify=nope', '?a=1'],
      ['?other=1', '?other=1'],
    ] as const) {
      window.history.replaceState(null, '', `/${junk}`);
      render(<GameApp deps={world.deps()} />);
      await screen.findByTestId('fairness-link');
      await settle();
      expect(screen.queryByTestId('verify-modal'), junk).toBeNull();
      expect(window.location.search, junk).toBe(left);
      cleanup();
    }
  });

  it('with test hooks on, the page posts one snapshot stream, the dialog included', async () => {
    const world = new FakeWorld({ testHooks: true });
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('fairness-link'));
    await screen.findByTestId('verify-empty');
    expect(screen.getAllByTestId('test-beacon')).toHaveLength(1);
    await waitFor(() => expect(world.snapshots.at(-1)?.items['verify-empty']).toBeDefined());
    expect(world.snapshots.at(-1)?.items['verify-modal']).toBeDefined();
  });
});

describe('the old verify pages', () => {
  /** What a server component's `redirect()` throws: its digest names the target. */
  async function redirectOf(page: () => unknown): Promise<string> {
    try {
      await page();
    } catch (error) {
      const digest = String((error as { digest?: unknown }).digest ?? '');
      const target = digest.split(';')[2];
      if (digest.startsWith('NEXT_REDIRECT') && target !== undefined) return target;
      throw error;
    }
    throw new Error('the page rendered instead of redirecting');
  }

  it('/verify and /verify/<gameId> redirect to the dialog over the game', async () => {
    const gameId: Hex = `0x${'7e'.repeat(32)}`;
    expect(await redirectOf(() => VerifyImportPage())).toBe('/?verify=import');
    expect(await redirectOf(() => VerifyGamePage({ params: Promise.resolve({ gameId }) }))).toBe(`/?verify=${gameId}`);
    // Whatever the path holds is passed on encoded; the page decides what to open.
    expect(await redirectOf(() => VerifyGamePage({ params: Promise.resolve({ gameId: 'a&b=c' }) }))).toBe(
      '/?verify=a%26b%3Dc',
    );
  });
});
