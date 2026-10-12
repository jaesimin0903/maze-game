// One agent wallet playing the game without a browser. The page does the same in
// apps/web/src/client/use-game.ts; the calls, in order, for one game:
//
//   personal_sign(ticketRequestMessage)   the wallet proves it asks for its own ticket
//   POST /api/games                       ticket (commitment fixed before the client seed is sent)
//   createGame(...) + receipt             the bet, paid on chain from the agent's own wallet
//   POST /api/games/:id/start             first cell, retried while the server indexes the bet
//   POST /api/games/:id/move | cashout    play
//   GET  /api/games/:id                   the path so far; after the end, until the server names
//                                         the transaction that settled the game
//
// The server settles on chain and pays the wallet. The session token is the only way back into a
// game, so the active game is written to disk before the bet is signed, and the bet's hash before
// it is broadcast: a process that dies anywhere in between picks the game up again on restart.
// Only one process may use a wallet's state file at a time.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
  keccak256,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  markStartSide,
  mazeBetAbi,
  ticketRequestMessage,
  type ConfigResponse,
  type Dir,
  type GameView,
  type Hex,
  type StartSide,
  type TicketResponse,
  type TierConfig,
} from '@maze/shared';
import { advise, type Advice, type ObservedCell } from './advise';
import type { AgentSettings } from './settings';

/** Monad testnet. A balance under 10 MON may drop further only 3 blocks after the account's last transaction. */
const MONAD_TESTNET = 10143;
const RESERVE_SPACING_BLOCKS = 4n;
const RESERVE_WAIT_MS = 20_000;
const RECEIPT_WAIT_MS = 60_000;
const START_RETRY_MS = 60_000;
const SETTLE_WAIT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Most gas a `createGame` may be sent with. */
const MAX_CREATE_GAS = 1_000_000n;

export class ServerError extends Error {
  override readonly name = 'ServerError';
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export type Outcome = 'exit' | 'cashout' | 'auto-cashout' | 'loss';

export interface ActiveGame {
  gameId: Hex;
  token: string;
  tier: number;
  n: number;
  betWei: string;
  clientSeed: Hex;
  createTxHash: Hex | null;
  startedAt: string;
}

export interface FinishedGame {
  gameId: Hex;
  n: number;
  betWei: string;
  payoutWei: string;
  outcome: Outcome;
  steps: number;
  createTxHash: Hex | null;
  settleTxHash: Hex | null;
  endedAt: string;
}

interface StoredState {
  active: ActiveGame | null;
  history: FinishedGame[];
  /** Block of this wallet's last bet, decimal, for the Monad reserve rule. */
  lastTxBlock?: string;
}

const OUTCOMES: Record<0 | 1 | 2, Outcome> = { 0: 'exit', 1: 'cashout', 2: 'loss' };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error);
  return message.split('\n')[0];
}

export class AgentClient {
  readonly address: Hex;
  /** Bets placed by this process, for `MAZE_AGENT_BUDGET`. */
  wageredWei = 0n;
  /** Why a game left by an earlier run could not be picked up on connect, or `null`. */
  resumeError: string | null = null;
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;
  private readonly stateFile: string;
  private state: StoredState;
  /** Latest view of the active game read by this process, `null` until the first one. */
  private lastView: GameView | null = null;
  /** Visited cells of the active game, or `null` until they are read from the server. */
  private path: ObservedCell[] | null = null;

  private constructor(
    readonly settings: AgentSettings,
    readonly config: ConfigResponse,
    readonly chain: Chain,
  ) {
    this.account = privateKeyToAccount(settings.key);
    this.address = this.account.address;
    const transport = http(settings.rpcUrl ?? config.rpcUrl);
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
    this.stateFile = path.join(settings.dataDir, `${this.address.toLowerCase()}.json`);
    this.state = existsSync(this.stateFile)
      ? (JSON.parse(readFileSync(this.stateFile, 'utf8')) as StoredState)
      : { active: null, history: [] };
  }

  static async connect(settings: AgentSettings): Promise<AgentClient> {
    const config = await request<ConfigResponse>(settings.serverUrl, 'GET', '/api/config');
    const symbol = config.network?.symbol ?? 'ETH';
    const chain = defineChain({
      id: config.chainId,
      name: config.network?.name ?? `chain ${config.chainId}`,
      nativeCurrency: { name: symbol, symbol, decimals: 18 },
      rpcUrls: { default: { http: [settings.rpcUrl ?? config.rpcUrl] } },
    });
    const client = new AgentClient(settings, config, chain);
    try {
      await client.resume();
    } catch (error) {
      // The game stays recorded; looking at it again retries.
      client.resumeError = shortError(error);
    }
    return client;
  }

