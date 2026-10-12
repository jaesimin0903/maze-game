// The bet a player is about to place: the bet slider's marks and its mapping, the balance check,
// and what the page says while the wallet and the chain do their part.

import { parseEther } from 'viem';
import { formatEth } from './format';
import type { BetStep } from './use-game';
import type { WalletKind } from './wallet';

/**
 * The marks between the table's limits on the bet slider, in the chain's coin. On Monad the bet
 * transaction's fee is near 0.018 MON, so much smaller bets lose more to the fee than a win pays.
 */
const MARKS = ['0.01', '0.05'];

/** The slider moves in steps of 0.001 between its marks. */
export const BET_STEP_WEI = 10n ** 15n;

/** A pointer that lets go within this share of the track from a tick puts the bet on the tick. */
export const SNAP = 0.02;

export interface Preset {
  wei: bigint;
  /** Short tick text: ".05", "1". */
  label: string;
}

function tickLabel(wei: bigint): string {
  const text = formatEth(wei);
  return text.startsWith('0.') ? text.slice(1) : text;
}

/**
 * The slider's ticks, evenly spaced along the track: the table's minimum, the marks 0.01 and 0.05
 * that lie strictly between the limits, and the table's maximum (0.001, 0.01, 0.05, 0.1 on the
 * tables in use).
 */
export function betTicks(minWei: bigint, maxWei: bigint): Preset[] {
  const marks = MARKS.map((eth) => parseEther(eth)).filter((wei) => wei > minWei && wei < maxWei);
  const all = minWei === maxWei ? [minWei] : [minWei, ...marks, maxWei];
  return all.map((wei) => ({ wei, label: tickLabel(wei) }));
}

/** Where `wei` sits on the track, from 0 (the first tick) to 1 (the last), straight between ticks. */
export function sliderPosition(ticks: Preset[], wei: bigint): number {
  const n = ticks.length - 1;
  if (n <= 0 || wei <= ticks[0].wei) return 0;
  if (wei >= ticks[n].wei) return 1;
  const i = ticks.findIndex((t, k) => k < n && wei >= t.wei && wei <= ticks[k + 1].wei);
  const span = Number(ticks[i + 1].wei - ticks[i].wei);
  return (i + Number(wei - ticks[i].wei) / span) / n;
}

function clampWei(ticks: Preset[], wei: bigint): bigint {
  const lo = ticks[0].wei;
  const hi = ticks[ticks.length - 1].wei;
  return wei < lo ? lo : wei > hi ? hi : wei;
}

/**
 * The bet at `position` (0..1) on the track: the amount on the straight line between the two ticks
 * around it, in steps of 0.001, kept within the table's limits. With `snap` (a pointer's input) a
 * position within `SNAP` of a tick is the tick; keyboard and assistive-technology input never snaps.
 */
export function sliderValue(ticks: Preset[], position: number, snap = false): bigint {
  const n = ticks.length - 1;
  if (n <= 0) return ticks[0].wei;
  const p = Math.max(0, Math.min(1, position));
  // A hair of slack, so that exactly 2% from a tick still counts despite rounding in `p`.
  const near = snap ? ticks.findIndex((_, k) => Math.abs(p - k / n) <= SNAP + 1e-9) : -1;
  if (near !== -1) return ticks[near].wei;
  const i = Math.min(n - 1, Math.floor(p * n));
  const from = Number(ticks[i].wei / BET_STEP_WEI);
  const to = Number(ticks[i + 1].wei / BET_STEP_WEI);
  const steps = Math.round(from + (to - from) * (p * n - i));
  return clampWei(ticks, BigInt(steps) * BET_STEP_WEI);
}

/**
 * A bet carried over from elsewhere (a finished game, the page's storage) as the slider holds it:
 * rounded down to the 0.001 grid, then kept within the table's limits.
 */
export function normalizeBet(ticks: Preset[], wei: bigint): bigint {
  return clampWei(ticks, (wei / BET_STEP_WEI) * BET_STEP_WEI);
}

/** One 0.001 step up or down from `wei`, kept within the table's limits (the arrow keys). */
export function stepBet(ticks: Preset[], wei: bigint, delta: 1 | -1): bigint {
  return clampWei(ticks, wei + BigInt(delta) * BET_STEP_WEI);
}

/** The tick `wei` sits on, or `null` between ticks. */
export function tickAt(ticks: Preset[], wei: bigint): Preset | null {
  return ticks.find((t) => t.wei === wei) ?? null;
}

/**
 * The tick PageUp, PageDown and a D-pad press move to from `wei`: the next one up or down,
 * staying in range.
 */
