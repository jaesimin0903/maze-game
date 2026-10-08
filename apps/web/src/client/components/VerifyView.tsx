'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DIR_BIT,
  ONCHAIN_STATUS,
  Outcome,
  commitmentOf,
  replayMoves,
  startSideOf,
  verifyGame,
  type ConfigResponse,
  type Hex,
  type ReplayResult,
  type RevealReason,
  type VerifyReport,
} from '@maze/shared';
import { ApiError, apiMessage } from '../api';
import { DIRS } from '../board-view';
import type { OnchainGame } from '../chain';
import { assertConfig, tableFromConfig } from '../config';
import { defaultDeps, type ClientDeps } from '../deps';
import { formatEth, formatPercent, formatPoints, shortHex } from '../format';
import { loadRecord, parseRecord, type PlayRecord } from '../record';
import { isHex32 } from '../seed';

interface Props {
  /** Game to load from this browser's records, or `null` to start from an imported record. */
  gameId: string | null;
  deps?: ClientDeps;
}

/**
 * The fairness check as a dialog over the game: Escape, the close button or a click outside
 * closes it, and focus goes back where it was.
 */
export function VerifyModal({ gameId, deps, onClose }: Props & { onClose(): void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    dialog.current?.querySelector<HTMLElement>('[data-testid="verify-close"]')?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  return (
    <div
      className="sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="sheet verify-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="verify-title"
        data-testid="verify-modal"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' && event.code !== 'Escape') return;
          // A record being pasted is not thrown away by Escape; the close button still works.
          const target = event.target as HTMLElement;
          if (target.tagName === 'TEXTAREA' && (target as HTMLTextAreaElement).value !== '') return;
          event.preventDefault();
          onClose();
        }}
      >
        <div className="sheet-head">
          <h2 id="verify-title" className="sheet-title">
            VERIFY
          </h2>
          <button type="button" className="quiet" data-testid="verify-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <VerifyPanel gameId={gameId} deps={deps} />
      </div>
    </div>
  );
}

const WALL_CLASS = ['wall-n', 'wall-e', 'wall-s', 'wall-w'] as const;
const SIDE = ['N', 'E', 'S', 'W'] as const;
const REVEAL_REASON: Record<RevealReason, string> = {
  settled: 'a settled game',
  reclaimed: 'a reclaimed game',
  'ticket-expired': 'a ticket that expired without a game being created on chain',
};

/** Open sides of a wall mask in words, for the comparison table. */
function openText(mask: number): string {
  if (mask < 0) return 'no such cell';
  const sides = DIRS.filter((dir) => (mask & DIR_BIT[dir]) !== 0).map((dir) => SIDE[dir]);
  return sides.length === 0 ? 'all closed' : `open: ${sides.join('·')}`;
}

/** Everything recomputed for one record. */
interface Verdict {
  report: VerifyReport;
  /** The recorded moves replayed over the real maze. */
  walk: ReplayResult;
  /** The bet, from the contract when it can be read, else from the record. */
  betWei: bigint | null;
  /** The commitment the revealed server seed hashes to. */
  expected: Hex;
  n: number;
}

function Check({
  testId,
  ok,
  label,
  children,
}: {
  testId: string;
  /** `null` when the check could not be made. */
  ok: boolean | null;
  label: string;
  children?: ReactNode;
}) {
  return (
    <div className="check" data-testid={testId} data-match={ok === null ? 'unknown' : String(ok)}>
      <span className="check-mark">{ok === null ? 'Cannot check' : ok ? 'Match' : 'Mismatch'}</span>
      <span className="check-label">{label}</span>
      {children !== undefined && <span className="check-detail">{children}</span>}
    </div>
  );
}

/**
 * The verify screen (plan AC-W5, AC-M5). Everything is recomputed in the browser from the
 * revealed server seed, the client seed and the game id: the commitment, the whole maze, the
 * walked path, the solution, and whether each wall the server showed was really there.
 */
