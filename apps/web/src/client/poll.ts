'use client';

// Timers (plan §7.3, §7.7). Deadlines are chain seconds, so the only clock the UI counts down
// against is the block timestamp: the one read from the browser's own RPC, advanced by any
// chain time the server reports. Wall-clock timers only decide when to ask again.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChainApi } from './chain';

/** Calls the latest `fn` every `ms` milliseconds while `ms` is not `null`. */
export function useInterval(fn: () => void, ms: number | null): void {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => latest.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export interface ChainClock {
  /** Latest known chain second, or 0 before the first reading. Never goes backwards. */
  now: number;
  /** Feeds a chain second reported by the server. */
  observe(sec: number): void;
  /** The last RPC read failed. */
  rpcDown: boolean;
  /** Number of clock reads so far. Chain-driven work runs once per read, new block or not. */
  ticks: number;
}

/** `startSec` is a chain second already known when the clock starts (0 when none is). */
export function useChainClock(chain: ChainApi | null, ms: number, startSec = 0): ChainClock {
  const [now, setNow] = useState(startSec);
  const [rpcDown, setRpcDown] = useState(false);
  const [ticks, setTicks] = useState(0);

  const observe = useCallback((sec: number) => {
    if (Number.isFinite(sec)) setNow((prev) => (sec > prev ? sec : prev));
  }, []);

  useEffect(() => {
    if (!chain) return;
    let live = true;
    let reading = false;
    const tick = async (): Promise<void> => {
      if (reading) return;
      reading = true;
      try {
        const sec = await chain.now();
        if (live) {
          observe(sec);
          setRpcDown(false);
        }
      } catch {
        if (live) setRpcDown(true);
      } finally {
        reading = false;
        if (live) setTicks((count) => count + 1);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), ms);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [chain, ms, observe]);

  return { now, observe, rpcDown, ticks };
}
