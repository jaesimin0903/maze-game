// The chain clock (plan §7.7). Ticket expiry, idle and game deadlines, the settle deadline and
// the reveal condition are all measured against it. `Date.now()` is never used for a deadline;
// the wall clock only decides how long a reading may be reused.

import { ApiError } from './errors';

export interface Clock {
  /** Timestamp of the latest block, in seconds. Never goes backwards. */
  chainNow(): Promise<number>;
  /** Feeds a block timestamp the caller has just read, so the next `chainNow()` needs no RPC. */
  observe?(timestampSec: number): void;
}

/**
 * A clock that reads the latest block through `readHead` and reuses a reading for `cacheMs`
 * milliseconds. A failed read is reported as `CHAIN_UNAVAILABLE`.
 */
export function createChainClock(
  readHead: () => Promise<{ timestamp: number }>,
  cacheMs = 500,
): Clock {
  let latest = -1;
  let readAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<number> | null = null;

  function accept(timestampSec: number): number {
    if (timestampSec > latest) latest = timestampSec;
    readAt = performance.now();
    return latest;
  }

  return {
    chainNow() {
      if (latest >= 0 && performance.now() - readAt < cacheMs) return Promise.resolve(latest);
      if (inflight === null) {
        inflight = readHead()
          .then(
            (head) => accept(head.timestamp),
            () => {
              throw new ApiError('CHAIN_UNAVAILABLE');
            },
          )
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
    observe(timestampSec) {
      accept(timestampSec);
    },
  };
}
