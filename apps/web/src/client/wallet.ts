// Wallet abstraction over viem (plan §1.3 (f), §7.6). Three paths produce the same `WalletApi`:
// a browser wallet (EIP-1193), the Privy embedded wallet of a player who logged in with email,
// Google or a passkey (also EIP-1193, but it signs without asking), and the dev wallet, an Anvil
// account signing locally. The dev wallet exists only when the server's config says so. All sign
// messages as well as transactions: a ticket request carries the player's signature
// (`ticketRequestMessage`).

import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  createWalletClient,
  custom,
  http,
  type Account,
  type EIP1193Provider,
  type WalletClient,
} from 'viem';
import {
  mazeBetAbi,
  type ConfigResponse,
  type GameTerminal,
  type Hex,
  type TicketResponse,
} from '@maze/shared';
import { chainOf, type ChainConfig } from './chain';

/** `privy` is the embedded wallet of a Privy login; it signs without a prompt of its own. */
export type WalletKind = 'injected' | 'dev' | 'privy';

/** The contract calls a player makes directly. Each resolves to the transaction hash. */
export interface WalletApi {
  kind: WalletKind;
  address: Hex;
  /**
   * EIP-191 `personal_sign` of the UTF-8 bytes of `message` by `address`. The dev and Privy
   * wallets sign without asking; a browser wallet asks the player.
   */
  signMessage(message: string): Promise<Hex>;
  createGame(p: { ticket: TicketResponse; clientSeed: Hex; betWei: bigint }): Promise<Hex>;
  /** Submits the server-signed settlement the player received when the game ended. */
  settle(p: { gameId: Hex; terminal: GameTerminal }): Promise<Hex>;
  reclaim(gameId: Hex): Promise<Hex>;
  withdrawPending(): Promise<Hex>;
  /**
   * Sends `valueWei` of the chain's native coin from the wallet to `to`, with the gas limit `gas`
   * when given (Monad charges the whole limit, so the page sets it from an estimate).
   */
  transfer(p: { to: Hex; valueWei: bigint; gas?: bigint }): Promise<Hex>;
}

/** Anvil accounts reserved for players (plan §7.9: #0 house, #1 server, #2..#9 players). */
export const DEV_ACCOUNT_INDEXES = [2, 3, 4, 5, 6, 7, 8, 9] as const;

/** The public, well-known mnemonic every Anvil instance starts with. */
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

/** Which connection paths the UI may offer. The dev path depends on `config.devWallet` alone. */
export function walletOptions(
  config: Pick<ConfigResponse, 'devWallet'>,
  hasInjected: boolean,
): { injected: boolean; dev: boolean } {
  return { injected: hasInjected, dev: config.devWallet === true };
}

export function injectedProvider(): EIP1193Provider | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { ethereum?: EIP1193Provider }).ethereum ?? null;
}

function walletFrom(
  kind: WalletKind,
  client: WalletClient,
  account: Account | Hex,
  config: ChainConfig,
): WalletApi {
  const base = {
    account,
    chain: chainOf(config),
    address: config.contract,
    abi: mazeBetAbi,
  } as const;
  return {
    kind,
    address: typeof account === 'string' ? account : account.address,
    // viem signs with a local account itself and sends `personal_sign` for an address.
    signMessage: (message) => client.signMessage({ account, message }),
    createGame: ({ ticket, clientSeed, betWei }) =>
      client.writeContract({
        ...base,
        functionName: 'createGame',
        args: [
          ticket.gameId,
          ticket.tier,
          ticket.commitment,
          BigInt(ticket.expirySec),
          clientSeed,
          ticket.signature,
        ],
        value: betWei,
      }),
    settle: ({ gameId, terminal }) =>
      client.writeContract({
        ...base,
        functionName: 'settle',
        args: [
          gameId,
          terminal.outcome,
          terminal.steps,
          BigInt(terminal.payoutWei),
          terminal.serverSeed,
          terminal.signature,
        ],
      }),
    reclaim: (gameId) => client.writeContract({ ...base, functionName: 'reclaim', args: [gameId] }),
    withdrawPending: () => client.writeContract({ ...base, functionName: 'withdrawPending' }),
    transfer: ({ to, valueWei, gas }) =>
      client.sendTransaction({ account, chain: base.chain, to, value: valueWei, ...(gas === undefined ? {} : { gas }) }),
  };
}

