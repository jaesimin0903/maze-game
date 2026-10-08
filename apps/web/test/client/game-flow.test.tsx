import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ONCHAIN_STATUS,
  exitPayoutWei,
  refundWei,
  solve,
  ticketRequestMessage,
  type Dir,
  type Hex,
} from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { DIRS, DIR_NAMES, legalMoves } from '../../src/client/board-view';
import type { ClientDeps } from '../../src/client/deps';
import { formatEth } from '../../src/client/format';
import { activeGameId, loadRecord } from '../../src/client/record';
import { hashSessionToken } from '../../src/client/seed';
import type { WalletApi } from '../../src/client/wallet';
import {
  CLIENT_SEED,
  CONTRACT,
  FakeWorld,
  PLAYER,
  TABLE,
  anvilAccount,
  planDeadEnd,
  planExit,
} from './helpers';

configure({ asyncUtilTimeout: 3000 });

const BET = 10n ** 16n;
const KEY_CODE = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'] as const;
const WASD_CODE = ['KeyW', 'KeyD', 'KeyS', 'KeyA'] as const;

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

const attr = (testId: string, name: string): string | null =>
  screen.getByTestId(testId).getAttribute(name);
const button = (testId: string): HTMLButtonElement =>
  screen.getByTestId(testId) as HTMLButtonElement;
const step = (): number => Number(attr('board', 'data-step'));

/** Requests other than the polling read and the test beacon. */
const calls = (world: FakeWorld): string[] =>
  world.requests.filter((r) => r !== 'GET /api/games/:id' && !r.includes('ui-snapshot'));

/** Without the periodic poll, so that only an explicit trigger can reach the server. */
const noPoll = (world: FakeWorld): ClientDeps => ({
  ...world.deps(),
  timing: { pollMs: 600_000, clockMs: 15, startRetryMs: 15 },
});

/**
 * Opens the page, connects the dev wallet, picks the smallest maze, the amount and the client
 * seed (a hidden field of the dock) and presses START, which opens the bet sheet. The dock is
 * inert behind the open sheet, so everything in it is set first.
 */
async function openLobby(world: FakeWorld, deps: ClientDeps = world.deps()): Promise<void> {
  render(<GameApp deps={deps} />);
  fireEvent.click(await screen.findByTestId('wallet-dev-option'));
  await screen.findByTestId('wallet-address');
  fireEvent.click(screen.getByTestId('tier-0'));
  fireEvent.change(screen.getByTestId('bet-amount'), { target: { value: '0.01' } });
  fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: CLIENT_SEED } });
  fireEvent.click(screen.getByTestId('bet-start'));
  await screen.findByTestId('sign-sheet');
}

/** Presses "Sign and bet" in the sheet and waits for the first cell; the sheet closes by itself. */
async function bet(): Promise<Hex> {
  fireEvent.click(screen.getByTestId('bet-submit'));
  await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
  await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
  return attr('board', 'data-game-id') as Hex;
}

async function startGame(world: FakeWorld, deps: ClientDeps = world.deps()): Promise<Hex> {
  await openLobby(world, deps);
  return bet();
}

/**
 * The bet failed: the page is back in the lobby (the empty board, the ready dock) with `text` on
 * screen, and the sheet is still open with "Sign and bet" usable again.
 */
async function backInLobbyWith(text: string): Promise<void> {
  expect((await screen.findByTestId('error-message')).textContent).toContain(text);
  expect(attr('board', 'data-game-id')).toBe('');
  expect(attr('dock', 'data-mode')).toBe('ready');
  expect(screen.getByTestId('sign-sheet')).toBeTruthy();
  expect(button('bet-submit').disabled).toBe(false);
  expect(attr('bet-status', 'data-step')).toBe('');
}

/** With the bet sheet open: closes it, chooses size `tier` in the dock and opens it again. */
async function chooseSize(tier: number): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByTestId('sign-sheet')).toBeNull());
  fireEvent.click(screen.getByTestId(`tier-${tier}`));
  fireEvent.click(screen.getByTestId('bet-start'));
  await screen.findByTestId('sign-sheet');
}

async function walk(dirs: Dir[]): Promise<void> {
  for (const dir of dirs) {
    const before = step();
    const id = `move-${DIR_NAMES[dir]}`;
    await waitFor(() => expect(attr(id, 'data-legal')).toBe('true'));
    fireEvent.click(button(id));
    await waitFor(() => expect(step()).toBe(before + 1));
  }
}

