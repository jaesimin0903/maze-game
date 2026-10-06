// Test doubles for the client: an in-memory game server behind `fetch`, a chain and a wallet.
// The server plays real mazes with the shared module, so the flows exercised here are the ones
// the real server will answer; only transport, the server's signatures and mining are faked. The
// wallet signs ticket requests with a real key and the server verifies them with the shared
// message helper, so a client that signs other bytes gets no ticket here either.

import { UserRejectedRequestError, verifyMessage } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import fixture from '@maze/shared/fixtures/tuning.fixture.json';
import {
  DIR_BIT,
  ERROR_STATUS,
  ONCHAIN_STATUS,
  Outcome,
  chestAt,
  chestConfig,
  chestPoints,
  commitmentOf,
  deriveFinalSeed,
  exitCell,
  exitPayoutWei,
  generateMaze,
  isDeadEnd,
  neighbor,
  parseTuning,
  refundWei,
  replayMoves,
  solve,
  ticketRequestMessage,
  type ConfigResponse,
  type CreateGameRequest,
  type Dir,
  type ErrorCode,
  type FoundChest,
  type GameStatus,
  type GameTerminal,
  type GameView,
  type Hex,
  type Maze,
  type PointsAward,
  type PointsResponse,
  type TuningTable,
  type UiSnapshotInput,
} from '@maze/shared';
import { createApi, type FetchLike } from '../../src/client/api';
import type { ChainApi, OnchainGame } from '../../src/client/chain';
import type { ClientDeps } from '../../src/client/deps';
import { dirBetween } from '../../src/client/record';
import { hashSessionToken } from '../../src/client/seed';
import type { WalletApi } from '../../src/client/wallet';

export const TABLE: TuningTable = parseTuning(fixture);

export const PLAYER: Hex = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
export const CONTRACT: Hex = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
export const SERVER_SEED: Hex = `0x${'5e'.repeat(32)}`;
export const CLIENT_SEED: Hex = `0x${'c1'.repeat(32)}`;
const SIGNATURE: Hex = `0x${'ab'.repeat(65)}`;

/** Anvil accounts of the public mnemonic. #2 is `PLAYER`. */
export const anvilAccount = (index: number) =>
  mnemonicToAccount('test test test test test test test test test test test junk', {
    addressIndex: index,
  });

/**
 * The chest block of `/api/config` (rule 2). A `FakeWorld` built with it awards path chests as
 * moves enter them and the chest of a dead end that ends the game, as the real server does.
 */
export const CHEST_CONFIG = chestConfig();

/** The id `FakeWorld` gives the first ticket it issues (its hashes count up from 1). */
export const firstGameId: Hex = `0x9a3e${'1'.padStart(60, '0')}`;

export function makeConfig(overrides: Partial<ConfigResponse> = {}): ConfigResponse {
  return {
    chainId: 31337,
    rpcUrl: 'http://127.0.0.1:8551',
    contract: CONTRACT,
    mazeVersion: TABLE.mazeVersion,
    tableVersion: TABLE.tableVersion,
    tableHash: `0x${'11'.repeat(32)}`,
    calibrated: false,
    fixture: true,
    testHooks: false,
    tiers: TABLE.tiers,
    minBetWei: TABLE.limits.minBetWei,
    maxBetWei: TABLE.limits.maxBetWei,
    idleTimeoutSec: TABLE.timing.idleTimeoutSec,
    maxGameSec: TABLE.timing.maxGameSec,
    settleWindowSec: TABLE.timing.settleWindowSec,
    chainNowSec: 1_700_000_000,
    devWallet: true,
    ...overrides,
  };
}

/** Moves along the cells of `path`. */
export function movesAlong(n: number, path: number[]): Dir[] {
  return path.slice(1).map((cell, index) => {
    const dir = dirBetween(n, path[index], cell);
    if (dir === null) throw new Error('path cells are not adjacent');
    return dir;
  });
}

