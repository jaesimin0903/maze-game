'use client';

import type { FoundChest } from '@maze/shared';
import { formatPercent, formatPoints } from '../format';

interface Props {
  /** The chests found so far in this game, as the server listed them. */
  chests: FoundChest[];
  /** Moves made so far. */
  step: number;
}

/**
 * During play: the chest the last move found, if it found one, and the points this game has
 * earned so far. Points have no cash value.
 */
export function GameChests({ chests, step }: Props) {
  const total = chests.reduce((sum, chest) => sum + BigInt(chest.points), 0n);
  const fresh = chests.find((chest) => chest.step === step) ?? null;
  return (
    <section className="game-chests" aria-live="polite">
      {fresh !== null && (
        <p
          className="chest-just-found"
          data-testid="chest-just-found"
          data-kind={fresh.kind}
          data-x={fresh.cell.x}
          data-y={fresh.cell.y}
          data-reward-bps={fresh.rewardBps}
          data-points={fresh.points}
        >
          보물상자 발견! +{formatPoints(fresh.points)} 포인트{' '}
          <span className="money-sub">베팅액의 {formatPercent(fresh.rewardBps)}</span>
        </p>
      )}
      <p className="game-points" data-testid="game-points" data-points={total.toString()} data-count={chests.length}>
        <span className="money-label">이번 판 포인트</span> <strong>{formatPoints(total)}</strong>{' '}
        <small className="points-note">현금 가치 없음</small>
      </p>
    </section>
  );
}
