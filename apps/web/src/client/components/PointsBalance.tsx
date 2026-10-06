'use client';

import { useEffect, useState } from 'react';
import type { Hex } from '@maze/shared';
import type { ApiClient } from '../api';
import { formatPoints } from '../format';

interface Props {
  api: Pick<ApiClient, 'points'>;
  /** The connected wallet, or `null`. */
  address: Hex | null;
  /** Changes whenever the balance may have changed (a game ended, was settled). */
  refreshKey: string;
}

/**
 * The connected wallet's points from treasure chests, read from `GET /api/points/:address`.
 * Points have no cash value, and the header says so next to the number.
 */
export function PointsBalance({ api, address, refreshKey }: Props) {
  const [points, setPoints] = useState<{ address: Hex; total: string } | null>(null);

  useEffect(() => {
    if (address === null) return;
    let live = true;
    api
      .points(address)
      .then((reply) => {
        if (live) setPoints({ address, total: reply.totalPoints });
      })
      .catch(() => {
        // The balance is a convenience; the next refresh asks again.
      });
    return () => {
      live = false;
    };
  }, [api, address, refreshKey]);

  if (address === null) return null;
  const total = points !== null && points.address === address ? points.total : null;
  return (
    <span
      className="points-balance"
      data-testid="points-balance"
      data-points={total ?? ''}
      title="보물상자에서 얻은 포인트입니다. 현금 가치가 없고 돈으로 바꿀 수 없습니다."
    >
      포인트 {total === null ? '확인 중' : formatPoints(total)}{' '}
      <small className="points-note">현금 가치 없음</small>
    </span>
  );
}