/** The moves that reach the exit. */
export function planExit(maze: Maze): Dir[] {
  return movesAlong(maze.w, solve(maze));
}

/** Moves that end in a dead end without passing the exit. Throws when the maze has none. */
export function planDeadEnd(maze: Maze): Dir[] {
  const parent = new Map<number, number>([[0, 0]]);
  const queue = [0];
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    for (const dir of [0, 1, 2, 3] as const) {
      if ((maze.open[cell] & DIR_BIT[dir]) === 0) continue;
      const next = neighbor(maze, cell, dir);
      if (next !== null && !parent.has(next)) {
        parent.set(next, cell);
        queue.push(next);
      }
    }
  }
  for (const leaf of queue) {
    const path = [leaf];
    while (path[0] !== 0) path.unshift(parent.get(path[0]) as number);
    const moves = movesAlong(maze.w, path);
    if (moves.length > 0 && replayMoves(maze, moves).outcome === Outcome.Loss) return moves;
  }
  throw new Error('this maze has no dead end to walk into');
}

interface ServerGame {
  gameId: Hex;
  player: Hex;
  tier: number;
  n: number;
  commitment: Hex;
  tokenHash: Hex;
  expirySec: number;
  /** Set once the bet transaction is on the fake chain. */
  onChain: { clientSeed: Hex; bet: bigint; maze: Maze; createdAt: number } | null;
  path: number[];
  moves: Dir[];
  lastMoveAt: number;
  status: GameStatus;
  auto: boolean;
  terminal: GameTerminal | null;
  /** The chests found so far, in the order found. */
  chests: FoundChest[];
}

export class FakeWorld {
  config: ConfigResponse;
  table: TuningTable;
  /** Latest block timestamp. Tests advance it by hand. */
  chainNow: number;
  serverUp = true;
  rpcUp = true;
  /** The relayer settles ended games on the request after the one that ended them. */
  autoSettle = true;
  /** `settle` transactions the relayer sends that are dropped (never mined) before one is mined. */
  settlesToDrop = 0;
  /** Every settlement hash the server has reported, in the order it sent the transactions. */
  settleHashesSent: Hex[] = [];
  /** Game id -> the transaction that settled it on the chain. */
  readonly settledBy = new Map<Hex, Hex>();
  pending = 0n;
  balance = 10n ** 19n;
  /** The key the wallet signs messages with. The wallet's address stays `PLAYER`. */
  signer = anvilAccount(2);
  /** The wallet prompt the player dismisses next: the signature request or the bet transaction. */
  rejectNext: 'sign' | 'tx' | null = null;
  /** Messages the wallet signed, in order. */
  signed: string[] = [];
  /** Wallet and server steps in the order they happened: `sign`, `tx <function>`, and requests. */
  timeline: string[] = [];
  /** What the server answers the next request with, once, instead of handling it. */
  answerNext: (() => Response) | null = null;

  /** Requests that reached the server, as `METHOD /path` with the game id replaced by `:id`. */
  requests: string[] = [];
  /** Contract functions the wallet sent, in order. */
  txs: string[] = [];
  snapshots: UiSnapshotInput[] = [];
  /** Configs the chain factory was called with. */
  chainConfigs: ConfigResponse[] = [];

  readonly games = new Map<Hex, ServerGame>();
  readonly onchain = new Map<Hex, OnchainGame>();
  /** Chest awards by lower-cased address, oldest first, as the server's ledger keeps them. */
  readonly awards = new Map<string, PointsAward[]>();
  private counter = 0;

  constructor(overrides: Partial<ConfigResponse> = {}) {
    this.config = makeConfig(overrides);
    this.table = { ...TABLE, tiers: this.config.tiers };
    this.chainNow = this.config.chainNowSec;
  }

  private nextHash(tag: string): Hex {
    this.counter += 1;
    return `0x${tag}${this.counter.toString(16).padStart(64 - tag.length, '0')}`;
  }

