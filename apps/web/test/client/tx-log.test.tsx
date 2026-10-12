// The transaction log beside the console and the game's details it opens: the log's entries as a
// game happens (ticket, bet pending then confirmed, start, result, settlement, reclaim) with links
// to the block explorer, and the details dialog for a game in progress, a finished one (the server
// seed, Verify) and, before any bet, the lobby's choice.

import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exitPayoutWei, refundWei, type Dir, type Hex } from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { DIR_NAMES } from '../../src/client/board-view';
import { txEntries } from '../../src/client/components/TxLog';
import type { ClientDeps } from '../../src/client/deps';
import { formatEth } from '../../src/client/format';
import { loadRecord, type PlayRecord } from '../../src/client/record';
import type { WalletApi } from '../../src/client/wallet';
import { CLIENT_SEED, FakeWorld, SERVER_SEED, TABLE, planDeadEnd, planExit } from './helpers';

configure({ asyncUtilTimeout: 3000 });

const BET = 10n ** 16n;
const EXPLORER = 'https://testnet.monadexplorer.com';
const MONAD = { name: 'Monad Testnet', symbol: 'MON', explorerUrl: EXPLORER, faucetUrl: null };

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

const attr = (testId: string, name: string): string | null => screen.getByTestId(testId).getAttribute(name);
const text = (testId: string): string => screen.getByTestId(testId).textContent ?? '';
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));
/** The log's entries in order, as `<key>:<state>`. */
const log = (): string[] =>
  [...document.querySelectorAll('[data-testid="tx-log"] [data-testid^="txlog-"]')].map(
    (el) => `${el.getAttribute('data-testid')?.slice('txlog-'.length)}:${el.getAttribute('data-state')}`,
  );
/** The text of an entry's button: what happened, and its figure. */
const entry = (key: string): string => screen.getByTestId(`txlog-${key}`).querySelector('button')?.textContent ?? '';
const link = (testId: string): string | null => screen.getByTestId(testId).querySelector('a')?.getAttribute('href') ?? null;

function gate(): { held: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const held = new Promise<void>((resolve) => (open = resolve));
  return { held, open: () => open() };
}

/** The page with the dev wallet, its bet transaction and its receipt held until released. */
async function heldBet(world: FakeWorld): Promise<{ tx: ReturnType<typeof gate>; mined: ReturnType<typeof gate> }> {
  const real = world.wallet();
  const tx = gate();
  const mined = gate();
  const wallet: WalletApi = {
    ...real,
    createGame: async (p) => {
      await tx.held;
      return real.createGame(p);
    },
  };
  const deps: ClientDeps = {
    ...world.deps(),
    chain: () => ({
      ...world.chain,
      waitForTx: async () => {
        await mined.held;
        return 'success';
      },
    }),
    connectDev: async () => wallet,
  };
  render(<GameApp deps={deps} />);
  fireEvent.click(await screen.findByTestId('wallet-dev-option'));
  await screen.findByTestId('wallet-address');
  fireEvent.click(screen.getByTestId('tier-0'));
  fireEvent.click(screen.getByTestId('bet-preset-.01'));
  fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: CLIENT_SEED } });
  return { tx, mined };
}

async function startGame(world: FakeWorld): Promise<Hex> {
  render(<GameApp deps={world.deps()} />);
  fireEvent.click(await screen.findByTestId('wallet-dev-option'));
  await screen.findByTestId('wallet-address');
  fireEvent.click(screen.getByTestId('tier-0'));
  fireEvent.click(screen.getByTestId('bet-preset-.01'));
  fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: CLIENT_SEED } });
  fireEvent.click(screen.getByTestId('btn-a'));
  await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
  return attr('board', 'data-game-id') as Hex;
}

async function walk(dirs: Dir[]): Promise<void> {
  for (const dir of dirs) {
    const id = `move-${DIR_NAMES[dir]}`;
    const before = Number(attr('board', 'data-step'));
    await waitFor(() => expect(attr(id, 'data-legal')).toBe('true'));
    fireEvent.click(screen.getByTestId(id));
    await waitFor(() => expect(Number(attr('board', 'data-step'))).toBe(before + 1));
  }
}

