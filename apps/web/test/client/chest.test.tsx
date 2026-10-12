// AC-P6: what the page shows of treasure chests. A dead end's chest appears on the board and on
// the result screen only once the move into it has ended the game; the points are labelled as
// having no cash value; the header shows the wallet's balance; the verify screen lists every
// chest after the reveal and checks the server's chest against the seed.
// AC-P11 (chest rule 2): a path chest appears on its cell, with the points just earned, the moment
// the move enters it; the game's running total and the header balance follow; the result screen
// lists every chest of the game; the verify screen shows every chest with its kind and checks all
// the chests the player was given; the play record keeps them.

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
  type FoundChest,
  type GameView,
  type Hex,
  type Maze,
} from '@maze/shared';
import { GameApp } from '../../src/client/GameApp';
import { VerifyPanel } from '../../src/client/components/VerifyView';
import { DIR_NAMES } from '../../src/client/board-view';
import { formatPoints } from '../../src/client/format';
import { loadRecord, parseRecord, saveRecord, withView, type PlayRecord } from '../../src/client/record';
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
 * (`withChest`) or holds none, and passes at least one path chest (`pathChest`) or none.
 */
function plan(withChest: boolean, gameId: Hex = firstGameId, pathChest = false): Planned {
  for (let i = 0; i < 2000; i++) {
    const clientSeed = seedOf(`client chest ${withChest} ${pathChest} ${i}`);
    const finalSeed = deriveFinalSeed({ serverSeed: SERVER_SEED, clientSeed, gameId });
    const maze = generateMaze(finalSeed, N);
    let moves: Dir[];
    try {
      moves = planDeadEnd(maze);
    } catch {
      continue;
    }
    if (moves.length < 2) continue;
    const cells = replayMoves(maze, moves).path;
    const end = cells.at(-1)!;
    const passes = cells.slice(1, -1).some((cell) => chestAt(finalSeed, maze, cell) !== null);
    if ((chestAt(finalSeed, maze, end) !== null) === withChest && passes === pathChest) {
      return { clientSeed, maze, finalSeed, moves, end };
    }
  }
  throw new Error('no such client seed among 2000');
}

/** The chests the planned route enters, in order, as the server lists them. */
function routeChests(planned: Planned): FoundChest[] {
  return replayMoves(planned.maze, planned.moves).path.flatMap((cell, step) => {
    const chest = step === 0 ? null : chestAt(planned.finalSeed, planned.maze, cell);
    return chest === null
      ? []
      : [
          {
            cell: { x: cell % N, y: Math.floor(cell / N) },
            kind: chest.kind,
            rewardBps: chest.rewardBps,
            points: chestPoints(BET, chest.rewardBps).toString(),
            step,
          },
        ];
  });
}

const sumOf = (chests: readonly FoundChest[]): string =>
  chests.reduce((sum, chest) => sum + BigInt(chest.points), 0n).toString();

async function openAndBet(world: FakeWorld, clientSeed: Hex): Promise<Hex> {
  render(<GameApp deps={world.deps()} />);
  fireEvent.click(await screen.findByTestId('wallet-dev-option'));
  await screen.findByTestId('wallet-address');
  fireEvent.click(screen.getByTestId('tier-0'));
  fireEvent.click(screen.getByTestId('bet-preset-.01'));
  fireEvent.change(screen.getByTestId('client-seed-input'), { target: { value: clientSeed } });
  fireEvent.click(screen.getByTestId('btn-a'));
  fireEvent.click(await screen.findByTestId('bet-submit'));
  await waitFor(() => expect(attr('cell-0-0', 'data-state')).toBe('current'));
  return attr('board', 'data-game-id') as Hex;
}

async function walk(dirs: Dir[]): Promise<void> {
  for (const dir of dirs) {
    const before = step();
    const id = `move-${DIR_NAMES[dir]}`;
    await waitFor(() => expect(attr(id, 'data-legal')).toBe('true'));
    fireEvent.click(screen.getByTestId(id));
    await waitFor(() => expect(step()).toBe(before + 1));
  }
}

