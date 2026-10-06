// AC-P6: what the page shows of treasure chests. The chest appears on the board and on the result
// screen only once the move into its dead end has ended the game; the points are labelled as
// having no cash value; the header shows the wallet's balance; the verify screen lists every
// chest after the reveal and checks the server's chest against the seed.

import { createHash } from 'node:crypto';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ONCHAIN_STATUS,
  chestAt,
  chestPoints,
  chestsOf,
  commitmentOf,
  deriveFinalSeed,
  exitPayoutWei,
  generateMaze,
  replayMoves,
  type ChestFound,
  type Dir,
  type Hex,
  type Maze,
} from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { VerifyView } from '../../src/client/components/VerifyView';
import { DIR_NAMES } from '../../src/client/board-view';
import { formatPoints } from '../../src/client/format';
import { loadRecord, parseRecord, saveRecord, type PlayRecord } from '../../src/client/record';
import { CHEST_CONFIG, FakeWorld, PLAYER, SERVER_SEED, TABLE, firstGameId, planDeadEnd } from './helpers';

configure({ asyncUtilTimeout: 3000 });

const BET = 10n ** 16n;
const N = TABLE.tiers[0].n;

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

const attr = (testId: string, name: string): string | null => screen.getByTestId(testId).getAttribute(name);
const step = (): number => Number(attr('board', 'data-step'));

