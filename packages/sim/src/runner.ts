// Resumable simulation primitives (plan §9.3).
//
// Everything expensive goes through a `Runner`, and everything a `Runner` computes is stored
// under a key derived from its complete definition. A command is therefore a deterministic
// program that can be run again from the top after any interruption: finished units are read
// back, and work resumes at the first unit that is missing.
//
//   cell      = (bot, hyperparameters, grid, stream, games), split into cached chunks
//   artifact  = a trained table, a recorded trajectory set or a search result
//
// The runner only stores, looks up and dispatches. Everything that determines a result (how a
// cell's games are split into jobs, how job results merge, how a table is built from a pass)
// lives in the files the simulator code hash covers, so a change to it changes every key.
//
// Before each new unit the runner checks the work slice (`SliceExpired` → exit code 2) and the
// per-cell run-time limit (`Blocked('runtime')` → exit code 3). No path lowers a game count.

import { memberLabel, type BotSpec, type SuiteMember, type ValueHyper } from './bots/index';
import { cacheKey, CacheStore, tierHash, type Artifact } from './cache';
import {
  closeStats,
  emptyPairStats,
  emptyStats,
  mergePairStats,
  mergeStats,
  type ChunkStats,
  type MazeSource,
  type PairStats,
  type TierEconomics,
} from './engine';
import type { EnumeratedMazes } from './exact';
import {
  addAccumulator,
  addRegionAccumulator,
  concatTrajectories,
  finalizeRegionTable,
  harmonicLsmTable,
  newAccumulator,
  newRegionAccumulator,
  shapeOf,
  tableFromHarmonicPass,
  tableFromValuePass,
  type RegionTable,
  type TableAccumulator,
  type Trajectories,
  type ValueTable,
} from './lsm';
import type { Executor } from './pool';
import type { Profile } from './profile';
import { estimate, scaleMoments, type Estimate } from './stats';
import type { RngMode, StreamName } from './streams';
import { jobGames, splitRange, type TrainPolicy } from './worker';

/** The work slice is used up: the command must exit with code 2 and be called again. */
export class SliceExpired extends Error {
  constructor() {
    super('the work slice is used up; call the command again to continue');
    this.name = 'SliceExpired';
  }
}

/** A BLOCKED condition of plan §8.6. Never reported as success. */
export class Blocked extends Error {
  constructor(
    readonly kind: 'economic' | 'runtime',
    message: string,
  ) {
    super(message);
    this.name = 'Blocked';
  }
}

/** A read-only runner needed something that is not in the cache. */
export class CacheMiss extends Error {
  constructor(what: string) {
    super(`not in the cache: ${what}`);
    this.name = 'CacheMiss';
  }
}

/** A tier's economics together with the hash that keys its cells. */
export interface TierRef {
  econ: TierEconomics;
  hash: string;
}

export function tierRef(econ: TierEconomics): TierRef {
  return { econ, hash: tierHash(econ) };
}

/**
 * A bot as it appears in a cell definition: name, parameters and, for the learning bots, the
 * cache key of the table it plays with. Everything that determines the bot's behaviour is here.
 */
export type BotDef =
  | Exclude<
      SuiteMember,
      { bot: 'region-heuristic' | 'param-search' | 'harmonic-lsm' | 'value-table' | 'value-lsm' | 'value-lookahead-all' | 'rollout' }
    >
  | { bot: 'oracle-stop' }
  | { bot: 'region-heuristic'; table: string }
  | { bot: 'param-search'; theta: number[] }
  | { bot: 'harmonic-lsm'; table: string }
  | { bot: 'value-table'; table: string }
  | { bot: 'value-lsm'; table: string; hyper: ValueHyper }
  | { bot: 'value-lookahead-all'; table: string }
  | { bot: 'rollout'; samples: number; table: string };

export function botLabel(def: BotDef): string {
  if (def.bot === 'oracle-stop') return def.bot;
  return memberLabel(def as SuiteMember);
}

