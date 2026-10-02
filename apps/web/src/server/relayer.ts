// At-least-once settlement loop (plan §3.7).
//
// For every game that has ended in the server's log and is still `Active` on chain, `settle` is
// sent again whenever no `settle` transaction of that game is younger than `RESEND_AFTER_SEC`
// chain seconds, until the game is finished on chain or its deadline has passed. A transaction
// that is dropped, stuck or reverted is therefore simply followed by another one. A send that
// fails outright leaves no transaction behind and is tried again on the next pass, whether or
// not the chain clock has moved in between.
//
// Sends use the node's pending nonce and are serialized by one mutex, which is held only while
// a transaction is being submitted, never while one is waiting to be mined. Together with the
// contract's gas-capped payment this means one game's settlement cannot hold up another's.
// There is no nonce replacement or gap filling: a duplicate `settle` is rejected by the
// contract (`GameNotActive`) and costs gas only.

import { ONCHAIN_STATUS, type Hex } from '@maze/shared';
import type { ChainPort } from './chain';
import type { Clock } from './clock';
import type { Game, GameService } from './game-service';
import { describeError, type Logger } from './log';
import { Mutex } from './mutex';

export const RESEND_AFTER_SEC = 10;
/** An alert is logged when a game is still unsettled this close to its deadline. */
export const ALERT_BEFORE_DEADLINE_SEC = 300;

export class Relayer {
  private readonly mutex = new Mutex();
  /**
   * Chain second at which the node last accepted a `settle` of each game. Set the moment the
   * node answers, before the send is recorded in the log, so that a pass which runs in between
   * cannot send a second transaction. A send the node refused leaves no mark.
   */
  private readonly sentAt = new Map<Hex, number>();
  private readonly alerted = new Set<Hex>();
  private readonly abandoned = new Set<Hex>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      chain: ChainPort;
      service: GameService;
      clock: Clock;
      log: Logger;
    },
  ) {}

  /** One pass over every unsettled game. Called for every new block. */
  async sweep(): Promise<void> {
    const now = await this.deps.clock.chainNow();
    const games = this.deps.service.unsettledGames();
    const pending = new Set(games.map((game) => game.gameId));
    for (const memo of [this.sentAt, this.alerted, this.abandoned]) {
      for (const gameId of memo.keys()) if (!pending.has(gameId)) memo.delete(gameId);
    }
    for (const game of games) await this.attempt(game.gameId, now);
  }

  /** Sends the settlement of a game that has just ended, without waiting for the next block. */
  kick(gameId: Hex): void {
    const run = this.deps.clock.chainNow().then(
      (now) => this.attempt(gameId, now),
      (error: unknown) => this.logFailure(gameId, null, error),
    );
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
  }

  /** Resolves once every send started by `kick` has finished. */
  async drain(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  /** True when no `settle` of the game was accepted by the node in the last `RESEND_AFTER_SEC`. */
  private due(game: Game, now: number): boolean {
    const accepted = this.sentAt.get(game.gameId);
    const recorded = game.settle.lastSentSec;
    const last = accepted === undefined ? recorded : Math.max(accepted, recorded ?? accepted);
    return last === null || now - last >= RESEND_AFTER_SEC;
  }

  /** Never throws: a failure for one game must not stop the pass over the others. */
  private async attempt(gameId: Hex, now: number): Promise<void> {
    try {
      const { service, log } = this.deps;
      const game = service.get(gameId);
      if (game === undefined || game.chain === null || game.ended === null) return;
      if (game.final !== null || game.ended.cause === 'chain') return;
      const deadline = game.chain.settleDeadlineSec;
      const { steps, outcome } = game.ended;

      if (now > deadline) {
        if (!this.abandoned.has(gameId)) {
          this.abandoned.add(gameId);
          log.event({ level: 'alert', event: 'settle-abandoned', chainSec: now, gameId, step: steps, outcome });
        }
        return;
      }
      if (now >= deadline - ALERT_BEFORE_DEADLINE_SEC && !this.alerted.has(gameId)) {
        this.alerted.add(gameId);
        log.event({
          level: 'alert',
          event: 'settle-overdue',
          chainSec: now,
          gameId,
          step: steps,
          outcome,
          txHash: game.settle.lastTxHash,
          detail: { settleDeadlineSec: deadline, sends: game.settle.sends },
        });
      }
      if (!this.due(game, now)) return;

      await this.mutex.run(() => this.send(game, deadline));
    } catch (error) {
      this.logFailure(gameId, now, error);
    }
  }

  private async send(game: Game, deadline: number): Promise<void> {
    const { chain, service, clock } = this.deps;
    const { gameId, ended } = game;
    if (ended === null) return;
    // Everything is checked again: the state may have changed while waiting for the mutex.
    const at = await clock.chainNow();
    if (game.final !== null || at > deadline || !this.due(game, at)) return;

    // "Still Active on chain" is read from the chain, not inferred from the log. When the game
    // is already finished there, the watcher records how.
    const onchain = await chain.game(gameId);
    if (onchain.status !== ONCHAIN_STATUS.Active) return;

    const nonce = await chain.pendingNonce();
    const txHash = await chain.sendSettle(
      {
        gameId,
        outcome: ended.outcome,
        steps: ended.steps,
        payoutWei: ended.payoutWei,
        serverSeed: game.serverSeed,
        signature: ended.signature,
      },
      nonce,
    );
    this.sentAt.set(gameId, at);
    await service.recordSettleSent(gameId, txHash, nonce, at);
  }

  private logFailure(gameId: Hex, now: number | null, error: unknown): void {
    this.deps.log.event({
      level: 'error',
      event: 'settle-send-failed',
      chainSec: now,
      gameId,
      detail: { error: describeError(error) },
    });
  }
}