describe('game flow', () => {
  it('AC-W1 AC-W4 AC-E1: a bet opens the board and the solution path ends in the exit payout', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    const moves = planExit(world.mazeOf(gameId));
    await walk(moves);

    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('exit');
    expect(attr('result-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, BET, 0).toString());
    // The console screen says what the escape won, under the banner.
    expect(attr('end-amount', 'data-wei')).toBe(exitPayoutWei(TABLE, BET, 0).toString());
    expect(screen.getByTestId('end-amount').textContent).toBe(`+${formatEth(exitPayoutWei(TABLE, BET, 0), 4)} ETH`);
    expect(attr('verify-link', 'href')).toBe(`/?verify=${gameId}`);
    // The settlement hash arrives with a later poll.
    await waitFor(() => expect(attr('settle-tx', 'data-tx')).toMatch(/^0x5e771e/));
    await waitFor(() => expect(attr('settle-tx', 'data-confirmed')).toBe('true'));

    expect(calls(world)).toEqual([
      'GET /api/config',
      'POST /api/games',
      'POST /api/games/:id/start',
      ...moves.map(() => 'POST /api/games/:id/move'),
    ]);
    expect(world.txs).toEqual(['createGame']);

    const record = loadRecord(gameId);
    expect(record?.terminal?.outcome).toBe(0);
    expect(record?.moves).toEqual(moves);
    expect(record?.observations).toHaveLength(moves.length + 1);
    expect(record?.clientSeed).toBe(CLIENT_SEED);
  });

  it('AC-W4 AC-R4 AC-E1: walking into a dead end shows the loss with a payout of zero', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    await walk(planDeadEnd(world.mazeOf(gameId)));

    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('loss');
    expect(attr('result-payout', 'data-wei')).toBe('0');
    expect(screen.queryByTestId('cashout-open')).toBeNull();
    expect(screen.queryByTestId('cashout-button')).toBeNull();
    expect(world.txs).toEqual(['createGame']);
  });

  it('AC-W3 AC-W4 AC-R3: the refundable amount follows the table at every step and cash-out pays it', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    const moves = planExit(world.mazeOf(gameId)).slice(0, 3);

    for (let k = 0; k <= 3; k++) {
      if (k > 0) await walk([moves[k - 1]]);
      expect(attr('refundable-amount', 'data-wei')).toBe(refundWei(TABLE, BET, 0, k).toString());
      expect(attr('refundable-amount', 'data-step')).toBe(String(k));
      // What one more step would leave.
      expect(attr('next-step', 'data-wei')).toBe(refundWei(TABLE, BET, 0, k + 1).toString());
      expect(attr('exit-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, BET, 0).toString());
      expect(button('cashout-open').disabled).toBe(false);
    }

    // Asking is not cashing out: the question names the amount and nothing reaches the server.
    const asked = world.requests.length;
    fireEvent.click(button('cashout-open'));
    expect(attr('dock', 'data-mode')).toBe('confirm');
    expect(screen.getByTestId('dock').textContent).toContain(`${formatEth(refundWei(TABLE, BET, 0, 3), 4)} ETH`);
    expect(world.requests.slice(asked).filter((r) => r !== 'GET /api/games/:id')).toEqual([]);
    fireEvent.click(button('cashout-button'));
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe(
      'cashout',
    );
    expect(attr('result-payout', 'data-wei')).toBe(refundWei(TABLE, BET, 0, 3).toString());
    // A stopped game shows on the screen what it handed back.
    expect(attr('end-amount', 'data-wei')).toBe(refundWei(TABLE, BET, 0, 3).toString());
    expect(screen.getByTestId('end-amount').textContent).toBe(`${formatEth(refundWei(TABLE, BET, 0, 3), 4)} ETH BACK`);
    expect(calls(world).slice(-4)).toEqual([
      'POST /api/games/:id/move',
      'POST /api/games/:id/move',
      'POST /api/games/:id/move',
      'POST /api/games/:id/cashout',
    ]);
    expect(world.txs).toEqual(['createGame']);
  });

  it('AC-W7 AC-E2: an idle auto cash-out is found by the read triggered when the chain clock reaches the idle deadline', async () => {
    const world = new FakeWorld({ idleTimeoutSec: 6 });
    const gameId = await startGame(world, noPoll(world));
    await walk(planExit(world.mazeOf(gameId)).slice(0, 2));
    expect(attr('idle-countdown', 'data-remaining-sec')).toBe('6');

    const before = world.requests.length;
    world.chainNow += 6;

    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe(
      'auto-cashout',
    );
    expect(attr('result-payout', 'data-wei')).toBe(refundWei(TABLE, BET, 0, 2).toString());
    // The client only read; it never asked for the cash-out.
    expect(new Set(world.requests.slice(before))).toEqual(new Set(['GET /api/games/:id']));
    expect(world.txs).toEqual(['createGame']);
  });

  it('AC-E2 scenario 05: with the server down the open page reclaims the bet once the chain passes the settle deadline', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    await walk(planExit(world.mazeOf(gameId)).slice(0, 1));

    world.serverUp = false;
    await screen.findByTestId('server-unreachable');
    const deadline = world.onchain.get(gameId)?.settleDeadline as number;
    await waitFor(() => expect(attr('reclaim-countdown', 'data-deadline-sec')).toBe(String(deadline)));
    // Counted on block timestamps: the contract accepts the reclaim one second past the deadline.
    expect(attr('reclaim-countdown', 'data-remaining-sec')).toBe(
      String(deadline + 1 - world.chainNow),
    );
    expect(button('reclaim-button').disabled).toBe(true);
    expect(button('reclaim-button').textContent).toBe('Reclaim bet');
    // The outage does not take the game away: the play dock stays, with the reclaim beside it.
    expect(attr('dock', 'data-mode')).toBe('play');
    expect(attr('refundable-amount', 'data-wei')).toBe(refundWei(TABLE, BET, 0, 1).toString());
    expect(screen.getByTestId('cashout-open')).toBeTruthy();
    expect(screen.getByTestId('next-step')).toBeTruthy();
    expect(screen.getByTestId('exit-payout')).toBeTruthy();

    world.chainNow += 1900;
    await waitFor(() => expect(button('reclaim-button').disabled).toBe(false));
    expect(attr('reclaim-countdown', 'data-remaining-sec')).toBe('0');
    expect(attr('reclaim-countdown', 'data-chain-now-sec')).toBe(String(world.chainNow));

    fireEvent.click(button('reclaim-button'));
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe(
      'reclaimed',
    );
    expect(attr('result-payout', 'data-wei')).toBe(BET.toString());
    expect(attr('settle-tx', 'data-tx')).toMatch(/^0x4ec1a1/);
    expect(screen.queryByTestId('reclaim-button')).toBeNull();
    expect(world.txs).toEqual(['createGame', 'reclaim']);
    expect(loadRecord(gameId)?.reclaimed?.amountWei).toBe(BET.toString());

    // The reclaimed game stays the page's game: a reload shows its result again.
    expect(activeGameId()).toBe(gameId);
    cleanup();
    world.serverUp = true;
    render(<GameApp deps={world.deps()} />);
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('reclaimed');
    expect(attr('result-payout', 'data-wei')).toBe(BET.toString());
    expect(attr('board', 'data-game-id')).toBe(gameId);
    expect(attr('dock', 'data-mode')).toBe('ended');
  });

  it('the reclaim panel stays hidden while the server answers and the deadline has not passed', async () => {
    const world = new FakeWorld();
    await startGame(world);
    expect(screen.queryByTestId('reclaim-countdown')).toBeNull();
    expect(screen.queryByTestId('reclaim-button')).toBeNull();
    expect(screen.queryByTestId('server-unreachable')).toBeNull();
  });

  it('a settlement the server does not send can be submitted by the player', async () => {
    const world = new FakeWorld();
    world.autoSettle = false;
    const gameId = await startGame(world);
    await walk(planExit(world.mazeOf(gameId)));
    await screen.findByTestId('result-outcome');
    expect(attr('settle-tx', 'data-tx')).toBe('');
    expect(screen.queryByTestId('settle-self')).toBeNull();

    world.chainNow += 11;
    fireEvent.click(await screen.findByTestId('settle-self'));
    await waitFor(() => expect(attr('settle-tx', 'data-tx')).toMatch(/^0x5e1f/));
    await waitFor(() => expect(attr('settle-tx', 'data-confirmed')).toBe('true'));
    expect(world.txs).toEqual(['createGame', 'settle']);
  });

  it('a settle transaction that is dropped and sent again: the page names the one that settled the game, then stops asking', async () => {
    const world = new FakeWorld();
    world.settlesToDrop = 1;
    const gameId = await startGame(world);
    await walk(planExit(world.mazeOf(gameId)));
    await screen.findByTestId('result-outcome');

    // The first transaction the server reports is never mined; the second one settles the game.
    await waitFor(() => expect(world.settleHashesSent).toHaveLength(2));
    const [dropped, mined] = world.settleHashesSent;
    expect(dropped).toMatch(/^0xd40bbed/);
    expect(world.settledBy.get(gameId)).toBe(mined);
    await waitFor(() => expect(attr('settle-tx', 'data-tx')).toBe(mined));
    expect(attr('settle-tx', 'data-confirmed')).toBe('true');
    expect(loadRecord(gameId)?.terminal?.settleTxHash).toBe(mined);

    // Nothing is left to learn: the page no longer asks the server.
    const reads = (): number => world.requests.filter((r) => r === 'GET /api/games/:id').length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const settledReads = reads();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads()).toBe(settledReads);
    expect(attr('settle-tx', 'data-tx')).toBe(mined);
  });

  it('a transaction that was sent but did not settle the game is not shown as the settlement', async () => {
    const world = new FakeWorld();
    world.settlesToDrop = 1_000;
    const gameId = await startGame(world);
    await walk(planExit(world.mazeOf(gameId)));
    await screen.findByTestId('result-outcome');

    // The server keeps reporting transactions that are never mined: no hash, not confirmed, and
    // the page keeps asking.
    await waitFor(() => expect(world.settleHashesSent.length).toBeGreaterThanOrEqual(3));
    expect(world.settledBy.has(gameId)).toBe(false);
    expect(attr('settle-tx', 'data-tx')).toBe('');
    expect(attr('settle-tx', 'data-confirmed')).toBe('false');
  });

  it('a reported settle transaction that never mines does not take the player\'s own settle away', async () => {
    const world = new FakeWorld();
    world.settlesToDrop = 1_000;
    const gameId = await startGame(world);
    await walk(planExit(world.mazeOf(gameId)));
    await screen.findByTestId('result-outcome');

    // The server has reported a hash, the chain still shows the game Active.
    await waitFor(() => expect(loadRecord(gameId)?.terminal?.settleTxHash).toMatch(/^0xd40bbed/));
    expect(world.onchain.get(gameId)?.status).toBe(ONCHAIN_STATUS.Active);
    // Not offered at once: the relayer normally settles within a block or two.
    expect(screen.queryByTestId('settle-self')).toBeNull();

    world.chainNow += 11;
    fireEvent.click(await screen.findByTestId('settle-self'));
    await waitFor(() => expect(attr('settle-tx', 'data-tx')).toMatch(/^0x5e1f/));
    await waitFor(() => expect(attr('settle-tx', 'data-confirmed')).toBe('true'));
    expect(attr('result-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, BET, 0).toString());
    expect(screen.queryByTestId('settle-self')).toBeNull();
    expect(world.txs).toEqual(['createGame', 'settle']);
  });

  it('after a win, with a hash reported and the server gone, the player can settle instead of only reclaiming the bet', async () => {
    const world = new FakeWorld();
    world.settlesToDrop = 1_000;
    const gameId = await startGame(world);
    await walk(planExit(world.mazeOf(gameId)));
    await screen.findByTestId('result-outcome');
    await waitFor(() => expect(loadRecord(gameId)?.terminal?.settleTxHash).toMatch(/^0xd40bbed/));

    world.serverUp = false;
    await screen.findByTestId('server-unreachable');
    // The reclaim panel counts down, and the signed settlement is offered next to it, under the
    // result of the game.
    await screen.findByTestId('reclaim-countdown');
    expect(button('reclaim-button').disabled).toBe(true);
    expect(button('reclaim-button').textContent).toMatch(/^Reclaim · \d+:\d\d$/);
    expect(attr('dock', 'data-mode')).toBe('ended');
    expect(attr('result-outcome', 'data-outcome')).toBe('exit');
    fireEvent.click(await screen.findByTestId('settle-self'));
    await waitFor(() => expect(attr('settle-tx', 'data-tx')).toMatch(/^0x5e1f/));
    expect(attr('settle-tx', 'data-confirmed')).toBe('true');
    expect(screen.queryByTestId('reclaim-button')).toBeNull();
    expect(world.txs).toEqual(['createGame', 'settle']);
  });

  it('a reloaded page without a wallet still shows the player\'s own settle, and sends it once a wallet is connected', async () => {
    const world = new FakeWorld();
    world.settlesToDrop = 1_000;
    const gameId = await startGame(world);
    await walk(planExit(world.mazeOf(gameId)));
    await screen.findByTestId('result-outcome');
    await waitFor(() => expect(loadRecord(gameId)?.terminal?.settleTxHash).toMatch(/^0xd40bbed/));
    world.serverUp = false;
    cleanup();

    // The config is the one thing a page cannot start without; the game server stays down after it.
    const deps = world.deps();
    const config = world.config;
    render(<GameApp deps={{ ...deps, api: { ...deps.api, config: async () => config } }} />);
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('exit');
    await waitFor(() => expect(button('settle-self').disabled).toBe(true));
    expect(button('settle-self').textContent).toContain('connect a wallet');
    expect(button('settle-self').getAttribute('title')).toContain('Connect a wallet');

    fireEvent.click(screen.getByTestId('wallet-dev-option'));
    await waitFor(() => expect(button('settle-self').disabled).toBe(false));
    fireEvent.click(button('settle-self'));
    await waitFor(() => expect(attr('settle-tx', 'data-tx')).toMatch(/^0x5e1f/));
    expect(attr('settle-tx', 'data-confirmed')).toBe('true');
    expect(world.txs).toEqual(['createGame', 'settle']);
  });

  it('the player\'s own settle is not offered once the settle deadline has passed', async () => {
    const world = new FakeWorld();
    world.autoSettle = false;
    const gameId = await startGame(world);
    await walk(planExit(world.mazeOf(gameId)));
    await screen.findByTestId('result-outcome');

    world.chainNow = (world.onchain.get(gameId)?.settleDeadline as number) + 1;
    await waitFor(() => expect(button('reclaim-button').disabled).toBe(false));
    expect(screen.queryByTestId('settle-self')).toBeNull();
  });
});

describe('a finished game', () => {
  it('stays on the page after it is settled: a reload or a reconnected wallet shows its result, and only New game leaves it', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    await walk(planExit(world.mazeOf(gameId)));
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('exit');
    await waitFor(() => expect(attr('settle-tx', 'data-confirmed')).toBe('true'));
    await waitFor(() => expect(attr('settle-tx', 'data-tx')).toMatch(/^0x5e771e/));
    const tx = attr('settle-tx', 'data-tx');
    expect(activeGameId()).toBe(gameId);

    // A reload, without a wallet: the same game, ended, with its result and settlement.
    cleanup();
    render(<GameApp deps={world.deps()} />);
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('exit');
    expect(attr('board', 'data-game-id')).toBe(gameId);
    expect(attr('dock', 'data-mode')).toBe('ended');
    expect(attr('result-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, BET, 0).toString());
    await waitFor(() => expect(attr('settle-tx', 'data-confirmed')).toBe('true'));
    // The reloaded page names the settlement again: the hash in the record, confirmed on chain.
    await waitFor(() => expect(attr('settle-tx', 'data-tx')).toBe(tx));

    // Connecting, disconnecting and connecting the wallet again does not leave the game.
    fireEvent.click(screen.getByTestId('wallet-dev-option'));
    fireEvent.click(await screen.findByTestId('wallet-disconnect'));
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
    expect(attr('dock', 'data-mode')).toBe('ended');
    expect(attr('result-outcome', 'data-outcome')).toBe('exit');
    expect(attr('board', 'data-game-id')).toBe(gameId);

    // New game leaves it, for good: the next load starts in the lobby.
    fireEvent.click(screen.getByTestId('new-game'));
    await waitFor(() => expect(attr('dock', 'data-mode')).toBe('ready'));
    expect(activeGameId()).toBeNull();
    cleanup();
    render(<GameApp deps={world.deps()} />);
    await screen.findByTestId('bet-start');
    expect(attr('board', 'data-game-id')).toBe('');
    expect(screen.queryByTestId('result-outcome')).toBeNull();
    // The record itself is kept for the verify dialog.
    expect(loadRecord(gameId)?.terminal?.outcome).toBe(0);
  });
});

describe('polling after the end', () => {
  it('a reloaded page whose game the chain shows settled, with no hash from the server, stops asking after a few polls', async () => {
    const world = new FakeWorld();
    world.autoSettle = false;
    const gameId = await startGame(world);
    await walk(planExit(world.mazeOf(gameId)));
    await screen.findByTestId('result-outcome');
    // The player settled the game from elsewhere: the chain shows it settled, and the server
    // never reports a settlement hash.
    const onchain = world.onchain.get(gameId);
    if (!onchain) throw new Error('the game is not on chain');
    onchain.status = ONCHAIN_STATUS.Settled;
    world.settledBy.set(gameId, `0x${'5e1f'.padEnd(64, '0')}`);
    cleanup();

    const reads = (): number => world.requests.filter((r) => r === 'GET /api/games/:id').length;
    const before = reads();
    render(<GameApp deps={world.deps()} />);
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('exit');
    await waitFor(() => expect(attr('settle-tx', 'data-confirmed')).toBe('true'));
    // The page asks a few more times (every 40 ms here), then stops.
    await waitFor(
      async () => {
        const now = reads();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(reads()).toBe(now);
      },
      { timeout: 4000 },
    );
    const asked = reads() - before;
    // The resume read, at most ten polls once the chain showed the game finished, and the few
    // polls that ran before the first chain read came back.
    expect(asked).toBeGreaterThan(1);
    expect(asked).toBeLessThanOrEqual(14);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(reads() - before).toBe(asked);
    // The transaction stays unnamed; the result does not change.
    expect(attr('settle-tx', 'data-tx')).toBe('');
    expect(attr('result-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, BET, 0).toString());
  });
});

describe('ticket request', () => {
  const ticketPosts = (world: FakeWorld): number =>
    world.requests.filter((r) => r === 'POST /api/games').length;

  it('the wallet signs the ticket request message before the ticket is asked for, and the server verifies it', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);

    const token = loadRecord(gameId)?.token as string;
    expect(world.signed).toEqual([
      ticketRequestMessage({
        chainId: 31337,
        mazeBetAddress: CONTRACT,
        player: PLAYER,
        tier: 0,
        sessionTokenHash: hashSessionToken(token),
      }),
    ]);
    expect(world.signed[0]).toBe(
      `maze-ticket:31337:${CONTRACT.toLowerCase()}:${PLAYER.toLowerCase()}:0:${hashSessionToken(token)}`,
    );
    // One click on "bet" does all of it: no step of the dev wallet waits for the player.
    expect(world.timeline.filter((t) => t !== 'GET /api/games/:id')).toEqual([
      'GET /api/config',
      'sign',
      'POST /api/games',
      'tx createGame',
      'POST /api/games/:id/start',
    ]);
  });

  it('a signature by a key that is not the player\'s is refused, and the page says so', async () => {
    const world = new FakeWorld();
    world.signer = anvilAccount(3);
    await openLobby(world);
    fireEvent.click(screen.getByTestId('bet-submit'));
    await backInLobbyWith('could not verify the wallet signature');
    expect(world.games.size).toBe(0);
    expect(world.txs).toEqual([]);
  });

  it('dismissing the signature prompt returns to the lobby, and pressing bet again starts the game', async () => {
    const world = new FakeWorld();
    world.rejectNext = 'sign';
    await openLobby(world);
    fireEvent.click(screen.getByTestId('bet-submit'));
    await backInLobbyWith('signature was rejected in the wallet');
    expect(ticketPosts(world)).toBe(0);
    expect(world.txs).toEqual([]);

    const gameId = await bet();
    expect(world.games.get(gameId)?.onChain).not.toBeNull();
    expect(screen.queryByTestId('error-message')).toBeNull();
    expect(world.txs).toEqual(['createGame']);
  });

  it('dismissing the transaction prompt returns to the lobby, and pressing bet again continues with the same ticket', async () => {
    const world = new FakeWorld();
    world.rejectNext = 'tx';
    await openLobby(world);
    fireEvent.click(screen.getByTestId('bet-submit'));
    await backInLobbyWith('transaction was rejected in the wallet');
    expect(world.txs).toEqual([]);
    expect(world.games.size).toBe(1);
    const [ticketId] = [...world.games.keys()];

    const gameId = await bet();
    expect(gameId).toBe(ticketId);
    expect(world.games.size).toBe(1);
    expect(ticketPosts(world)).toBe(2);
    expect(world.signed).toHaveLength(2);
    expect(world.txs).toEqual(['createGame']);
    // The ticket now belongs to the second session token: the game answers this page.
    await walk(planExit(world.mazeOf(gameId)).slice(0, 1));
    expect(world.games.get(gameId)?.moves).toHaveLength(1);
  });

  it('a reloaded page that never sent its bet gets the same ticket back', async () => {
    const world = new FakeWorld();
    world.rejectNext = 'tx';
    await openLobby(world);
    fireEvent.click(screen.getByTestId('bet-submit'));
    await backInLobbyWith('transaction was rejected in the wallet');
    const [ticketId] = [...world.games.keys()];
    cleanup();

    expect(await startGame(world)).toBe(ticketId);
    expect(world.games.size).toBe(1);
  });

  it('an unused ticket for another size is not spent: the page names both sizes and sends nothing', async () => {
    const world = new FakeWorld();
    world.rejectNext = 'tx';
    await openLobby(world);
    fireEvent.click(screen.getByTestId('bet-submit'));
    await backInLobbyWith('transaction was rejected in the wallet');

    // The 5×5 ticket is still unused; the player now asks for 7×7. The size is chosen in the
    // dock, which the open sheet makes inert: close the sheet, choose, press START again.
    await chooseSize(1);
    fireEvent.click(screen.getByTestId('bet-submit'));
    await backInLobbyWith('unused 5×5 ticket');
    const message = screen.getByTestId('error-message').textContent as string;
    expect(message).toContain('7×7');
    expect(message).toContain(`in about ${Math.floor(TABLE.timing.ticketExpirySec / 60)}:`);
    expect(world.txs).toEqual([]);
    expect(world.games.size).toBe(1);

    // Betting the size of the ticket goes through.
    await chooseSize(0);
    const gameId = await bet();
    expect(attr('board', 'data-n')).toBe('5');
    expect(world.games.get(gameId)?.tier).toBe(0);
    expect(world.txs).toEqual(['createGame']);
  });

  it('a browser wallet is told which of its two prompts is open; the dev wallet is not told to approve anything', async () => {
    for (const kind of ['injected', 'dev'] as const) {
      const world = new FakeWorld({ devWallet: kind === 'dev' });
      const real = world.wallet();
      let releaseSign = (): void => undefined;
      let releaseTx = (): void => undefined;
      const signHeld = new Promise<void>((resolve) => (releaseSign = resolve));
      const txHeld = new Promise<void>((resolve) => (releaseTx = resolve));
      const wallet: WalletApi = {
        ...real,
        kind,
        signMessage: async (message) => {
          await signHeld;
          return real.signMessage(message);
        },
        createGame: async (p) => {
          await txHeld;
          return real.createGame(p);
        },
      };
      const deps: ClientDeps = {
        ...world.deps(),
        injected: () => ({ request: async () => null }) as never,
        connectInjected: async () => wallet,
        connectDev: async () => wallet,
      };
      render(<GameApp deps={deps} />);
      fireEvent.click(
        await screen.findByTestId(kind === 'dev' ? 'wallet-dev-option' : 'wallet-connect'),
      );
      expect((await screen.findByTestId('wallet-address')).getAttribute('data-kind')).toBe(kind);
      fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: CLIENT_SEED } });
      fireEvent.click(screen.getByTestId('bet-start'));
      fireEvent.click(await screen.findByTestId('bet-submit'));

      await waitFor(() => expect(attr('bet-status', 'data-step')).toBe('sign'));
      const signText = screen.getByTestId('bet-status').textContent as string;
      expect(button('bet-submit').disabled).toBe(true);
      releaseSign();
      await waitFor(() => expect(attr('bet-status', 'data-step')).toBe('tx'));
      const txText = screen.getByTestId('bet-status').textContent as string;
      releaseTx();
      await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));

      if (kind === 'injected') {
        expect(signText).toContain('1 of 2');
        expect(signText).toContain('approve the ticket request signature');
        expect(txText).toContain('2 of 2');
        expect(txText).toContain('approve the bet transaction');
      } else {
        expect(signText).toContain('dev wallet');
        expect(txText).toContain('dev wallet');
        expect(signText + txText).not.toContain('approve');
      }
      cleanup();
      window.localStorage.clear();
    }
  });
});

