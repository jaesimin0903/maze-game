'use client';

import { useEffect, useRef } from 'react';
import { exitPayoutWei, refundWei, type TuningTable } from '@maze/shared';
import { formatEth, formatMultiplier, formatPercent } from '../format';

interface Props {
  table: TuningTable;
  tier: number;
  /** The bet the amounts are computed for, or `null` when the entered amount is not usable. */
  betWei: bigint | null;
  /** During a game: the number of moves made so far. */
  currentStep?: number;
}

/**
 * What the player can take back after every step, and what the exit pays (plan AC-W6, §13).
 * One row per entry of the tier's refund table, so the drop at bet time (row 0) and after the
 * first move (row 1) is on screen before any money is committed.
 */
export function RefundSchedule({ table, tier, betWei, currentStep }: Props) {
  const { refundBps, multiplierBps } = table.tiers[tier];
  const exitWei = betWei === null ? null : exitPayoutWei(table, betWei, tier);
  const list = useRef<HTMLOListElement>(null);

  // Keep the current row in view without scrolling the page.
  useEffect(() => {
    const container = list.current;
    if (!container || currentStep === undefined) return;
    const row = container.children[currentStep] as HTMLElement | undefined;
    if (row) container.scrollTop = row.offsetTop - container.clientHeight / 2;
  }, [currentStep]);

  return (
    <section
      className="schedule"
      data-testid="refund-schedule"
      data-tier={tier}
      data-bet-wei={betWei?.toString() ?? ''}
    >
      <h2 className="schedule-title">걸음마다 돌려받을 수 있는 금액</h2>
      <p className="schedule-note">
        베팅하는 순간 환불액은 베팅액의 {formatPercent(refundBps[0])}가 되고, 첫 걸음을 떼면{' '}
        {formatPercent(refundBps[1])}로 내려갑니다. 그 뒤로는 걸을 때마다 조금씩 줄어듭니다.
      </p>
      <ol className="schedule-rows" ref={list}>
        {refundBps.map((bps, k) => {
          const wei = betWei === null ? null : refundWei(table, betWei, tier, k);
          return (
            <li
              key={k}
              className="schedule-row"
              data-testid={`schedule-row-${k}`}
              data-step={k}
              data-bps={bps}
              data-wei={wei?.toString() ?? ''}
              data-current={k === currentStep ? 'true' : undefined}
              data-passed={currentStep !== undefined && k < currentStep ? 'true' : undefined}
            >
              <span className="schedule-step">{k === 0 ? '베팅 직후' : `${k}걸음 뒤`}</span>
              <span className="schedule-bar" aria-hidden="true">
                <i style={{ width: `${bps / 100}%` }} />
              </span>
              <span className="schedule-pct">{formatPercent(bps)}</span>
              <span className="schedule-amt">{wei === null ? '—' : `${formatEth(wei)} ETH`}</span>
            </li>
          );
        })}
      </ol>
      <p
        className="schedule-exit"
        data-testid="schedule-exit-payout"
        data-wei={exitWei?.toString() ?? ''}
        data-multiplier-bps={multiplierBps}
      >
        출구에 도착하면{' '}
        <strong>{exitWei === null ? '—' : `${formatEth(exitWei)} ETH`}</strong> (베팅액의{' '}
        {formatMultiplier(multiplierBps)})
      </p>
    </section>
  );
}
