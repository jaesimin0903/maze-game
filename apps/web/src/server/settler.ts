// The settlement worker: one pass per new block (plan §7.7).
//
// A pass (1) reads the contract's new game events, which is what starts a game's clock,
// (2) forgets tickets that can no longer create a game, (3) ends every game whose idle or game
// deadline has passed with a cash-out at its current step, and (4) lets the relayer send or
// re-send every settlement that is due. The worker polls for a new block every `pollMs`
// milliseconds; all decisions inside a pass use the chain clock.
//
// The steps of a pass do not depend on each other's success. A step that fails is reported and
// the steps after it still run: a chain scan that cannot be completed must not keep the games
// the server already knows from being cashed out and settled before their settle deadline.

import type { Watcher } from './chain';
import type { GameService } from './game-service';
import { describeError, type Logger } from './log';
import type { Relayer } from './relayer';

export class Worker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private started = false;
  private failing = false;
  /** `performance.now()` at the end of the last pass in which every step succeeded. */
  private completedAtMs: number | null = null;

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

  /**
   * Milliseconds since a pass last completed with every step successful, or `null` when none
   * has. Measured on the process's monotonic clock: this is about the worker being alive, not
   * about a game deadline.
   */
  sinceCompletedMs(): number | null {
    return this.completedAtMs === null ? null : performance.now() - this.completedAtMs;
  }

  /** Every step runs; the pass fails with the first failure once all of them have. */
  private async pass(): Promise<void> {
    const { watcher, service, relayer } = this.deps;
    const steps: [name: string, run: () => Promise<void>][] = [
      ['chain-scan', () => watcher.sync()],
      ['ticket-expiry', async () => service.forgetDeadTickets(watcher.scannedTimeSec)],
      ['auto-cashout', () => service.expireDue()],
      ['settle-sweep', () => relayer.sweep()],
    ];
    let failure: Error | null = null;
    for (const [name, run] of steps) {
      try {
        await run();
      } catch (error) {
        failure ??= new Error(`${name}: ${describeError(error)}`);
      }
    }
    if (failure !== null) throw failure;
    this.completedAtMs = performance.now();
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