describe('server errors', () => {
  const answer = (status: number, body: unknown) => (): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('an INTERNAL answer is shown as a server error; it is not "unreachable" and does not open the reclaim panel', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world, noPoll(world));
    const [first] = planExit(world.mazeOf(gameId));

    world.answerNext = answer(500, { error: { code: 'INTERNAL', message: 'boom' } });
    fireEvent.click(button(`move-${DIR_NAMES[first]}`));
    expect((await screen.findByTestId('error-message')).textContent).toContain('internal error');
    expect(screen.queryByTestId('server-unreachable')).toBeNull();
    expect(screen.queryByTestId('reclaim-countdown')).toBeNull();
    expect(step()).toBe(0);

    // The game goes on once the server answers properly again.
    await walk([first]);
  });

  it('a 500 without a known error code is an unreachable server, which opens the reclaim panel', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world, noPoll(world));
    const [first] = planExit(world.mazeOf(gameId));

    world.answerNext = answer(500, { message: 'boom' });
    fireEvent.click(button(`move-${DIR_NAMES[first]}`));
    await screen.findByTestId('server-unreachable');
    await screen.findByTestId('reclaim-countdown');
    expect(button('reclaim-button').disabled).toBe(true);
    expect(screen.queryByTestId('error-message')).toBeNull();
  });

  it('an INTERNAL answer to the ticket request returns to the lobby with the message', async () => {
    const world = new FakeWorld();
    await openLobby(world);
    world.answerNext = answer(500, { error: { code: 'INTERNAL', message: 'boom' } });
    fireEvent.click(screen.getByTestId('bet-submit'));
    await backInLobbyWith('internal error');
    expect(screen.queryByTestId('server-unreachable')).toBeNull();
    expect(world.txs).toEqual([]);
  });
});

