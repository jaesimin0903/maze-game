// Frozen in Phase 0 (plan §7.4). Change only through the §8.1 modification procedure.
// `pnpm abi:check` compares this array with contracts/out/MazeBet.sol/MazeBet.json.

import type { Abi } from 'viem';

/** `enum Status { None, Active, Settled, Reclaimed }`, the `status` field of `getGame`. */
export const ONCHAIN_STATUS = { None: 0, Active: 1, Settled: 2, Reclaimed: 3 } as const;

export const mazeBetAbi = [
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner_', type: 'address' },
      { name: 'serverSigner_', type: 'address' },
      { name: 'tableVersion_', type: 'uint32' },
      { name: 'mazeVersion_', type: 'uint16' },
      {
        name: 'tiers_',
        type: 'tuple[]',
        components: [
          { name: 'n', type: 'uint8' },
          { name: 'multiplierBps', type: 'uint32' },
          { name: 'refundBps', type: 'uint16[]' },
        ],
      },
      { name: 'minBet_', type: 'uint256' },
      { name: 'maxBet_', type: 'uint256' },
      { name: 'settleWindow_', type: 'uint64' },
    ],
  },
  { type: 'receive', stateMutability: 'payable' },

  // ----- views -----
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'serverSigner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'tableHash',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'tierCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'tiers',
    stateMutability: 'view',
    inputs: [{ name: 'tier', type: 'uint8' }],
    outputs: [
      { name: 'n', type: 'uint8' },
      { name: 'multiplierBps', type: 'uint32' },
    ],
  },
  {
    type: 'function',
    name: 'refundBps',
    stateMutability: 'view',
    inputs: [
      { name: 'tier', type: 'uint8' },
      { name: 'step', type: 'uint16' },
    ],
    outputs: [{ name: '', type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'minBet',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'maxBet',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'settleWindow',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'getGame',
    stateMutability: 'view',
    inputs: [{ name: 'gameId', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'player', type: 'address' },
          { name: 'tier', type: 'uint8' },
          { name: 'status', type: 'uint8' },
          { name: 'createdAt', type: 'uint64' },
          { name: 'settleDeadline', type: 'uint64' },
          { name: 'bet', type: 'uint128' },
          { name: 'maxPayout', type: 'uint128' },
          { name: 'reserved', type: 'uint128' },
          { name: 'commitment', type: 'bytes32' },
          { name: 'clientSeed', type: 'bytes32' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'totalReserved',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalPending',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'pendingWithdrawals',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'availableLiquidity',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'quoteExitPayout',
    stateMutability: 'view',
    inputs: [
      { name: 'tier', type: 'uint8' },
      { name: 'bet', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },

  // ----- state-changing -----
  {
    type: 'function',
    name: 'createGame',
    stateMutability: 'payable',
    inputs: [
      { name: 'gameId', type: 'bytes32' },
      { name: 'tier', type: 'uint8' },
      { name: 'commitment', type: 'bytes32' },
      { name: 'expiry', type: 'uint64' },
      { name: 'clientSeed', type: 'bytes32' },
      { name: 'serverSig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'gameId', type: 'bytes32' },
      { name: 'outcome', type: 'uint8' },
      { name: 'steps', type: 'uint16' },
      { name: 'payout', type: 'uint256' },
      { name: 'serverSeed', type: 'bytes32' },
      { name: 'serverSig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'reclaim',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'gameId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdrawPending',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'fund',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdrawHouse',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setServerSigner',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'signer', type: 'address' }],
    outputs: [],
  },

  // ----- events -----
  {
    type: 'event',
    name: 'GameCreated',
    anonymous: false,
    inputs: [
      { name: 'gameId', type: 'bytes32', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'tier', type: 'uint8', indexed: false },
      { name: 'bet', type: 'uint256', indexed: false },
      { name: 'maxPayout', type: 'uint256', indexed: false },
      { name: 'commitment', type: 'bytes32', indexed: false },
      { name: 'clientSeed', type: 'bytes32', indexed: false },
      { name: 'settleDeadline', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'GameSettled',
    anonymous: false,
    inputs: [
      { name: 'gameId', type: 'bytes32', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'outcome', type: 'uint8', indexed: false },
      { name: 'steps', type: 'uint16', indexed: false },
      { name: 'payout', type: 'uint256', indexed: false },
      { name: 'serverSeed', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'GameReclaimed',
    anonymous: false,
    inputs: [
      { name: 'gameId', type: 'bytes32', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PayoutDeferred',
    anonymous: false,
    inputs: [
      { name: 'player', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'HouseFunded',
    anonymous: false,
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'HouseWithdrawn',
    anonymous: false,
    inputs: [
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ServerSignerChanged',
    anonymous: false,
    inputs: [{ name: 'signer', type: 'address', indexed: true }],
  },

  // ----- errors -----
  { type: 'error', name: 'InvalidSignature', inputs: [] },
  { type: 'error', name: 'TicketExpired', inputs: [] },
  { type: 'error', name: 'GameExists', inputs: [] },
  { type: 'error', name: 'BetOutOfRange', inputs: [] },
  { type: 'error', name: 'InvalidTier', inputs: [] },
  { type: 'error', name: 'InsufficientLiquidity', inputs: [] },
  { type: 'error', name: 'NotPlayer', inputs: [] },
  { type: 'error', name: 'GameNotActive', inputs: [] },
  { type: 'error', name: 'DeadlinePassed', inputs: [] },
  { type: 'error', name: 'DeadlineNotReached', inputs: [] },
  { type: 'error', name: 'CommitmentMismatch', inputs: [] },
  { type: 'error', name: 'PayoutMismatch', inputs: [] },
  { type: 'error', name: 'InvalidOutcome', inputs: [] },
  { type: 'error', name: 'InvalidSteps', inputs: [] },
  { type: 'error', name: 'NothingToWithdraw', inputs: [] },
  { type: 'error', name: 'ExceedsAvailable', inputs: [] },
  { type: 'error', name: 'NotOwner', inputs: [] },
  { type: 'error', name: 'InvalidTable', inputs: [] },
] as const satisfies Abi;
