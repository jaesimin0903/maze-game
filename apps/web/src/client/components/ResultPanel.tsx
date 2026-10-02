'use client';

import type { Hex } from '@maze/shared';
import { formatEth } from '../format';
import type { Busy, GameResult, ResultOutcome } from '../use-game';

interface Props {
  gameId: Hex;
  /** `null` while the server's final answer is still on its way. */
  result: GameResult | null;
  betWei: bigint | null;
  /** The chain confirms the settlement or the reclaim. */
  confirmed: boolean;
  canSelfSettle: boolean;
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
          서버의 정산이 늦어지고 있습니다. 서버가 서명한 정산을 직접 제출할 수 있습니다.
          <button
            type="button"
            data-testid="settle-self"
            disabled={busy !== null}
            onClick={onSettleSelf}
          >
            정산 직접 제출
          </button>
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