describe('board', () => {
  it('AC-W2: visited and current cells show their walls, every other cell is hidden, start and exit are marked', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    const maze = world.mazeOf(gameId);
    const path = solve(maze);
    await walk(planExit(maze).slice(0, 2));

    const seen = path.slice(0, 3);
    for (let cell = 0; cell < 25; cell++) {
      const el = screen.getByTestId(`cell-${cell % 5}-${Math.floor(cell / 5)}`);
      if (seen.includes(cell)) {
        expect(el.getAttribute('data-state')).toBe(cell === seen[2] ? 'current' : 'visited');
        expect(el.getAttribute('data-open')).toBe(String(maze.open[cell]));
      } else {
        expect(el.getAttribute('data-state')).toBe('hidden');
        expect(el.getAttribute('data-open')).toBe('');
        // Drawn as fog, as a cell the player may step into now, or (the exit) as the door's floor.
        expect(el.className).toMatch(cell === 24 ? /\bt-(floor|near)\b/ : /\bt-(fog|near)\b/);
      }
      expect(el.getAttribute('data-start')).toBe(String(cell === 0));
      expect(el.getAttribute('data-exit')).toBe(String(cell === 24));
    }

    // No wall or passage is drawn where only hidden cells meet: the screen gives away no wall of a
    // cell the server has not shown.
    const tiles = [...(document.querySelector('[data-testid="board"] [role="list"]')?.children ?? [])];
    const cols = 11;
    expect(tiles).toHaveLength(cols * cols);
    const known = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < 5 && y < 5 && seen.includes(y * 5 + x);
    tiles.forEach((tile, index) => {
      const tx = index % cols;
      const ty = Math.floor(index / cols);
      if (tx % 2 === 1 && ty % 2 === 1) return;
      const xs = tx % 2 === 1 ? [(tx - 1) / 2] : [tx / 2 - 1, tx / 2];
      const ys = ty % 2 === 1 ? [(ty - 1) / 2] : [ty / 2 - 1, ty / 2];
      const touchesKnown = xs.some((x) => ys.some((y) => known(x, y)));
      if (!touchesKnown) expect(tile.className, `tile ${tx},${ty}`).toMatch(/\bt-fog\b/);
    });
  });

  it('AC-R5: only directions through an open side to an unvisited cell are legal', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    const maze = world.mazeOf(gameId);
    const path = solve(maze);
    await walk(planExit(maze).slice(0, 2));

    const observations = path.slice(0, 3).map((cell, k) => ({ step: k, cell, open: maze.open[cell] }));
    const legal = legalMoves(5, observations);
    expect(legal.length).toBeGreaterThan(0);
    for (const dir of DIRS) {
      // The D-pad stays pressable; legality is on the button, and an illegal press is refused.
      expect(button(`move-${DIR_NAMES[dir]}`).disabled).toBe(false);
      expect(attr(`move-${DIR_NAMES[dir]}`, 'data-legal')).toBe(String(legal.includes(dir)));
    }
  });

  it('moves with the arrow keys and with WASD, and ignores a key that points at a wall', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world, noPoll(world));
    const maze = world.mazeOf(gameId);
    const moves = planExit(maze);

    // The start cell has exactly one opening, so every other direction is a wall or the edge.
    const blocked = DIRS.find((dir) => dir !== moves[0]) as Dir;
    const before = world.requests.length;
    fireEvent.keyDown(window, { code: KEY_CODE[blocked] });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(world.requests.slice(before)).toEqual([]);
    expect(step()).toBe(0);
    expect(screen.getByTestId('screen-msg').textContent).toMatch(/wall|edge/);

    fireEvent.keyDown(window, { code: KEY_CODE[moves[0]] });
    await waitFor(() => expect(step()).toBe(1));
    await waitFor(() => expect(attr(`move-${DIR_NAMES[moves[1]]}`, 'data-legal')).toBe('true'));
    fireEvent.keyDown(window, { code: WASD_CODE[moves[1]] });
    await waitFor(() => expect(step()).toBe(2));
  });

  it('clicking the open neighbouring cell moves there', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    const path = solve(world.mazeOf(gameId));
    const next = screen.getByTestId(`cell-${path[1] % 5}-${Math.floor(path[1] / 5)}`);
    expect(next.getAttribute('data-enter')).not.toBeNull();
    fireEvent.click(next);
    await waitFor(() => expect(step()).toBe(1));
  });
});

