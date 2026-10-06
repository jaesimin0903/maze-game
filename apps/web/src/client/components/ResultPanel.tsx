'use client';

import type { FoundChest, Hex } from '@maze/shared';
import { formatEth, formatPercent, formatPoints } from '../format';
import type { Busy, GameResult, ResultOutcome } from '../use-game';

interface Props {
  gameId: Hex;
  /** `null` while the server's final answer is still on its way. */
  result: GameResult | null;
  betWei: bigint | null;
  /** The chain confirms the settlement or the reclaim. */
  confirmed: boolean;
  canSelfSettle: boolean;
  walletConnected: boolean;
  busy: Busy | null;
  onSettleSelf(): void;
  onNewGame(): void;
}

const TITLE: Record<ResultOutcome, string> = {
  exit: '출구에 도착했습니다',
  loss: '막다른 칸입니다',
  cashout: '캐시아웃했습니다',
  'auto-cashout': '자동으로 캐시아웃되었습니다',
  reclaimed: '베팅액을 회수했습니다',
};

const DETAIL: Record<ResultOutcome, string> = {
  exit: '출구 배당을 받습니다.',
  loss: '더 갈 곳이 없는 칸에 들어서서 베팅액을 잃었습니다.',
  cashout: '그만둔 시점의 환불액을 받습니다.',
  'auto-cashout':
    '움직이지 않은 채 제한 시간이 지나, 서버가 그 시점의 환불액으로 정산했습니다.',
  reclaimed: '서버가 기한 안에 정산하지 않아 컨트랙트에서 베팅액 전액을 돌려받았습니다.',
};

/** How the game ended, what it paid, and the transaction that paid it (plan AC-W4). */
export function ResultPanel({
  gameId,
  result,
  betWei,
  confirmed,
  canSelfSettle,
  walletConnected,
  busy,
  onSettleSelf,
  onNewGame,
}: Props) {
  if (!result) {
    return (
      <section className="result" aria-live="polite">
        <p className="result-wait">게임이 끝났습니다. 결과를 불러오는 중입니다.</p>
      </section>
    );
  }

  const net = betWei === null ? null : result.payoutWei - betWei;
  return (
    <section className="result" data-outcome={result.outcome} aria-live="polite">
      <h2 className="result-title" data-testid="result-outcome" data-outcome={result.outcome}>
        {TITLE[result.outcome]}
      </h2>
      <p className="result-detail">{DETAIL[result.outcome]}</p>
      {result.chest !== undefined && result.chest !== null && (
        <div
          className="result-chest"
          data-testid="chest-found"
          data-points={result.chest.points}
          data-reward-bps={result.chest.rewardBps}
          data-x={result.chest.cell.x}
          data-y={result.chest.cell.y}
        >
          <p className="result-chest-title">
            보물상자 발견: +{formatPoints(result.chest.points)} 포인트
          </p>
          <p className="result-chest-figure">
            <strong className="figure" data-testid="chest-points" data-points={result.chest.points}>
              +{formatPoints(result.chest.points)} 포인트
            </strong>
            <span className="money-sub">베팅액의 {formatPercent(result.chest.rewardBps)}</span>
          </p>
          <p className="result-chest-note" data-testid="chest-no-cash-value">
            현금 가치 없음. 포인트는 이 지갑 주소에 쌓이며 돈으로 바꾸거나 출금할 수 없습니다. 받는
            금액은 위 막다른 칸 규칙 그대로입니다.
          </p>
        </div>
      )}
      {result.chest === null && (
        <p className="result-chest-none" data-testid="chest-none">
          이 막다른 칸에는 보물상자가 없었습니다.
        </p>
      )}
      {result.chests !== undefined && result.chests.length > 0 && (
        <GameChestList chests={result.chests} />
      )}
      <p className="result-pay">
        <span className="money-label">받는 금액</span>
        <strong
          className="figure"
          data-testid="result-payout"
          data-wei={result.payoutWei.toString()}
        >
          {formatEth(result.payoutWei)} <small>ETH</small>
        </strong>
        {net !== null && (
          <span className="money-sub" data-testid="result-net" data-wei={net.toString()}>
            베팅 {formatEth(betWei!)} ETH 대비 {net >= 0n ? '+' : '−'}
            {formatEth(net >= 0n ? net : -net)} ETH
          </span>
        )}
      </p>
      <p className="result-tx">
        <span className="money-label">
          {result.outcome === 'reclaimed' ? '회수 트랜잭션' : '정산 트랜잭션'}
        </span>
        <code
          className="mono"
          data-testid="settle-tx"
          data-tx={result.txHash ?? ''}
          data-confirmed={confirmed}
        >
          {result.txHash ??
            (confirmed ? '체인에서 정산이 확인되었습니다' : '서버가 정산 트랜잭션을 보내는 중입니다')}
        </code>
      </p>
      {canSelfSettle && (
        <p className="result-self">
          서버의 정산이 체인에서 아직 확인되지 않았습니다. 서버가 서명한 정산을 직접 제출할 수
          있습니다.
          <button
            type="button"
            data-testid="settle-self"
            disabled={busy !== null || !walletConnected}
            onClick={onSettleSelf}
          >
            정산 직접 제출
          </button>
          {!walletConnected && <span>정산 트랜잭션을 보내려면 지갑을 연결하세요.</span>}
        </p>
      )}
      <div className="result-actions">
        <a className="button-link" data-testid="verify-link" href={`/verify/${gameId}`}>
          이 판이 공정했는지 검증하기
        </a>
        <button type="button" className="primary" data-testid="new-game" onClick={onNewGame}>
          새 게임
        </button>
      </div>
    </section>
  );
}

const KIND_TEXT = { path: '길 상자', 'dead-end': '막다른 칸 상자' } as const;

/** The chests found in this game, in the order found, and their points in all. */
function GameChestList({ chests }: { chests: FoundChest[] }) {
  const total = chests.reduce((sum, chest) => sum + BigInt(chest.points), 0n).toString();
  return (
    <section className="result-chests" data-testid="game-chests" data-count={chests.length} data-points={total}>
      <p className="result-chests-title">이번 판에서 찾은 보물상자 {chests.length}개</p>
      <ol className="result-chest-list">
        {chests.map((chest, k) => (
          <li
            key={`${chest.cell.x}-${chest.cell.y}`}
            data-testid={`game-chest-${k}`}
            data-kind={chest.kind}
            data-x={chest.cell.x}
            data-y={chest.cell.y}
            data-step={chest.step}
            data-reward-bps={chest.rewardBps}
            data-points={chest.points}
          >
            {KIND_TEXT[chest.kind]} ({chest.cell.x},{chest.cell.y}), {chest.step}걸음째: +
            {formatPoints(chest.points)} 포인트 (베팅액의 {formatPercent(chest.rewardBps)})
          </li>
        ))}
      </ol>
      <p className="result-chests-total" data-testid="game-points-total" data-points={total}>
        합계 +{formatPoints(total)} 포인트. 현금 가치 없음: 포인트는 돈으로 바꾸거나 출금할 수 없고,
        받는 금액에는 영향이 없습니다.
      </p>
    </section>
  );
}
