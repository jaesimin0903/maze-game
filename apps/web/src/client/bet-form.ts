// The bet a player is about to place: amount checks, the one-tap amounts the dock offers, and
// what the page says while the wallet and the chain do their part.

import { formatEther, parseEther } from 'viem';
import { formatEth, parseEthInput } from './format';
import type { BetStep } from './use-game';
import type { WalletKind } from './wallet';

/**
 * The amounts the dock offers as chips next to the amount field, in the chain's coin. On Monad the
 * bet transaction's fee is near 0.018 MON, so smaller chips would lose more to the fee than a
 * win pays; a smaller amount can still be typed.
 */
const CHIPS = ['0.01', '0.05', '0.1'];

export interface Preset {
  wei: bigint;
  /** Short chip text: ".05", "1". */
  label: string;
}

function chipLabel(wei: bigint): string {
  const text = formatEth(wei);
  return text.startsWith('0.') ? text.slice(1) : text;
}

/**
 * The chips 0.01, 0.05 and 0.1 that lie within the table's limits; any other amount is typed into
 * the field. A table whose limits hold none of them gets its limits as chips.
 */
export function betPresets(minWei: bigint, maxWei: bigint): Preset[] {
  let picks = CHIPS.map((eth) => parseEther(eth)).filter((wei) => wei >= minWei && wei <= maxWei);
  if (picks.length === 0) picks = minWei === maxWei ? [minWei] : [minWei, maxWei];
  return picks.map((wei) => ({ wei, label: chipLabel(wei) }));
}

/** The chip a D-pad press moves to from `wei`: the next one up or down, staying in range. */
export function stepPreset(presets: Preset[], wei: bigint | null, delta: 1 | -1): Preset | null {
  if (presets.length === 0) return null;
  if (wei === null) return presets[0];
  let index = presets.findIndex((p) => p.wei >= wei);
  if (index === -1) index = presets.length;
  // `index` is the first chip at or above the amount; moving down from an amount between two
  // chips lands on the lower one.
  const exact = presets[index]?.wei === wei;
  const target = delta > 0 ? (exact ? index + 1 : index) : index - 1;
  return presets[Math.max(0, Math.min(presets.length - 1, target))];
}

/** The amount the bet field starts with: 0.05, kept within the table's limits. */
export function initialAmount(minWei: bigint, maxWei: bigint): string {
  const preferred = parseEther('0.05');
  return formatEther(preferred < minWei ? minWei : preferred > maxWei ? maxWei : preferred);
}

/** The bet in wei, or the reason the typed amount cannot be bet. `symbol` names the chain's coin. */
export function readAmount(
  text: string,
  minWei: bigint,
  maxWei: bigint,
  symbol = 'ETH',
): { betWei: bigint } | { reason: string } {
  const wei = parseEthInput(text);
  if (wei === null) return { reason: `Enter the bet in ${symbol}, for example 0.01` };
  if (wei < minWei) return { reason: `The minimum bet is ${formatEth(minWei)} ${symbol}` };
  if (wei > maxWei) return { reason: `The maximum bet is ${formatEth(maxWei)} ${symbol}` };
  return { betWei: wei };
}

/**
 * The gas the balance check allows the bet transaction (`createGame`). It used 176,475 gas on
 * Anvil, which prices gas as Ethereum does; Monad charges more for cold storage access, so the same
 * call can come near 200,000 there. The exact figure can only be estimated with the ticket, which
 * comes after the signature, so the check counts this round figure. Monad charges the whole limit.
 */
export const BET_GAS = 250_000n;

/**
 * The gas a bet transaction typically uses, for the fee the dock shows as a guide: 173,824 on
 * Monad testnet. The balance check counts `BET_GAS` instead.
 */
export const TYPICAL_BET_GAS = 175_000n;

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
  amountReason: string | null;
  seedOk: boolean;
  /** What the wallet lacks for the bet and its fee (`betShortfall`), when known. */
  shortWei?: bigint | null;
  symbol?: string;
}): string | null {
  if (!p.walletConnected) return 'Connect a wallet first';
  if (p.amountReason !== null) return p.amountReason;
  if (!p.seedOk) return 'The client seed must be 0x followed by 64 hex digits';
  if (p.shortWei !== undefined && p.shortWei !== null) {
    const symbol = p.symbol ?? 'ETH';
    return `Not enough ${symbol}: the bet and its network fee need ${formatEth(p.shortWei)} ${symbol} more`;
  }
  return null;
}

/**
 * What the page is waiting for at each bet step. A browser wallet asks the player at `sign` and
 * `tx`; the dev wallet and the account wallet of a Privy login sign without asking.
 */
export function stepText(step: BetStep, kind: WalletKind | null): string {
  const signer = kind === 'dev' ? 'the dev wallet' : kind === 'privy' ? 'your account wallet' : null;
  switch (step) {
    case 'sign':
      return signer === null
        ? 'Wallet 1 of 2: approve the ticket request signature. Signing sends no money'
        : `Signing the ticket request with ${signer}`;
    case 'ticket':
      return 'The server is fixing the maze seed and sending its commit';
    case 'tx':
      return signer === null ? 'Wallet 2 of 2: approve the bet transaction' : `Sending the bet transaction from ${signer}`;
    case 'confirm':
      return 'Waiting for the bet transaction to land in a block';
  }
}

/** Short screen tag for each bet step. */
export function stepTag(step: BetStep): string {
  return { sign: 'SIGNING...', ticket: 'COMMITTING...', tx: 'SENDING BET...', confirm: 'CONFIRMING...' }[step];
}