  mazeOf(gameId: Hex): Maze {
    const maze = this.games.get(gameId)?.onChain?.maze;
    if (!maze) throw new Error('the game is not on chain');
    return maze;
  }

  private view(g: ServerGame, withPath: boolean): GameView {
    const chain = g.onChain;
    if (!chain) throw new Error('view of a game that is not on chain');
    const { maze } = chain;
    const cell = g.path[g.path.length - 1];
    const point = (c: number): { x: number; y: number } => ({ x: c % g.n, y: Math.floor(c / g.n) });
    const step = g.moves.length;
    const view: GameView = {
      gameId: g.gameId,
      tier: g.tier,
      n: g.n,
      status: g.status,
      auto: g.auto,
      step,
      cell: point(cell),
      open: maze.open[cell],
      betWei: chain.bet.toString(),
      refundableWei: refundWei(this.table, chain.bet, g.tier, step).toString(),
      exitPayoutWei: exitPayoutWei(this.table, chain.bet, g.tier).toString(),
      chainNowSec: this.chainNow,
      idleDeadlineSec: g.lastMoveAt + this.config.idleTimeoutSec,
      gameDeadlineSec: chain.createdAt + this.config.maxGameSec,
      settleDeadlineSec: chain.createdAt + this.config.settleWindowSec,
    };
    if (this.config.chest !== undefined) {
      view.chestRule = this.config.chest.ruleVersion;
      view.chests = g.chests.map((chest) => ({ ...chest, cell: { ...chest.cell } }));
    }
    if (withPath) view.path = g.path.map((c) => ({ ...point(c), open: maze.open[c] }));
    if (g.terminal) view.terminal = { ...g.terminal };
    return view;
  }

  /**
   * Like the real server: the chest rule is asked about the cell a move has just entered, and a
   * chest found there is awarded at once. Returns the chest, or `null`.
   */
  private award(g: ServerGame, cell: number, kind: 'path' | 'dead-end'): FoundChest | null {
    const chain = g.onChain;
    const rule = this.config.chest?.ruleVersion;
    if (!chain || rule === undefined) return null;
    const finalSeed = deriveFinalSeed({ serverSeed: SERVER_SEED, clientSeed: chain.clientSeed, gameId: g.gameId });
    const chest = chestAt(finalSeed, chain.maze, cell, rule);
    if (chest === null || chest.kind !== kind) return null;
    const found: FoundChest = {
      cell: { x: cell % g.n, y: Math.floor(cell / g.n) },
      kind,
      rewardBps: chest.rewardBps,
      points: chestPoints(chain.bet, chest.rewardBps).toString(),
      step: g.moves.length,
    };
    g.chests.push(found);
    const key = g.player.toLowerCase();
    this.awards.set(key, [
      ...(this.awards.get(key) ?? []),
      {
        gameId: g.gameId,
        n: g.n,
        cell: found.cell,
        betWei: chain.bet.toString(),
        rewardBps: found.rewardBps,
        points: found.points,
        chestRule: rule,
        atSec: this.chainNow,
        kind,
        step: found.step,
      },
    ]);
    return found;
  }

  private end(g: ServerGame, outcome: 0 | 1 | 2, auto: boolean): void {
    const chain = g.onChain;
    if (!chain) return;
    const steps = g.moves.length;
    const payout =
      outcome === 0
        ? exitPayoutWei(this.table, chain.bet, g.tier)
        : outcome === 1
          ? refundWei(this.table, chain.bet, g.tier, steps)
          : 0n;
    g.status = outcome === 0 ? 'won' : outcome === 1 ? 'cashed_out' : 'lost';
    g.auto = auto;
    g.terminal = {
      serverSeed: SERVER_SEED,
      clientSeed: chain.clientSeed,
      outcome,
      steps,
      payoutWei: payout.toString(),
      signature: SIGNATURE,
      settleTxHash: null,
    };
    // Like the real server: a dead end is asked about its chest, and only when the game ends
    // there. Rule 2 names the rule on every ending.
    const rule = this.config.chest?.ruleVersion;
    if (rule !== undefined && (rule >= 2 || (outcome === 2 && !auto))) g.terminal.chestRule = rule;
    if (outcome === 2 && !auto && rule !== undefined) {
      const chest = this.award(g, g.path[g.path.length - 1], 'dead-end');
      g.terminal.chest = chest === null ? null : { cell: chest.cell, rewardBps: chest.rewardBps, points: chest.points };
    }
  }

