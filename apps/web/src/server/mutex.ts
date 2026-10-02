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