export function stepPreset(presets: Preset[], wei: bigint | null, delta: 1 | -1): Preset | null {
  if (presets.length === 0) return null;
  if (wei === null) return presets[0];
  let index = presets.findIndex((p) => p.wei >= wei);
  if (index === -1) index = presets.length;
  // `index` is the first tick at or above the amount; moving down from an amount between two
  // ticks lands on the lower one.
  const exact = presets[index]?.wei === wei;
  const target = delta > 0 ? (exact ? index + 1 : index) : index - 1;
  return presets[Math.max(0, Math.min(presets.length - 1, target))];
}

/** The bet the slider starts on: 0.05, kept within the table's limits. */
export function initialBet(ticks: Preset[]): bigint {
  return clampWei(ticks, parseEther('0.05'));
}

/**
 * The gas the balance check allows the bet transaction (`createGame`). It used 176,475 gas on
 * Anvil, which prices gas as Ethereum does; Monad charges more for cold storage access, so the same
 * call can come near 200,000 there. The exact figure can only be estimated with the ticket, which
 * comes after the signature, so the check counts this round figure. Monad charges the whole limit.
 */
export const BET_GAS = 250_000n;

/**
 * The gas a bet transaction typically uses, for the fee the lobby screen names next to the bet:
 * 173,824 on Monad testnet. The balance check counts `BET_GAS` instead.
 */
export const TYPICAL_BET_GAS = 175_000n;

/**
 * The largest bet the balance pays with the bet transaction's fee reserved (`BET_GAS` at the fee
 * bid per gas), or `null` when the balance does not even cover the fee.
 */
export function maxAffordable(balanceWei: bigint, maxFeePerGasWei: bigint): bigint | null {
  const left = balanceWei - BET_GAS * maxFeePerGasWei;
  return left >= 0n ? left : null;
}

/**
 * What the wallet lacks for `betWei` plus the bet transaction's fee, or `null` when the balance
 * covers both. `maxFeePerGasWei` is what the wallet bids per gas (`ChainApi.maxFeePerGas`): the
 * chain wants gas limit × that bid in the balance before it takes the transaction.
 */
export function betShortfall(balanceWei: bigint, betWei: bigint, maxFeePerGasWei: bigint): bigint | null {
  const need = betWei + BET_GAS * maxFeePerGasWei;
  return balanceWei >= need ? null : need - balanceWei;
}

/** Why the bet cannot be placed yet, or `null` when it can. */
export function betBlocked(p: {
  walletConnected: boolean;
  /** The bet, and the table's limits it must lie within. */
  betWei: bigint;
  minWei: bigint;
  maxWei: bigint;
  seedOk: boolean;
  /** What the wallet lacks for the bet and its fee (`betShortfall`), when known. */
  shortWei?: bigint | null;
  symbol?: string;
}): string | null {
  if (!p.walletConnected) return 'Connect a wallet first';
  const symbol = p.symbol ?? 'ETH';
  if (p.betWei <= 0n) return 'Choose a bet';
  if (p.betWei < p.minWei) return `The minimum bet is ${formatEth(p.minWei)} ${symbol}`;
  if (p.betWei > p.maxWei) return `The maximum bet is ${formatEth(p.maxWei)} ${symbol}`;
  if (!p.seedOk) return 'The client seed must be 0x followed by 64 hex digits';
  if (p.shortWei !== undefined && p.shortWei !== null) {
    return `Not enough ${symbol}: the bet and its network fee need ${formatEth(p.shortWei)} ${symbol} more`;
  }
  return null;
}

/** The steps of placing a bet as the screen shows them: the balance read A starts with, then the bet's. */
export type PlaceStep = 'check' | BetStep;

/**
 * What the page is waiting for at each bet step. A browser wallet asks the player at `sign` and
 * `tx`; the dev wallet and the account wallet of a Privy login sign without asking.
 */
export function stepText(step: PlaceStep, kind: WalletKind | null): string {
  const signer = kind === 'dev' ? 'the dev wallet' : kind === 'privy' ? 'your account wallet' : null;
  switch (step) {
    case 'check':
      return 'Checking your balance before the bet';
    case 'sign':
      return signer === null
        ? 'Wallet 1 of 2: approve the ticket request signature. Signing sends no money'
        : `Signing the ticket request with ${signer}`;
    case 'ticket':
      return 'The server is locking in the maze before your bet';
    case 'tx':
      return signer === null ? 'Wallet 2 of 2: approve the bet transaction' : `Sending the bet transaction from ${signer}`;
    case 'confirm':
      return 'Waiting for the bet transaction to land in a block';
  }
}

/** Short screen tag for each bet step. */
export function stepTag(step: PlaceStep): string {
  return {
    check: 'CHECKING...',
    sign: 'SIGNING...',
    ticket: 'LOCKING MAZE...',
    tx: 'SENDING BET...',
    confirm: 'CONFIRMING...',
  }[step];
}
