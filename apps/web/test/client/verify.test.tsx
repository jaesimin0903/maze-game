import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ONCHAIN_STATUS,
  commitmentOf,
  deriveFinalSeed,
  exitPayoutWei,
  generateMaze,
  markStartSide,
  refundWei,
  solve,
  type Hex,
  type Maze,
} from '@maze/shared';
import { VerifyPanel } from '../../src/client/components/VerifyView';
import { saveRecord, type PlayRecord } from '../../src/client/record';
import { CLIENT_SEED, FakeWorld, PLAYER, SERVER_SEED, TABLE, movesAlong } from './helpers';

configure({ asyncUtilTimeout: 3000 });

const GAME_ID: Hex = `0x${'7e'.repeat(32)}`;
const BET = 10n ** 16n;
const N = 5;

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

function maze(): Maze {
  return generateMaze(
    deriveFinalSeed({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, gameId: GAME_ID }),
    N,
  );
}

/** The record of a game that walked `cells` of the real maze. */
function recordOf(cells: number[], terminal: PlayRecord['terminal']): PlayRecord {
  const real = maze();
  return {
    gameId: GAME_ID,
    tier: 0,
    n: N,
    commitment: commitmentOf({ mazeVersion: TABLE.mazeVersion, n: N, serverSeed: SERVER_SEED }),
    clientSeed: CLIENT_SEED,
    token: 'token',
    observations: cells.map((cell, step) => ({ step, cell, open: real.open[cell] })),
    moves: movesAlong(N, cells),
    terminal,
    betWei: BET.toString(),
  };
}

function exitRecord(): PlayRecord {
  const path = solve(maze());
  return recordOf(path, {
    serverSeed: SERVER_SEED,
    clientSeed: CLIENT_SEED,
    outcome: 0,
    steps: path.length - 1,
    payoutWei: exitPayoutWei(TABLE, BET, 0).toString(),
    signature: '0x00',
    settleTxHash: `0x${'5e'.repeat(32)}`,
  });
}

/** A world whose chain holds the game of `record`. */
function worldWith(record: PlayRecord, status: number = ONCHAIN_STATUS.Settled): FakeWorld {
  const world = new FakeWorld();
  world.onchain.set(record.gameId, {
    player: PLAYER,
    tier: record.tier,
    status,
    createdAt: world.chainNow - 100,
    settleDeadline: world.chainNow + 1700,
    bet: BET,
    maxPayout: exitPayoutWei(TABLE, BET, 0),
    commitment: record.commitment,
    clientSeed: record.clientSeed,
  });
  return world;
}

/** Makes the fake server know the game, as it would after issuing its ticket. */
function issueTicket(world: FakeWorld, record: PlayRecord): void {
  world.games.set(record.gameId, {
    gameId: record.gameId,
    player: PLAYER,
    tier: record.tier,
    n: record.n,
    commitment: record.commitment,
    tokenHash: '0x00',
    expirySec: world.chainNow,
    onChain: null,
    path: [0],
    moves: [],
    lastMoveAt: 0,
    status: 'active',
    auto: false,
    terminal: null,
    chests: [],
  });
}

const match = (testId: string): string | null => screen.getByTestId(testId).getAttribute('data-match');
const cellId = (cell: number): string => `verify-cell-${cell % N}-${Math.floor(cell / N)}`;
const shownCells = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="verify-cell-"]'));