describe('recovery', () => {
  it('scenario 08: a move refused as stale re-reads the game and shows what the other tab did', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world, noPoll(world));
    const maze = world.mazeOf(gameId);
    const moves = planExit(maze);
    const path = solve(maze);

    // Another tab of the same browser moves first.
    const token = loadRecord(gameId)?.token as string;
    const other = await world.fetch(`/api/games/${gameId}/move`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ step: 0, dir: moves[0] }),
    });
    expect(other.status).toBe(200);

    fireEvent.click(button(`move-${DIR_NAMES[moves[0]]}`));
    await waitFor(() => expect(step()).toBe(1));
    expect(await screen.findByTestId('error-message')).toBeTruthy();
    expect(attr(`cell-${path[1] % 5}-${Math.floor(path[1] / 5)}`, 'data-state')).toBe('current');
    expect(attr('refundable-amount', 'data-wei')).toBe(refundWei(TABLE, BET, 0, 1).toString());
    // One accepted move only: the server never applied this page's stale request.
    expect(world.games.get(gameId)?.moves).toEqual([moves[0]]);
    expect(calls(world).slice(-2)).toEqual(['POST /api/games/:id/move', 'POST /api/games/:id/move']);
  });

  it('a reloaded page resumes its game from the saved record and the server path', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    await walk(planExit(world.mazeOf(gameId)).slice(0, 2));
    cleanup();

    render(<GameApp deps={world.deps()} />);
    await waitFor(() => expect(attr('board', 'data-game-id')).toBe(gameId));
    expect(step()).toBe(2);
    await waitFor(() =>
      expect(attr('refundable-amount', 'data-wei')).toBe(refundWei(TABLE, BET, 0, 2).toString()),
    );
    // Play continues without a wallet: the session token is in the record.
    await walk(planExit(world.mazeOf(gameId)).slice(2, 3));
    expect(world.games.get(gameId)?.moves).toHaveLength(3);
  });

  it('a pointer to a game that is not on this chain is dropped and the lobby comes back', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    cleanup();

    // A fresh chain and server: neither knows the game.
    const fresh = new FakeWorld();
    render(<GameApp deps={fresh.deps()} />);
    await screen.findByTestId('bet-start', undefined, { timeout: 3000 });
    expect(attr('board', 'data-game-id')).toBe('');
    expect(attr('dock', 'data-mode')).toBe('ready');
    expect(loadRecord(gameId)).not.toBeNull();
  });

  it('a refused ticket returns to the lobby with the reason', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    cleanup();
    window.localStorage.removeItem('maze:active');

    // The same wallet still has that game in progress.
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    await screen.findByTestId('wallet-address');
    fireEvent.click(screen.getByTestId('bet-start'));
    fireEvent.click(await screen.findByTestId('bet-submit'));
    expect((await screen.findByTestId('error-message')).textContent).toContain('already has a game in progress');
    expect(attr('board', 'data-game-id')).toBe('');
    expect(world.txs).toEqual(['createGame']);
    expect(world.games.get(gameId)?.status).toBe('active');
  });
});

describe('wallet', () => {
  it('a payout the contract held back can be withdrawn', async () => {
    const world = new FakeWorld();
    world.pending = 123n * 10n ** 12n;
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('wallet-dev-option'));
    const withdraw = await screen.findByTestId('withdraw-pending');
    expect(withdraw.getAttribute('data-wei')).toBe(world.pending.toString());
    fireEvent.click(withdraw);
    await waitFor(() => expect(screen.queryByTestId('withdraw-pending')).toBeNull());
    expect(world.txs).toEqual(['withdrawPending']);
  });
});
