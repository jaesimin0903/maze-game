// Display formatting. Amounts stay `bigint` wei until the moment they are printed.

import { formatEther, parseEther } from 'viem';

/**
 * Wei as an ETH figure with at most `decimals` fraction digits, rounded down so that a
 * displayed payout never exceeds the real one.
 */
export function formatEth(wei: bigint, decimals = 6): string {
  const [whole, fraction = ''] = formatEther(wei).split('.');
  const kept = fraction.slice(0, decimals).replace(/0+$/, '');
  if (kept === '' && whole === '0' && wei > 0n) return `<0.${'0'.repeat(decimals - 1)}1`;
  return kept === '' ? whole : `${whole}.${kept}`;
}

/** An ETH amount typed by the player, or `null` when it is not a plain decimal number. */
export function parseEthInput(text: string): bigint | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(trimmed)) return null;
  return parseEther(trimmed);
}

/** Basis points as a percentage: 9500 -> "95.00%". */
export function formatPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * A payout multiplier in basis points, printed exactly with two to four decimals:
 * 25500 -> "2.55배", 26088 -> "2.6088배". It is never rounded, so the page does not show a
 * multiplier larger than the one the contract pays.
 */
export function formatMultiplier(bps: number): string {
  const fraction = String(bps % 10_000).padStart(4, '0').replace(/0{1,2}$/, '');
  return `${Math.floor(bps / 10_000)}.${fraction}배`;
}

export function shortHex(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 3 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Seconds as `m:ss`. Negative values print as `0:00`. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
