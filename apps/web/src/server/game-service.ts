// The game state machine (plan §7.3, §7.8).
//
// Rules this file is built around:
//
// - Persist, then apply, then answer. Every state change is one `StoreEvent` (or one atomic
//   group). It is appended and flushed first, the in-memory state is changed by `apply` only
//   after that, and the caller answers last. Booting replays the same events through the same
//   `apply`, so the recovered state is exactly the state that was answered from.
// - One request at a time per game. Handlers, the timeout pass and the chain watcher all take
//   the game's mutex, read the chain clock inside it, and re-check the state they act on.
// - One signature per game. A `Settlement` is signed only by `finish`, only for a game with no
//   ending, under the mutex, and it leaves the process only after its `ended` event is durable.
// - A ticket is issued only to the address that asked for it. The request carries the address's
//   own signature, so nobody can take, hold or refresh another address's one ticket slot. The
//   tickets that are outstanding at once and the tickets written per unit of chain time are both
//   capped over all addresses, and a ticket that can no longer create a game is forgotten.
// - The maze never reaches a response. Mazes live in a private map. A move reads `maze.open` of
//   the arrival cell only; everything else is answered from the open masks the player was
//   already shown. A maze is built once, when the game is seen on chain, and never by a move,
//   cash-out or read.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DIR_BIT,
  commitmentOf,
  deriveFinalSeed,
  exitPayoutWei,
  generateMaze,
  isDeadEnd,
  neighbor,
  openDirs,
  refundWei,
  ticketRequestMessage,
  type Dir,
  type GameView,
  type Hex,
  type Maze,
  type TicketResponse,
  type TuningTable,
} from '@maze/shared';
import { getAddress, isAddress, verifyMessage } from 'viem';
import type { ChainEvent } from './chain';
import type { Clock } from './clock';
import { ApiError } from './errors';
import { describeError, type Logger } from './log';
import { KeyedMutex } from './mutex';
import { toPublicView, toTicketResponse } from './serializer';
import type { Signer } from './signer';
import type { EndCause, EventStore, StoreEvent } from './store';
import { testServerSeed } from './test-hooks';

const OUTCOME_EXIT = 0;
const OUTCOME_CASH_OUT = 1;
const OUTCOME_LOSS = 2;
type OutcomeCode = 0 | 1 | 2;

/** Signed ticket requests one address may make per `TICKET_RATE_WINDOW_SEC` chain seconds. */
const TICKET_RATE_MAX = 10;
const TICKET_RATE_WINDOW_SEC = 60;
const TICKET_RATE_PRUNE_AT = 10_000;

/**
 * Tickets that may be outstanding at once over all addresses. A ticket is outstanding from its
 * issue until its game is seen on chain or it expires. An honest ticket is outstanding for the
 * few seconds between the wallet prompt and the `createGame` block, so 64 at once is far more
 * than a local table needs, while it bounds what a flood of requests can hold in memory.
 */
export const TICKET_OUTSTANDING_MAX = 64;
/**
 * Ticket lines (new tickets and re-bindings) the server writes per `TICKET_GLOBAL_WINDOW_SEC`
 * chain seconds over all addresses: one game start per second on average. This is the bound on
 * how fast ticket requests can grow the event log (about 0.6 kB per line).
 */
export const TICKET_GLOBAL_RATE_MAX = 60;
export const TICKET_GLOBAL_WINDOW_SEC = 60;
/**
 * Chain seconds a ticket that never created a game is kept after its expiry. `/reveal` gives out
 * its seed from `expiry + 60` (plan §3.5) until `expiry + TICKET_RETENTION_SEC`; after that the
 * ticket is dropped from memory, and from the log at the next boot. With the issue rate above,
 * at most 60 x (120 + 3600) / 60 = 3,720 such tickets exist at any time.
 */
export const TICKET_RETENTION_SEC = 3600;

const START_CELL = 0;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
/** A 65-byte signature, `r ‖ s ‖ v`. */
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TICKET_FIELDS = ['player', 'tier', 'sessionTokenHash'] as const;

export interface Game {
  readonly gameId: Hex;
  /** Checksummed address the ticket was issued to. */
  readonly player: Hex;
  readonly tier: number;
  readonly n: number;
  readonly serverSeed: Hex;
  readonly commitment: Hex;
  /** Server signature over the EIP-712 `Ticket`. */
  readonly ticketSignature: Hex;
  /** Replaced when the ticket's owner asks for the ticket again before creating the game. */
  sessionTokenHash: Hex;
  /** Chain second after which the ticket can no longer create a game. */
  readonly expirySec: number;
  /** Set once the server has seen `GameCreated` for this game. */
  chain: null | {
    clientSeed: Hex;
    betWei: bigint;
    maxPayoutWei: bigint;
    createdAtSec: number;
    settleDeadlineSec: number;
    blockNumber: bigint;
  };
  moves: Dir[];
  /** Cells the player has stood in, in order, with the open mask shown for each. */
  path: { cell: number; open: number }[];
  /** Creation block time, then the chain time of each accepted move. Start of the idle timer. */
  lastActivitySec: number;
  ended: null | {
    outcome: OutcomeCode;
    steps: number;
    payoutWei: bigint;
    signature: Hex;
    auto: boolean;
    cause: EndCause;
    atSec: number;
  };
  settle: {
    lastSentSec: number | null;
    lastTxHash: Hex | null;
    sends: number;
    minedTxHash: Hex | null;
  };
  /** How the game finished on chain, once the server has seen it. */
  final: null | 'settled' | 'reclaimed';
}

