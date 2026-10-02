'use client';

import { refundWei, type GameView, type TuningTable } from '@maze/shared';
import { formatClock, formatEth } from '../format';
import type { Busy } from '../use-game';

interface Props {
  view: GameView;
  table: TuningTable;
  /** Chain seconds; 0 while unknown. */
  now: number;
  busy: Busy | null;
  onCashOut(): void;
}

/** The two figures that matter during play, always on screen, and the way out (plan AC-W3). */
export function StatusBar({ view, table, now, busy, onCashOut }: Props) {
  const refundable = BigInt(view.refundableWei);
  const exit = BigInt(view.exitPayoutWei);
  const bet = BigInt(view.betWei);
  const nextStep = view.step + 1;
  const hasNext = nextStep < (table.tiers[view.tier]?.refundBps.length ?? 0);
  const idleLeft = now === 0 ? null : view.idleDeadlineSec - now;
  const gameLeft = now === 0 ? null : view.gameDeadlineSec - now;

  return (
    <section className="money" aria-label="금액과 캐시아웃">
      <div className="money-box money-now">
        <span className="money-label">지금 그만두면 받는 금액</span>
        <strong
          className="figure"
          data-testid="refundable-amount"
          data-wei={view.refundableWei}
          data-step={view.step}
        >
          {formatEth(refundable)} <small>ETH</small>
        </strong>
        <span className="money-sub">
          {view.step}걸음째
          {hasNext &&
            `, 한 걸음 더 가면 ${formatEth(refundWei(table, bet, view.tier, nextStep))} ETH`}
        </span>
      </div>
      <div className="money-box money-exit">
        <span className="money-label">출구에 도착하면</span>
        <strong className="figure" data-testid="exit-payout" data-wei={view.exitPayoutWei}>
          {formatEth(exit)} <small>ETH</small>
        </strong>
        <span className="money-sub">베팅 {formatEth(bet)} ETH</span>
      </div>
      <button
        type="button"
        className="cashout"
        data-testid="cashout-button"
        disabled={busy !== null}
        onClick={onCashOut}
      >
        {formatEth(refundable)} ETH 받고 그만하기
      </button>
      <dl className="timers">
        <div>
          <dt>움직이지 않으면 자동 캐시아웃</dt>
          <dd
            data-testid="idle-countdown"
            data-remaining-sec={idleLeft ?? ''}
            data-deadline-sec={view.idleDeadlineSec}
            data-urgent={idleLeft !== null && idleLeft <= 15}
          >
            {idleLeft === null ? '—' : formatClock(idleLeft)}
          </dd>
        </div>
        <div>
          <dt>강제 정산까지</dt>
          <dd
            data-testid="game-countdown"
            data-remaining-sec={gameLeft ?? ''}
            data-deadline-sec={view.gameDeadlineSec}
          >
            {gameLeft === null ? '—' : formatClock(gameLeft)}
          </dd>
        </div>
      </dl>
    </section>
  );
}