export interface CellResult {
  key: string;
  bot: BotDef;
  label: string;
  stream: StreamName;
  games: number;
  chunks: number;
  stats: ChunkStats;
  /** Return to player as a fraction of the bet. */
  rtp: Estimate;
  /** Share of games that reached the exit: the slope of the RTP in the multiplier. */
  winRate: number;
  /** Wall-clock seconds spent computing the cell's chunks. */
  seconds: number;
}

export interface PairResult {
  key: string;
  adversary: BotDef;
  reference: BotDef;
  stream: StreamName;
  games: number;
  stats: PairStats;
  /** Adversary minus reference, as a fraction of the bet. */
  diff: Estimate;
  adversaryRtp: Estimate;
  referenceRtp: Estimate;
  seconds: number;
}

/** RTP estimate (fraction of the bet) of a run whose payouts were recorded in bps. */
export function rtpOf(stats: ChunkStats): Estimate {
  return estimate(scaleMoments({ n: stats.n, sum: stats.sum, sumSq: stats.sumSq }, 1 / 10_000));
}

function perJob(def: BotDef): number {
  return jobGames(def.bot, def.bot === 'value-lsm' && def.hyper.lookahead === 'all');
}

export interface RunnerOptions {
  executor: Executor;
  store: CacheStore;
  profile: Profile;
  codeHash: string;
  rngMode: RngMode;
  /** Epoch milliseconds after which no new unit of work is started. */
  deadline: number;
  /** True for `--check`: nothing is computed, a missing unit raises `CacheMiss`. */
  readOnly?: boolean;
  log?: (line: string) => void;
  now?: () => number;
}

export class Runner {
  readonly executor: Executor;
  readonly store: CacheStore;
  readonly profile: Profile;
  readonly codeHash: string;
  readonly rngMode: RngMode;
  readonly readOnly: boolean;
  private readonly deadline: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly tables = new Map<string, ValueTable>();
  private readonly regions = new Map<string, RegionTable>();
  private readonly trajectorySets = new Map<string, Trajectories>();
  /** Units (chunks, training passes, …) computed by this runner, as opposed to read from the cache. */
  newUnits = 0;