function seedOf(label: string): Hex {
  return `0x${createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

interface Planned {
  clientSeed: Hex;
  maze: Maze;
  finalSeed: Hex;
  moves: Dir[];
  end: number;
}

/**
 * A client seed for game `gameId` (by default the first game of a `FakeWorld`) whose dead-end
 * route (the one `planDeadEnd` takes, at least two moves) ends in a dead end that holds a chest
 * (`withChest`) or holds none.
 */
function plan(withChest: boolean, gameId: Hex = firstGameId): Planned {
  for (let i = 0; i < 400; i++) {
    const clientSeed = seedOf(`client chest ${withChest} ${i}`);
    const finalSeed = deriveFinalSeed({ serverSeed: SERVER_SEED, clientSeed, gameId });
    const maze = generateMaze(finalSeed, N);
    let moves: Dir[];
    try {
      moves = planDeadEnd(maze);
    } catch {
      continue;
    }
    if (moves.length < 2) continue;
    const end = replayMoves(maze, moves).path.at(-1)!;
    if ((chestAt(finalSeed, maze, end) !== null) === withChest) return { clientSeed, maze, finalSeed, moves, end };
  }
  throw new Error('no such client seed among 400');
}

async function openAndBet(world: FakeWorld, clientSeed: Hex): Promise<Hex> {
  render(<GameApp deps={world.deps()} />);
  fireEvent.click(await screen.findByTestId('wallet-dev-option'));
  await screen.findByTestId('wallet-address');
  fireEvent.click(screen.getByTestId('tier-0'));
  fireEvent.change(screen.getByTestId('bet-amount'), { target: { value: '0.01' } });
  fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: clientSeed } });
  fireEvent.click(screen.getByTestId('bet-submit'));
  await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
  return attr('board', 'data-game-id') as Hex;
}

async function walk(dirs: Dir[]): Promise<void> {
  for (const dir of dirs) {
    const before = step();
    const id = `move-${DIR_NAMES[dir]}`;
    await waitFor(() => expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId(id));
    await waitFor(() => expect(step()).toBe(before + 1));
  }
}

/** Nothing on the page tells of a chest. */
function expectNoChestShown(): void {
  expect(screen.queryByTestId('chest-found')).toBeNull();
  expect(screen.queryByTestId('chest-reveal')).toBeNull();
  expect(document.querySelector('[data-chest]')).toBeNull();
  expect(document.body.textContent).not.toContain('보물상자');
}

describe('AC-P6: chests on the page', () => {
  it('AC-P6 the move into a chest dead end reveals the chest on the board and the points on the result screen, and the header balance follows', async () => {
    const planned = plan(true);
    const chest = chestAt(planned.finalSeed, planned.maze, planned.end)!;
    const points = chestPoints(BET, chest.rewardBps).toString();
    const world = new FakeWorld({ chest: CHEST_CONFIG });

    const gameId = await openAndBet(world, planned.clientSeed);
    expect(gameId).toBe(firstGameId);
    await waitFor(() => expect(attr('points-balance', 'data-points')).toBe('0'));
    expect(screen.getByTestId('points-balance').textContent).toContain('현금 가치 없음');

    await walk(planned.moves.slice(0, -1));
    expectNoChestShown();
    await walk(planned.moves.slice(-1));

    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('loss');
    expect(attr('result-payout', 'data-wei')).toBe('0');
    const found = await screen.findByTestId('chest-found');
    expect(found.getAttribute('data-points')).toBe(points);
    expect(found.getAttribute('data-reward-bps')).toBe(String(chest.rewardBps));
    expect(found.textContent).toContain(`보물상자 발견: +${formatPoints(points)} 포인트`);
    expect(found.textContent).toContain('현금 가치 없음');
    expect(attr('chest-points', 'data-points')).toBe(points);

    const x = planned.end % N;
    const y = Math.floor(planned.end / N);
    expect(attr('chest-reveal', 'data-x')).toBe(String(x));
    expect(attr('chest-reveal', 'data-y')).toBe(String(y));
    expect(attr(`cell-${x}-${y}`, 'data-chest')).toBe('true');
    expect(document.querySelectorAll('[data-chest]')).toHaveLength(1);

    await waitFor(() => expect(attr('points-balance', 'data-points')).toBe(points));
    // The record keeps the server's word on the chest for the verify screen.
    expect(loadRecord(gameId)?.terminal).toMatchObject({ chestRule: 1, chest: { rewardBps: chest.rewardBps, points } });
  });

  it('AC-P6 an empty dead end says so, shows no chest and adds no points', async () => {
    const planned = plan(false);
    const world = new FakeWorld({ chest: CHEST_CONFIG });
    await openAndBet(world, planned.clientSeed);
    await walk(planned.moves);
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('loss');
    expect(await screen.findByTestId('chest-none')).not.toBeNull();
    expect(screen.queryByTestId('chest-found')).toBeNull();
    expect(screen.queryByTestId('chest-reveal')).toBeNull();
    await waitFor(() => expect(attr('points-balance', 'data-points')).toBe('0'));
  });

  it('AC-P6 a cash-out shows no chest, and a server without chests gets no points request', async () => {
    const planned = plan(true);
    const world = new FakeWorld();
    await openAndBet(world, planned.clientSeed);
    expect(screen.queryByTestId('points-balance')).toBeNull();
    await walk(planned.moves);
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('loss');
    expectNoChestShown();
    expect(world.requests.some((request) => request.startsWith('GET /api/points/'))).toBe(false);

    cleanup();
    window.localStorage.clear();
    const cashWorld = new FakeWorld({ chest: CHEST_CONFIG });
    await openAndBet(cashWorld, planned.clientSeed);
    await walk(planned.moves.slice(0, 1));
    fireEvent.click(screen.getByTestId('cashout-button'));
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('cashout');
    expectNoChestShown();
  });
});

// ----- the verify screen -----

/** The record a dead-end game leaves, with the server's chest claim as given. */
function lossRecord(planned: Planned, gameId: Hex, chest: ChestFound | null): PlayRecord {
  const cells = replayMoves(planned.maze, planned.moves).path;
  return {
    gameId,
    tier: 0,
    n: N,
    commitment: commitmentOf({ mazeVersion: TABLE.mazeVersion, n: N, serverSeed: SERVER_SEED }),
    clientSeed: planned.clientSeed,
    token: 'token',
    observations: cells.map((cell, index) => ({ step: index, cell, open: planned.maze.open[cell] })),
    moves: planned.moves,
    terminal: {
      serverSeed: SERVER_SEED,
      clientSeed: planned.clientSeed,
      outcome: 2,
      steps: planned.moves.length,
      payoutWei: '0',
      signature: '0x00',
      settleTxHash: `0x${'5e'.repeat(32)}`,
      chestRule: 1,
      chest,
    },
    betWei: BET.toString(),
  };
}

function worldWith(record: PlayRecord): FakeWorld {
  const world = new FakeWorld({ chest: CHEST_CONFIG });
  world.onchain.set(record.gameId, {
    player: PLAYER,
    tier: 0,
    status: ONCHAIN_STATUS.Settled,
    createdAt: world.chainNow - 100,
    settleDeadline: world.chainNow + 1700,
    bet: BET,
    maxPayout: exitPayoutWei(TABLE, BET, 0),
    commitment: record.commitment,
    clientSeed: record.clientSeed,
  });
  return world;
}

describe('AC-P6: chests on the verify screen', () => {
  const GAME: Hex = `0x${'7c'.repeat(32)}`;

  it('AC-P6 lists every chest of the revealed maze and confirms the awarded one', async () => {
    const planned = plan(true, GAME);
    const chest = chestAt(planned.finalSeed, planned.maze, planned.end)!;
    const record = lossRecord(planned, GAME, {
      cell: { x: planned.end % N, y: Math.floor(planned.end / N) },
      rewardBps: chest.rewardBps,
      points: chestPoints(BET, chest.rewardBps).toString(),
    });
    saveRecord(record);
    render(<VerifyView gameId={GAME} deps={worldWith(record).deps()} />);

    await waitFor(() => expect(attr('verify-chest-match', 'data-match')).toBe('true'));
    const all = chestsOf(planned.finalSeed, planned.maze);
    expect(attr('verify-chests', 'data-cells')).toBe(all.map((entry) => entry.cell).join(','));
    expect(attr('verify-chests', 'data-count')).toBe(String(all.length));
    expect(attr('verify-chests', 'data-rule')).toBe('1');
    const marked = document.querySelectorAll('[data-testid="verify-maze"] [data-chest="true"]');
    expect(marked).toHaveLength(all.length);
    // The other checks are untouched by chests.
    expect(attr('verify-cells-match', 'data-match')).toBe('true');
    expect(attr('verify-outcome-ok', 'data-match')).toBe('true');
  });

  it('AC-P6 flags a chest the server hid from a player who entered a chest cell, and a misvalued one', async () => {
    const planned = plan(true, GAME);
    const hidden = lossRecord(planned, GAME, null);
    saveRecord(hidden);
    const { unmount } = render(<VerifyView gameId={GAME} deps={worldWith(hidden).deps()} />);
    await waitFor(() => expect(attr('verify-chest-match', 'data-match')).toBe('false'));
    expect(screen.getByTestId('verify-chest-match').textContent).toContain('없다고 했습니다');
    unmount();

    const chest = chestAt(planned.finalSeed, planned.maze, planned.end)!;
    const cheap = lossRecord(planned, GAME, {
      cell: { x: planned.end % N, y: Math.floor(planned.end / N) },
      rewardBps: chest.rewardBps,
      points: '1',
    });
    saveRecord(cheap);
    render(<VerifyView gameId={GAME} deps={worldWith(cheap).deps()} />);
    await waitFor(() => expect(attr('verify-chest-match', 'data-match')).toBe('false'));
  });

  it('AC-P6 a play record keeps the chest claim, and a malformed one is refused', () => {
    const planned = plan(true, GAME);
    const record = lossRecord(planned, GAME, { cell: { x: 1, y: 2 }, rewardBps: 1500, points: '1500' });
    expect(parseRecord(JSON.parse(JSON.stringify(record))).terminal).toMatchObject({
      chestRule: 1,
      chest: { cell: { x: 1, y: 2 }, rewardBps: 1500, points: '1500' },
    });
    expect(parseRecord(JSON.parse(JSON.stringify(lossRecord(planned, GAME, null)))).terminal?.chest).toBeNull();
    const bad = JSON.parse(JSON.stringify(record)) as { terminal: { chest: { points: string } } };
    bad.terminal.chest.points = 'lots';
    expect(() => parseRecord(bad)).toThrow('terminal.chest');
  });
});