export interface GameServiceDeps {
  /** Chain and contract a ticket request must be signed for. */
  chainId: number;
  contract: Hex;
  table: TuningTable;
  /** Effective timeouts in chain seconds (the table's, or a shorter override). */
  idleTimeoutSec: number;
  maxGameSec: number;
  clock: Clock;
  store: EventStore;
  signer: Signer;
  log: Logger;
  /** Builds the maze of a game. Defaults to `generateMaze`. */
  mazeFactory?: (finalSeed: Hex, n: number) => Maze;
  /** 32 random bytes as hex. Defaults to `crypto.randomBytes`. */
  random32?: () => Hex;
  /** Set only while test hooks are on: server seeds are then derived from the game id. */
  testSeedSecret?: string | null;
  /** How long building a maze appears to take, in milliseconds. See `buildMaze`. */
  mazePadMs?: number;
}

export interface GameServiceHooks {
  /** Called (not awaited) when a game ends, so that its settlement is sent at once. */
  onEnded?: (gameId: Hex) => void;
  /** Brings the chain watcher up to the latest block. */
  syncChain?: () => Promise<void>;
}

function maskOf(dirs: readonly Dir[]): number {
  let mask = 0;
  for (const dir of dirs) mask |= DIR_BIT[dir];
  return mask;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `body` is an object with exactly the keys `keys`. */
function hasExactly(body: unknown, keys: readonly string[]): body is Record<string, unknown> {
  if (!isPlainObject(body)) return false;
  const present = Object.keys(body);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(body, key));
}

