// Wallet abstraction over viem (plan §1.3 (f), §7.6). Two paths produce the same `WalletApi`:
// a browser wallet (EIP-1193) and the dev wallet, an Anvil account signing locally. The dev
// wallet exists only when the server's config says so.

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

export type WalletKind = 'injected' | 'dev';

/** The contract calls a player makes directly. Each resolves to the transaction hash. */
export interface WalletApi {
  kind: WalletKind;
  address: Hex;
  createGame(p: { ticket: TicketResponse; clientSeed: Hex; betWei: bigint }): Promise<Hex>;
  /** Submits the server-signed settlement the player received when the game ended. */
  settle(p: { gameId: Hex; terminal: GameTerminal }): Promise<Hex>;
  reclaim(gameId: Hex): Promise<Hex>;
  withdrawPending(): Promise<Hex>;
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
  };
}

/** Signs locally with Anvil account `index` and sends through the configured RPC. */
export async function connectDevWallet(
  config: ChainConfig & Pick<ConfigResponse, 'devWallet'>,
  index: number,
): Promise<WalletApi> {
  if (!walletOptions(config, false).dev) {
    throw new Error('개발용 지갑은 이 서버에서 사용할 수 없습니다');
  }
  if (!(DEV_ACCOUNT_INDEXES as readonly number[]).includes(index)) {
    throw new Error(`개발용 계정 번호는 ${DEV_ACCOUNT_INDEXES[0]}~${DEV_ACCOUNT_INDEXES.at(-1)}입니다`);
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
  if (!address) throw new Error('지갑이 계정을 내주지 않았습니다');

  if ((await client.getChainId()) !== config.chainId) {
    try {
      await client.switchChain({ id: config.chainId });
    } catch {
      await client.addChain({ chain });
    }
    if ((await client.getChainId()) !== config.chainId) {
      throw new Error(`지갑의 네트워크를 체인 ${config.chainId}(${config.rpcUrl})로 바꿔 주세요`);
    }
  }
  return walletFrom('injected', client, address, config);
}

/** Name of the contract's custom error behind a failed call, when there is one. */
export function revertName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  return reverted.data?.errorName ?? reverted.reason ?? null;
}

const REVERT_MESSAGES: Record<string, string> = {
  InvalidSignature: '서버 서명이 컨트랙트에서 확인되지 않았습니다',
  TicketExpired: '티켓 유효 시간이 지났습니다. 다시 베팅해 주세요',
  GameExists: '이미 만들어진 게임입니다',
  BetOutOfRange: '베팅 금액이 허용 범위를 벗어났습니다',
  InvalidTier: '없는 크기입니다',
  InsufficientLiquidity: '하우스 잔액이 이 베팅의 최대 배당을 감당하지 못합니다',
  GameNotActive: '이 게임은 이미 정산되었거나 회수되었습니다',
  DeadlinePassed: '정산 기한이 지났습니다. 베팅액을 회수할 수 있습니다',
  DeadlineNotReached: '아직 정산 기한이 지나지 않아 회수할 수 없습니다',
  NothingToWithdraw: '인출할 보류 금액이 없습니다',
};

/** A sentence for the player about a failed transaction. */
export function describeTxError(error: unknown): string {
  const name = revertName(error);
  if (name !== null) return REVERT_MESSAGES[name] ?? `컨트랙트가 거부했습니다 (${name})`;
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return '지갑에서 요청을 거절했습니다';
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