describe('verify screen', () => {
  it('AC-W5 AC-M4: shows the hash match, the whole maze with the walked path, every compared cell and the solution', async () => {
    const record = exitRecord();
    saveRecord(record);
    render(<VerifyPanel gameId={GAME_ID} deps={worldWith(record).deps()} />);

    await screen.findByTestId('verify-hash-match');
    expect(match('verify-hash-match')).toBe('true');
    expect(screen.getByTestId('verify-hash-match').textContent).toContain('Match');
    await waitFor(() => expect(match('verify-onchain-match')).toBe('true'));
    expect(match('verify-cells-match')).toBe('true');
    expect(match('verify-outcome-ok')).toBe('true');
    expect(match('verify-payout-ok')).toBe('true');

    // The whole maze is drawn with its real walls.
    const real = maze();
    const grid = screen.getByTestId('verify-maze');
    expect(grid.children).toHaveLength(N * N);
    Array.from(grid.children).forEach((cell, index) => {
      expect(cell.getAttribute('data-actual-open')).toBe(String(real.open[index]));
    });

    // Every cell the player was shown is compared, and all of them match.
    const path = solve(real);
    expect(shownCells()).toHaveLength(path.length);
    for (const cell of path) {
      expect(match(cellId(cell))).toBe('true');
      expect(screen.getByTestId(cellId(cell)).getAttribute('data-walked')).toBe('true');
    }
    const walked = Array.from(grid.children).filter((c) => c.getAttribute('data-walked') === 'true');
    expect(walked).toHaveLength(path.length);

    const solution = screen.getByTestId('verify-solution');
    expect(solution.getAttribute('data-cells')).toBe(path.join(','));
    expect(solution.getAttribute('data-length')).toBe(String(path.length - 1));
    expect(solution.textContent).toContain(`(${N - 1},${N - 1})`);
    expect(screen.getByTestId('verify-final-seed').textContent).toBe(
      deriveFinalSeed({ serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, gameId: GAME_ID }),
    );
  });

  it('AC-M5 scenario 06: a record with one wall bit changed flags that cell and no other', async () => {
    const record = exitRecord();
    saveRecord(record);
    render(<VerifyPanel gameId={GAME_ID} deps={worldWith(record).deps()} />);
    await screen.findByTestId('verify-hash-match');

    const tampered: PlayRecord = JSON.parse(JSON.stringify(record));
    tampered.observations[3].open ^= 1;
    fireEvent.change(screen.getByTestId('verify-import'), {
      target: { value: JSON.stringify(tampered) },
    });

    const changed = record.observations[3].cell;
    await waitFor(() => expect(match(cellId(changed))).toBe('false'));
    const mismatched = shownCells().filter((c) => c.getAttribute('data-match') === 'false');
    expect(mismatched.map((c) => c.getAttribute('data-testid'))).toEqual([cellId(changed)]);
    expect(shownCells().filter((c) => c.getAttribute('data-match') === 'true')).toHaveLength(
      record.observations.length - 1,
    );
    expect(screen.getByTestId(cellId(changed)).getAttribute('data-observed-open')).toBe(
      String(tampered.observations[3].open),
    );
    expect(match('verify-cells-match')).toBe('false');
    expect(screen.getByTestId('verify-row-3').getAttribute('data-match')).toBe('false');
    // The seeds and the moves were not touched.
    expect(match('verify-hash-match')).toBe('true');
    expect(match('verify-outcome-ok')).toBe('true');
    // The stored record is not replaced by an imported one.
    expect(JSON.parse(window.localStorage.getItem(`maze:record:${GAME_ID}`) as string)).toEqual(
      JSON.parse(JSON.stringify(record)),
    );
  });

  it('AC-M4: a server seed that does not hash to the commitment is reported', async () => {
    const record = exitRecord();
    const forged: PlayRecord = {
      ...record,
      terminal: { ...record.terminal!, serverSeed: `0x${'0f'.repeat(32)}` },
    };
    saveRecord(forged);
    render(<VerifyPanel gameId={GAME_ID} deps={worldWith(record).deps()} />);
    await screen.findByTestId('verify-hash-match');
    expect(match('verify-hash-match')).toBe('false');
    expect(screen.getByTestId('verify-hash-match').textContent).toContain('Mismatch');
  });

  it('checks the settled payout against the table', async () => {
    const path = solve(maze()).slice(0, 4);
    const terminal = {
      serverSeed: SERVER_SEED,
      clientSeed: CLIENT_SEED,
      outcome: 1 as const,
      steps: 3,
      payoutWei: refundWei(TABLE, BET, 0, 3).toString(),
      signature: '0x00' as Hex,
      settleTxHash: null,
    };
    const honest = recordOf(path, terminal);
    saveRecord(honest);
    const { unmount } = render(<VerifyPanel gameId={GAME_ID} deps={worldWith(honest).deps()} />);
    await screen.findByTestId('verify-payout-ok');
    expect(match('verify-outcome-ok')).toBe('true');
    await waitFor(() => expect(match('verify-payout-ok')).toBe('true'));
    unmount();

    const short = recordOf(path, {
      ...terminal,
      payoutWei: (BigInt(terminal.payoutWei) - 1n).toString(),
    });
    saveRecord(short);
    render(<VerifyPanel gameId={GAME_ID} deps={worldWith(short).deps()} />);
    await screen.findByTestId('verify-payout-ok');
    expect(match('verify-payout-ok')).toBe('false');
    expect(match('verify-outcome-ok')).toBe('true');
  });

  it('verifies a reclaimed game with the seed from the reveal route', async () => {
    const record = recordOf(solve(maze()).slice(0, 2), undefined);
    const world = worldWith(record, ONCHAIN_STATUS.Reclaimed);
    issueTicket(world, record);
    saveRecord(record);
    render(<VerifyPanel gameId={GAME_ID} deps={world.deps()} />);

    await screen.findByTestId('verify-hash-match');
    expect(world.requests).toContain('GET /api/games/:id/reveal');
    expect(match('verify-hash-match')).toBe('true');
    expect(shownCells()).toHaveLength(2);
    expect(shownCells().every((c) => c.getAttribute('data-match') === 'true')).toBe(true);
    // There was no settlement to check.
    expect(match('verify-outcome-ok')).toBe('unknown');
    expect(match('verify-payout-ok')).toBe('unknown');
  });

  it('a record without a single observed cell says that nothing was compared, not that the walls match', async () => {
    // Reclaimed before the server showed the first cell: there is no wall to hold against the maze.
    const record = recordOf([], undefined);
    expect(record.observations).toEqual([]);
    const world = worldWith(record, ONCHAIN_STATUS.Reclaimed);
    issueTicket(world, record);
    saveRecord(record);
    render(<VerifyPanel gameId={GAME_ID} deps={world.deps()} />);

    await screen.findByTestId('verify-hash-match');
    expect(match('verify-hash-match')).toBe('true');
    expect(match('verify-cells-match')).toBe('unknown');
    const check = screen.getByTestId('verify-cells-match');
    expect(check.textContent).toContain('Cannot check');
    expect(check.textContent).toContain('nothing was compared');
    expect(check.textContent).not.toContain('0 / 0');
    expect(shownCells()).toEqual([]);

    // The same screen still reports a real comparison for a record that has observations.
    fireEvent.change(screen.getByTestId('verify-import'), {
      target: { value: JSON.stringify(exitRecord()) },
    });
    await waitFor(() => expect(match('verify-cells-match')).toBe('true'));
  });

  it('says that the seed is not public yet for a game still active on chain', async () => {
    const record = recordOf(solve(maze()).slice(0, 2), undefined);
    const world = worldWith(record, ONCHAIN_STATUS.Active);
    issueTicket(world, record);
    saveRecord(record);
    render(<VerifyPanel gameId={GAME_ID} deps={world.deps()} />);
    await waitFor(() =>
      expect(screen.getByTestId('verify-unrevealed').textContent).toContain('cannot be revealed yet'),
    );
    expect(screen.queryByTestId('verify-hash-match')).toBeNull();
    expect(screen.queryByTestId('verify-maze')).toBeNull();
  });

  it('starts empty without a stored record and verifies a pasted one', async () => {
    const record = exitRecord();
    render(<VerifyPanel gameId={null} deps={worldWith(record).deps()} />);
    expect(await screen.findByTestId('verify-empty')).toBeTruthy();

    const box = screen.getByTestId('verify-import') as HTMLTextAreaElement;
    box.value = 'not json';
    fireEvent.click(screen.getByTestId('verify-import-submit'));
    expect((await screen.findByTestId('verify-import-error')).textContent).toContain('JSON');

    // A record with only the §7.6 fields: the bet comes from the chain.
    const bare: Partial<PlayRecord> = { ...record };
    delete bare.betWei;
    box.value = JSON.stringify(bare);
    fireEvent.click(screen.getByTestId('verify-import-submit'));
    await screen.findByTestId('verify-hash-match');
    expect(match('verify-hash-match')).toBe('true');
    await waitFor(() => expect(match('verify-payout-ok')).toBe('true'));
    expect(screen.queryByTestId('verify-import-error')).toBeNull();
    expect(screen.getByTestId('verify-game').getAttribute('data-game-id')).toBe(GAME_ID);
  });

  it('reports a walk the real maze does not allow', async () => {
    const record = exitRecord();
    const bent: PlayRecord = JSON.parse(JSON.stringify(record));
    // Turn the second move into the opposite of the first: back onto the start cell.
    bent.moves[1] = ((bent.moves[0] + 2) % 4) as 0 | 1 | 2 | 3;
    saveRecord(bent);
    render(<VerifyPanel gameId={GAME_ID} deps={worldWith(record).deps()} />);
    await screen.findByTestId('verify-outcome-ok');
    expect(match('verify-outcome-ok')).toBe('false');
    expect(match('verify-hash-match')).toBe('true');
  });
});