function isStep(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export class GameService {
  private readonly games = new Map<Hex, Game>();
  private readonly mazes = new Map<Hex, Maze>();
  /** On chain, not ended, not finished on chain. */
  private readonly live = new Set<Hex>();
  /** Ended in this log, not yet finished on chain. */
  private readonly unsettled = new Set<Hex>();
  /** Games the server knows to be `Active` on chain, by lower-cased player address. */
  private readonly activeByPlayer = new Map<string, Set<Hex>>();
  /** Game ids of tickets issued to each lower-cased player address, for the live-entry check. */
  private readonly ticketsByPlayer = new Map<string, Set<Hex>>();
  /** Tickets whose game the server has not seen on chain, in issue order (so in expiry order). */
  private readonly uncreated = new Map<Hex, Game>();
  /** Chain seconds of the latest ticket lines written, at most `TICKET_GLOBAL_RATE_MAX` of them. */
  private readonly issueTimes: number[] = [];
  /** Ticket lines that passed the global checks and are being signed or stored. */
  private issuing = 0;
  private capLoggedSec = Number.NEGATIVE_INFINITY;
  private readonly ticketTimes = new Map<string, number[]>();
  private readonly locks = new KeyedMutex();
  /** Serializes ticket issuance per address so the live-entry check and its reservation are atomic. */
  private readonly ticketLocks = new KeyedMutex();
  private readonly missedWindow = new Set<Hex>();
  private hooks: GameServiceHooks = {};

  private readonly table: TuningTable;
  private readonly clock: Clock;
  private readonly store: EventStore;
  private readonly signer: Signer;
  private readonly log: Logger;
  private readonly mazeFactory: (finalSeed: Hex, n: number) => Maze;
  private readonly random32: () => Hex;

  constructor(private readonly deps: GameServiceDeps) {
    this.table = deps.table;
    this.clock = deps.clock;
    this.store = deps.store;
    this.signer = deps.signer;
    this.log = deps.log;
    this.mazeFactory = deps.mazeFactory ?? generateMaze;
    this.random32 = deps.random32 ?? (() => `0x${randomBytes(32).toString('hex')}`);
  }

  setHooks(hooks: GameServiceHooks): void {
    this.hooks = hooks;
  }

  // ----- boot -----

  /**
   * Rebuilds the state from the event log. Mazes of games that are still in play are generated
   * again and checked against the recorded path; a mismatch means the log and the code disagree
   * and booting must not continue.
   */
  restore(events: readonly StoreEvent[]): void {
    for (const event of events) this.apply(event);
    for (const gameId of this.live) {
      const game = this.games.get(gameId)!;
      const maze = this.mazeFactory(this.finalSeedOf(game, game.chain!.clientSeed), game.n);
      for (let i = 0; i < game.path.length; i++) {
        const { cell, open } = game.path[i];
        const reachable =
          i === 0
            ? cell === START_CELL
            : neighbor(maze, game.path[i - 1].cell, game.moves[i - 1]) === cell;
        if (!reachable || maskOf(openDirs(maze, cell)) !== open) {
          throw new Error(`event log: game ${gameId} does not match its regenerated maze`);
        }
      }
      this.mazes.set(gameId, maze);
    }
  }

  // ----- requests -----

  /**
   * `POST /api/games`. The request is signed by `player` (EIP-191, see `ticketRequestMessage`):
   * a request without that signature is `UNAUTHORIZED` and leaves no trace, not even in the
   * address's rate allowance. While the address holds a ticket that has not expired and has not
   * created its game, a signed request gets that same ticket back, bound to the session token
   * of this request.
   */
  async issueTicket(body: unknown): Promise<TicketResponse> {
    if (!hasExactly(body, TICKET_FIELDS) && !hasExactly(body, [...TICKET_FIELDS, 'signature'])) {
      throw new ApiError('BAD_REQUEST');
    }
    const { tier, sessionTokenHash } = body;
    if (typeof body.player !== 'string' || !isAddress(body.player, { strict: false })) {
      throw new ApiError('BAD_REQUEST');
    }
    if (!isStep(tier) || tier >= this.table.tiers.length) throw new ApiError('BAD_REQUEST');
    if (typeof sessionTokenHash !== 'string' || !HEX32.test(sessionTokenHash)) {
      throw new ApiError('BAD_REQUEST');
    }
    const player = getAddress(body.player);
    const playerKey = player.toLowerCase();
    const tokenHash = sessionTokenHash.toLowerCase() as Hex;
    if (!(await this.signedBy(player, tier, tokenHash, body.signature))) {
      throw new ApiError('UNAUTHORIZED');
    }

    // Serialized per address: without this, two concurrent requests could both pass the
    // live-entry check and each reserve house liquidity. Different addresses do not contend.
    return this.ticketLocks.run(playerKey, async () => {
      const now = await this.clock.chainNow();
      // Checked here only; the contract does not enforce it (plan §7.3). An address has one live
      // entry at most: an on-chain active game, or a ticket that has not expired and has not yet
      // created a game. Counting only on-chain active games let an address pre-issue several
      // tickets while none was active and then create several games at once, each reserving
      // `max(bet, maxPayout)` of the house balance. When the address still looks busy one chain
      // scan is made on the spot, so a game settled a moment ago is not held against it.
      let held = this.liveTicketOf(playerKey, now);
      const busy = held !== null || this.hasActiveGame(playerKey);
      if (busy) {
        // Counted before the chain is read: the scan is not free for the asking.
        this.countTicket(playerKey, now);
        await this.hooks.syncChain?.();
        if (this.hasActiveGame(playerKey)) throw new ApiError('ALREADY_ACTIVE');
        held = this.liveTicketOf(playerKey, now);
      }
      if (held !== null) return this.rebind(held, tokenHash, now);

      if (this.outstandingTickets(now) + this.issuing >= TICKET_OUTSTANDING_MAX) {
        this.refuseForCapacity(now, 'outstanding');
      }
      this.requireIssueBudget(now);
      // An address is entered in the per-address count only when it holds, or now gets, a
      // ticket or a game: a request refused by a global limit above leaves nothing behind.
      if (!busy) this.countTicket(playerKey, now);
      this.issuing += 1;
      try {
        let gameId = this.random32();
        while (this.games.has(gameId)) gameId = this.random32();
        const secret = this.deps.testSeedSecret;
        const serverSeed =
          secret === undefined || secret === null ? this.random32() : testServerSeed(secret, gameId);
        const n = this.table.tiers[tier].n;
        const commitment = commitmentOf({ mazeVersion: this.table.mazeVersion, n, serverSeed });
        const expirySec = now + this.table.timing.ticketExpirySec;
        const signature = await this.signer.signTicket({
          gameId,
          player,
          tier,
          commitment,
          expiry: BigInt(expirySec),
        });

        await this.persist([
          {
            type: 'ticket-issued',
            gameId,
            player,
            tier,
            n,
            serverSeed,
            commitment,
            sessionTokenHash: tokenHash,
            expirySec,
            signature,
            atSec: now,
          },
        ]);
        this.log.event({ event: 'ticket-issued', chainSec: now, gameId, detail: { player, tier } });
        return toTicketResponse(this.games.get(gameId)!, signature);
      } finally {
        this.issuing -= 1;
      }
    });
  }

  /** `POST /api/games/:id/start` */
  async start(gameId: Hex, token: string | null): Promise<GameView> {
    const game = this.authorize(gameId, token);
    await this.requireOnChain(game);
    return this.locks.run(gameId, async () => {
      const now = await this.clock.chainNow();
      this.requirePlayable(game, now);
      if (game.moves.length !== 0) throw new ApiError('STALE_STEP');
      this.log.event({ event: 'start', chainSec: now, gameId, step: 0 });
      return this.viewOf(game, now, false);
    });
  }

  /** `POST /api/games/:id/move` */
  async move(gameId: Hex, token: string | null, body: unknown): Promise<GameView> {
    if (!hasExactly(body, ['step', 'dir']) || !isStep(body.step)) throw new ApiError('BAD_REQUEST');
    const { step, dir } = body;
    if (dir !== 0 && dir !== 1 && dir !== 2 && dir !== 3) throw new ApiError('BAD_REQUEST');

    const game = this.authorize(gameId, token);
    await this.requireOnChain(game);
    return this.locks.run(gameId, async () => {
      const now = await this.clock.chainNow();
      this.requirePlayable(game, now);
      if (step !== game.moves.length) throw new ApiError('STALE_STEP');

      const maze = this.mazes.get(gameId);
      if (maze === undefined) throw new Error(`game ${gameId} has no maze`);
      const here = game.path[game.path.length - 1];
      // Geometry, the mask already shown for the current cell, and the player's own path
      // decide whether the move is legal. None of them reads the maze.
      const arrival = neighbor(maze, here.cell, dir);
      if (arrival === null) throw new ApiError('INVALID_MOVE_BOUNDS');
      if ((here.open & DIR_BIT[dir]) === 0) throw new ApiError('INVALID_MOVE_WALL');
      if (game.path.some((visited) => visited.cell === arrival)) {
        throw new ApiError('INVALID_MOVE_VISITED');
      }

      // The only maze reads of a move: `maze.open[arrival]`.
      const open = maskOf(openDirs(maze, arrival));
      const steps = step + 1;
      const moved: StoreEvent = {
        type: 'move',
        gameId,
        step: steps,
        dir,
        cell: arrival,
        open,
        atSec: now,
      };
      const outcome =
        arrival === game.n * game.n - 1
          ? OUTCOME_EXIT
          : isDeadEnd(maze, arrival, here.cell)
            ? OUTCOME_LOSS
            : null;
      if (outcome === null) {
        await this.persist([moved]);
        this.log.event({ event: 'move', chainSec: now, gameId, step: steps });
      } else {
        await this.finish(game, {
          outcome,
          steps,
          auto: false,
          cause: outcome === OUTCOME_EXIT ? 'exit' : 'dead-end',
          now,
          moved,
        });
      }
      return this.viewOf(game, now, false);
    });
  }

  /** `POST /api/games/:id/cashout` */
  async cashout(gameId: Hex, token: string | null, body: unknown): Promise<GameView> {
    if (!hasExactly(body, ['step']) || !isStep(body.step)) throw new ApiError('BAD_REQUEST');
    const { step } = body;

    const game = this.authorize(gameId, token);
    await this.requireOnChain(game);
    return this.locks.run(gameId, async () => {
      const now = await this.clock.chainNow();
      this.requirePlayable(game, now);
      if (step !== game.moves.length) throw new ApiError('STALE_STEP');
      await this.finish(game, {
        outcome: OUTCOME_CASH_OUT,
        steps: step,
        auto: false,
        cause: 'cashout',
        now,
      });
      return this.viewOf(game, now, false);
    });
  }

  /** `GET /api/games/:id` */
  async view(gameId: Hex, token: string | null): Promise<GameView> {
    const game = this.authorize(gameId, token);
    await this.requireOnChain(game);
    const now = await this.clock.chainNow();
    return this.viewOf(game, now, true);
  }

  // ----- worker -----

  /**
   * Ends every game whose idle or game deadline has passed with a cash-out at its current
   * step. Covers games whose player never called `/start`: the timers run from the creation
   * block.
   */
  async expireDue(): Promise<void> {
    const now = await this.clock.chainNow();
    for (const gameId of [...this.live]) {
      const game = this.games.get(gameId)!;
      if (!this.isDue(game, now) || this.missedWindow.has(gameId)) continue;
      try {
        await this.locks.run(gameId, async () => {
          const at = await this.clock.chainNow();
          const chain = game.chain;
          if (chain === null || game.ended !== null || game.final !== null) return;
          if (!this.isDue(game, at)) return;
          if (at > chain.settleDeadlineSec) {
            // Too late for `settle`; the contract only accepts `reclaim` now.
            if (!this.missedWindow.has(gameId)) {
              this.missedWindow.add(gameId);
              this.log.event({
                level: 'alert',
                event: 'settle-window-missed',
                chainSec: at,
                gameId,
                step: game.moves.length,
              });
            }
            return;
          }
          await this.finish(game, {
            outcome: OUTCOME_CASH_OUT,
            steps: game.moves.length,
            auto: true,
            cause: at >= chain.createdAtSec + this.deps.maxGameSec ? 'max-game' : 'idle',
            now: at,
          });
        });
      } catch (error) {
        this.log.event({
          level: 'error',
          event: 'auto-cashout-failed',
          chainSec: now,
          gameId,
          detail: { error: describeError(error) },
        });
      }
    }
  }

  /**
   * Forgets every ticket that can no longer create a game and whose seed has been available
   * through `/reveal` for the whole retention window. `scannedSec` is the timestamp of the
   * latest block up to which the server has read every game event: a ticket that expired before
   * that block, and whose `GameCreated` was not among those events, has no game and can never
   * get one, because `createGame` refuses a ticket after its expiry. `null` (nothing scanned
   * yet) forgets nothing.
   */
  forgetDeadTickets(scannedSec: number | null): void {
    if (scannedSec === null) return;
    for (const [gameId, game] of this.uncreated) {
      // In issue order, so the first ticket that is still young ends the walk.
      if (game.expirySec + TICKET_RETENTION_SEC >= scannedSec) break;
      this.uncreated.delete(gameId);
      this.games.delete(gameId);
      const playerKey = game.player.toLowerCase();
      const tickets = this.ticketsByPlayer.get(playerKey);
      tickets?.delete(gameId);
      if (tickets?.size === 0) this.ticketsByPlayer.delete(playerKey);
    }
  }

  /** `GameCreated`, `GameSettled` or `GameReclaimed`, as read from the chain. Idempotent. */
  async onChainEvent(event: ChainEvent): Promise<void> {
    const game = this.games.get(event.gameId);
    if (game === undefined) {
      // Created with a ticket this log does not hold (another data directory). The server
      // cannot play or settle it.
      if (event.type === 'created') {
        this.log.event({
          level: 'warn',
          event: 'chain-created-unknown',
          gameId: event.gameId,
          txHash: event.txHash,
        });
      }
      return;
    }
    await this.locks.run(event.gameId, async () => {
      const now = await this.clock.chainNow();
      if (event.type === 'created') await this.onCreated(game, event, now);
      else if (event.type === 'settled') await this.onSettled(game, event, now);
      else await this.onReclaimed(game, event, now);
    });
  }

  async recordSettleSent(gameId: Hex, txHash: Hex, nonce: number, atSec: number): Promise<void> {
    await this.locks.run(gameId, async () => {
      const game = this.games.get(gameId);
      if (game === undefined || game.ended === null) return;
      await this.persist([{ type: 'settle-sent', gameId, txHash, nonce, atSec }]);
      this.log.event({
        event: 'settle-sent',
        chainSec: atSec,
        gameId,
        step: game.ended.steps,
        outcome: game.ended.outcome,
        txHash,
        detail: { nonce, attempt: game.settle.sends },
      });
    });
  }

  // ----- reads for the relayer, the reveal route and tests -----

  get(gameId: Hex): Game | undefined {
    return this.games.get(gameId);
  }

  /** Games that ended in this log and are not yet finished on chain. */
  unsettledGames(): Game[] {
    return [...this.unsettled].map((gameId) => this.games.get(gameId)!);
  }

  /**
   * What the contract reserves for the games this log knows to be `Active` on chain:
   * `max(bet, maxPayout)` each, as `createGame` computes it.
   */
  reservedWei(): bigint {
    let total = 0n;
    for (const gameId of [...this.live, ...this.unsettled]) {
      const { betWei, maxPayoutWei } = this.games.get(gameId)!.chain!;
      total += betWei > maxPayoutWei ? betWei : maxPayoutWei;
    }
    return total;
  }

  /** How much the server holds in memory: every record, and the tickets without a game. */
  counts(): { games: number; uncreatedTickets: number } {
    return { games: this.games.size, uncreatedTickets: this.uncreated.size };
  }

  // ----- internals -----

  private async onCreated(
    game: Game,
    event: Extract<ChainEvent, { type: 'created' }>,
    now: number,
  ): Promise<void> {
    if (game.chain !== null) return;
    const { gameId } = game;
    if (
      event.player.toLowerCase() !== game.player.toLowerCase() ||
      event.tier !== game.tier ||
      event.commitment.toLowerCase() !== game.commitment
    ) {
      // The ticket signature binds all three, so the contract cannot emit this.
      this.log.event({
        level: 'error',
        event: 'chain-created-mismatch',
        chainSec: now,
        gameId,
        txHash: event.txHash,
      });
      return;
    }
    if (event.maxPayoutWei !== exitPayoutWei(this.table, event.betWei, game.tier)) {
      this.log.event({
        level: 'error',
        event: 'chain-created-payout-mismatch',
        chainSec: now,
        gameId,
        txHash: event.txHash,
      });
      return;
    }
    // The contract sets `settleDeadline = block.timestamp + settleWindow`.
    const createdAtSec = event.settleDeadlineSec - this.table.timing.settleWindowSec;
    const maze = await this.buildMaze(this.finalSeedOf(game, event.clientSeed), game.n);
    await this.persist([
      {
        type: 'chain-created',
        gameId,
        clientSeed: event.clientSeed,
        betWei: event.betWei.toString(),
        maxPayoutWei: event.maxPayoutWei.toString(),
        createdAtSec,
        settleDeadlineSec: event.settleDeadlineSec,
        blockNumber: event.blockNumber.toString(),
        startOpen: maskOf(openDirs(maze, START_CELL)),
        atSec: now,
      },
    ]);
    this.mazes.set(gameId, maze);
    this.log.event({
      event: 'chain-created',
      chainSec: now,
      gameId,
      step: 0,
      txHash: event.txHash,
      detail: { createdAtSec, betWei: event.betWei, blockNumber: event.blockNumber },
    });
  }

  private async onSettled(
    game: Game,
    event: Extract<ChainEvent, { type: 'settled' }>,
    now: number,
  ): Promise<void> {
    if (game.final !== null || game.chain === null) return;
    const { gameId } = game;
    const mined: StoreEvent = {
      type: 'settle-mined',
      gameId,
      txHash: event.txHash,
      blockNumber: event.blockNumber.toString(),
      atSec: now,
    };
    const ended = game.ended;
    if (ended === null) {
      // Settled with a signature this log has no record of. Record what the chain says.
      this.log.event({
        level: 'error',
        event: 'settled-without-ending',
        chainSec: now,
        gameId,
        txHash: event.txHash,
      });
      if (event.outcome !== 0 && event.outcome !== 1 && event.outcome !== 2) return;
      await this.persist([
        {
          type: 'ended',
          gameId,
          outcome: event.outcome,
          steps: event.steps,
          payoutWei: event.payoutWei.toString(),
          signature: '0x',
          auto: false,
          cause: 'chain',
          atSec: now,
        },
        mined,
      ]);
    } else {
      if (
        ended.outcome !== event.outcome ||
        ended.steps !== event.steps ||
        ended.payoutWei !== event.payoutWei
      ) {
        this.log.event({
          level: 'error',
          event: 'settled-differently',
          chainSec: now,
          gameId,
          txHash: event.txHash,
        });
      }
      await this.persist([mined]);
    }
    this.mazes.delete(gameId);
    this.log.event({
      event: 'settle-mined',
      chainSec: now,
      gameId,
      step: event.steps,
      outcome: event.outcome,
      txHash: event.txHash,
      detail: { payoutWei: event.payoutWei, blockNumber: event.blockNumber },
    });
  }

  private async onReclaimed(
    game: Game,
    event: Extract<ChainEvent, { type: 'reclaimed' }>,
    now: number,
  ): Promise<void> {
    if (game.final !== null || game.chain === null) return;
    const { gameId } = game;
    await this.persist([
      {
        type: 'reclaimed',
        gameId,
        txHash: event.txHash,
        blockNumber: event.blockNumber.toString(),
        amountWei: event.amountWei.toString(),
        atSec: now,
      },
    ]);
    this.mazes.delete(gameId);
    this.log.event({
      level: 'warn',
      event: 'reclaimed',
      chainSec: now,
      gameId,
      step: game.moves.length,
      txHash: event.txHash,
      detail: { amountWei: event.amountWei },
    });
  }

  /**
   * Ends a game: computes the payout from the recorded steps and the table, signs the
   * settlement, and stores the ending (together with the last move, if a move caused it).
   * The caller holds the game's mutex and has checked that the game has no ending.
   */
  private async finish(
    game: Game,
    p: {
      outcome: OutcomeCode;
      steps: number;
      auto: boolean;
      cause: EndCause;
      now: number;
      moved?: StoreEvent;
    },
  ): Promise<void> {
    const chain = game.chain;
    if (chain === null || game.ended !== null || game.final !== null) {
      throw new Error(`game ${game.gameId} cannot be ended`);
    }
    const { gameId } = game;
    const payoutWei =
      p.outcome === OUTCOME_EXIT
        ? exitPayoutWei(this.table, chain.betWei, game.tier)
        : p.outcome === OUTCOME_CASH_OUT
          ? refundWei(this.table, chain.betWei, game.tier, p.steps)
          : 0n;
    const signature = await this.signer.signSettlement({
      gameId,
      player: game.player,
      outcome: p.outcome,
      steps: p.steps,
      payout: payoutWei,
      serverSeed: game.serverSeed,
    });
    const ended: StoreEvent = {
      type: 'ended',
      gameId,
      outcome: p.outcome,
      steps: p.steps,
      payoutWei: payoutWei.toString(),
      signature,
      auto: p.auto,
      cause: p.cause,
      atSec: p.now,
    };
    await this.persist(p.moved === undefined ? [ended] : [p.moved, ended]);
    this.mazes.delete(gameId);

    if (p.moved !== undefined) {
      this.log.event({ event: 'move', chainSec: p.now, gameId, step: p.steps });
    }
    this.log.event({
      event: 'ended',
      chainSec: p.now,
      gameId,
      step: p.steps,
      outcome: p.outcome,
      detail: { cause: p.cause, auto: p.auto, payoutWei },
    });
    this.hooks.onEnded?.(gameId);
  }

  private async persist(events: readonly StoreEvent[]): Promise<void> {
    await this.store.append(events);
    for (const event of events) this.apply(event);
  }

  /** The only place the in-memory state changes. Used live and when replaying the log. */
  private apply(event: StoreEvent): void {
    if (event.type === 'meta' || event.type === 'block-scanned') return;

    if (event.type === 'ticket-issued') {
      if (this.games.has(event.gameId)) {
        throw new Error(`event log: ticket ${event.gameId} was issued twice`);
      }
      this.games.set(event.gameId, {
        gameId: event.gameId,
        player: event.player,
        tier: event.tier,
        n: event.n,
        serverSeed: event.serverSeed,
        commitment: event.commitment,
        ticketSignature: event.signature,
        sessionTokenHash: event.sessionTokenHash,
        expirySec: event.expirySec,
        chain: null,
        moves: [],
        path: [],
        lastActivitySec: 0,
        ended: null,
        settle: { lastSentSec: null, lastTxHash: null, sends: 0, minedTxHash: null },
        final: null,
      });
      this.uncreated.set(event.gameId, this.games.get(event.gameId)!);
      this.indexTicket(event.player, event.gameId);
      this.noteTicketLine(event.atSec);
      return;
    }

    const game = this.games.get(event.gameId);
    if (game === undefined) throw new Error(`event log: ${event.type} for an unknown game`);
    const { gameId } = game;
    const invalid = (): never => {
      throw new Error(`event log: ${event.type} does not fit the state of game ${gameId}`);
    };

    switch (event.type) {
      case 'ticket-rebound': {
        if (game.chain !== null) invalid();
        game.sessionTokenHash = event.sessionTokenHash;
        this.noteTicketLine(event.atSec);
        return;
      }
      case 'chain-created': {
        if (game.chain !== null) invalid();
        game.chain = {
          clientSeed: event.clientSeed,
          betWei: BigInt(event.betWei),
          maxPayoutWei: BigInt(event.maxPayoutWei),
          createdAtSec: event.createdAtSec,
          settleDeadlineSec: event.settleDeadlineSec,
          blockNumber: BigInt(event.blockNumber),
        };
        game.path = [{ cell: START_CELL, open: event.startOpen }];
        game.lastActivitySec = event.createdAtSec;
        this.uncreated.delete(gameId);
        this.live.add(gameId);
        this.activeGamesOf(game.player).add(gameId);
        return;
      }
      case 'move': {
        if (game.chain === null || game.ended !== null || event.step !== game.moves.length + 1) {
          invalid();
        }
        game.moves.push(event.dir);
        game.path.push({ cell: event.cell, open: event.open });
        game.lastActivitySec = event.atSec;
        return;
      }
      case 'ended': {
        if (game.chain === null || game.ended !== null) invalid();
        // An ending taken from the chain reports the chain's step count, whatever this log holds.
        if (event.cause !== 'chain' && event.steps !== game.moves.length) invalid();
        game.ended = {
          outcome: event.outcome,
          steps: event.steps,
          payoutWei: BigInt(event.payoutWei),
          signature: event.signature,
          auto: event.auto,
          cause: event.cause,
          atSec: event.atSec,
        };
        this.live.delete(gameId);
        if (game.final === null) this.unsettled.add(gameId);
        return;
      }
      case 'settle-sent': {
        if (game.ended === null) invalid();
        game.settle.lastSentSec = event.atSec;
        game.settle.lastTxHash = event.txHash;
        game.settle.sends += 1;
        return;
      }
      case 'settle-mined':
      case 'reclaimed': {
        if (game.chain === null) invalid();
        game.final = event.type === 'settle-mined' ? 'settled' : 'reclaimed';
        if (event.type === 'settle-mined') game.settle.minedTxHash = event.txHash;
        this.live.delete(gameId);
        this.unsettled.delete(gameId);
        this.missedWindow.delete(gameId);
        const active = this.activeByPlayer.get(game.player.toLowerCase());
        active?.delete(gameId);
        if (active?.size === 0) this.activeByPlayer.delete(game.player.toLowerCase());
        return;
      }
    }
  }

  /** Records a ticket under its player for the live-entry check (`apply`, live and on replay). */
  private indexTicket(player: Hex, gameId: Hex): void {
    const key = player.toLowerCase();
    let set = this.ticketsByPlayer.get(key);
    if (set === undefined) {
      set = new Set();
      this.ticketsByPlayer.set(key, set);
    }
    set.add(gameId);
  }

  /** True when the server knows a game of the address to be `Active` on chain. */
  private hasActiveGame(playerKey: string): boolean {
    return (this.activeByPlayer.get(playerKey)?.size ?? 0) > 0;
  }

  /**
   * The address's ticket that has not expired and has not yet created a game, or `null`. A game
   * can still be created from it at `now === expirySec`: the contract accepts a ticket up to
   * and including its expiry second. Synchronous, so the check and what follows it stay atomic
   * under `ticketLocks`. Entries that are no longer outstanding (created on chain, or expired)
   * are dropped from the index as seen.
   */
  private liveTicketOf(playerKey: string, now: number): Game | null {
    const tickets = this.ticketsByPlayer.get(playerKey);
    if (tickets === undefined) return null;
    let live: Game | null = null;
    for (const gameId of [...tickets]) {
      const game = this.games.get(gameId);
      if (game !== undefined && game.chain === null && now <= game.expirySec) live = game;
      else tickets.delete(gameId);
    }
    if (tickets.size === 0) this.ticketsByPlayer.delete(playerKey);
    return live;
  }

  /**
   * Hands the address's outstanding ticket out again, bound to the session token of the new
   * request: the owner rejected the wallet prompt, reloaded the page or lost the answer. The
   * ticket itself (game id, commitment, expiry, server signature) does not change, so the
   * address still has one ticket and can create one game.
   */
  private rebind(game: Game, tokenHash: Hex, now: number): Promise<TicketResponse> {
    return this.locks.run(game.gameId, async () => {
      // Seen on chain while this request waited: the game is in play under its session.
      if (game.chain !== null) throw new ApiError('ALREADY_ACTIVE');
      if (game.sessionTokenHash !== tokenHash) {
        this.requireIssueBudget(now);
        this.issuing += 1;
        try {
          await this.persist([
            {
              type: 'ticket-rebound',
              gameId: game.gameId,
              sessionTokenHash: tokenHash,
              expirySec: game.expirySec,
              atSec: now,
            },
          ]);
        } finally {
          this.issuing -= 1;
        }
        this.log.event({
          event: 'ticket-rebound',
          chainSec: now,
          gameId: game.gameId,
          detail: { player: game.player },
        });
      }
      return toTicketResponse(game, game.ticketSignature);
    });
  }

  /**
   * True when `signature` is `player`'s EIP-191 signature over this server's ticket request for
   * exactly this tier and session token. The signer is recovered from the signature alone, so
   * only externally owned accounts can ask for tickets; a contract wallet cannot.
   */
  private async signedBy(
    player: Hex,
    tier: number,
    sessionTokenHash: Hex,
    signature: unknown,
  ): Promise<boolean> {
    if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return false;
    const message = ticketRequestMessage({
      chainId: this.deps.chainId,
      mazeBetAddress: this.deps.contract,
      player,
      tier,
      sessionTokenHash,
    });
    try {
      return await verifyMessage({ address: player, message, signature: signature as Hex });
    } catch {
      return false;
    }
  }

  /** Tickets that could still create a game at `now` and have not yet, over all addresses. */
  private outstandingTickets(now: number): number {
    let count = 0;
    for (const game of this.uncreated.values()) if (now <= game.expirySec) count += 1;
    return count;
  }

  /** Refuses a ticket line that would exceed the global rate (`apply` records the lines). */
  private requireIssueBudget(now: number): void {
    const recent = this.issueTimes.filter((at) => at > now - TICKET_GLOBAL_WINDOW_SEC).length;
    if (recent + this.issuing >= TICKET_GLOBAL_RATE_MAX) this.refuseForCapacity(now, 'rate');
  }

  private noteTicketLine(atSec: number): void {
    this.issueTimes.push(atSec);
    if (this.issueTimes.length > TICKET_GLOBAL_RATE_MAX) this.issueTimes.shift();
  }

  /** `RATE_LIMITED` for a global limit, logged at most once per window. */
  private refuseForCapacity(now: number, limit: 'outstanding' | 'rate'): never {
    if (now - this.capLoggedSec >= TICKET_GLOBAL_WINDOW_SEC) {
      this.capLoggedSec = now;
      this.log.event({ level: 'warn', event: 'ticket-capacity-reached', chainSec: now, detail: { limit } });
    }
    throw new ApiError('RATE_LIMITED');
  }

  private activeGamesOf(player: Hex): Set<Hex> {
    const key = player.toLowerCase();
    let set = this.activeByPlayer.get(key);
    if (set === undefined) {
      set = new Set();
      this.activeByPlayer.set(key, set);
    }
    return set;
  }

  private countTicket(playerKey: string, now: number): void {
    const recent = (this.ticketTimes.get(playerKey) ?? []).filter(
      (at) => at > now - TICKET_RATE_WINDOW_SEC,
    );
    this.ticketTimes.set(playerKey, recent);
    if (recent.length >= TICKET_RATE_MAX) throw new ApiError('RATE_LIMITED');
    recent.push(now);
    if (this.ticketTimes.size > TICKET_RATE_PRUNE_AT) {
      for (const [key, times] of this.ticketTimes) {
        if (times.every((at) => at <= now - TICKET_RATE_WINDOW_SEC)) this.ticketTimes.delete(key);
      }
    }
  }

  /** The game `token` belongs to. The token hash is compared in constant time. */
  private authorize(gameId: Hex, token: string | null): Game {
    const game = this.games.get(gameId);
    if (game === undefined) throw new ApiError('NOT_FOUND');
    if (token === null) throw new ApiError('UNAUTHORIZED');
    const given = createHash('sha256').update(token, 'utf8').digest();
    const expected = Buffer.from(game.sessionTokenHash.slice(2), 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new ApiError('UNAUTHORIZED');
    }
    return game;
  }

  /**
   * Nothing about a game is shown before the server itself has read its `GameCreated` log
   * (AC-M3). If the watcher has not reached it yet, one scan is made on the spot.
   */
  private async requireOnChain(game: Game): Promise<void> {
    if (game.chain !== null) return;
    await this.hooks.syncChain?.();
    if (game.chain !== null) return;
    const now = await this.clock.chainNow();
    throw new ApiError(now > game.expirySec ? 'TICKET_EXPIRED' : 'NOT_ON_CHAIN');
  }

  private isDue(game: Game, now: number): boolean {
    const chain = game.chain;
    if (chain === null) return false;
    return (
      now >= game.lastActivitySec + this.deps.idleTimeoutSec ||
      now >= chain.createdAtSec + this.deps.maxGameSec
    );
  }

  /**
   * A move, cash-out or start is refused once the game has ended, and also once a deadline has
   * passed on the chain clock even if the worker has not ended the game yet.
   */
  private requirePlayable(game: Game, now: number): void {
    if (game.ended !== null || game.final !== null) throw new ApiError('GAME_NOT_ACTIVE');
    if (this.isDue(game, now)) throw new ApiError('DEADLINE_PASSED');
  }

  private viewOf(game: Game, now: number, withPath: boolean): GameView {
    return toPublicView({
      table: this.table,
      game,
      nowSec: now,
      idleTimeoutSec: this.deps.idleTimeoutSec,
      maxGameSec: this.deps.maxGameSec,
      withPath,
    });
  }

  private finalSeedOf(game: Game, clientSeed: Hex): Hex {
    return deriveFinalSeed({ serverSeed: game.serverSeed, clientSeed, gameId: game.gameId });
  }

  /**
   * Builds the maze of a newly created game. How long Wilson's algorithm runs depends on the
   * whole maze, and a player who calls `/start` before the watcher's next pass waits for this.
   * The timer is armed before the maze is generated and awaited after it, so the call takes
   * `mazePadMs` whatever the maze is (generation takes well under a millisecond).
   */
  private async buildMaze(finalSeed: Hex, n: number): Promise<Maze> {
    const padMs = this.deps.mazePadMs ?? 20;
    const pad = new Promise<void>((resolve) => {
      setTimeout(resolve, padMs);
    });
    const maze = this.mazeFactory(finalSeed, n);
    await pad;
    return maze;
  }
}
