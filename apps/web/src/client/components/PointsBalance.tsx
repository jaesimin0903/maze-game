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
      className="stat-chip points-balance"
      data-testid="points-balance"
      data-points={total ?? ''}
      title="Points from treasure chests. They have no cash value and cannot be exchanged for money."
    >
      <svg viewBox="0 0 7 7" width="14" height="14" shapeRendering="crispEdges" aria-hidden="true" style={{ fill: 'var(--brand)' }}>
        <path d="M3 0h1v1H3zM2 1h3v1H2zM0 2h7v1H0zM1 3h5v1H1zM2 4h3v1H2zM1 5h2v1H1zM4 5h2v1H4zM0 6h2v1H0zM5 6h2v1H5z" />
      </svg>
      <span className="stat-value">{total === null ? '...' : formatPoints(total)}</span>
      <span className="stat-label">PT</span>
      <span className="sr-only"> points, no cash value</span>
    </span>
  );
}