describe('verify screen: the start side a seed picks', () => {
  /** The exit record of a game whose client seed picks `side`. */
  function pickedRecord(side: 'E' | 'S'): PlayRecord {
    const clientSeed = markStartSide(CLIENT_SEED, side);
    const real = generateMaze(deriveFinalSeed({ serverSeed: SERVER_SEED, clientSeed, gameId: GAME_ID }), N);
    const path = solve(real);
    return {
      ...recordOf(path, {
        serverSeed: SERVER_SEED,
        clientSeed,
        outcome: 0,
        steps: path.length - 1,
        payoutWei: exitPayoutWei(TABLE, BET, 0).toString(),
        signature: '0x00',
        settleTxHash: `0x${'5e'.repeat(32)}`,
      }),
      clientSeed,
      observations: path.map((cell, step) => ({ step, cell, open: real.open[cell] })),
    };
  }

  it('checks that the start the server showed and the rebuilt maze open to the side the seed picked, and the other checks still pass', async () => {
    for (const side of ['E', 'S'] as const) {
      const record = pickedRecord(side);
      saveRecord(record);
      const { unmount } = render(<VerifyPanel gameId={GAME_ID} deps={worldWith(record).deps()} />);
      await waitFor(() => expect(match('verify-start-side')).toBe('true'));
      const word = side === 'E' ? 'east' : 'south';
      expect(screen.getByTestId('verify-start-side').textContent).toContain(
        `Your seed picked ${word}; the server showed the start opening ${word}; the rebuilt maze opens ${word}`,
      );
      expect(match('verify-hash-match')).toBe('true');
      await waitFor(() => expect(match('verify-onchain-match')).toBe('true'));
      expect(match('verify-cells-match')).toBe('true');
      expect(match('verify-outcome-ok')).toBe('true');
      // The start cell the player was shown opens to that side only.
      expect(record.observations[0].open).toBe(side === 'E' ? 2 : 4);
      unmount();
      window.localStorage.clear();
    }
  });

  it('fails when the server showed the start opening the other way, and cannot check without a shown start', async () => {
    // The server showed a start cell that opens south, for a seed that picked east.
    const honest = pickedRecord('E');
    const tampered: PlayRecord = {
      ...honest,
      observations: honest.observations.map((o, k) => (k === 0 ? { ...o, open: 4 } : o)),
    };
    saveRecord(tampered);
    const { unmount } = render(<VerifyPanel gameId={GAME_ID} deps={worldWith(tampered).deps()} />);
    await waitFor(() => expect(match('verify-start-side')).toBe('false'));
    expect(screen.getByTestId('verify-start-side').textContent).toContain(
      'Your seed picked east; the server showed the start opening south; the rebuilt maze opens east',
    );
    // The flipped start is also a wall the server showed wrongly.
    expect(match('verify-cells-match')).toBe('false');
    expect(match(cellId(0))).toBe('false');
    expect(match('verify-hash-match')).toBe('true');
    unmount();

    // A record without the start observation: the side the server showed is unknown.
    const blind: PlayRecord = { ...honest, observations: [], moves: [] };
    saveRecord(blind);
    render(<VerifyPanel gameId={GAME_ID} deps={worldWith(blind).deps()} />);
    await waitFor(() => expect(match('verify-start-side')).toBe('unknown'));
    expect(screen.getByTestId('verify-start-side').textContent).toContain('the server showed the start opening (not shown)');
  });

  it('has no start-side check for a seed that picks no side', async () => {
    const record = exitRecord();
    saveRecord(record);
    render(<VerifyPanel gameId={GAME_ID} deps={worldWith(record).deps()} />);
    await waitFor(() => expect(match('verify-cells-match')).toBe('true'));
    expect(screen.queryByTestId('verify-start-side')).toBeNull();
  });
});
