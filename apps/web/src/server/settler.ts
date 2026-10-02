// The settlement worker: one pass per new block (plan §7.7).
//
// A pass (1) reads the contract's new game events, which is what starts a game's clock,
// (2) ends every game whose idle or game deadline has passed with a cash-out at its current
// step, and (3) lets the relayer send or re-send every settlement that is due. The worker polls
// for a new block every `pollMs` milliseconds; all decisions inside a pass use the chain clock.

import type { Watcher } from './chain';
import type { GameService } from './game-service';
import { describeError, type Logger } from './log';
import type { Relayer } from './relayer';

export class Worker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private started = false;
  private failing = false;

  constructor(
    private readonly deps: {
      watcher: Watcher;
      service: GameService;
      relayer: Relayer;
      log: Logger;
      pollMs: number;
    },
  ) {}

  /** Runs one pass. A pass already in progress is joined rather than doubled. */
  tick(): Promise<void> {
    if (this.running === null) {
      this.running = this.pass().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  private async pass(): Promise<void> {
    const { watcher, service, relayer } = this.deps;
    await watcher.sync();
    await service.expireDue();
    await relayer.sweep();
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.tick()
        .then(
          () => {
            if (this.failing) this.deps.log.event({ event: 'worker-recovered' });
            this.failing = false;
          },
          (error: unknown) => {
            // Logged once per outage, not once per poll.
            if (!this.failing) {
              this.deps.log.event({
                level: 'error',
                event: 'worker-error',
                detail: { error: describeError(error) },
              });
            }
            this.failing = true;
          },
        )
        .finally(() => {
          if (this.started) this.schedule();
        });
    }, this.deps.pollMs);
    // The poll must not keep a finished script or test process alive.
    this.timer.unref();
  }
}
