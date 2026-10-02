// EIP-712 signing of tickets and settlements (plan §7.5).
//
// The contract accepts only 65-byte signatures with a low `s`; viem's local accounts produce
// exactly that (`r ‖ s ‖ v`, `v` = 27 or 28).

import {
  EIP712_TYPES,
  type Hex,
  type MazeBetDomain,
  type SettlementMessage,
  type TicketMessage,
} from '@maze/shared';
import { privateKeyToAccount } from 'viem/accounts';

export interface Signer {
  readonly address: Hex;
  signTicket(message: TicketMessage): Promise<Hex>;
  signSettlement(message: SettlementMessage): Promise<Hex>;
}

export function createSigner(privateKey: Hex, domain: MazeBetDomain): Signer {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signTicket: (message) =>
      account.signTypedData({ domain, types: EIP712_TYPES, primaryType: 'Ticket', message }),
    signSettlement: (message) =>
      account.signTypedData({ domain, types: EIP712_TYPES, primaryType: 'Settlement', message }),
  };
}
