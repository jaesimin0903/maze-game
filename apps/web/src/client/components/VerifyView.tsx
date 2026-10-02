'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DIR_BIT,
  ONCHAIN_STATUS,
  Outcome,
  commitmentOf,
  replayMoves,
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
import { formatEth, shortHex } from '../format';
import { loadRecord, parseRecord, type PlayRecord } from '../record';
import { isHex32 } from '../seed';
import { TestBeacon } from './TestBeacon';

interface Props {
  /** Game to load from this browser's records, or `null` to start from an imported record. */
  gameId: string | null;
  deps?: ClientDeps;
}

const WALL_CLASS = ['wall-n', 'wall-e', 'wall-s', 'wall-w'] as const;
const SIDE = ['북', '동', '남', '서'] as const;
const REVEAL_REASON: Record<RevealReason, string> = {
  settled: '정산된 게임',
  reclaimed: '회수된 게임',
  'ticket-expired': '체인에 만들어지지 않고 만료된 티켓',
};

/** Open sides of a wall mask in words, for the comparison table. */
function openText(mask: number): string {
  if (mask < 0) return '없는 칸';
  const sides = DIRS.filter((dir) => (mask & DIR_BIT[dir]) !== 0).map((dir) => SIDE[dir]);
  return sides.length === 0 ? '모두 막힘' : `${sides.join('·')} 열림`;
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
      <span className="check-mark">{ok === null ? '확인 불가' : ok ? '일치' : '불일치'}</span>
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
export function VerifyView({ gameId, deps = defaultDeps }: Props) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
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
            : '게임 서버에 연결할 수 없어 배당 표를 불러오지 못했습니다',
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
              : '게임 서버에 연결할 수 없어 서버 시드를 받지 못했습니다',
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
        throw new Error('붙여 넣은 내용이 JSON이 아닙니다');
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
    if (!tier) return { error: '기록의 미로 크기(tier)가 현재 배당 표에 없습니다' };
    if (tier.n !== record.n) {
      return { error: `기록의 미로 크기(${record.n})가 배당 표의 크기(${tier.n})와 다릅니다` };
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
      });
      const walk = replayMoves(
        report.maze,
        record.moves,
        terminal?.outcome === Outcome.CashOut ? terminal.steps : undefined,
      );
      const expected = commitmentOf({ mazeVersion: table.mazeVersion, n: tier.n, serverSeed });
      return { report, walk, betWei, expected, n: tier.n };
    } catch (error) {
      return { error: `검증할 수 없는 기록입니다: ${(error as Error).message}` };
    }
  }, [config, record, serverSeed, chainGame]);

  const verdict = analysis !== null && !('error' in analysis) ? analysis : null;

  return (
    <div className="app verify">
      <header className="masthead">
        <a className="brand" href="/">
          미로 베팅
        </a>
        <span className="chain-info">공정성 검증</span>
      </header>

      <main className="verify-main">
        <h1 className="verify-title">이 판은 공정했는가</h1>
        <p className="verify-lede">
          서버는 베팅 전에 시드의 해시를 확정했습니다. 공개된 시드로 미로를 이 브라우저에서 다시
          만들어, 게임 중에 서버가 보여 준 벽과 하나씩 대조합니다.
        </p>

        {configError !== null && (
          <p className="banner banner-down" role="alert" data-testid="server-unreachable">
            {configError}
          </p>
        )}

        {record === null && (
          <p className="verify-empty" data-testid="verify-empty">
            {isHex32(gameId)
              ? '이 브라우저에 저장된 이 게임의 플레이 기록이 없습니다. 아래에 기록을 붙여 넣으면 검증할 수 있습니다.'
              : '아래에 플레이 기록을 붙여 넣으면 검증할 수 있습니다.'}
          </p>
        )}

        {record !== null && (
          <p className="verify-game" data-testid="verify-game" data-game-id={record.gameId}>
            게임 <code className="mono">{record.gameId}</code>
            {imported ? ' (붙여 넣은 기록)' : ' (이 브라우저에 저장된 기록)'}
          </p>
        )}

        {record !== null && serverSeed === null && (
          <p className="banner banner-fixture" data-testid="verify-unrevealed">
            {revealError ?? '서버 시드를 불러오는 중입니다'}
          </p>
        )}

        {analysis !== null && 'error' in analysis && (
          <p className="banner banner-error" role="alert" data-testid="verify-error">
            {analysis.error}
          </p>
        )}

        {record !== null && verdict !== null && (
          <>
            <section className="checks" aria-label="검증 결과">
              <Check
                testId="verify-hash-match"
                ok={verdict.report.commitmentOk}
                label="공개된 서버 시드의 해시가 베팅 전 커밋과 같은가"
              >
                커밋 <code className="mono">{record.commitment}</code>
                <br />
                다시 계산한 값 <code className="mono">{verdict.expected}</code>
              </Check>
              <Check
                testId="verify-onchain-match"
                ok={
                  chainGame === null
                    ? null
                    : chainGame.commitment.toLowerCase() === record.commitment.toLowerCase() &&
                      chainGame.clientSeed.toLowerCase() === record.clientSeed.toLowerCase()
                }
                label="기록의 커밋과 클라이언트 시드가 컨트랙트에 남은 값과 같은가"
              >
                {chainGame !== null
                  ? `컨트랙트의 베팅액 ${formatEth(chainGame.bet)} ETH`
                  : chainDown
                    ? '체인을 읽을 수 없어 대조하지 못했습니다'
                    : onchain === null
                      ? '체인에서 읽는 중입니다'
                      : '이 체인의 컨트랙트에는 이 게임이 없습니다'}
              </Check>
              <Check
                testId="verify-cells-match"
                ok={verdict.report.cellsOk}
                label="서버가 보여 준 벽이 실제 미로와 같은가"
              >
                {verdict.report.cellsOk === null
                  ? '이 기록에는 서버가 보여 준 칸이 하나도 없어 아무것도 비교하지 않았습니다'
                  : `${verdict.report.cells.filter((cell) => cell.match).length} / ${verdict.report.cells.length}칸 일치`}
              </Check>
              <Check
                testId="verify-outcome-ok"
                ok={record.terminal ? verdict.report.outcomeOk : null}
                label="기록된 이동을 실제 미로에서 다시 걸으면 정산된 결말이 나오는가"
              >
                {record.terminal
                  ? verdict.walk.invalidAt !== null
                    ? `${verdict.walk.invalidAt + 1}번째 이동은 실제 미로에서 할 수 없는 이동입니다`
                    : `${record.terminal.steps}걸음`
                  : `정산 없이 끝난 게임입니다${
                      revealed ? ` (${REVEAL_REASON[revealed.reason]})` : ''
                    }`}
              </Check>
              <Check
                testId="verify-payout-ok"
                ok={record.terminal && verdict.betWei !== null ? verdict.report.payoutOk : null}
                label="정산 금액이 배당 표가 정한 금액과 같은가"
              >
                {record.terminal
                  ? verdict.betWei === null
                    ? '베팅액을 알 수 없어 확인하지 못했습니다'
                    : `베팅 ${formatEth(verdict.betWei)} ETH, 지급 ${formatEth(BigInt(record.terminal.payoutWei))} ETH`
                  : '정산 없이 끝난 게임입니다'}
              </Check>
            </section>

            <section className="verify-maze" aria-label="전체 미로">
              <h2>전체 미로와 걸은 길</h2>
              <VerifyMaze record={record} verdict={verdict} />
              <ul className="legend">
                <li>
                  <i className="legend-walk" /> 걸은 칸 (숫자는 걸음 순서)
                </li>
                <li>
                  <i className="legend-solution" /> 정답 경로
                </li>
                <li>
                  <i className="legend-mismatch" /> 서버가 다르게 보여 준 칸
                </li>
              </ul>
              <p
                className="verify-solution"
                data-testid="verify-solution"
                data-length={Math.max(0, verdict.report.solution.length - 1)}
                data-cells={verdict.report.solution.join(',')}
              >
                정답 경로 {Math.max(0, verdict.report.solution.length - 1)}걸음:{' '}
                {verdict.report.solution
                  .map((cell) => `(${cell % verdict.n},${Math.floor(cell / verdict.n)})`)
                  .join(' → ')}
              </p>
            </section>

            <section className="verify-table" aria-label="칸별 대조">
              <h2>칸별 대조</h2>
              <table>
                <thead>
                  <tr>
                    <th scope="col">걸음</th>
                    <th scope="col">칸</th>
                    <th scope="col">서버가 보여 준 벽</th>
                    <th scope="col">실제 미로</th>
                    <th scope="col">결과</th>
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
                        <td>{cell.match ? '일치' : '불일치'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            <section className="verify-seeds" aria-label="시드">
              <h2>시드</h2>
              <dl>
                <dt>서버 시드 (게임이 끝난 뒤 공개)</dt>
                <dd className="mono" data-testid="verify-server-seed">
                  {serverSeed}
                </dd>
                <dt>클라이언트 시드 (베팅 트랜잭션에 기록)</dt>
                <dd className="mono">{record.clientSeed}</dd>
                <dt>미로를 만든 최종 시드</dt>
                <dd className="mono" data-testid="verify-final-seed">
                  {verdict.report.finalSeed}
                </dd>
              </dl>
            </section>
          </>
        )}

        <section className="verify-import" aria-label="기록 가져오기">
          <h2>다른 기록 검증하기</h2>
          <p>
            플레이 기록(JSON)을 붙여 넣으세요. 기록을 한 글자라도 고치면 그 칸이 불일치로
            표시됩니다.
          </p>
          <textarea
            ref={importBox}
            className="mono"
            data-testid="verify-import"
            aria-label="플레이 기록 JSON"
            spellCheck={false}
            rows={6}
          />
          <button
            type="button"
            data-testid="verify-import-submit"
            onClick={() => importRecord(importBox.current?.value ?? '', false)}
          >
            이 기록 검증하기
          </button>
          {importError !== null && (
            <p className="banner banner-error" role="alert" data-testid="verify-import-error">
              {importError}
            </p>
          )}
          {record !== null && (
            <details className="verify-export">
              <summary>지금 보고 있는 기록 (복사용)</summary>
              <textarea
                className="mono"
                data-testid="verify-record"
                aria-label="현재 기록 JSON"
                readOnly
                rows={6}
                value={JSON.stringify(record)}
              />
            </details>
          )}
        </section>

        <p className="verify-foot">
          게임 {record ? shortHex(record.gameId) : ''}
          {config ? `, 체인 ${config.chainId}, 미로 버전 ${config.mazeVersion}` : ''}
        </p>
      </main>

      {config?.testHooks === true && <TestBeacon api={deps.api} chainNowSec={config.chainNowSec} />}
    </div>
  );
}


/**
 * The whole maze with its real walls. A cell the player was shown carries `verify-cell-<x>-<y>`
 * and `data-match`; cells the player never saw have nothing to compare and carry neither.
 */
function VerifyMaze({ record, verdict }: { record: PlayRecord; verdict: Verdict }) {
  const { report, walk, n } = verdict;
  const stepOf = new Map<number, number>();
  walk.path.forEach((cell, step) => stepOf.set(cell, step));
  const solution = new Set(report.solution);

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
      aria-label={`${n}×${n} 전체 미로. 칸별 내용은 아래 표에 있습니다`}
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
          >
            {step !== undefined && <span className="vstep">{step}</span>}
            {cell === 0 && <span className="mark mark-start">출발</span>}
            {cell === n * n - 1 && <span className="mark mark-exit">출구</span>}
          </div>
        );
      })}
    </div>
  );
}