const closeDetails = async (): Promise<void> => {
  fireEvent.click(screen.getByTestId('details-close'));
  await waitFor(() => expect(screen.queryByTestId('game-details')).toBeNull());
};
const title = (): string | null | undefined => screen.getByTestId('game-details').querySelector('#details-title')?.textContent;

describe('the transaction log', () => {
  it('sits at the top of the left side, above the recent games, and before a bet holds one entry', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    const panel = await screen.findByTestId('tx-log');
    const aside = panel.closest('aside');
    expect(aside?.classList.contains('col-left')).toBe(true);
    expect(aside?.firstElementChild).toBe(panel);
    expect(panel.compareDocumentPosition(screen.getByTestId('recent-feed')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(log()).toEqual(['none:done']);
    expect(entry('none')).toBe('No bet yet · Rules & odds');
    expect(attr('tx-log', 'data-game-id')).toBe('');
  });

  it('lists the game as it happens: ticket, bet sent then confirmed, start, result, settlement, with explorer links', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    const { tx, mined } = await heldBet(world);
    fireEvent.click(screen.getByTestId('btn-a'));

    // The ticket is signed and the bet transaction is on its way.
    await waitFor(() => expect(log()).toEqual(['ticket:done', 'bet:now']));
    const record = loadRecord([...world.games.keys()][0]) as PlayRecord;
    expect(entry('ticket')).toBe(`Ticket signed · commit ${record.commitment.slice(0, 6)}…${record.commitment.slice(-4)}`);
    expect(entry('bet')).toBe('Sending bet... · 0.01 MON');
    expect(attr('txlog-bet', 'data-tx')).toBe('');

    // Sent: its hash, linked to the explorer, while the chain confirms it.
    tx.open();
    await waitFor(() => expect(entry('bet')).toBe('Bet sent, confirming... · 0.01 MON'));
    const createTx = attr('txlog-bet', 'data-tx') as Hex;
    expect(createTx).toMatch(/^0xc4ea7e/);
    expect(attr('txlog-bet', 'data-state')).toBe('now');
    expect(link('txlog-bet')).toBe(`${EXPLORER}/tx/${createTx}`);
    expect(screen.getByTestId('txlog-bet').querySelector('a')?.textContent).toBe(`${createTx.slice(0, 6)}…${createTx.slice(-4)}`);

    mined.open();
    await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
    await waitFor(() => expect(log()).toEqual(['ticket:done', 'bet:done', 'start:done']));
    const gameId = attr('board', 'data-game-id') as Hex;
    expect(attr('tx-log', 'data-game-id')).toBe(gameId);
    expect(entry('bet')).toBe('Bet confirmed · 0.01 MON');
    expect(attr('txlog-bet', 'data-tx')).toBe(createTx);
    expect(entry('start')).toBe('Game started · 5×5');

    // The result, then the settlement once the chain shows it.
    await walk(planExit(world.mazeOf(gameId)));
    const payout = exitPayoutWei(TABLE, BET, 0);
    await waitFor(() => expect(entry('result')).toBe(`Escaped · +${formatEth(payout, 4)} MON`));
    expect(screen.getByTestId('txlog-result').querySelector('.tone-win')).not.toBeNull();
    // The chain may show the game settled a poll before the page knows which transaction did it.
    await waitFor(() => expect(attr('txlog-settle', 'data-tx')).toMatch(/^0x5e771e/));
    expect(log()).toEqual(['ticket:done', 'bet:done', 'start:done', 'result:done', 'settle:done']);
    const settleTx = attr('txlog-settle', 'data-tx') as Hex;
    expect(entry('settle')).toBe('Settled');
    expect(link('txlog-settle')).toBe(`${EXPLORER}/tx/${settleTx}`);

    // New game: the log starts over.
    await waitFor(() => expect(attr('btn-a', 'data-action')).toBe('new-game'));
    fireEvent.click(screen.getByTestId('new-game'));
    await waitFor(() => expect(log()).toEqual(['none:done']));
  });

  it('says "Settling..." until the chain shows the game settled', async () => {
    const world = new FakeWorld();
    world.autoSettle = false;
    await startGame(world);
    await waitFor(() => expect(attr('console', 'data-mode')).toBe('play'));
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(await screen.findByTestId('cashout-button'));
    await waitFor(() => expect(entry('result')).toBe(`Cashed out · ${formatEth(refundWei(TABLE, BET, 0, 0), 4)} ETH back`));
    expect(attr('txlog-settle', 'data-state')).toBe('now');
    expect(entry('settle')).toBe('Settling...');
    // Without an explorer the hash is shown, not linked.
    world.autoSettle = true;
    await waitFor(() => expect(attr('txlog-settle', 'data-tx')).toMatch(/^0x5e771e/));
    expect(attr('txlog-settle', 'data-state')).toBe('done');
    expect(screen.getByTestId('txlog-settle').querySelector('a')).toBeNull();
    expect(screen.getByTestId('txlog-settle').querySelector('.txlog-tx')?.textContent).toMatch(/^0x5e77…/);
  });

  it('a dead end shows the lost bet', async () => {
    const world = new FakeWorld();
    const gameId = await startGame(world);
    await walk(planDeadEnd(world.mazeOf(gameId)));
    await waitFor(() => expect(entry('result')).toBe(`Died · -${formatEth(BET, 4)} ETH`));
    expect(screen.getByTestId('txlog-result').querySelector('.tone-loss')).not.toBeNull();
  });

  it('names each step while the bet is placed, and a reclaimed bet with its transaction', () => {
    const base = { result: null, settled: false };
    expect(
      txEntries({ ...base, record: null, phase: 'betting', betStep: 'sign' }, 'MON').map((e) => [e.key, e.state, e.label]),
    ).toEqual([['ticket', 'now', 'Signing ticket...']]);
    expect(txEntries({ ...base, record: null, phase: 'betting', betStep: 'ticket' }, 'MON')[0].label).toBe('Getting ticket...');
    const record: PlayRecord = {
      gameId: `0x${'01'.repeat(32)}`,
      tier: 0,
      n: 5,
      commitment: `0x${'02'.repeat(32)}`,
      clientSeed: CLIENT_SEED,
      token: 't',
      observations: [],
      moves: [],
      betWei: BET.toString(),
      createTxHash: `0x${'03'.repeat(32)}`,
      reclaimed: { txHash: `0x${'04'.repeat(32)}`, amountWei: BET.toString() },
    };
    const reclaimed = txEntries(
      {
        record,
        phase: 'ended',
        betStep: null,
        result: { outcome: 'reclaimed', payoutWei: BET, txHash: record.reclaimed?.txHash ?? null },
        settled: true,
      },
      'MON',
    );
    expect(reclaimed.map((e) => e.key)).toEqual(['ticket', 'bet', 'reclaim']);
    expect(reclaimed[2]).toMatchObject({ label: 'Bet reclaimed', detail: '0.01 MON', tx: record.reclaimed?.txHash, state: 'done' });
  });

  it('every entry, the DETAILS key and the panel open the details; an explorer link does not', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    await startGame(world);
    await waitFor(() => expect(log()).toEqual(['ticket:done', 'bet:done', 'start:done']));
    for (const open of [
      () => fireEvent.click(screen.getByTestId('txlog-ticket').querySelector('button') as HTMLButtonElement),
      () => fireEvent.click(screen.getByTestId('txlog-start').querySelector('button') as HTMLButtonElement),
      () => fireEvent.click(screen.getByTestId('tx-log-open')),
      () => fireEvent.click(screen.getByTestId('tx-log')),
    ]) {
      open();
      expect((await screen.findByTestId('game-details')).getAttribute('data-mode')).toBe('live');
      await closeDetails();
    }
    // The entries are buttons: the keyboard reaches them, and Enter on one is its own, not A.
    const button = screen.getByTestId('txlog-bet').querySelector('button') as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' })).toBe(true);
    await settle();
    expect(attr('console', 'data-mode')).toBe('play');

    fireEvent.click(screen.getByTestId('txlog-bet').querySelector('a') as HTMLAnchorElement);
    await settle();
    expect(screen.queryByTestId('game-details')).toBeNull();
  });
});