  constructor(options: RunnerOptions) {
    this.executor = options.executor;
    this.store = options.store;
    this.profile = options.profile;
    this.codeHash = options.codeHash;
    this.rngMode = options.rngMode;
    this.deadline = options.deadline;
    this.readOnly = options.readOnly ?? false;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  /** Throws unless a new unit of work may start now. */
  checkpoint(what: string, cellKey: string | null = null): void {
    if (this.readOnly) throw new CacheMiss(what);
    if (this.now() >= this.deadline) throw new SliceExpired();
    if (cellKey !== null && this.store.cellSeconds(cellKey) > this.profile.cellHours * 3600) {
      throw new Blocked('runtime', `${what} has run for more than ${this.profile.cellHours} hours in total`);
    }
  }

  private source(stream: StreamName, enumerated?: EnumeratedMazes): MazeSource {
    if (enumerated !== undefined) return { kind: 'enum', stream, mazes: enumerated.mazes, count: enumerated.count };
    return { kind: 'rng', mode: this.rngMode, stream };
  }

  private sourceTag(enumerated?: EnumeratedMazes): string {
    return enumerated !== undefined ? 'enum' : this.rngMode;
  }

  /** Turns a bot definition into something a worker can build: tables are loaded from the cache. */
  resolve(def: BotDef): BotSpec {
    switch (def.bot) {
      case 'region-heuristic':
        return { bot: def.bot, table: this.loadRegion(def.table) };
      case 'harmonic-lsm':
      case 'value-table':
      case 'value-lookahead-all':
        return { bot: def.bot, table: this.loadTable(def.table) };
      case 'value-lsm':
        return { bot: def.bot, table: this.loadTable(def.table), hyper: def.hyper };
      case 'rollout':
        return { bot: def.bot, samples: def.samples, table: this.loadTable(def.table) };
      default:
        return def;
    }
  }

  private evalDefinition(tier: TierRef, bot: BotDef, stream: StreamName, games: number, enumerated?: EnumeratedMazes) {
    return {
      kind: 'eval',
      profile: this.profile.name,
      rng: this.sourceTag(enumerated),
      w: tier.econ.w,
      h: tier.econ.h,
      bot,
      stream,
      games,
      chunk: this.profile.chunkGames,
    };
  }

  /** Cache key of a cell. Computes nothing. */
  cellKey(tier: TierRef, bot: BotDef, stream: StreamName, games: number, enumerated?: EnumeratedMazes): string {
    return cacheKey(tier.hash, this.codeHash, this.evalDefinition(tier, bot, stream, games, enumerated));
  }

  /** Runs `bot` over games `0 .. games - 1` of `stream`, chunk by chunk, reusing cached chunks. */
  async evalCell(tier: TierRef, bot: BotDef, stream: StreamName, games: number, enumerated?: EnumeratedMazes): Promise<CellResult> {
    const chunkGames = this.profile.chunkGames;
    const definition = this.evalDefinition(tier, bot, stream, games, enumerated);
    const key = cacheKey(tier.hash, this.codeHash, definition);
    const label = botLabel(bot);
    const source = this.source(stream, enumerated);
    const spans = splitRange(0, games, chunkGames);
    let total: ChunkStats | null = null;
    let seconds = 0;
    let spec: BotSpec | null = null;
    for (let c = 0; c < spans.length; c++) {
      const [from, to] = spans[c];
      let record = this.store.readChunk<ChunkStats>(key, c, from, to);
      if (record === null) {
        const what = `cell ${label} ${tier.econ.w}x${tier.econ.h} stream ${stream} chunk ${c + 1}/${spans.length}`;
        this.checkpoint(what, key);
        spec ??= this.resolve(bot);
        const jobSpec = spec;
        this.store.writeCellDefinition(key, { ...definition, tier: tier.hash, codeHash: this.codeHash });
        const started = this.now();
        const parts = await Promise.all(
          splitRange(from, to, perJob(bot)).map(([a, b]) =>
            this.executor.run({ kind: 'eval', econ: tier.econ, bot: jobSpec, source, from: a, to: b }),
          ),
        );
        const stats = emptyStats(tier.econ.w * tier.econ.h, parts[0].expected);
        for (const part of parts) mergeStats(stats, part);
        closeStats(stats, tier.econ);
        const elapsed = (this.now() - started) / 1000;
        record = { schema: 1, key, chunk: c, from, to, seconds: elapsed, stats };
        this.store.writeChunk(record);
        this.store.addCellSeconds(key, elapsed);
        this.store.addGames(`${enumerated !== undefined ? 'exact-eval' : 'eval'}:${stream}`, to - from);
        this.newUnits += 1;
        this.log(`${what}: ${to - from} games in ${elapsed.toFixed(1)}s`);
      }
      total ??= emptyStats(tier.econ.w * tier.econ.h, record.stats.expected);
      mergeStats(total, record.stats);
      seconds += record.seconds;
    }
    if (total === null) throw new RangeError('evalCell: a cell needs at least one game');
    closeStats(total, tier.econ);
    return {
      key,
      bot,
      label,
      stream,
      games,
      chunks: spans.length,
      stats: total,
      rtp: rtpOf(total),
      winRate: total.wins / total.n,
      seconds,
    };
  }

  /** Plays `adversary` and `reference` on the same games of `stream`; `D = adversary - reference`. */
  async pairCell(tier: TierRef, adversary: BotDef, reference: BotDef, stream: StreamName, games: number): Promise<PairResult> {
    const chunkGames = this.profile.pairChunk;
    const definition = {
      kind: 'pair',
      profile: this.profile.name,
      rng: this.rngMode,
      w: tier.econ.w,
      h: tier.econ.h,
      adversary,
      reference,
      stream,
      games,
      chunk: chunkGames,
    };
    const key = cacheKey(tier.hash, this.codeHash, definition);
    const label = `${botLabel(adversary)} vs ${botLabel(reference)}`;
    const source = this.source(stream);
    const spans = splitRange(0, games, chunkGames);
    const cells = tier.econ.w * tier.econ.h;
    const total = emptyPairStats(cells);
    let seconds = 0;
    let specs: [BotSpec, BotSpec] | null = null;
    const pairsPerJob = Math.min(perJob(adversary), perJob(reference));
    for (let c = 0; c < spans.length; c++) {
      const [from, to] = spans[c];
      let record = this.store.readChunk<PairStats>(key, c, from, to);
      if (record === null) {
        const what = `pair ${label} ${tier.econ.w}x${tier.econ.h} stream ${stream} chunk ${c + 1}/${spans.length}`;
        this.checkpoint(what, key);
        specs ??= [this.resolve(adversary), this.resolve(reference)];
        const [botA, botB] = specs;
        this.store.writeCellDefinition(key, { ...definition, tier: tier.hash, codeHash: this.codeHash });
        const started = this.now();
        const parts = await Promise.all(
          splitRange(from, to, pairsPerJob).map(([a, b]) =>
            this.executor.run({ kind: 'pair', econ: tier.econ, botA, botB, source, from: a, to: b }),
          ),
        );
        const stats = emptyPairStats(cells);
        for (const part of parts) mergePairStats(stats, part);
        closeStats(stats.a, tier.econ);
        closeStats(stats.b, tier.econ);
        const elapsed = (this.now() - started) / 1000;
        record = { schema: 1, key, chunk: c, from, to, seconds: elapsed, stats };
        this.store.writeChunk(record);
        this.store.addCellSeconds(key, elapsed);
        // A pair is two games: one per bot on the same maze.
        this.store.addGames(`pair:${stream}`, 2 * (to - from));
        this.newUnits += 1;
        this.log(`${what}: ${to - from} pairs in ${elapsed.toFixed(1)}s`);
      }
      mergePairStats(total, record.stats);
      seconds += record.seconds;
    }
    closeStats(total.a, tier.econ);
    closeStats(total.b, tier.econ);
    return {
      key,
      adversary,
      reference,
      stream,
      games,
      stats: total,
      diff: estimate(scaleMoments({ n: total.n, sum: total.sumD, sumSq: total.sumSqD }, 1 / 10_000)),
      adversaryRtp: rtpOf(total.a),
      referenceRtp: rtpOf(total.b),
      seconds,
    };
  }

  private loadArtifact(key: string, what: string): Artifact {
    const artifact = this.store.readArtifact(key);
    if (artifact === null) throw new CacheMiss(`${what} ${key}`);
    return artifact;
  }

  /** A trained value table by its cache key. */
  loadTable(key: string): ValueTable {
    let table = this.tables.get(key);
    if (table === undefined) {
      const { meta, arrays } = this.loadArtifact(key, 'value table');
      table = {
        cells: meta.cells as number,
        shortest: meta.shortest as number,
        qBins: meta.qBins as number,
        rBins: meta.rBins as number,
        binCentreFallback: meta.binCentreFallback as boolean,
        values: arrays.values as Float64Array,
        winAtDistance: arrays.winAtDistance as Float64Array,
      };
      this.tables.set(key, table);
    }
    return table;
  }

  private saveTable(key: string, table: ValueTable, extra: Record<string, unknown>): void {
    this.store.writeArtifact(key, {
      meta: {
        ...extra,
        cells: table.cells,
        shortest: table.shortest,
        qBins: table.qBins,
        rBins: table.rBins,
        binCentreFallback: table.binCentreFallback,
      },
      arrays: { values: table.values, winAtDistance: table.winAtDistance },
    });
  }

  loadRegion(key: string): RegionTable {
    let table = this.regions.get(key);
    if (table === undefined) {
      const { meta, arrays } = this.loadArtifact(key, 'region table');
      table = { cells: meta.cells as number, shortest: meta.shortest as number, win: arrays.win as Float64Array };
      this.regions.set(key, table);
    }
    return table;
  }

  private async trainPass(
    econ: TierEconomics,
    policy: TrainPolicy,
    rBins: number,
    games: number,
    enumerated: EnumeratedMazes | undefined,
  ): Promise<TableAccumulator> {
    const size = policy.kind === 'harmonic' ? jobGames('harmonic') : jobGames('value-lsm', policy.hyper.lookahead === 'all');
    const source = this.source('C', enumerated);
    const parts = await Promise.all(
      splitRange(0, games, size).map(([a, b]) => this.executor.run({ kind: 'train', econ, policy, rBins, source, from: a, to: b })),
    );
    const acc = newAccumulator(shapeOf(econ.w, econ.h, rBins));
    for (const part of parts) addAccumulator(acc, part);
    this.store.addGames(enumerated !== undefined ? 'exact-train:C' : 'train:C', games);
    return acc;
  }

  private harmonicPassKey(w: number, h: number, rBins: number, games: number, enumerated?: EnumeratedMazes): string {
    return cacheKey('grid', this.codeHash, {
      kind: 'lsm-harmonic-pass',
      profile: this.profile.name,
      rng: this.sourceTag(enumerated),
      w,
      h,
      rBins,
      games,
      stream: 'C',
    });
  }

  /**
   * Training pass 0: harmonic moves, no cash-out, wins recorded instead of payouts. It depends
   * on the grid only, so one pass serves every curve and every multiplier of that grid.
   */
  async harmonicPass(
    w: number,
    h: number,
    rBins: number,
    games: number,
    enumerated?: EnumeratedMazes,
  ): Promise<{ key: string; acc: TableAccumulator }> {
    const key = this.harmonicPassKey(w, h, rBins, games, enumerated);
    const cached = this.store.readArtifact(key);
    if (cached !== null) {
      const { sum, cnt, cntAt, winAt } = cached.arrays as Record<string, Float64Array>;
      return { key, acc: { sum, cnt, cntAt, winAt } };
    }
    this.checkpoint(`harmonic training pass ${w}x${h}`);
    const started = this.now();
    const econ: TierEconomics = { w, h, multiplierBps: 10_000, refundBps: new Array<number>(w * h).fill(0) };
    const acc = await this.trainPass(econ, { kind: 'harmonic' }, rBins, games, enumerated);
    this.store.writeArtifact(key, { meta: { kind: 'lsm-harmonic-pass', w, h, rBins, games }, arrays: { ...acc } });
    this.newUnits += 1;
    this.log(`harmonic training pass ${w}x${h}: ${games} games in ${((this.now() - started) / 1000).toFixed(1)}s`);
    return { key, acc };
  }

  private passKey(tier: TierRef, hyper: ValueHyper, rBins: number, games: number, parent: string, enumerated?: EnumeratedMazes): string {
    return cacheKey(tier.hash, this.codeHash, {
      kind: 'lsm-pass',
      profile: this.profile.name,
      rng: this.sourceTag(enumerated),
      hyper,
      rBins,
      games,
      minSamples: this.profile.minSamples,
      stream: 'C',
      parent,
    });
  }

  /** One policy-iteration pass: walk stream C with `parent` as the policy, return the new table's key. */
  private async valuePass(
    tier: TierRef,
    hyper: ValueHyper,
    rBins: number,
    games: number,
    parentKey: string,
    parent: ValueTable,
    enumerated?: EnumeratedMazes,
  ): Promise<string> {
    const key = this.passKey(tier, hyper, rBins, games, parentKey, enumerated);
    if (this.tables.has(key) || this.store.hasArtifact(key)) return key;
    this.checkpoint(`value training pass ${tier.econ.w}x${tier.econ.h} at ${tier.econ.multiplierBps} bps`);
    const started = this.now();
    const acc = await this.trainPass(tier.econ, { kind: 'value', table: parent, hyper }, rBins, games, enumerated);
    const table = tableFromValuePass(shapeOf(tier.econ.w, tier.econ.h, rBins), acc, parent, this.profile.minSamples);
    this.saveTable(key, table, { kind: 'lsm-pass', parent: parentKey, multiplierBps: tier.econ.multiplierBps });
    this.newUnits += 1;
    this.log(
      `value training pass ${tier.econ.w}x${tier.econ.h} at ${tier.econ.multiplierBps} bps: ${games} games in ${((this.now() - started) / 1000).toFixed(1)}s`,
    );
    return key;
  }

  /**
   * The canonical table of a tier: the harmonic pass followed by `profile.trainPasses` passes of
   * the bot's own policy on stream C. Returns the cache key of the final table.
   */
  async valueTableScratch(tier: TierRef, hyper: ValueHyper, rBins: number, games: number, enumerated?: EnumeratedMazes): Promise<string> {
    const { w, h } = tier.econ;
    // The chain of keys is known before anything is trained, so a finished chain is found at once.
    const harmonicKey = this.harmonicPassKey(w, h, rBins, games, enumerated);
    const keys: string[] = [];
    let parentKey = `harmonic:${harmonicKey}`;
    for (let pass = 0; pass < this.profile.trainPasses; pass++) {
      parentKey = this.passKey(tier, hyper, rBins, games, parentKey, enumerated);
      keys.push(parentKey);
    }
    // A read-only check needs the key only: the cells trained with the table are looked up by it.
    if (this.readOnly) return keys[keys.length - 1];
    let done = keys.length;
    while (done > 0 && !this.tables.has(keys[done - 1]) && !this.store.hasArtifact(keys[done - 1])) done -= 1;
    if (done === keys.length) return keys[keys.length - 1];

    let table: ValueTable;
    let tableKey: string;
    if (done === 0) {
      const { acc } = await this.harmonicPass(w, h, rBins, games, enumerated);
      table = tableFromHarmonicPass(shapeOf(w, h, rBins), acc, tier.econ.multiplierBps, this.profile.minSamples);
      tableKey = `harmonic:${harmonicKey}`;
    } else {
      tableKey = keys[done - 1];
      table = this.loadTable(tableKey);
    }
    for (let pass = done; pass < keys.length; pass++) {
      tableKey = await this.valuePass(tier, hyper, rBins, games, tableKey, table, enumerated);
      table = this.loadTable(tableKey);
    }
    return tableKey;
  }

  /** One pass that continues from a table trained at another multiplier (coarse bisection). */
  async valueTableWarm(tier: TierRef, hyper: ValueHyper, rBins: number, games: number, parentKey: string): Promise<string> {
    return this.valuePass(tier, hyper, rBins, games, parentKey, this.loadTable(parentKey));
  }

  /** `Ŵ[k][d]` of region-heuristic on stream C. Depends on the grid only. */
  async regionTable(w: number, h: number, games: number): Promise<string> {
    const key = cacheKey('grid', this.codeHash, {
      kind: 'region-table',
      profile: this.profile.name,
      rng: this.rngMode,
      w,
      h,
      games,
      minSamples: this.profile.minSamples,
      stream: 'C',
    });
    if (this.readOnly || this.regions.has(key) || this.store.hasArtifact(key)) return key;
    this.checkpoint(`region table ${w}x${h}`);
    const started = this.now();
    const econ: TierEconomics = { w, h, multiplierBps: 10_000, refundBps: new Array<number>(w * h).fill(0) };
    const source = this.source('C');
    const parts = await Promise.all(
      splitRange(0, games, jobGames('region-heuristic')).map(([a, b]) => this.executor.run({ kind: 'train-region', econ, source, from: a, to: b })),
    );
    const acc = newRegionAccumulator(w * h, w + h - 2);
    for (const part of parts) addRegionAccumulator(acc, part);
    const table = finalizeRegionTable(acc, w * h, w + h - 2, this.profile.minSamples);
    this.store.addGames('train:C', games);
    this.store.writeArtifact(key, { meta: { kind: 'region-table', cells: table.cells, shortest: table.shortest, games }, arrays: { win: table.win } });
    this.newUnits += 1;
    this.log(`region table ${w}x${h}: ${games} games in ${((this.now() - started) / 1000).toFixed(1)}s`);
    return key;
  }

  private trajectoryKey(w: number, h: number, stream: StreamName, games: number): string {
    return cacheKey('grid', this.codeHash, {
      kind: 'trajectories',
      profile: this.profile.name,
      rng: this.rngMode,
      w,
      h,
      games,
      stream,
    });
  }

  /** Pure harmonic walks of games `0 .. games - 1` of `stream`. Depends on the grid only. */
  async trajectories(w: number, h: number, stream: StreamName, games: number): Promise<{ key: string; data: Trajectories }> {
    const key = this.trajectoryKey(w, h, stream, games);
    const known = this.trajectorySets.get(key);
    if (known !== undefined) return { key, data: known };
    const cached = this.store.readArtifact(key);
    let data: Trajectories;
    if (cached !== null) {
      data = {
        games: cached.meta.games as number,
        len: cached.arrays.len as Uint8Array,
        onPath: cached.arrays.onPath as Uint8Array,
        win: cached.arrays.win as Uint8Array,
        steps: cached.arrays.steps as Uint16Array,
      };
    } else {
      this.checkpoint(`trajectories ${w}x${h} stream ${stream}`);
      const started = this.now();
      const econ: TierEconomics = { w, h, multiplierBps: 10_000, refundBps: new Array<number>(w * h).fill(0) };
      const source = this.source(stream);
      const parts = await Promise.all(
        splitRange(0, games, jobGames('harmonic')).map(([a, b]) => this.executor.run({ kind: 'trajectories', econ, source, from: a, to: b })),
      );
      data = concatTrajectories(parts);
      this.store.addGames(`trajectories:${stream}`, games);
      this.store.writeArtifact(key, {
        meta: { kind: 'trajectories', w, h, stream, games: data.games },
        arrays: { len: data.len, onPath: data.onPath, win: data.win, steps: data.steps },
      });
      this.newUnits += 1;
      this.log(`trajectories ${w}x${h} stream ${stream}: ${games} games in ${((this.now() - started) / 1000).toFixed(1)}s`);
    }
    this.trajectorySets.set(key, data);
    return { key, data };
  }

  /** The harmonic-lsm table of a tier: backward induction over the stream C trajectories. */
  async harmonicLsm(tier: TierRef, games: number): Promise<{ key: string; inSampleBps: number }> {
    const { w, h } = tier.econ;
    const key = cacheKey(tier.hash, this.codeHash, {
      kind: 'harmonic-lsm',
      profile: this.profile.name,
      trajectories: this.trajectoryKey(w, h, 'C', games),
      minSamples: this.profile.minSamples,
    });
    const cached = this.store.readArtifact(key);
    if (cached !== null) return { key, inSampleBps: cached.meta.inSampleBps as number };
    if (this.readOnly) return { key, inSampleBps: Number.NaN };
    const { data } = await this.trajectories(w, h, 'C', games);
    this.checkpoint(`harmonic-lsm table ${w}x${h} at ${tier.econ.multiplierBps} bps`);
    const { table, inSampleBps } = harmonicLsmTable(data, tier.econ, this.profile.minSamples);
    this.saveTable(key, table, { kind: 'harmonic-lsm', inSampleBps, multiplierBps: tier.econ.multiplierBps });
    this.newUnits += 1;
    return { key, inSampleBps };
  }

  /** Mean payout (bps) of param-search(θ) for every θ over the first `games` games of stream C. */
  async fitness(tier: TierRef, thetas: number[][], games: number): Promise<number[]> {
    const source = this.source('C');
    const size = Math.max(1, Math.ceil(games / Math.max(1, this.executor.size * 2)));
    const parts = await Promise.all(
      splitRange(0, games, size).map(([a, b]) => this.executor.run({ kind: 'fitness', econ: tier.econ, thetas, source, from: a, to: b })),
    );
    const sums = new Array<number>(thetas.length).fill(0);
    for (const part of parts) for (let i = 0; i < sums.length; i++) sums[i] += part.sums[i];
    this.store.addGames('search:C', games * thetas.length);
    return sums.map((sum) => sum / games);
  }
}
