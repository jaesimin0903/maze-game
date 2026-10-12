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

/** Wei with exactly `decimals` fraction digits, rounded down: (5e16, 4) -> "0.0500". */
export function formatEthFixed(wei: bigint, decimals: number): string {
  const text = formatEth(wei, decimals);
  if (text.startsWith('<')) return text;
  const [whole, fraction = ''] = text.split('.');
  return `${whole}.${fraction.padEnd(decimals, '0')}`;
}

/**
 * Wei with two significant digits, for a figure the page marks as approximate (~):
 * 17_850_000_000_000_000n -> "0.018", 175_000_000_000_000n -> "0.00018".
 */
export function formatApprox(wei: bigint): string {
  return new Intl.NumberFormat('en-US', { maximumSignificantDigits: 2, useGrouping: false }).format(
    Number(formatEther(wei)),
  );
}

/** An ETH amount typed by the player, or `null` when it is not a plain decimal number. */
export function parseEthInput(text: string): bigint | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(trimmed)) return null;
  return parseEther(trimmed);
}

/** A decimal count of points with thousands separators: "1234567" -> "1,234,567". */
export function formatPoints(points: bigint | string): string {
  return String(points).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Basis points as a percentage: 9500 -> "95.00%". */
export function formatPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * A payout multiplier in basis points, printed exactly with two to four decimals:
 * 25500 -> "×2.55", 26088 -> "×2.6088", 10000 -> "×1.00". It is never rounded, so the page does not show a
 * multiplier larger than the one the contract pays.
 */
export function formatMultiplier(bps: number): string {
  const fraction = String(bps % 10_000).padStart(4, '0').replace(/0{1,2}$/, '');
  return `×${Math.floor(bps / 10_000)}.${fraction}`;
}

/**
 * A multiplier to three significant digits, rounded down like `formatMultiplier` so it never shows
 * more than the contract pays: 26088 -> "×2.60", 66112 -> "×6.61", 184695 -> "×18.4".
 */
export function formatMultiplierShort(bps: number): string {
  const whole = Math.floor(bps / 10_000);
  if (whole >= 100) return `×${whole}`;
  if (whole >= 10) return `×${whole}.${Math.floor(bps / 1_000) % 10}`;
  return `×${whole}.${String(Math.floor(bps / 100) % 100).padStart(2, '0')}`;
}

export function shortHex(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 3 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Seconds as `m:ss`. Negative values print as `0:00`. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
