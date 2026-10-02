// AC-T9: results are cached per cell under a key that covers the tier's economics, the
// simulator code and the cell definition; an interrupted run resumes to the identical result.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBot } from '../src/bots/index';
import { cacheKey, CacheStore, canonicalJson, tierHash } from '../src/cache';
import { hashedFiles, simCodeHash, simPackageRoot } from '../src/codehash';
import { Game, runGames } from '../src/engine';
import { InlineExecutor, simWorkers, WorkerPool, type Executor } from '../src/pool';
import { PRODUCTION } from '../src/profile';
import { Blocked, CacheMiss, Runner, SliceExpired, tierRef } from '../src/runner';
import { runJob, type Job, type ResultOf } from '../src/worker';
import { econFor, temporaryDirectory, testRunner } from './helpers';

const ECON = econFor(5, 5, 26_300);
const SMALL = { chunkGames: 2000 };

/** Counts jobs, and can fail after a number of them like a process that dies mid-run. */
class CountingExecutor implements Executor {
  readonly size = 1;
  jobs = 0;

  constructor(private readonly dieAfter = Number.POSITIVE_INFINITY) {}

  run<J extends Job>(job: J): Promise<ResultOf<J>> {
    if (this.jobs >= this.dieAfter) return Promise.reject(new Error('killed'));
    this.jobs += 1;
    return Promise.resolve(runJob(job));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function runnerWith(directory: string, executor: Executor, options: { codeHash?: string; deadline?: number; now?: () => number; readOnly?: boolean } = {}): Runner {
  return new Runner({
    executor,
    store: new CacheStore(join(directory, 'cache')),
    profile: { ...PRODUCTION, ...SMALL },
    codeHash: options.codeHash ?? 'code-1',
    rngMode: 'fast',
    deadline: options.deadline ?? Number.POSITIVE_INFINITY,
    now: options.now,
    readOnly: options.readOnly,
  });
}

describe('AC-T9 cache keys', () => {
  it('canonical JSON does not depend on key order and rejects values that have no stable form', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
  });

  it('AC-T9 the key changes with the tier economics, the code hash and every field of the cell', () => {
    // Establishes: a result computed for another table, another code version or another cell can never be read back.
    const definition = { kind: 'eval', profile: 'production', rng: 'fast', w: 5, h: 5, bot: { bot: 'fixed-k-cashout', k: 3 }, stream: 'B', games: 3_000_000, chunk: 2_000_000 };
    const base = cacheKey(tierHash(ECON), 'code-1', definition);
    expect(cacheKey(tierHash(ECON), 'code-1', { ...definition })).toBe(base);
    const variants = [
      cacheKey(tierHash({ ...ECON, multiplierBps: ECON.multiplierBps + 1 }), 'code-1', definition),
      cacheKey(tierHash({ ...ECON, refundBps: ECON.refundBps.map((value, k) => (k === 7 ? value - 1 : value)) }), 'code-1', definition),
      cacheKey(tierHash(ECON), 'code-2', definition),
      cacheKey(tierHash(ECON), 'code-1', { ...definition, bot: { bot: 'fixed-k-cashout', k: 4 } }),
      cacheKey(tierHash(ECON), 'code-1', { ...definition, stream: 'A' }),
      cacheKey(tierHash(ECON), 'code-1', { ...definition, games: 3_000_001 }),
      cacheKey(tierHash(ECON), 'code-1', { ...definition, chunk: 1_000_000 }),
      cacheKey(tierHash(ECON), 'code-1', { ...definition, profile: 'smoke' }),
      cacheKey(tierHash(ECON), 'code-1', { ...definition, rng: 'seed' }),
      cacheKey(tierHash(ECON), 'code-1', { ...definition, kind: 'pair' }),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('AC-T9 the code hash covers engine, worker, posterior, lsm, streams, stats, bots/** and shared rng/maze/economics, and nothing else', () => {
    // Work on a copy of the sources so that the real tree is not touched.
    const root = temporaryDirectory();
    const sim = join(root, 'sim');
    cpSync(join(simPackageRoot(), 'src'), join(sim, 'src'), { recursive: true });
    cpSync(resolve(simPackageRoot(), '..', 'shared', 'src'), join(root, 'shared', 'src'), { recursive: true });
    const base = simCodeHash(sim);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(simCodeHash(sim)).toBe(base);

    const covered = hashedFiles(sim).map((path) => path.slice(root.length + 1));
    for (const name of ['engine', 'worker', 'posterior', 'lsm', 'streams', 'stats']) expect(covered).toContain(join('sim', 'src', `${name}.ts`));
    for (const name of ['rng', 'maze', 'economics']) expect(covered).toContain(join('shared', 'src', `${name}.ts`));
    for (const name of readdirSync(join(sim, 'src', 'bots'))) expect(covered).toContain(join('sim', 'src', 'bots', name));
    expect(covered).toHaveLength(6 + 3 + readdirSync(join(sim, 'src', 'bots')).length);

    const touch = (path: string): string => {
      const before = readFileSync(path);
      writeFileSync(path, `${before.toString('utf8')}\n// touched\n`);
      const hash = simCodeHash(sim);
      writeFileSync(path, before);
      return hash;
    };
    // Every covered file invalidates.
    for (const file of covered) expect(touch(join(root, file)), file).not.toBe(base);
    // A new bot file invalidates.
    writeFileSync(join(sim, 'src', 'bots', 'extra.ts'), 'export const extra = 1;\n');
    expect(simCodeHash(sim)).not.toBe(base);
    writeFileSync(join(sim, 'src', 'bots', 'extra.ts'), '');
    cpSync(join(simPackageRoot(), 'src', 'bots'), join(sim, 'src', 'bots'), { recursive: true });
    // Report, CLI, calibration, certification, exact and tuning code does not.
    for (const name of ['cli', 'report', 'calibrate', 'certify', 'exact', 'search', 'tune', 'cache', 'runner', 'pool', 'sensitivity']) {
      const path = join(sim, 'src', `${name}.ts`);
      expect(existsSync(path), name).toBe(true);
      const before = simCodeHash(sim);
      expect(touch(path), name).toBe(before);
    }
    const sharedBefore = simCodeHash(sim);
    expect(touch(join(root, 'shared', 'src', 'tuning.ts'))).toBe(sharedBefore);
    expect(simCodeHash()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cache store', () => {
  it('returns a chunk only when it is the chunk asked for, and ignores damaged files', () => {
    const store = new CacheStore(join(temporaryDirectory(), 'cache'));
    const stats = { n: 100, sum: 5 };
    store.writeChunk({ schema: 1, key: 'k', chunk: 0, from: 0, to: 100, seconds: 1.5, stats });
    expect(store.readChunk('k', 0, 0, 100)?.stats).toEqual(stats);
    expect(store.readChunk('k', 0, 0, 200)).toBeNull();
    expect(store.readChunk('k', 1, 100, 200)).toBeNull();
    expect(store.readChunk('other', 0, 0, 100)).toBeNull();
    writeFileSync(join(store.root, 'k', 'chunk-0.json'), '{"schema":1,"key":"k","chunk":0,"from":0,"to":100,"stats":{"n":1');
    expect(store.readChunk('k', 0, 0, 100)).toBeNull();
    // A half-written temporary file from a killed process is never taken for a chunk.
    mkdirSync(join(store.root, 'j'), { recursive: true });
    writeFileSync(join(store.root, 'j', 'chunk-0.json.tmp-123'), JSON.stringify({ schema: 1, key: 'j', chunk: 0, from: 0, to: 100, stats }));
    expect(store.readChunk('j', 0, 0, 100)).toBeNull();
  });

  it('artifacts round-trip all array types, and a missing data file is a miss', () => {
    const store = new CacheStore(join(temporaryDirectory(), 'cache'));
    const arrays = { values: Float64Array.from([1.5, Number.NaN, -3]), len: Uint8Array.from([1, 2, 255]), steps: Uint16Array.from([4864, 7, 65535, 9, 1]) };
    store.writeArtifact('a', { meta: { kind: 'test', games: 3 }, arrays });
    const back = store.readArtifact('a')!;
    expect(back.meta).toEqual({ kind: 'test', games: 3 });
    expect(Array.from(back.arrays.values)).toEqual(Array.from(arrays.values));
    expect(Array.from(back.arrays.len)).toEqual([1, 2, 255]);
    expect(Array.from(back.arrays.steps)).toEqual([4864, 7, 65535, 9, 1]);
    expect(back.arrays.values.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(store.readArtifact('missing')).toBeNull();
    store.writeArtifact('b', { meta: {}, arrays: { values: Float64Array.from([1]) } });
    writeFileSync(join(store.root, 'artifacts', 'b.bin'), new Uint8Array(3));
    expect(store.readArtifact('b')).toBeNull();
  });

  it('the run-time ledger accumulates across processes', () => {
    const directory = join(temporaryDirectory(), 'cache');
    const first = new CacheStore(directory);
    first.addCellSeconds('cell', 10);
    first.addCampaignSeconds('tune', 100);
    const second = new CacheStore(directory);
    second.addCellSeconds('cell', 5.5);
    second.addCampaignSeconds('tune', 50);
    expect(new CacheStore(directory).cellSeconds('cell')).toBe(15.5);
    expect(new CacheStore(directory).campaignSeconds('tune')).toBe(150);
    expect(new CacheStore(directory).cellSeconds('other')).toBe(0);
  });
});

describe('AC-T9 resumable cells', () => {
  const tier = tierRef(ECON);
  const games = 9000; // five chunks of 2,000 (the last one of 1,000)

  it('a cell equals the direct run of the same games and is not computed twice', async () => {
    const directory = temporaryDirectory();
    const executor = new CountingExecutor();
    const runner = runnerWith(directory, executor);
    const cell = await runner.evalCell(tier, { bot: 'nervous', epsilon: 0.1 }, 'B', games);
    const g = new Game(ECON);
    expect(cell.stats).toEqual(runGames(g, createBot({ bot: 'nervous', epsilon: 0.1 }, g), { kind: 'rng', mode: 'fast', stream: 'B' }, 0, games));
    expect(cell.chunks).toBe(5);
    expect(runner.newUnits).toBe(5);
    const jobs = executor.jobs;
    const again = await runnerWith(directory, executor).evalCell(tier, { bot: 'nervous', epsilon: 0.1 }, 'B', games);
    expect(executor.jobs).toBe(jobs);
    expect(again.stats).toEqual(cell.stats);
    expect(again.key).toBe(cell.key);
  });

  it('AC-T9 a code change or a table change invalidates the cell', async () => {
    const directory = temporaryDirectory();
    const executor = new CountingExecutor();
    const first = await runnerWith(directory, executor).evalCell(tier, { bot: 'naive-greedy' }, 'B', games);
    const afterFirst = executor.jobs;
    const otherCode = await runnerWith(directory, executor, { codeHash: 'code-2' }).evalCell(tier, { bot: 'naive-greedy' }, 'B', games);
    expect(otherCode.key).not.toBe(first.key);
    expect(executor.jobs).toBe(2 * afterFirst);
    const otherTable = await runnerWith(directory, executor).evalCell(tierRef({ ...ECON, multiplierBps: ECON.multiplierBps + 100 }), { bot: 'naive-greedy' }, 'B', games);
    expect(otherTable.key).not.toBe(first.key);
    expect(executor.jobs).toBe(3 * afterFirst);
    // The read-only check (what verify:all does) sees the cell under the old code only.
    await expect(runnerWith(directory, new InlineExecutor(), { readOnly: true }).evalCell(tier, { bot: 'naive-greedy' }, 'B', games)).resolves.toMatchObject({ key: first.key });
    await expect(runnerWith(directory, new InlineExecutor(), { readOnly: true, codeHash: 'code-3' }).evalCell(tier, { bot: 'naive-greedy' }, 'B', games)).rejects.toBeInstanceOf(CacheMiss);
  });

  it('AC-T9 a run that stops when its work slice ends resumes to the identical result', async () => {
    // Establishes: exit code 2 and a second call give exactly what one uninterrupted call gives.
    const reference = await runnerWith(temporaryDirectory(), new CountingExecutor()).evalCell(tier, { bot: 'nervous', epsilon: 0.1 }, 'B', games);

    const directory = temporaryDirectory();
    const executor = new CountingExecutor();
    // A clock that reaches the deadline after the second chunk.
    let ticks = 0;
    const sliced = runnerWith(directory, executor, { deadline: 6, now: () => ticks++ });
    await expect(sliced.evalCell(tier, { bot: 'nervous', epsilon: 0.1 }, 'B', games)).rejects.toBeInstanceOf(SliceExpired);
    expect(sliced.newUnits).toBeGreaterThan(0);
    expect(sliced.newUnits).toBeLessThan(5);
    const done = sliced.newUnits;
    const resumed = runnerWith(directory, executor);
    const cell = await resumed.evalCell(tier, { bot: 'nervous', epsilon: 0.1 }, 'B', games);
    expect(resumed.newUnits).toBe(5 - done);
    expect(cell.stats).toEqual(reference.stats);
    expect(cell.rtp).toEqual(reference.rtp);
    expect(cell.key).toBe(reference.key);
  });

  it('AC-T9 a run that is killed in the middle of a chunk resumes to the identical result', async () => {
    const reference = await runnerWith(temporaryDirectory(), new CountingExecutor()).evalCell(tier, { bot: 'sloppy-greedy', epsilon: 0.1 }, 'B', games);
    for (const dieAfter of [0, 1, 3, 4]) {
      const directory = temporaryDirectory();
      await expect(runnerWith(directory, new CountingExecutor(dieAfter)).evalCell(tier, { bot: 'sloppy-greedy', epsilon: 0.1 }, 'B', games)).rejects.toThrow('killed');
      const chunksOnDisk = existsSync(join(directory, 'cache', reference.key))
        ? readdirSync(join(directory, 'cache', reference.key)).filter((name) => /^chunk-\d+\.json$/.test(name)).length
        : 0;
      expect(chunksOnDisk).toBe(dieAfter);
      const executor = new CountingExecutor();
      const cell = await runnerWith(directory, executor).evalCell(tier, { bot: 'sloppy-greedy', epsilon: 0.1 }, 'B', games);
      expect(executor.jobs).toBe(5 - dieAfter);
      expect(cell.stats).toEqual(reference.stats);
    }
  });

  it('a paired cell resumes the same way', async () => {
    const pairs = 250;
    const profile = { pairChunk: 100 };
    const make = (directory: string, executor: Executor): Runner =>
      new Runner({ executor, store: new CacheStore(join(directory, 'cache')), profile: { ...PRODUCTION, ...profile }, codeHash: 'code-1', rngMode: 'fast', deadline: Number.POSITIVE_INFINITY });
    const reference = await make(temporaryDirectory(), new CountingExecutor()).pairCell(tier, { bot: 'harmonic' }, { bot: 'naive-greedy' }, 'D', pairs);
    const directory = temporaryDirectory();
    await expect(make(directory, new CountingExecutor(2)).pairCell(tier, { bot: 'harmonic' }, { bot: 'naive-greedy' }, 'D', pairs)).rejects.toThrow('killed');
    const cell = await make(directory, new CountingExecutor()).pairCell(tier, { bot: 'harmonic' }, { bot: 'naive-greedy' }, 'D', pairs);
    expect(cell.stats).toEqual(reference.stats);
    expect(cell.diff.mean).toBeCloseTo(cell.adversaryRtp.mean - cell.referenceRtp.mean, 12);
    expect(cell.games).toBe(pairs);
  });

  it('a cell over its run-time limit is BLOCKED(runtime), never shortened', async () => {
    const directory = temporaryDirectory();
    const runner = runnerWith(directory, new CountingExecutor());
    const key = runner.cellKey(tier, { bot: 'naive-greedy' }, 'B', games);
    runner.store.addCellSeconds(key, 6 * 3600 + 1);
    await expect(runner.evalCell(tier, { bot: 'naive-greedy' }, 'B', games)).rejects.toMatchObject({ name: 'Blocked', kind: 'runtime' });
    await expect(runner.evalCell(tier, { bot: 'naive-greedy' }, 'B', games)).rejects.toBeInstanceOf(Blocked);
  });

  it('trained tables are cached under their definition and reused', async () => {
    const directory = temporaryDirectory();
    const executor = new CountingExecutor();
    const runner = testRunner(directory, { minSamples: 30 });
    const key = await runner.valueTableScratch(tier, { lookahead: 'near-tie', threshold: 0.2 }, 1, 3000);
    const units = runner.newUnits;
    expect(units).toBe(1 + PRODUCTION.trainPasses);
    const second = new Runner({ executor, store: new CacheStore(join(directory, 'cache')), profile: { ...PRODUCTION, minSamples: 30 }, codeHash: 'test-code-hash', rngMode: 'fast', deadline: Number.POSITIVE_INFINITY });
    expect(await second.valueTableScratch(tier, { lookahead: 'near-tie', threshold: 0.2 }, 1, 3000)).toBe(key);
    expect(executor.jobs).toBe(0);
    expect(Array.from(second.loadTable(key).values)).toEqual(Array.from(runner.loadTable(key).values));
    // Another multiplier is another table.
    expect(await runner.valueTableScratch(tierRef({ ...ECON, multiplierBps: 27_000 }), { lookahead: 'near-tie', threshold: 0.2 }, 1, 3000)).not.toBe(key);
  });
});

describe('worker threads', () => {
  it('the worker cap is max(1, min(8, cores − 4)) and SIM_WORKERS can only lower it', () => {
    expect(simWorkers({}, 12)).toBe(8);
    expect(simWorkers({}, 16)).toBe(8);
    expect(simWorkers({}, 6)).toBe(2);
    expect(simWorkers({}, 2)).toBe(1);
    expect(simWorkers({ SIM_WORKERS: '3' }, 12)).toBe(3);
    expect(simWorkers({ SIM_WORKERS: '64' }, 12)).toBe(8);
    expect(simWorkers({ SIM_WORKERS: 'x' }, 12)).toBe(8);
  });

  it('a job gives the same result on a worker thread as on the calling thread', async () => {
    // Establishes: the pool only moves work; it cannot change a result.
    const pool = new WorkerPool(2, pathToFileURL(join(simPackageRoot(), 'src', 'worker.ts')), ['--import', 'tsx']);
    try {
      const job: Job = { kind: 'eval', econ: ECON, bot: { bot: 'nervous', epsilon: 0.1 }, source: { kind: 'rng', mode: 'fast', stream: 'B' }, from: 500, to: 2500 };
      const [a, b] = await Promise.all([pool.run(job), pool.run({ ...job, kind: 'pair', botA: { bot: 'harmonic' }, botB: { bot: 'naive-greedy' } } as Job)]);
      expect(a).toEqual(runJob(job));
      expect(b).toEqual(runJob({ ...job, kind: 'pair', botA: { bot: 'harmonic' }, botB: { bot: 'naive-greedy' } } as Job));
      await expect(pool.run({ ...job, econ: { ...ECON, refundBps: [1, 2, 3] } })).rejects.toThrow(/refund table/);
    } finally {
      await pool.close();
    }
  }, 120_000);
});