  /** What `GET /api/points/:address` answers. */
  pointsOf(address: Hex): PointsResponse {
    const awards = this.awards.get(address.toLowerCase()) ?? [];
    return {
      address,
      totalPoints: awards.reduce((sum, award) => sum + BigInt(award.points), 0n).toString(),
      awardCount: awards.length,
      awards: awards.slice(-20).reverse(),
      cashValue: false,
    };
  }

  /** What the server's worker does on every block: settlements, then idle cash-outs. */
  private work(): void {
    for (const g of this.games.values()) {
      if (!g.onChain) continue;
      const game = this.onchain.get(g.gameId);
      if (g.terminal && this.autoSettle && game?.status === ONCHAIN_STATUS.Active) {
        // Like the real server, the hash is reported as soon as the transaction is sent.
        if (this.settlesToDrop > 0) {
          this.settlesToDrop -= 1;
          g.terminal.settleTxHash = this.nextHash('d40bbed');
        } else {
          game.status = ONCHAIN_STATUS.Settled;
          g.terminal.settleTxHash = this.nextHash('5e771e');
          this.settledBy.set(g.gameId, g.terminal.settleTxHash);
        }
        this.settleHashesSent.push(g.terminal.settleTxHash);
      }
      const deadline = Math.min(
        g.lastMoveAt + this.config.idleTimeoutSec,
        g.onChain.createdAt + this.config.maxGameSec,
      );
      if (g.status === 'active' && this.chainNow >= deadline) this.end(g, 1, true);
    }
  }