/** Nothing on the page tells of a chest. */
function expectNoChestShown(): void {
  expect(screen.queryByTestId('chest-found')).toBeNull();
  expect(screen.queryByTestId('chest-reveal')).toBeNull();
  expect(document.querySelector('[data-chest]')).toBeNull();
  expect(document.body.textContent?.toLowerCase()).not.toContain('chest');
}

describe('AC-P6: chests on the page', () => {
  it('AC-P6 the move into a chest dead end reveals the chest on the board and the points on the result screen, and the header balance follows', async () => {
    const planned = plan(true, firstGameId, false);
    const chest = chestAt(planned.finalSeed, planned.maze, planned.end)!;
    const points = chestPoints(BET, chest.rewardBps).toString();
    const world = new FakeWorld({ chest: CHEST_CONFIG });

    const gameId = await openAndBet(world, planned.clientSeed);
    expect(gameId).toBe(firstGameId);
    await waitFor(() => expect(attr('points-balance', 'data-points')).toBe('0'));
    expect(screen.getByTestId('points-balance').textContent).toContain('no cash value');

    await walk(planned.moves.slice(0, -1));
    expectNoChestShown();
    await walk(planned.moves.slice(-1));

    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('loss');
    expect(attr('result-payout', 'data-wei')).toBe('0');
    const found = await screen.findByTestId('chest-found');
    expect(found.getAttribute('data-points')).toBe(points);
    expect(found.getAttribute('data-reward-bps')).toBe(String(chest.rewardBps));
    expect(found.textContent).toContain(`Chest found: +${formatPoints(points)} points`);
    expect(found.textContent).toContain('No cash value');
    expect(attr('chest-points', 'data-points')).toBe(points);

    const x = planned.end % N;
    const y = Math.floor(planned.end / N);
    expect(attr('chest-reveal', 'data-x')).toBe(String(x));
    expect(attr('chest-reveal', 'data-y')).toBe(String(y));
    expect(attr(`cell-${x}-${y}`, 'data-chest')).toBe('true');
    expect(document.querySelectorAll('[data-chest]')).toHaveLength(1);

    await waitFor(() => expect(attr('points-balance', 'data-points')).toBe(points));
    // The record keeps the server's word on the chest for the verify screen.
    expect(loadRecord(gameId)?.terminal).toMatchObject({ chestRule: 2, chest: { rewardBps: chest.rewardBps, points } });
  });

  it('AC-P6 an empty dead end says so, shows no chest and adds no points', async () => {
    const planned = plan(false, firstGameId, false);
    const world = new FakeWorld({ chest: CHEST_CONFIG });
    await openAndBet(world, planned.clientSeed);
    await walk(planned.moves);
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('loss');
    expect(await screen.findByTestId('chest-none')).not.toBeNull();
    expect(screen.getByTestId('chest-none').textContent).toContain('This dead end held no chest.');
    expect(screen.queryByTestId('chest-found')).toBeNull();
    expect(screen.queryByTestId('chest-reveal')).toBeNull();
    await waitFor(() => expect(attr('points-balance', 'data-points')).toBe('0'));
  });

  it('AC-P6 a cash-out shows no chest, and a server without chests gets no points request', async () => {
    const planned = plan(true, firstGameId, false);
    const world = new FakeWorld();
    await openAndBet(world, planned.clientSeed);
    expect(screen.queryByTestId('points-balance')).toBeNull();
    expect(screen.queryByTestId('game-points')).toBeNull();
    await walk(planned.moves);
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('loss');
    expectNoChestShown();
    expect(world.requests.some((request) => request.startsWith('GET /api/points/'))).toBe(false);

    cleanup();
    window.localStorage.clear();
    const cashWorld = new FakeWorld({ chest: CHEST_CONFIG });
    await openAndBet(cashWorld, planned.clientSeed);
    await walk(planned.moves.slice(0, 1));
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(screen.getByTestId('cashout-button'));
    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('cashout');
    expectNoChestShown();
  });
});