describe('the game details', () => {
  it('for a game in progress: the ids, seeds, commitment and transactions, the rules and schedule; Verify waits for the end', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    const gameId = await startGame(world);
    const record = loadRecord(gameId) as PlayRecord;
    fireEvent.click(screen.getByTestId('txlog-bet').querySelector('button') as HTMLButtonElement);
    const details = await screen.findByTestId('game-details');
    expect(details.getAttribute('data-mode')).toBe('live');
    expect(details.getAttribute('data-game-id')).toBe(gameId);
    expect(title()).toBe('GAME DETAILS');
    expect(text('details-game-id')).toBe(gameId);
    expect(attr('details-board', 'data-n')).toBe('5');
    expect(attr('details-board', 'data-multiplier-bps')).toBe(String(TABLE.tiers[0].multiplierBps));
    expect(text('details-bet')).toBe('0.01 MON');
    expect(attr('details-exit-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, BET, 0).toString());
    expect(text('details-client-seed')).toBe(CLIENT_SEED);
    expect(screen.queryByTestId('details-start-side')).toBeNull();
    expect(text('details-commitment')).toBe(record.commitment);
    expect(attr('details-commitment', 'data-pending')).toBe('false');
    expect(attr('details-server-seed', 'data-revealed')).toBe('false');
    expect(text('details-server-seed')).toBe('Revealed when the game ends.');
    expect(attr('details-bet-tx', 'data-tx')).toBe(record.createTxHash);
    expect(attr('details-bet-tx', 'data-confirmed')).toBe('true');
    expect(link('details-bet-tx')).toBe(`${EXPLORER}/tx/${record.createTxHash}`);
    expect(attr('details-settle-tx', 'data-state')).toBe('none');
    expect(attr('refund-schedule', 'data-tier')).toBe('0');
    expect(attr('refund-schedule', 'data-bet-wei')).toBe(BET.toString());
    expect(attr('schedule-row-1', 'data-wei')).toBe(refundWei(TABLE, BET, 0, 1).toString());
    expect(text('bet-rules')).toContain(`If you do not move for ${TABLE.timing.idleTimeoutSec}s`);
    expect(text('bet-rules')).toContain(`${TABLE.timing.maxGameSec}s after the start`);
    expect((screen.getByTestId('details-verify') as HTMLButtonElement).disabled).toBe(true);
    expect(text('details-verify-note')).toContain('once the game has ended');
    // No seed of the player's own once the game is on.
    expect(screen.queryByTestId('own-seed')).toBeNull();

    // While it is open, the game's keys do nothing; Escape closes it.
    for (const code of ['ArrowRight', 'ArrowDown', 'Enter', 'Space']) fireEvent.keyDown(window, { code });
    await settle();
    expect(attr('board', 'data-step')).toBe('0');
    expect(attr('console', 'data-mode')).toBe('play');
    expect(world.games.get(gameId)?.moves).toEqual([]);
    fireEvent.keyDown(window, { code: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('game-details')).toBeNull());
    expect(attr('console', 'data-mode')).toBe('play');
  });

  it('for a finished game: the revealed server seed and the settlement; Verify closes it and opens the fairness check', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    const gameId = await startGame(world);
    await walk(planExit(world.mazeOf(gameId)));
    await waitFor(() => expect(attr('txlog-settle', 'data-tx')).toMatch(/^0x5e771e/));
    fireEvent.click(screen.getByTestId('txlog-result').querySelector('button') as HTMLButtonElement);
    await screen.findByTestId('game-details');
    expect(attr('details-server-seed', 'data-revealed')).toBe('true');
    expect(text('details-server-seed')).toBe(SERVER_SEED);
    const settleTx = attr('details-settle-tx', 'data-tx') as Hex;
    expect(settleTx).toMatch(/^0x5e771e/);
    expect(attr('details-settle-tx', 'data-state')).toBe('settled');
    expect(link('details-settle-tx')).toBe(`${EXPLORER}/tx/${settleTx}`);
    expect(screen.queryByTestId('details-verify-note')).toBeNull();
    const verify = screen.getByTestId('details-verify') as HTMLButtonElement;
    expect(verify.disabled).toBe(false);
    expect(verify.textContent).toBe('Verify this game');

    fireEvent.click(verify);
    await screen.findByTestId('verify-modal');
    expect(screen.queryByTestId('game-details')).toBeNull();
    await waitFor(() => expect(attr('verify-game', 'data-game-id')).toBe(gameId));
    fireEvent.click(screen.getByTestId('verify-close'));
    await waitFor(() => expect(screen.queryByTestId('verify-modal')).toBeNull());
    expect(attr('console', 'data-mode')).toBe('ended');
  });

  it('while the bet is placed: the game from its ticket on, its bet transaction sending, then confirming, then confirmed', async () => {
    const world = new FakeWorld({ network: MONAD, chainId: 10143 });
    const { tx, mined } = await heldBet(world);
    fireEvent.click(screen.getByTestId('btn-a'));
    await waitFor(() => expect(log()).toEqual(['ticket:done', 'bet:now']));
    fireEvent.click(screen.getByTestId('tx-log-open'));
    await screen.findByTestId('game-details');
    expect(attr('game-details', 'data-mode')).toBe('live');
    expect(attr('details-bet-tx', 'data-tx')).toBe('');
    expect(text('details-bet-tx')).toBe('Sending...');
    expect((screen.getByTestId('details-verify') as HTMLButtonElement).disabled).toBe(true);
    tx.open();
    await waitFor(() => expect(attr('details-bet-tx', 'data-tx')).toMatch(/^0xc4ea7e/));
    expect(attr('details-bet-tx', 'data-confirmed')).toBe('false');
    expect(text('details-bet-tx')).toContain('confirming');
    mined.open();
    await waitFor(() => expect(attr('details-bet-tx', 'data-confirmed')).toBe('true'));
    await closeDetails();
  });

  it('before a bet: the lobby\'s choice; the game\'s keys do nothing, Escape and a click outside close it', async () => {
    const world = new FakeWorld();
    render(<GameApp deps={world.deps()} />);
    fireEvent.click(await screen.findByTestId('tier-1'));
    fireEvent.click(screen.getByTestId('bet-preset-.01'));
    fireEvent.click(screen.getByTestId('txlog-none').querySelector('button') as HTMLButtonElement);
    const details = await screen.findByTestId('game-details');
    expect(details.getAttribute('data-mode')).toBe('preview');
    expect(title()).toBe('RULES & ODDS');
    expect(attr('details-board', 'data-tier')).toBe('1');
    expect(attr('details-bet', 'data-wei')).toBe(BET.toString());
    expect(attr('refund-schedule', 'data-tier')).toBe('1');
    expect(attr('refund-schedule', 'data-bet-wei')).toBe(BET.toString());
    expect(attr('schedule-exit-payout', 'data-wei')).toBe(exitPayoutWei(TABLE, BET, 1).toString());
    expect(text('details-commitment')).toContain('Appears after the bet');
    expect(screen.queryByTestId('details-server-seed')).toBeNull();
    expect(screen.queryByTestId('details-verify')).toBeNull();

    for (const code of ['ArrowDown', 'ArrowRight', 'Enter', 'KeyZ']) fireEvent.keyDown(window, { code });
    await settle();
    expect(attr('tier-1', 'data-selected')).toBe('true');
    expect(attr('bet-slider', 'data-wei')).toBe(BET.toString());
    expect(screen.queryByTestId('screen-msg')).toBeNull();
    // Escape inside the dialog closes it, and with the focus outside it too.
    fireEvent.keyDown(screen.getByTestId('details-close'), { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('game-details')).toBeNull());
    fireEvent.click(screen.getByTestId('tx-log-open'));
    await screen.findByTestId('game-details');
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { code: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('game-details')).toBeNull());
    // A click outside it closes it too.
    fireEvent.click(screen.getByTestId('tx-log-open'));
    const again = await screen.findByTestId('game-details');
    fireEvent.click(again.parentElement as HTMLElement);
    await waitFor(() => expect(screen.queryByTestId('game-details')).toBeNull());
    expect(world.requests).toEqual(['GET /api/config']);
  });
});
