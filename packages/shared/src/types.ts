// Frozen in Phase 0 (plan §7.1). Change only through the §8.1 modification procedure.

export type Hex = `0x${string}`;

/** Direction index: 0 = N, 1 = E, 2 = S, 3 = W. */
export type Dir = 0 | 1 | 2 | 3;

/** Bit of each direction in an open-direction mask, indexed by `Dir`: N = 1, E = 2, S = 4, W = 8. */
export const DIR_BIT = [1, 2, 4, 8] as const;

/** `open[y * w + x]` is the open-direction bitmask of that cell. Games use `w = h = n`. */
export interface Maze {
  w: number;
  h: number;
  open: Uint8Array;
}

/** Same numbering as the contract's `outcome` argument. */
export const enum Outcome {
  Exit = 0,
  CashOut = 1,
  Loss = 2,
}

export const MAZE_VERSION = 1;

/** Refund-curve family. A discriminated union so that families can be added later. */
export type CurveParams = {
  family: 'two-stage-geometric';
  e0Bps: number;
  aBps: number;
  phi: number;
};

export interface TierConfig {
  id: number;
  n: number;
  curve: CurveParams;
  multiplierBps: number;
  /** Length `n * n`, strictly decreasing. `refundBps[k]` applies after `k` moves. */
  refundBps: number[];
}

export interface TuningTable {
  tableVersion: number;
  mazeVersion: number;
  /** Present (and `true`) only on test tables. */
  fixture?: true;
  calibration: {
    calibrated: boolean;
    ceilingBps: number;
    gate1Bps: number;
    gate2Bps: number;
    certifyKey: string | null;
    simCodeHash: string | null;
    streams: { A: string; B: string; C: string; D: string } | null;
  };
  tiers: TierConfig[];
  /** Decimal wei strings. */
  limits: { minBetWei: string; maxBetWei: string };
  /** Chain seconds. */
  timing: {
    ticketExpirySec: number;
    idleTimeoutSec: number;
    maxGameSec: number;
    settleWindowSec: number;
  };
}