  readonly fetch: FetchLike = async (input, init) => {
    if (!this.serverUp) throw new TypeError('fetch failed');
    const method = init?.method ?? 'GET';
    this.requests.push(`${method} ${input.replace(/0x[0-9a-fA-F]{64}/, ':id')}`);
    this.timeline.push(this.requests[this.requests.length - 1]);
    if (this.answerNext) {
      const answer = this.answerNext;
      this.answerNext = null;
      return answer();
    }
    this.work();

    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const error = (code: ErrorCode): Response =>
      json(ERROR_STATUS[code], { error: { code, message: code } });
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

    if (input === '/api/config') return json(200, { ...this.config, chainNowSec: this.chainNow });

    const points = /^\/api\/points\/(0x[0-9a-fA-F]{40})$/.exec(input);
    if (points) {
      if (this.config.chest === undefined) return error('NOT_FOUND');
      return json(200, this.pointsOf(points[1] as Hex));
    }

    if (input === '/api/test/ui-snapshot') {
      if (!this.config.testHooks) return error('NOT_FOUND');
      this.snapshots.push(body as UiSnapshotInput);
      return new Response(null, { status: 204 });
    }

    if (input === '/api/games' && method === 'POST') {
      const request = body as CreateGameRequest;
      const message = ticketRequestMessage({
        chainId: this.config.chainId,
        mazeBetAddress: this.config.contract,
        player: request.player,
        tier: request.tier,
        sessionTokenHash: request.sessionTokenHash,
      });
      const signed =
        typeof request.signature === 'string' &&
        (await verifyMessage({
          address: request.player,
          message,
          signature: request.signature,
        }).catch(() => false));
      if (!signed) return error('UNAUTHORIZED');

      const ticketOf = (game: ServerGame): Response =>
        json(201, {
          gameId: game.gameId,
          player: game.player,
          tier: game.tier,
          commitment: game.commitment,
          expirySec: game.expirySec,
          signature: SIGNATURE,
        });
      const mine = [...this.games.values()].filter(
        (game) => game.player.toLowerCase() === request.player.toLowerCase(),
      );
      if (mine.some((game) => game.status === 'active' && game.onChain)) {
        return error('ALREADY_ACTIVE');
      }
      // A ticket that never became a game and has not expired is handed out again, as it was,
      // to the session that asks now.
      const unused = mine.find((game) => !game.onChain && this.chainNow <= game.expirySec);
      if (unused) {
        unused.tokenHash = request.sessionTokenHash;
        return ticketOf(unused);
      }
      const n = this.config.tiers[request.tier].n;
      const g: ServerGame = {
        gameId: this.nextHash('9a3e'),
        player: request.player,
        tier: request.tier,
        n,
        commitment: commitmentOf({ mazeVersion: this.config.mazeVersion, n, serverSeed: SERVER_SEED }),
        tokenHash: request.sessionTokenHash,
        expirySec: this.chainNow + TABLE.timing.ticketExpirySec,
        onChain: null,
        path: [0],
        moves: [],
        lastMoveAt: 0,
        status: 'active',
        auto: false,
        terminal: null,
        chests: [],
      };
      this.games.set(g.gameId, g);
      return ticketOf(g);
    }

    const match = /^\/api\/games\/(0x[0-9a-fA-F]{64})(\/[a-z]+)?$/.exec(input);
    if (!match) return error('NOT_FOUND');
    const g = this.games.get(match[1] as Hex);
    const action = match[2] ?? '';
    if (!g) return error('NOT_FOUND');

    if (action === '/reveal') {
      const status = this.onchain.get(g.gameId)?.status ?? ONCHAIN_STATUS.None;
      if (status === ONCHAIN_STATUS.Active) return error('NOT_REVEALABLE');
      if (status === ONCHAIN_STATUS.None && this.chainNow <= g.expirySec + 60) {
        return error('NOT_REVEALABLE');
      }
      return json(200, {
        gameId: g.gameId,
        commitment: g.commitment,
        serverSeed: SERVER_SEED,
        reason:
          status === ONCHAIN_STATUS.Settled
            ? 'settled'
            : status === ONCHAIN_STATUS.Reclaimed
              ? 'reclaimed'
              : 'ticket-expired',
      });
    }

    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    if (!auth.startsWith('Bearer ') || hashSessionToken(auth.slice(7)) !== g.tokenHash) {
      return error('UNAUTHORIZED');
    }
    if (!g.onChain) return error('NOT_ON_CHAIN');
    const { maze } = g.onChain;

    if (action === '' && method === 'GET') return json(200, this.view(g, true));
    if (action === '/start') return json(200, this.view(g, false));
    if (g.status !== 'active') return error('GAME_NOT_ACTIVE');
    const request = body as { step: number; dir?: Dir };
    if (request.step !== g.moves.length) return error('STALE_STEP');

    if (action === '/cashout') {
      this.end(g, 1, false);
      return json(200, this.view(g, false));
    }
    if (action === '/move' && request.dir !== undefined) {
      const cell = g.path[g.path.length - 1];
      const target = neighbor(maze, cell, request.dir);
      if (target === null) return error('INVALID_MOVE_BOUNDS');
      if ((maze.open[cell] & DIR_BIT[request.dir]) === 0) return error('INVALID_MOVE_WALL');
      if (g.path.includes(target)) return error('INVALID_MOVE_VISITED');
      g.path.push(target);
      g.moves.push(request.dir);
      g.lastMoveAt = this.chainNow;
      if (target === exitCell(maze)) this.end(g, 0, false);
      else if (isDeadEnd(maze, target, cell)) this.end(g, 2, false);
      else this.award(g, target, 'path');
      return json(200, this.view(g, false));
    }
    return error('BAD_REQUEST');
  };

