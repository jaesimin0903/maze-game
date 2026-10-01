// Frozen in Phase 0 (plan §7.5). Change only through the §8.1 modification procedure.

import type { Hex } from './types';

export const EIP712_DOMAIN_NAME = 'MazeBet';
export const EIP712_DOMAIN_VERSION = '1';

/** domain = { name: "MazeBet", version: "1", chainId, verifyingContract } */
export interface MazeBetDomain {
  name: typeof EIP712_DOMAIN_NAME;
  version: typeof EIP712_DOMAIN_VERSION;
  chainId: number;
  verifyingContract: Hex;
}

export function mazeBetDomain(chainId: number, verifyingContract: Hex): MazeBetDomain {
  return { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId, verifyingContract };
}

/** Canonical type strings, exactly as hashed into the Solidity type hashes. */
export const TICKET_TYPE =
  'Ticket(bytes32 gameId,address player,uint8 tier,bytes32 commitment,uint64 expiry)';
export const SETTLEMENT_TYPE =
  'Settlement(bytes32 gameId,address player,uint8 outcome,uint16 steps,uint256 payout,bytes32 serverSeed)';

/** `types` argument for viem's `signTypedData` / `verifyTypedData` / `hashTypedData`. */
export const EIP712_TYPES = {
  Ticket: [
    { name: 'gameId', type: 'bytes32' },
    { name: 'player', type: 'address' },
    { name: 'tier', type: 'uint8' },
    { name: 'commitment', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
  ],
  Settlement: [
    { name: 'gameId', type: 'bytes32' },
    { name: 'player', type: 'address' },
    { name: 'outcome', type: 'uint8' },
    { name: 'steps', type: 'uint16' },
    { name: 'payout', type: 'uint256' },
    { name: 'serverSeed', type: 'bytes32' },
  ],
} as const;

export interface TicketMessage {
  gameId: Hex;
  player: Hex;
  tier: number;
  commitment: Hex;
  /** Chain seconds. */
  expiry: bigint;
}

export interface SettlementMessage {
  gameId: Hex;
  player: Hex;
  /** 0 = Exit, 1 = CashOut, 2 = Loss. */
  outcome: number;
  steps: number;
  /** Wei. */
  payout: bigint;
  serverSeed: Hex;
}