/** Signs locally with Anvil account `index` and sends through the configured RPC. */
export async function connectDevWallet(
  config: ChainConfig & Pick<ConfigResponse, 'devWallet'>,
  index: number,
): Promise<WalletApi> {
  if (!walletOptions(config, false).dev) {
    throw new Error('The dev wallet is not available on this server');
  }
  if (!(DEV_ACCOUNT_INDEXES as readonly number[]).includes(index)) {
    throw new Error(`Dev account index must be ${DEV_ACCOUNT_INDEXES[0]} to ${DEV_ACCOUNT_INDEXES.at(-1)}`);
  }
  const { mnemonicToAccount } = await import('viem/accounts');
  const account = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
  const client = createWalletClient({
    account,
    chain: chainOf(config),
    transport: http(config.rpcUrl),
  });
  return walletFrom('dev', client, account, config);
}

/** Connects a browser wallet and moves it to the configured chain. */
export async function connectInjectedWallet(
  config: ChainConfig,
  provider: EIP1193Provider,
): Promise<WalletApi> {
  const chain = chainOf(config);
  const client = createWalletClient({ chain, transport: custom(provider) });
  const [address] = await client.requestAddresses();
  if (!address) throw new Error('The wallet did not provide an account');

  if ((await client.getChainId()) !== config.chainId) {
    try {
      await client.switchChain({ id: config.chainId });
    } catch {
      await client.addChain({ chain });
    }
    if ((await client.getChainId()) !== config.chainId) {
      throw new Error(`Switch your wallet network to chain ${config.chainId} (${config.rpcUrl})`);
    }
  }
  return walletFrom('injected', client, address, config);
}

/**
 * Wraps the EIP-1193 provider of a Privy embedded wallet and moves it to the configured chain.
 * The wallet signs without a prompt (Privy's own confirmation screens are turned off), so the
 * page's Start button is the player's consent to both signatures of a bet.
 */
export async function connectPrivyWallet(config: ChainConfig, provider: EIP1193Provider): Promise<WalletApi> {
  const client = createWalletClient({ chain: chainOf(config), transport: custom(provider) });
  const [address] = await client.requestAddresses();
  if (!address) throw new Error('The account wallet did not provide an address');
  if ((await client.getChainId()) !== config.chainId) {
    // The chain is Privy's only supported chain, so the embedded wallet can always switch to it.
    await client.switchChain({ id: config.chainId });
    if ((await client.getChainId()) !== config.chainId) {
      throw new Error(`The account wallet could not switch to chain ${config.chainId}`);
    }
  }
  return walletFrom('privy', client, address, config);
}

/** Name of the contract's custom error behind a failed call, when there is one. */
export function revertName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  return reverted.data?.errorName ?? reverted.reason ?? null;
}

const REVERT_MESSAGES: Record<string, string> = {
  InvalidSignature: 'The contract could not verify the server signature',
  TicketExpired: 'The ticket has expired. Place your bet again',
  GameExists: 'This game already exists',
  BetOutOfRange: 'The bet amount is out of range',
  InvalidTier: 'That maze size does not exist',
  InsufficientLiquidity: 'The house balance cannot cover the maximum payout of this bet',
  GameNotActive: 'This game has already been settled or reclaimed',
  DeadlinePassed: 'The settlement deadline has passed. You can reclaim your bet',
  DeadlineNotReached: 'The settlement deadline has not passed yet, so you cannot reclaim',
  NothingToWithdraw: 'There is no pending balance to withdraw',
};

/** The player dismissed the wallet's prompt (EIP-1193 error 4001) instead of approving it. */
export function isUserRejection(error: unknown): boolean {
  return (
    error instanceof BaseError && error.walk((e) => e instanceof UserRejectedRequestError) !== null
  );
}

/** A sentence for the player about a failed transaction. */
export function describeTxError(error: unknown): string {
  const name = revertName(error);
  if (name !== null) return REVERT_MESSAGES[name] ?? `The contract rejected the request (${name})`;
  if (isUserRejection(error)) return 'The request was rejected in the wallet';
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}