  // ----- reading -----

  get symbol(): string {
    return this.config.network?.symbol ?? 'ETH';
  }

  get active(): ActiveGame | null {
    return this.state.active;
  }

  get history(): readonly FinishedGame[] {
    return this.state.history;
  }

  get budgetLeftWei(): bigint | null {
    const budget = this.settings.budgetWei;
    return budget === null ? null : budget > this.wageredWei ? budget - this.wageredWei : 0n;
  }

  amount(wei: bigint | string): string {
    return `${formatEther(BigInt(wei))} ${this.symbol}`;
  }

  txUrl(hash: Hex | null): string | null {
    const explorer = this.config.network?.explorerUrl;
    return hash === null || !explorer ? null : `${explorer}/tx/${hash}`;
  }

  tierOfSize(n: number): number {
    const index = this.config.tiers.findIndex((tier) => tier.n === n);
    if (index === -1) {
      throw new Error(`no ${n}×${n} board; sizes are ${this.config.tiers.map((t) => t.n).join(', ')}`);
    }
    return index;
  }

  balance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.address });
  }

  /**
   * The active game as the server sees it, with every visited cell. A game this process has not
   * seen yet is opened first (`/start`), which also picks up a bet that was still being mined.
   */
  async view(): Promise<GameView> {
    const view = this.lastView === null ? await this.start() : await this.read();
    this.resumeError = null;
    return view;
  }

  /** What the walls seen so far say about each way forward. */
  async advice(): Promise<Advice> {
    const active = this.requireActive();
    if (this.path === null || this.lastView === null || this.path.length !== this.lastView.step + 1) {
      await this.view();
    }
    return advise(this.tier(active.tier), this.path ?? []);
  }

  // ----- playing -----

  /** Pays the bet on chain and opens the game. Returns the first view and the bet transaction. */
  async newGame(p: { tier: number; betWei: bigint; side?: StartSide }): Promise<{ view: GameView; createTxHash: Hex }> {
    if (this.state.active !== null) {
      throw new Error(
        `game ${this.state.active.gameId} is still in progress; look at it, then move or cash out until it ends`,
      );
    }
    const tier = this.tier(p.tier);
    this.checkBet(p.betWei);
    const balance = await this.balance();
    if (balance < p.betWei) {
      throw new Error(`the agent wallet holds ${this.amount(balance)}, less than the bet of ${this.amount(p.betWei)}`);
    }
    await this.waitReserveSpacing();

    const token = randomBytes(32).toString('hex');
    const sessionTokenHash: Hex = `0x${createHash('sha256').update(token, 'utf8').digest('hex')}`;
    const signature = await this.account.signMessage({
      message: ticketRequestMessage({
        chainId: this.config.chainId,
        mazeBetAddress: this.config.contract,
        player: this.address,
        tier: p.tier,
        sessionTokenHash,
      }),
    });
    const ticket = await this.api<TicketResponse>('POST', '/api/games', {
      player: this.address,
      tier: p.tier,
      sessionTokenHash,
      signature,
    });
    if (ticket.player.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error('the server sent a ticket for another wallet');
    }
    if (ticket.tier !== p.tier) {
      const held = this.config.tiers[ticket.tier]?.n;
      throw new Error(
        `this wallet still holds an unused ${held}×${held} ticket, so it cannot get a ${tier.n}×${tier.n} one ` +
          `until that ticket expires; no bet was sent. Bet on ${held}×${held} instead, or wait`,
      );
    }

    const side = p.side ?? (randomBytes(1)[0] & 1 ? 'E' : 'S');
    const clientSeed = markStartSide(`0x${randomBytes(32).toString('hex')}`, side);
    this.state.active = {
      gameId: ticket.gameId,
      token,
      tier: p.tier,
      n: tier.n,
      betWei: p.betWei.toString(),
      clientSeed,
      createTxHash: null,
      startedAt: new Date().toISOString(),
    };
    this.lastView = null;
    this.path = null;
    this.save();

    // Signed here so that the hash is on disk before anything is broadcast.
    let serializedTransaction: Hex;
    try {
      const prepared = await this.walletClient.prepareTransactionRequest({
        to: this.config.contract,
        data: encodeFunctionData({
          abi: mazeBetAbi,
          functionName: 'createGame',
          args: [ticket.gameId, ticket.tier, ticket.commitment, BigInt(ticket.expirySec), clientSeed, ticket.signature],
        }),
        value: p.betWei,
      });
      // Monad charges the whole gas limit. A `createGame` estimate there is about 174k; Monad has
      // been seen to return estimates some 100 times too high for other calls.
      if (prepared.gas > MAX_CREATE_GAS) {
        throw new Error(`the gas estimate came back at ${prepared.gas}, far above what a bet needs`);
      }
      serializedTransaction = await this.walletClient.signTransaction(prepared);
    } catch (error) {
      // Gas estimation or signing failed: nothing left the wallet.
      this.drop();
      throw new Error(`the bet transaction was not sent: ${shortError(error)}`);
    }
    const hash = keccak256(serializedTransaction);
    this.state.active.createTxHash = hash;
    this.save();
    try {
      await this.publicClient.sendRawTransaction({ serializedTransaction });
    } catch (error) {
      // The node may have taken it before the error: give the game up only if it does not know it.
      const known = await this.publicClient.getTransaction({ hash }).then(
        () => true,
        () => false,
      );
      if (!known) {
        this.drop();
        throw new Error(`the bet transaction was not sent: ${shortError(error)}`);
      }
    }
    this.wageredWei += p.betWei;

    let receipt;
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS });
    } catch {
      throw new Error(`the bet transaction ${hash} is not mined yet; look at the game again in a moment to continue`);
    }
    this.noteTx(receipt.blockNumber);
    if (receipt.status !== 'success') {
      this.wageredWei -= p.betWei;
      this.drop();
      throw new Error(`the bet transaction ${hash} was reverted; the bet stayed in the wallet`);
    }
    return { view: await this.start(), createTxHash: hash };
  }

  move(dir: Dir): Promise<GameView> {
    return this.act('move', (step) => ({ step, dir }));
  }

  cashOut(): Promise<GameView> {
    return this.act('cashout', (step) => ({ step }));
  }

  /**
   * After the game has ended: waits until the server names the transaction that paid it (at most
   * `timeoutMs`), records the game in the history and clears it.
   */
  async finish(timeoutMs = SETTLE_WAIT_MS): Promise<FinishedGame> {
    const active = this.requireActive();
    const deadline = Date.now() + timeoutMs;
    let view = await this.view();
    if (view.status === 'active') throw new Error('the game is still in progress');
    while (!view.terminal?.settleTxHash && Date.now() < deadline) {
      await sleep(1000);
      view = await this.read();
    }
    const terminal = view.terminal;
    if (terminal === undefined) {
      throw new Error('the server has not said yet how the game ended; look at it again in a moment');
    }
    let settleTxHash = terminal.settleTxHash;
    if (settleTxHash !== null) {
      try {
        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash: settleTxHash,
          timeout: Math.max(5_000, deadline - Date.now()),
        });
        if (receipt.status !== 'success') settleTxHash = null;
      } catch {
        // Not mined yet: the server sends it again under another hash if it is dropped.
      }
    }
    const finished: FinishedGame = {
      gameId: active.gameId,
      n: active.n,
      betWei: active.betWei,
      payoutWei: terminal.payoutWei,
      outcome: view.auto ? 'auto-cashout' : OUTCOMES[terminal.outcome],
      steps: view.step,
      createTxHash: active.createTxHash,
      settleTxHash,
      endedAt: new Date().toISOString(),
    };
    this.state.history.push(finished);
    this.drop();
    return finished;
  }

  // ----- internals -----

  /** Picks up a game left by an earlier run: finishes it if it has ended, drops it if the server does not know it. */
  private async resume(): Promise<void> {
    if (this.state.active === null) return;
    try {
      const view = await this.view();
      if (view.status !== 'active') await this.finish(5_000);
    } catch (error) {
      if (error instanceof ServerError && (error.code === 'NOT_FOUND' || error.code === 'UNAUTHORIZED')) {
        this.drop();
        return;
      }
      // `start` dropped a game whose bet never reached the chain.
      if (this.state.active === null) return;
      throw error;
    }
  }

  private async start(): Promise<GameView> {
    const active = this.requireActive();
    const deadline = Date.now() + START_RETRY_MS;
    for (;;) {
      try {
        return this.absorb(await this.api<GameView>('POST', `/api/games/${active.gameId}/start`, {}, active.token));
      } catch (error) {
        if (!(error instanceof ServerError)) throw error;
        if (error.code === 'NOT_ON_CHAIN') {
          if (Date.now() >= deadline) {
            throw new Error(`the server has not seen the bet of game ${active.gameId} on chain yet; look again in a moment`);
          }
          await sleep(500);
          continue;
        }
        if (error.code === 'TICKET_EXPIRED') {
          // The contract refuses a ticket past its expiry, so this bet can no longer land.
          this.drop();
          throw new Error(`the bet of game ${active.gameId} did not reach the chain before its ticket expired; no bet was taken`);
        }
        // Already started, for example by an earlier run: the plain read has the game.
        return this.read();
      }
    }
  }

  private async read(): Promise<GameView> {
    const active = this.requireActive();
    return this.absorb(await this.api<GameView>('GET', `/api/games/${active.gameId}`, undefined, active.token));
  }

  private async act(kind: 'move' | 'cashout', body: (step: number) => object): Promise<GameView> {
    const active = this.requireActive();
    const step = (this.lastView ?? (await this.view())).step;
    try {
      return this.absorb(await this.api<GameView>('POST', `/api/games/${active.gameId}/${kind}`, body(step), active.token));
    } catch (error) {
      if (error instanceof ServerError && error.code === 'STALE_STEP') {
        // An earlier request went through after all. Moves are not repeated blindly.
        const fresh = await this.read();
        throw new Error(`the game had moved on: ${fresh.step} moves made, status ${fresh.status}; look at it again`);
      }
      throw error;
    }
  }

  private absorb(view: GameView): GameView {
    this.lastView = view;
    if (view.path !== undefined) {
      this.path = view.path.map(({ x, y, open }) => ({ x, y, open }));
    } else if (this.path !== null && view.step === this.path.length) {
      this.path.push({ x: view.cell.x, y: view.cell.y, open: view.open });
    } else if (view.step === 0) {
      this.path = [{ x: view.cell.x, y: view.cell.y, open: view.open }];
    } else {
      this.path = null;
    }
    return view;
  }

  private drop(): void {
    this.state.active = null;
    this.lastView = null;
    this.path = null;
    this.save();
  }

  private noteTx(block: bigint): void {
    this.state.lastTxBlock = block.toString();
    this.save();
  }

  private tier(index: number): TierConfig {
    const tier = this.config.tiers[index];
    if (tier === undefined) throw new Error(`no tier ${index}`);
    return tier;
  }

  private checkBet(betWei: bigint): void {
    const min = BigInt(this.config.minBetWei);
    const max = BigInt(this.config.maxBetWei);
    if (betWei < min || betWei > max) {
      throw new Error(`the bet must be between ${this.amount(min)} and ${this.amount(max)}`);
    }
    const cap = this.settings.maxBetWei;
    if (cap !== null && betWei > cap) {
      throw new Error(`the bet is over this agent's limit of ${this.amount(cap)} per game (MAZE_AGENT_MAX_BET)`);
    }
    const left = this.budgetLeftWei;
    if (left !== null && betWei > left) {
      throw new Error(`the bet is over what is left of this session's budget: ${this.amount(left)} (MAZE_AGENT_BUDGET)`);
    }
  }

  /** On Monad, waits until this wallet's last bet is `RESERVE_SPACING_BLOCKS` old (docs/deploy-monad.md §3.1). */
  private async waitReserveSpacing(): Promise<void> {
    if (this.config.chainId !== MONAD_TESTNET || this.state.lastTxBlock === undefined) return;
    const target = BigInt(this.state.lastTxBlock) + RESERVE_SPACING_BLOCKS;
    const deadline = Date.now() + RESERVE_WAIT_MS;
    while ((await this.publicClient.getBlockNumber()) < target) {
      if (Date.now() >= deadline) {
        throw new Error('the chain has not yet moved 4 blocks past this wallet\'s last bet; no bet was sent. Try again in a moment');
      }
      await sleep(400);
    }
  }

  private requireActive(): ActiveGame {
    if (this.state.active === null) throw new Error('there is no game in progress; start one first');
    return this.state.active;
  }

  private save(): void {
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temp = `${this.stateFile}.tmp`;
    // Holds the session token of the active game.
    writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.stateFile);
  }

  private api<T>(method: 'GET' | 'POST', route: string, body?: unknown, token?: string): Promise<T> {
    return request<T>(this.settings.serverUrl, method, route, body, token);
  }
}

async function request<T>(
  server: string,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(`${server}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`cannot reach the game server at ${server}: ${shortError(error)}`);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not the server's JSON; handled below.
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
    if (error?.code !== undefined) throw new ServerError(error.code, response.status, error.message ?? '');
    throw new Error(`the game server answered ${response.status} to ${method} ${route}`);
  }
  return parsed as T;
}