  readonly chain: ChainApi = {
    now: async () => {
      if (!this.rpcUp) throw new Error('rpc down');
      return this.chainNow;
    },
    game: async (gameId) => {
      if (!this.rpcUp) throw new Error('rpc down');
      const game = this.onchain.get(gameId);
      return game
        ? { ...game }
        : {
            player: `0x${'00'.repeat(20)}`,
            tier: 0,
            status: ONCHAIN_STATUS.None,
            createdAt: 0,
            settleDeadline: 0,
            bet: 0n,
            maxPayout: 0n,
            commitment: `0x${'00'.repeat(32)}`,
            clientSeed: `0x${'00'.repeat(32)}`,
          };
    },
    pendingOf: async () => this.pending,
    balanceOf: async () => this.balance,
    waitForTx: async () => 'success',
    settledBy: async (hash, gameId) => {
      if (!this.rpcUp) throw new Error('rpc down');
      return this.settledBy.get(gameId) === hash;
    },
  };

  wallet(address: Hex = PLAYER): WalletApi {
    return {
      kind: 'dev',
      address,
      signMessage: async (message) => {
        if (this.rejectNext === 'sign') {
          this.rejectNext = null;
          throw new UserRejectedRequestError(new Error('User rejected the request.'));
        }
        this.signed.push(message);
        this.timeline.push('sign');
        return this.signer.signMessage({ message });
      },
      createGame: async ({ ticket, clientSeed, betWei }) => {
        if (this.rejectNext === 'tx') {
          this.rejectNext = null;
          throw new UserRejectedRequestError(new Error('User rejected the request.'));
        }
        this.txs.push('createGame');
        this.timeline.push('tx createGame');
        const g = this.games.get(ticket.gameId);
        if (!g) throw new Error('InvalidSignature');
        const maze = generateMaze(
          deriveFinalSeed({ serverSeed: SERVER_SEED, clientSeed, gameId: g.gameId }),
          g.n,
        );
        g.onChain = { clientSeed, bet: betWei, maze, createdAt: this.chainNow };
        g.lastMoveAt = this.chainNow;
        this.onchain.set(g.gameId, {
          player: address,
          tier: g.tier,
          status: ONCHAIN_STATUS.Active,
          createdAt: this.chainNow,
          settleDeadline: this.chainNow + this.config.settleWindowSec,
          bet: betWei,
          maxPayout: exitPayoutWei(this.table, betWei, g.tier),
          commitment: ticket.commitment,
          clientSeed,
        });
        return this.nextHash('c4ea7e');
      },
      settle: async ({ gameId }) => {
        this.txs.push('settle');
        const game = this.onchain.get(gameId);
        if (!game || game.status !== ONCHAIN_STATUS.Active) throw new Error('GameNotActive');
        game.status = ONCHAIN_STATUS.Settled;
        const hash = this.nextHash('5e1f');
        this.settledBy.set(gameId, hash);
        return hash;
      },
      reclaim: async (gameId) => {
        this.txs.push('reclaim');
        const game = this.onchain.get(gameId);
        if (!game || game.status !== ONCHAIN_STATUS.Active) throw new Error('GameNotActive');
        if (this.chainNow <= game.settleDeadline) throw new Error('DeadlineNotReached');
        game.status = ONCHAIN_STATUS.Reclaimed;
        return this.nextHash('4ec1a1');
      },
      withdrawPending: async () => {
        this.txs.push('withdrawPending');
        this.pending = 0n;
        return this.nextHash('d4a3');
      },
    };
  }

  deps(): ClientDeps {
    return {
      api: createApi(this.fetch),
      chain: (config) => {
        this.chainConfigs.push(config);
        return this.chain;
      },
      injected: () => null,
      connectInjected: async () => this.wallet(),
      connectDev: async (config) => {
        if (!config.devWallet) throw new Error('dev wallet disabled');
        return this.wallet();
      },
      timing: { pollMs: 40, clockMs: 15, startRetryMs: 15 },
    };
  }
}
