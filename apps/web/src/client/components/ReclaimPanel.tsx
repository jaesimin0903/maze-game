'use client';

import { formatClock, formatEth } from '../format';
import type { Busy, ReclaimInfo } from '../use-game';

interface Props {
  info: ReclaimInfo;
  /** Chain seconds. */
  now: number;
  betWei: bigint | null;
  walletConnected: boolean;
  busy: Busy | null;
  onReclaim(): void;
}

/**
 * Direct reclaim (plan §3.7, scenario 05). Once the settle deadline has passed on chain and the
 * game is still unsettled, anyone can make the contract return the bet to the player. The
 * countdown runs on block timestamps.
 */
export function ReclaimPanel({ info, now, betWei, walletConnected, busy, onReclaim }: Props) {
  return (
    <section className="reclaim" data-ready={info.ready}>
      <h2 className="reclaim-title">베팅액 직접 회수</h2>
      <p className="reclaim-text">
        서버가 정산 기한까지 이 게임을 정산하지 않으면, 컨트랙트에서 베팅액
        {betWei === null ? '' : ` ${formatEth(betWei)} ETH`} 전액을 직접 돌려받을 수 있습니다.
      </p>
      <p
        className="reclaim-countdown"
        data-testid="reclaim-countdown"
        data-remaining-sec={info.remainingSec}
        data-deadline-sec={info.deadlineSec}
        data-chain-now-sec={now}
        data-ready={info.ready}
      >
        {info.ready
          ? '정산 기한이 지났습니다. 지금 회수할 수 있습니다.'
          : `회수할 수 있을 때까지 ${formatClock(info.remainingSec)} (블록 시각 기준)`}
      </p>
      <button
        type="button"
        className="primary"
        data-testid="reclaim-button"
        disabled={!info.ready || !walletConnected || busy !== null}
        onClick={onReclaim}
      >
        {busy === 'reclaim' ? '회수 트랜잭션 처리 중' : '베팅액 회수'}
      </button>
      {!walletConnected && <p className="reclaim-text">회수 트랜잭션을 보내려면 지갑을 연결하세요.</p>}
    </section>
  );
}
