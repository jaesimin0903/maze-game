// Promise-based mutual exclusion. Requests for one game, chain scans and relayer sends are each
// serialized through one of these (plan §4.2).

/** Runs callers one at a time, in arrival order. A failing caller does not block the next one. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** One `Mutex` per key, created on demand and dropped once nobody holds or waits for it. */
export class KeyedMutex {
  private readonly entries = new Map<string, { mutex: Mutex; users: number }>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { mutex: new Mutex(), users: 0 };
      this.entries.set(key, entry);
    }
    entry.users += 1;
    try {
      return await entry.mutex.run(fn);
    } finally {
      entry.users -= 1;
      if (entry.users === 0) this.entries.delete(key);
    }
  }
}

/**
 * `run` made single-flight. A call while no run is going starts one. A call during a run does not
 * queue a run of its own: it shares the next run, which starts when the current one has finished
 * and serves every caller that arrived meanwhile. Each caller thus waits for a run that started
 * after its call, and a burst of callers costs two runs, not one each.
 */
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let next: Promise<void> | null = null;
  const start = (): Promise<void> => {
    const current: Promise<void> = run().finally(() => {
      if (running === current) running = null;
    });
    running = current;
    return current;
  };
  return () => {
    if (running === null) return start();
    next ??= running
      .catch(() => undefined)
      .then(() => {
        next = null;
        return start();
      });
    return next;
  };
}