describe('AC-P11: path chests on the page', () => {
  it('AC-P11 a path chest shows on its cell the moment the move enters it, with the points just earned, the running total and the header balance', async () => {
    const planned = plan(true, firstGameId, true);
    const expected = routeChests(planned);
    expect(expected.filter((chest) => chest.kind === 'path').length).toBeGreaterThan(0);
    const world = new FakeWorld({ chest: CHEST_CONFIG });
    const gameId = await openAndBet(world, planned.clientSeed);
    await waitFor(() => expect(attr('points-balance', 'data-points')).toBe('0'));
    expect(attr('game-points', 'data-points')).toBe('0');

    let total = 0n;
    for (let k = 0; k < planned.moves.length - 1; k++) {
      await walk([planned.moves[k]]);
      const fresh = expected.find((chest) => chest.step === k + 1);
      if (fresh !== undefined) {
        total += BigInt(fresh.points);
        const { x, y } = fresh.cell;
        const just = await screen.findByTestId('chest-just-found');
        expect(just.getAttribute('data-kind')).toBe('path');
        expect(just.getAttribute('data-points')).toBe(fresh.points);
        expect(just.getAttribute('data-reward-bps')).toBe(String(fresh.rewardBps));
        expect([just.getAttribute('data-x'), just.getAttribute('data-y')]).toEqual([String(x), String(y)]);
        expect(just.textContent).toContain(`Treasure chest! +${formatPoints(fresh.points)} PT`);
        expect(just.textContent).toContain('no cash value');
        // On the board: the points over the cell, and the chest mark that stays.
        expect([attr('chest-pop', 'data-x'), attr('chest-pop', 'data-y')]).toEqual([String(x), String(y)]);
        expect(attr('chest-pop', 'data-points')).toBe(fresh.points);
        expect(screen.getByTestId('chest-pop').textContent).toBe(`+${formatPoints(fresh.points)} PT`);
        expect(attr(`chest-cell-${x}-${y}`, 'data-points')).toBe(fresh.points);
        expect(attr(`cell-${x}-${y}`, 'data-chest-kind')).toBe('path');
      } else {
        expect(screen.queryByTestId('chest-just-found')).toBeNull();
        expect(screen.queryByTestId('chest-pop')).toBeNull();
      }
      expect(attr('game-points', 'data-points')).toBe(total.toString());
      await waitFor(() => expect(attr('points-balance', 'data-points')).toBe(total.toString()));
      // Only cells already entered carry a chest mark.
      const marked = [...document.querySelectorAll('[data-testid="board"] [data-chest]')].map((cell) =>
        cell.getAttribute('data-testid'),
      );
      const entered = expected.filter((chest) => chest.step <= k + 1).map((chest) => `cell-${chest.cell.x}-${chest.cell.y}`);
      expect(marked.sort()).toEqual(entered.sort());
    }
    expect(loadRecord(gameId)?.chests).toEqual(expected.filter((chest) => chest.kind === 'path'));
    expect(loadRecord(gameId)?.chestRule).toBe(2);
  });

  it('AC-P11 the result screen lists every chest of the game, path chests and the dead-end chest, with their total', async () => {
    const planned = plan(true, firstGameId, true);
    const expected = routeChests(planned);
    const world = new FakeWorld({ chest: CHEST_CONFIG });
    const gameId = await openAndBet(world, planned.clientSeed);
    await walk(planned.moves);

    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('loss');
    expect(attr('result-payout', 'data-wei')).toBe('0');
    const dead = expected.at(-1)!;
    expect(dead.kind).toBe('dead-end');
    expect(attr('chest-found', 'data-points')).toBe(dead.points);
    const list = screen.getByTestId('game-chests');
    expect(list.getAttribute('data-count')).toBe(String(expected.length));
    expect(list.getAttribute('data-points')).toBe(sumOf(expected));
    expected.forEach((chest, k) => {
      const item = screen.getByTestId(`game-chest-${k}`);
      expect(item.getAttribute('data-kind')).toBe(chest.kind);
      expect([item.getAttribute('data-x'), item.getAttribute('data-y')]).toEqual([String(chest.cell.x), String(chest.cell.y)]);
      expect(item.getAttribute('data-step')).toBe(String(chest.step));
      expect(item.getAttribute('data-points')).toBe(chest.points);
      expect(item.textContent).toContain(chest.kind === 'path' ? 'path chest' : 'dead-end chest');
    });
    expect(attr('game-points-total', 'data-points')).toBe(sumOf(expected));
    expect(screen.getByTestId('game-points-total').textContent).toContain(`Treasure +${formatPoints(sumOf(expected))} PT`);
    // The console screen shows the points under the end banner too.
    expect(attr('end-points', 'data-points')).toBe(sumOf(expected));
    expect(screen.getByTestId('end-points').textContent).toBe(`+${formatPoints(sumOf(expected))} PT`);
    expect(screen.getByTestId('game-points-total').textContent).toContain('no cash value');
    await waitFor(() => expect(attr('points-balance', 'data-points')).toBe(sumOf(expected)));
    // The board keeps every chest: the path chests and the dead end's.
    expect(attr('chest-reveal', 'data-x')).toBe(String(dead.cell.x));
    expect(document.querySelectorAll('[data-testid="board"] [data-chest]')).toHaveLength(expected.length);
    expect(screen.queryByTestId('chest-pop')).toBeNull();
    expect(loadRecord(gameId)?.chests).toEqual(expected);
  });

  it('AC-P11 path chests found before a cash-out stay on the result screen and in the balance', async () => {
    const planned = plan(true, firstGameId, true);
    const first = routeChests(planned).find((chest) => chest.kind === 'path')!;
    const world = new FakeWorld({ chest: CHEST_CONFIG });
    await openAndBet(world, planned.clientSeed);
    await walk(planned.moves.slice(0, first.step));
    expect(attr('chest-just-found', 'data-points')).toBe(first.points);
    fireEvent.click(screen.getByTestId('btn-a'));
    fireEvent.click(screen.getByTestId('cashout-button'));

    expect((await screen.findByTestId('result-outcome')).getAttribute('data-outcome')).toBe('cashout');
    const found = routeChests(planned).filter((chest) => chest.step <= first.step);
    expect(attr('game-chests', 'data-count')).toBe(String(found.length));
    expect(attr('game-chest-0', 'data-kind')).toBe('path');
    expect(screen.queryByTestId('chest-found')).toBeNull();
    expect(screen.queryByTestId('chest-none')).toBeNull();
    await waitFor(() => expect(attr('points-balance', 'data-points')).toBe(sumOf(found)));
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
    render(<VerifyPanel gameId={GAME} deps={worldWith(record).deps()} />);

    await waitFor(() => expect(attr('verify-chest-match', 'data-match')).toBe('true'));
    // A rule 1 record is checked under rule 1: chests in dead ends only.
    const all = chestsOf(planned.finalSeed, planned.maze, 1);
    expect(all.every((entry) => entry.kind === 'dead-end')).toBe(true);
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
    const { unmount } = render(<VerifyPanel gameId={GAME} deps={worldWith(hidden).deps()} />);
    await waitFor(() => expect(attr('verify-chest-match', 'data-match')).toBe('false'));
    expect(screen.getByTestId('verify-chest-match').textContent).toContain('said this dead end has no treasure chest');
    unmount();

    const chest = chestAt(planned.finalSeed, planned.maze, planned.end)!;
    const cheap = lossRecord(planned, GAME, {
      cell: { x: planned.end % N, y: Math.floor(planned.end / N) },
      rewardBps: chest.rewardBps,
      points: '1',
    });
    saveRecord(cheap);
    render(<VerifyPanel gameId={GAME} deps={worldWith(cheap).deps()} />);
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

/** The record a rule 2 dead-end game leaves: every chest the server showed, and its dead-end claim. */
function ruleTwoRecord(planned: Planned, gameId: Hex, chests: FoundChest[]): PlayRecord {
  const dead = chests.find((chest) => chest.kind === 'dead-end') ?? null;
  const record = lossRecord(
    planned,
    gameId,
    dead === null ? null : { cell: dead.cell, rewardBps: dead.rewardBps, points: dead.points },
  );
  return { ...record, terminal: { ...record.terminal!, chestRule: 2 }, chestRule: 2, chests };
}

describe('AC-P11: path chests on the verify screen and in the play record', () => {
  const GAME: Hex = `0x${'7d'.repeat(32)}`;

  it('AC-P11 the verify screen lists every chest with its kind and confirms every chest the player was given', async () => {
    const planned = plan(true, GAME, true);
    const record = ruleTwoRecord(planned, GAME, routeChests(planned));
    saveRecord(record);
    render(<VerifyPanel gameId={GAME} deps={worldWith(record).deps()} />);

    await waitFor(() => expect(attr('verify-chest-match', 'data-match')).toBe('true'));
    const all = chestsOf(planned.finalSeed, planned.maze, 2);
    expect(attr('verify-chests', 'data-rule')).toBe('2');
    expect(attr('verify-chests', 'data-cells')).toBe(all.map((entry) => entry.cell).join(','));
    expect(attr('verify-chests', 'data-path-count')).toBe(String(all.filter((entry) => entry.kind === 'path').length));
    expect(attr('verify-chests', 'data-dead-end-count')).toBe(
      String(all.filter((entry) => entry.kind === 'dead-end').length),
    );
    const marked = [...document.querySelectorAll('[data-testid="verify-maze"] [data-chest="true"]')];
    expect(marked.map((cell) => cell.getAttribute('data-chest-kind'))).toEqual(all.map((entry) => entry.kind));
    expect(screen.getByTestId('verify-chest-match').textContent).toContain('path chest');
    expect(attr('verify-cells-match', 'data-match')).toBe('true');
  });

  it('AC-P11 flags a path chest the server withheld, and one it invented', async () => {
    const planned = plan(true, GAME, true);
    const chests = routeChests(planned);
    const withheld = ruleTwoRecord(
      planned,
      GAME,
      chests.filter((chest) => chest !== chests.find((entry) => entry.kind === 'path')),
    );
    saveRecord(withheld);
    const { unmount } = render(<VerifyPanel gameId={GAME} deps={worldWith(withheld).deps()} />);
    await waitFor(() => expect(attr('verify-chest-match', 'data-match')).toBe('false'));
    unmount();

    // A chest on an entered cell where the seed puts none.
    const cells = replayMoves(planned.maze, planned.moves).path;
    const empty = cells.slice(1, -1).find((cell) => chestAt(planned.finalSeed, planned.maze, cell) === null);
    expect(empty).toBeDefined();
    const invented = ruleTwoRecord(planned, GAME, [
      ...chests,
      { cell: { x: empty! % N, y: Math.floor(empty! / N) }, kind: 'path', rewardBps: 300, points: '300', step: 1 },
    ]);
    saveRecord(invented);
    render(<VerifyPanel gameId={GAME} deps={worldWith(invented).deps()} />);
    await waitFor(() => expect(attr('verify-chest-match', 'data-match')).toBe('false'));
  });

  it('AC-P11 a play record keeps the chests the server showed, never overwrites one, and refuses a malformed one', () => {
    const planned = plan(true, GAME, true);
    const chests = routeChests(planned);
    const record = ruleTwoRecord(planned, GAME, chests);
    expect(parseRecord(JSON.parse(JSON.stringify(record)))).toMatchObject({ chestRule: 2, chests });

    // A later answer adds new chests and leaves recorded ones as they were.
    const first = { ...record, chests: chests.slice(0, 1) };
    const view = {
      gameId: GAME,
      step: record.moves.length,
      cell: { x: planned.end % N, y: Math.floor(planned.end / N) },
      open: planned.maze.open[planned.end],
      chestRule: 2,
      chests: [{ ...chests[0], points: '999999' }, ...chests.slice(1)],
    } as unknown as GameView;
    expect(withView(first, view).chests).toEqual(chests);

    const bad = JSON.parse(JSON.stringify(record)) as { chests: { kind: string }[] };
    bad.chests[0].kind = 'secret';
    expect(() => parseRecord(bad)).toThrow('chests[0]');
    const badRule = { ...JSON.parse(JSON.stringify(record)), chestRule: 0 };
    expect(() => parseRecord(badRule)).toThrow('chestRule');
  });
});