/** The checks themselves: the record, the revealed seed, the rebuilt maze and each comparison. */
export function VerifyPanel({ gameId, deps = defaultDeps }: Props) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const symbol = config?.network?.symbol ?? 'ETH';
  const [record, setRecord] = useState<PlayRecord | null>(null);
  const [imported, setImported] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{
    gameId: Hex;
    serverSeed: Hex;
    reason: RevealReason;
  } | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [onchain, setOnchain] = useState<{ gameId: Hex; game: OnchainGame } | null>(null);
  const [chainDown, setChainDown] = useState(false);
  const importBox = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    deps.api
      .config()
      .then((raw) => live && setConfig(assertConfig(raw)))
      .catch((error: unknown) => {
        if (!live) return;
        setConfigError(
          error instanceof ApiError
            ? apiMessage(error)
            : 'Cannot reach the game server, so the payout table could not be loaded',
        );
      });
    return () => {
      live = false;
    };
  }, [deps]);

  useEffect(() => {
    if (isHex32(gameId)) setRecord(loadRecord(gameId));
  }, [gameId]);

  // The seed of a game that ended without a settlement comes from the reveal route; the bet,
  // commitment and client seed the contract recorded come from the chain.
  useEffect(() => {
    if (!config || !record) return;
    let live = true;
    setRevealed(null);
    setRevealError(null);
    setOnchain(null);
    setChainDown(false);
    if (!record.terminal) {
      deps.api
        .reveal(record.gameId)
        .then(
          (r) =>
            live && setRevealed({ gameId: r.gameId, serverSeed: r.serverSeed, reason: r.reason }),
        )
        .catch((error: unknown) => {
          if (!live) return;
          setRevealError(
            error instanceof ApiError
              ? apiMessage(error)
              : 'Cannot reach the game server, so the server seed could not be fetched',
          );
        });
    }
    deps
      .chain(config)
      .game(record.gameId)
      .then((game) => live && setOnchain({ gameId: record.gameId, game }))
      .catch(() => live && setChainDown(true));
    return () => {
      live = false;
    };
  }, [config, record, deps]);

  const importRecord = useCallback((text: string, quiet: boolean): void => {
    let parsed: PlayRecord;
    try {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('The pasted text is not JSON');
      }
      parsed = parseRecord(json);
    } catch (error) {
      if (!quiet) setImportError((error as Error).message);
      return;
    }
    setImportError(null);
    setImported(true);
    setRecord(parsed);
  }, []);

  // Native listeners: a record put into the box by script is picked up like a pasted one.
  useEffect(() => {
    const box = importBox.current;
    if (!box) return;
    const listener = (): void => importRecord(box.value, true);
    box.addEventListener('input', listener);
    box.addEventListener('change', listener);
    return () => {
      box.removeEventListener('input', listener);
      box.removeEventListener('change', listener);
    };
  }, [importRecord]);

  const chainGame =
    record && onchain?.gameId === record.gameId && onchain.game.status !== ONCHAIN_STATUS.None
      ? onchain.game
      : null;
  const serverSeed =
    record?.terminal?.serverSeed ??
    (record && revealed?.gameId === record.gameId ? revealed.serverSeed : null);

  const analysis = useMemo((): Verdict | { error: string } | null => {
    if (!config || !record || serverSeed === null) return null;
    const table = tableFromConfig(config);
    const tier = table.tiers[record.tier];
    if (!tier) return { error: 'The maze size (tier) in the record is not in the current payout table' };
    if (tier.n !== record.n) {
      return { error: `The maze size in the record (${record.n}) differs from the payout table size (${tier.n})` };
    }
    const terminal = record.terminal;
    const betWei = chainGame?.bet ?? (record.betWei !== undefined ? BigInt(record.betWei) : null);
    try {
      const report = verifyGame({
        table,
        commitment: record.commitment,
        serverSeed,
        clientSeed: record.clientSeed,
        gameId: record.gameId,
        tier: record.tier,
        observations: record.observations,
        moves: record.moves,
        // A game that ended without a settlement (reclaimed, or never created) has no outcome
        // or payout to check. The seed, maze and wall checks do not depend on this argument,
        // and the outcome and payout results are not shown for such a game.
        settled: terminal
          ? {
              outcome: terminal.outcome,
              steps: terminal.steps,
              payoutWei: BigInt(terminal.payoutWei),
              betWei: betWei ?? 0n,
            }
          : { outcome: Outcome.CashOut, steps: record.moves.length, payoutWei: 0n, betWei: 0n },
        // What the server said about the chests: the one in the dead end the game ended in, if it
        // did, and every chest it showed during the game (rule 2 shows path chests as found).
        chest:
          terminal?.chestRule !== undefined
            ? {
                rule: terminal.chestRule,
                found:
                  terminal.chest == null
                    ? null
                    : {
                        cell: terminal.chest.cell.y * tier.n + terminal.chest.cell.x,
                        rewardBps: terminal.chest.rewardBps,
                        points: terminal.chest.points,
                      },
                ...(record.chests === undefined
                  ? {}
                  : {
                      awards: record.chests.map((chest) => ({
                        cell: chest.cell.y * tier.n + chest.cell.x,
                        kind: chest.kind,
                        rewardBps: chest.rewardBps,
                        points: chest.points,
                      })),
                    }),
              }
            : undefined,
        // Without the server's claim (a game it did not end), the chests are listed under the
        // rule the server named during play.
        chestRule: record.chestRule,
      });
      const walk = replayMoves(
        report.maze,
        record.moves,
        terminal?.outcome === Outcome.CashOut ? terminal.steps : undefined,
      );
      const expected = commitmentOf({ mazeVersion: table.mazeVersion, n: tier.n, serverSeed });
      return { report, walk, betWei, expected, n: tier.n };
    } catch (error) {
      return { error: `This record cannot be verified: ${(error as Error).message}` };
    }
  }, [config, record, serverSeed, chainGame]);

  const verdict = analysis !== null && !('error' in analysis) ? analysis : null;
  // A seed may pick the side the start opens to (see `deriveFinalSeed`); the rebuilt maze must agree.
  const picked = record !== null ? startSideOf(record.clientSeed) : null;
  const opens = verdict !== null && (verdict.report.maze.open[0] & DIR_BIT[1]) !== 0 ? 'E' : 'S';
  // What the server showed of the start cell during the game, against the seed's pick.
  const startShown = record?.observations[0]?.cell === 0 ? record.observations[0].open : null;
  const shownSide =
    startShown === null ? null : (startShown & DIR_BIT[1]) !== 0 ? 'E' : (startShown & DIR_BIT[2]) !== 0 ? 'S' : null;

  return (
    <div className="verify-main">
      <h3 className="verify-title">Was this round fair?</h3>
      <p className="verify-lede">
        The server committed to a hash of its seed before you bet. This check rebuilds the maze in
        your browser from the revealed seed and compares it with the walls the server showed you
        during the game, one by one.
      </p>

      {configError !== null && (
        <p className="banner banner-down" role="alert" data-testid="server-unreachable">
          {configError}
        </p>
      )}

      {record === null && (
        <p className="verify-empty" data-testid="verify-empty">
          {isHex32(gameId)
            ? 'This browser has no saved play record for this game. Paste a record below to verify it.'
            : 'Paste a play record below to verify it.'}
        </p>
      )}

      {record !== null && (
        <p className="verify-game" data-testid="verify-game" data-game-id={record.gameId}>
          Game <code className="mono">{record.gameId}</code>
          {imported ? ' (pasted record)' : ' (record saved in this browser)'}
        </p>
      )}

      {record !== null && serverSeed === null && (
        <p className="banner banner-fixture" data-testid="verify-unrevealed">
          {revealError ?? 'Loading the server seed…'}
        </p>
      )}

      {analysis !== null && 'error' in analysis && (
        <p className="banner banner-error" role="alert" data-testid="verify-error">
          {analysis.error}
        </p>
      )}

      {record !== null && verdict !== null && (
        <>
          <section className="checks" aria-label="Verification results">
            <Check
              testId="verify-hash-match"
              ok={verdict.report.commitmentOk}
              label="Does the hash of the revealed server seed equal the commit made before the bet?"
            >
              Commit <code className="mono">{record.commitment}</code>
              <br />
              Recomputed <code className="mono">{verdict.expected}</code>
            </Check>
            <Check
              testId="verify-onchain-match"
              ok={
                chainGame === null
                  ? null
                  : chainGame.commitment.toLowerCase() === record.commitment.toLowerCase() &&
                    chainGame.clientSeed.toLowerCase() === record.clientSeed.toLowerCase()
              }
              label="Do the commit and client seed in the record equal the values stored in the contract?"
            >
              {chainGame !== null
                ? `Bet in the contract: ${formatEth(chainGame.bet)} ${symbol}`
                : chainDown
                  ? 'Cannot read the chain, so nothing was compared'
                  : onchain === null
                    ? 'Reading from the chain…'
                    : 'The contract on this chain has no such game'}
            </Check>
            {picked !== null && (
              <Check
                testId="verify-start-side"
                ok={shownSide === null ? null : shownSide === picked && opens === picked}
                label="Did the start the server showed open to the side your seed picked?"
              >
                Your seed picked {SIDE_WORD[picked]}; the server showed the start opening{' '}
                {shownSide === null ? '(not shown)' : SIDE_WORD[shownSide]}; the rebuilt maze opens {SIDE_WORD[opens]}
              </Check>
            )}
            <Check
              testId="verify-cells-match"
              ok={verdict.report.cellsOk}
              label="Do the walls the server showed equal the real maze?"
            >
              {verdict.report.cellsOk === null
                ? 'This record has no cells the server showed, so nothing was compared'
                : `${verdict.report.cells.filter((cell) => cell.match).length} / ${verdict.report.cells.length} cells match`}
            </Check>
            <Check
              testId="verify-outcome-ok"
              ok={record.terminal ? verdict.report.outcomeOk : null}
              label="Does replaying the recorded moves in the real maze give the settled outcome?"
            >
              {record.terminal
                ? verdict.walk.invalidAt !== null
                  ? `Move ${verdict.walk.invalidAt + 1} is not possible in the real maze`
                  : `${record.terminal.steps} steps`
                : `The game ended without a settlement${
                    revealed ? ` (${REVEAL_REASON[revealed.reason]})` : ''
                  }`}
            </Check>
            <Check
              testId="verify-payout-ok"
              ok={record.terminal && verdict.betWei !== null ? verdict.report.payoutOk : null}
              label="Does the settled amount equal the amount set by the payout table?"
            >
              {record.terminal
                ? verdict.betWei === null
                  ? 'The bet amount is unknown, so this could not be checked'
                  : `Bet ${formatEth(verdict.betWei)} ${symbol}, paid ${formatEth(BigInt(record.terminal.payoutWei))} ${symbol}`
                : 'The game ended without a settlement'}
            </Check>
            <Check
              testId="verify-chest-match"
              ok={record.terminal ? verdict.report.chestOk : null}
              label="Does the chest result match the seed? (No chest hidden or invented in the cells you entered)"
            >
              {chestDetail(record, verdict)}
            </Check>
          </section>

          <section className="verify-chests" aria-label="Treasure chest locations">
            <h2>Treasure chest locations</h2>
            <p
              className="verify-chest-list"
              data-testid="verify-chests"
              data-rule={verdict.report.chestRule}
              data-count={verdict.report.chests?.length ?? ''}
              data-cells={verdict.report.chests?.map((chest) => chest.cell).join(',') ?? ''}
              data-path-count={verdict.report.chests?.filter((chest) => chest.kind === 'path').length ?? ''}
              data-dead-end-count={verdict.report.chests?.filter((chest) => chest.kind === 'dead-end').length ?? ''}
            >
              {verdict.report.chests === null
                ? `This verifier does not know chest rule v${verdict.report.chestRule}, so it could not compute the locations.`
                : verdict.report.chests.length === 0
                  ? `Computed from the revealed seed, this maze has no treasure chests (rule v${verdict.report.chestRule}).`
                  : `Treasure chests computed from the revealed seed: ${verdict.report.chests.length} (rule v${verdict.report.chestRule}${
                      verdict.report.chestRule < 2 ? ', dead ends only' : ''
                    }): ${verdict.report.chests
                      .map(
                        (chest) =>
                          `(${chest.cell % verdict.n},${Math.floor(chest.cell / verdict.n)}) ${KIND_TEXT[chest.kind]} ${formatPercent(chest.rewardBps)} of the bet`,
                      )
                      .join(', ')}`}
            </p>
            <p className="verify-chest-note">
              {verdict.report.chestRule < 2
                ? 'A treasure chest opens only when you enter a dead end and the round ends.'
                : 'A path chest opens the moment you enter its cell. A dead-end chest opens when you enter its dead end and the round ends. Whether a cell has a chest depends only on that cell\'s seed hash and its own walls, so finding a chest tells you nothing about cells you have not visited.'}{' '}
              The reward is points, and points have no cash value.
            </p>
          </section>

          <section className="verify-maze" aria-label="Full maze">
            <h2>Full maze and your path</h2>
            <VerifyMaze record={record} verdict={verdict} />
            <ul className="legend">
              <li>
                <i className="legend-walk" /> Cells you walked (numbers show step order)
              </li>
              <li>
                <i className="legend-solution" /> Solution path
              </li>
              <li>
                <i className="legend-mismatch" /> Cells the server showed differently
              </li>
            </ul>
            <p
              className="verify-solution"
              data-testid="verify-solution"
              data-length={Math.max(0, verdict.report.solution.length - 1)}
              data-cells={verdict.report.solution.join(',')}
            >
              Solution path, {Math.max(0, verdict.report.solution.length - 1)} steps:{' '}
              {verdict.report.solution
                .map((cell) => `(${cell % verdict.n},${Math.floor(cell / verdict.n)})`)
                .join(' → ')}
            </p>
          </section>

          <section className="verify-table" aria-label="Cell-by-cell comparison">
            <h2>Cell-by-cell comparison</h2>
            <table>
              <thead>
                <tr>
                  <th scope="col">Step</th>
                  <th scope="col">Cell</th>
                  <th scope="col">Walls the server showed</th>
                  <th scope="col">Real maze</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {record.observations.map((o, index) => {
                  const cell = verdict.report.cells[index];
                  return (
                    <tr
                      key={index}
                      data-testid={`verify-row-${index}`}
                      data-match={cell.match}
                      data-cell={o.cell}
                    >
                      <td>{o.step}</td>
                      <td>
                        ({o.cell % verdict.n},{Math.floor(o.cell / verdict.n)})
                      </td>
                      <td>{openText(cell.observed)}</td>
                      <td>{openText(cell.actual)}</td>
                      <td>{cell.match ? 'Match' : 'Mismatch'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="verify-seeds" aria-label="Seeds">
            <h2>Seeds</h2>
            <dl>
              <dt>Server seed (revealed after the game ends)</dt>
              <dd className="mono" data-testid="verify-server-seed">
                {serverSeed}
              </dd>
              <dt>Client seed (recorded in the bet transaction)</dt>
              <dd className="mono">{record.clientSeed}</dd>
              <dt>Final seed that built the maze</dt>
              <dd className="mono" data-testid="verify-final-seed">
                {verdict.report.finalSeed}
              </dd>
            </dl>
          </section>
        </>
      )}

      <section className="verify-import" aria-label="Import a record">
        <h2>Verify another record</h2>
        <p>
          Paste a play record (JSON). If you change even one character, that cell shows as a
          mismatch.
        </p>
        <textarea
          ref={importBox}
          className="mono"
          data-testid="verify-import"
          aria-label="Play record JSON"
          spellCheck={false}
          rows={6}
        />
        <button
          type="button"
          data-testid="verify-import-submit"
          onClick={() => importRecord(importBox.current?.value ?? '', false)}
        >
          Verify this record
        </button>
        {importError !== null && (
          <p className="banner banner-error" role="alert" data-testid="verify-import-error">
            {importError}
          </p>
        )}
        {record !== null && (
          <details className="verify-export">
            <summary>Record you are viewing (to copy)</summary>
            <textarea
              className="mono"
              data-testid="verify-record"
              aria-label="Current record JSON"
              readOnly
              rows={6}
              value={JSON.stringify(record)}
            />
          </details>
        )}
      </section>

      <p className="verify-foot">
        Game {record ? shortHex(record.gameId) : ''}
        {config ? `, chain ${config.chainId}, maze version ${config.mazeVersion}` : ''}
      </p>
    </div>
  );
}


const KIND_TEXT = { path: 'path chest', 'dead-end': 'dead-end chest' } as const;
const SIDE_WORD = { E: 'east', S: 'south' } as const;

/** The chest check in words: what the server said and what the seed says. */
function chestDetail(record: PlayRecord, verdict: Verdict): string {
  const { report, n } = verdict;
  const at = (cell: number): string => `(${cell % n},${Math.floor(cell / n)})`;
  const terminal = record.terminal;
  if (!terminal) return 'The game ended without a settlement, so the chests were not checked';
  if (report.chests === null) return `This verifier does not know chest rule v${report.chestRule}`;
  const expected = report.expectedChests;
  const seedSays =
    expected.length === 0
      ? 'Computed from the seed, the cells you entered have no treasure chests'
      : `Computed from the seed, the cells you entered have ${expected.length} treasure chest(s): ${expected
          .map(
            (chest) =>
              `${at(chest.cell)} ${KIND_TEXT[chest.kind]} ${formatPercent(chest.rewardBps)} of the bet${
                verdict.betWei !== null ? ` (+${formatPoints(chest.points)} points, no cash value)` : ''
              }`,
          )
          .join(', ')}`;
  if (terminal.chestRule === undefined) {
    return expected.length > 0
      ? `This record has no chest result from the server, so nothing was compared. ${seedSays}`
      : 'The cells you entered have no treasure chests';
  }
  const claimed =
    record.chests ??
    (terminal.chest == null ? [] : [{ ...terminal.chest, kind: 'dead-end' as const, step: terminal.steps }]);
  const serverSays =
    claimed.length > 0
      ? `Treasure chests the server awarded: ${claimed.length}: ${claimed
          .map(
            (chest) =>
              `(${chest.cell.x},${chest.cell.y}) ${KIND_TEXT[chest.kind]} ${formatPercent(chest.rewardBps)} of the bet, +${formatPoints(chest.points)} points (no cash value)`,
          )
          .join(', ')}`
      : terminal.chest === null
        ? 'The server said this dead end has no treasure chest'
        : 'The server awarded no treasure chest in this round';
  return `${serverSays}. ${seedSays}`;
}

/**
 * The whole maze with its real walls. A cell the player was shown carries `verify-cell-<x>-<y>`
 * and `data-match`; cells the player never saw have nothing to compare and carry neither.
 * Chest cells, recomputed from the revealed seed, carry `data-chest`.
 */
function VerifyMaze({ record, verdict }: { record: PlayRecord; verdict: Verdict }) {
  const { report, walk, n } = verdict;
  const stepOf = new Map<number, number>();
  walk.path.forEach((cell, step) => stepOf.set(cell, step));
  const solution = new Set(report.solution);
  const chests = new Map((report.chests ?? []).map((chest) => [chest.cell, chest]));

  const shown = new Map<number, { observed: number; match: boolean }>();
  record.observations.forEach((o, index) => {
    const previous = shown.get(o.cell);
    shown.set(o.cell, {
      observed: previous?.observed ?? o.open,
      match: (previous?.match ?? true) && report.cells[index].match,
    });
  });

  return (
    <div
      className="board vmaze"
      role="img"
      aria-label={`${n}×${n} full maze. Cell details are in the table below`}
      data-testid="verify-maze"
      data-n={n}
      style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}
    >
      {Array.from(report.maze.open, (open, cell) => {
        const seen = shown.get(cell);
        const step = stepOf.get(cell);
        const walls = DIRS.filter((dir) => (open & DIR_BIT[dir]) === 0).map((dir) => WALL_CLASS[dir]);
        const x = cell % n;
        const y = Math.floor(cell / n);
        return (
          <div
            key={cell}
            className={['cell', 'vcell', ...walls].join(' ')}
            data-testid={seen ? `verify-cell-${x}-${y}` : undefined}
            data-match={seen ? String(seen.match) : undefined}
            data-observed-open={seen?.observed}
            data-actual-open={open}
            data-walked={step !== undefined}
            data-solution={solution.has(cell)}
            data-start={cell === 0}
            data-exit={cell === n * n - 1}
            data-chest={chests.has(cell) ? 'true' : undefined}
            data-chest-kind={chests.get(cell)?.kind}
            data-chest-bps={chests.get(cell)?.rewardBps}
          >
            {step !== undefined && <span className="vstep">{step}</span>}
            {cell === 0 && <span className="mark mark-start">Start</span>}
            {cell === n * n - 1 && <span className="mark mark-exit">Exit</span>}
            {chests.has(cell) && <span className="mark mark-chest">Chest</span>}
          </div>
        );
      })}
    </div>
  );
}
