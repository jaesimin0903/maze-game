// Mazes and jobs of `sim:escape`. A job is a pure function of its description: the same job
// returns the same result on any thread, so the split into jobs and the number of workers never
// change a result.
//
// Mazes come from a stream of their own, built like the certification streams A..E (streams.ts),
// the human stream (human/feed.ts) and the chest stream (chest/model.ts): game `i` of an `n × n`
// grid is seeded with
//
//   seed = base + ((n << 8 | n) << 40) + i      (mod 2^64),  base = first 8 bytes of sha256(label)
//
// with the label "maze-sim/stream/escape/v1", and drawn with the engine's fast generator, so the
// mazes follow the certified distribution. `escapeStreamDisjoint` checks that the stream's seed
// interval meets none of A..E, the human stream or the chest stream. Every policy of a size plays
// the same mazes: game `i` is maze `i` for all of them. The random walk draws its choices from the
// maze generator after the maze, as the certified bots do.

import { fastRng, generateGridFromRng, type Rng } from '@maze/shared';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { createBot, VALUE_LSM_HYPER } from '../bots/index';
import type { Bot } from '../bots/types';
import { CHEST_STREAM_LABEL } from '../chest/model';
import { Game, OUTCOME_CASH, play, type TierEconomics } from '../engine';
import { HUMAN_STREAM_LABEL } from '../human/feed';
import type { ValueTable } from '../lsm';
import { STREAM_NAMES, STREAM_SPAN, streamBase } from '../streams';
import { edgeKey, enumeratedIndex, SolutionWalker } from './exact';

export const ESCAPE_STREAM_LABEL = 'maze-sim/stream/escape/v1';
/** `workerData` of the threads of this command's pool (pool.ts). */
export const ESCAPE_WORKER_TAG = 'maze-sim-escape-worker';
const MASK_64 = (1n << 64n) - 1n;
const INDEX_BITS = 40n;

/** Games per seed: `--seed s` plays games `s × SEED_SPAN ..` of each size. */
export const ESCAPE_SEED_SPAN = 2 ** 32;
export const ESCAPE_SEED_LIMIT = 2 ** 40 / ESCAPE_SEED_SPAN;
/** Within a seed, the generator census starts here; the games of the cells stay below it. */
export const CENSUS_OFFSET = 2 ** 31;
/** Draws a census may make before it would reach the games of the next seed. */
export const CENSUS_SPAN = ESCAPE_SEED_SPAN - CENSUS_OFFSET;

function hashBase(label: string): bigint {
  return BigInt(`0x${bytesToHex(sha256(utf8ToBytes(label)).slice(0, 8))}`);
}

let base: bigint | null = null;

export function escapeStreamBase(): bigint {
  base ??= hashBase(ESCAPE_STREAM_LABEL);
  return base;
}

export function escapeStreamBaseHex(): string {
  return `0x${escapeStreamBase().toString(16).padStart(16, '0')}`;
}

/** True when this stream's seed interval meets none of A..E, the human stream and the chest stream. */
export function escapeStreamDisjoint(): boolean {
  const own = escapeStreamBase();
  const others = [...STREAM_NAMES.map((name) => streamBase(name)), hashBase(HUMAN_STREAM_LABEL), hashBase(CHEST_STREAM_LABEL)];
  return others.every((other) => ((other - own) & MASK_64) >= STREAM_SPAN && ((own - other) & MASK_64) >= STREAM_SPAN);
}

/** First game index of `seed`. */
export function escapeFirstIndex(seed: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed >= ESCAPE_SEED_LIMIT) {
    throw new RangeError(`seed must be an integer in 0 .. ${ESCAPE_SEED_LIMIT - 1}, got ${seed}`);
  }
  return seed * ESCAPE_SEED_SPAN;
}

/** The 64-bit seed of maze `index` of an `n × n` grid on this stream. */
export function escapeGameSeed(n: number, index: number): bigint {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 40) {
    throw new RangeError(`game index must be an integer in 0 .. 2^40 - 1, got ${index}`);
  }
  return (escapeStreamBase() + (BigInt((n << 8) | n) << INDEX_BITS) + BigInt(index)) & MASK_64;
}

/** Yields maze `index` of one grid size. */
export class EscapeFeed {
  open: Uint8Array = new Uint8Array(0);
  /** The maze generator after the maze was drawn (the random walk draws its choices from it). */
  rng: Rng = fastRng(0n);

  constructor(readonly n: number) {}

  load(index: number): void {
    const rng = fastRng(escapeGameSeed(this.n, index));
    this.open = generateGridFromRng(rng, this.n, this.n).open;
    this.rng = rng;
  }
}

export const POLICY_IDS = ['random-walk', 'naive-greedy', 'harmonic', 'value-lsm'] as const;
export type PolicyId = (typeof POLICY_IDS)[number];

/**
 * A policy. The first three never cash out, so they need no economics and play every size;
 * value-lsm plays a certified tier with the value table its certification used.
 */
export type PolicySpec =
  | { policy: 'random-walk' }
  | { policy: 'naive-greedy' }
  | { policy: 'harmonic' }
  | { policy: 'value-lsm'; econ: TierEconomics; table: ValueTable };

/** Economics for the policies that never cash out: nothing they do reads them. */
export function noEconomics(n: number): TierEconomics {
  return { w: n, h: n, multiplierBps: 10_000, refundBps: new Array<number>(n * n).fill(0) };
}

interface Seat {
  g: Game;
  bot: Bot;
  mayCashOut: boolean;
}

function seat(spec: PolicySpec, n: number): Seat {
  if (spec.policy === 'value-lsm') {
    if (spec.econ.w !== n || spec.econ.h !== n) throw new RangeError(`value-lsm: economics are for ${spec.econ.w}x${spec.econ.h}, not ${n}x${n}`);
    const g = new Game(spec.econ);
    return { g, bot: createBot({ bot: 'value-lsm', table: spec.table, hyper: VALUE_LSM_HYPER }, g), mayCashOut: true };
  }
  const g = new Game(noEconomics(n));
  const bot =
    spec.policy === 'random-walk'
      ? createBot({ bot: 'random-walk-sampled' }, g)
      : spec.policy === 'naive-greedy'
        ? createBot({ bot: 'naive-greedy' }, g)
        : createBot({ bot: 'harmonic' }, g);
  return { g, bot, mayCashOut: false };
}

/** Games `first .. first + games - 1` of an `n × n` grid played by one policy. */
export interface GamesJob {
  kind: 'games';
  n: number;
  policy: PolicySpec;
  first: number;
  games: number;
}

/** How each game went, one entry per game in game order. */
export interface GameColumns {
  /** `OUTCOME_EXIT`, `OUTCOME_CASH` or `OUTCOME_LOSS` (a dead end). */
  outcome: Uint8Array;
  /** Moves made. */
  steps: Uint16Array;
  /** Moves on the maze's start-to-exit path. */
  pathLength: Uint16Array;
  /** Random walk only (empty otherwise): the exact probability that the walk escapes this maze. */
  exactP: Float64Array;
}

/** How often each maze of the enumeration of an `n × n` grid comes out of the generator. */
export interface CensusJob {
  kind: 'census';
  n: number;
  first: number;
  games: number;
}

export interface CensusCounts {
  /** `counts[i]`: draws that produced enumerated maze `i`. */
  counts: Float64Array;
  /** Draws that produced no enumerated maze (must be 0). */
  unknown: number;
}

/** Two policies on the same mazes `first .. first + games - 1`, each game as in its own cell. */
export interface PairedJob {
  kind: 'paired';
  n: number;
  a: PolicySpec;
  b: PolicySpec;
  first: number;
  games: number;
}

export interface PairedCounts {
  /** `table[3 × outcome of a + outcome of b]`: games by the pair of outcomes (exit, cash-out, dead end). */
  table: number[];
}

export type EscapeJob = GamesJob | CensusJob | PairedJob;
export type EscapeResult = GameColumns | CensusCounts | PairedCounts;

export function playGames(job: GamesJob): GameColumns {
  const { g, bot, mayCashOut } = seat(job.policy, job.n);
  const walker = new SolutionWalker(job.n, job.n);
  const feed = new EscapeFeed(job.n);
  const exact = job.policy.policy === 'random-walk';
  const out: GameColumns = {
    outcome: new Uint8Array(job.games),
    steps: new Uint16Array(job.games),
    pathLength: new Uint16Array(job.games),
    exactP: new Float64Array(exact ? job.games : 0),
  };
  for (let i = 0; i < job.games; i++) {
    feed.load(job.first + i);
    // The walker reads the whole maze but keeps its own `Game`, so the player sees nothing of it.
    const p = walker.walk(feed.open);
    play(g, bot, feed.open, feed.rng);
    if (g.outcome === OUTCOME_CASH && !mayCashOut) throw new Error(`${job.policy.policy} cashed out, but it never should`);
    out.outcome[i] = g.outcome;
    out.steps[i] = g.k;
    out.pathLength[i] = walker.length;
    if (exact) out.exactP[i] = p;
  }
  return out;
}

export function census(job: CensusJob): CensusCounts {
  const index = enumeratedIndex(job.n);
  const counts = new Float64Array(index.size);
  let unknown = 0;
  for (let i = 0; i < job.games; i++) {
    const rng = fastRng(escapeGameSeed(job.n, job.first + i));
    const at = index.get(edgeKey(generateGridFromRng(rng, job.n, job.n).open, job.n, job.n));
    if (at === undefined) unknown += 1;
    else counts[at] += 1;
  }
  return { counts, unknown };
}

/**
 * Both policies play every maze of the range. The maze is drawn afresh for each of them, so each
 * sees the generator state its own cell gives it and plays exactly the game it plays there.
 */
export function playPaired(job: PairedJob): PairedCounts {
  const feed = new EscapeFeed(job.n);
  const outcomeOf = (spec: PolicySpec, s: Seat, index: number): number => {
    feed.load(index);
    play(s.g, s.bot, feed.open, feed.rng);
    if (s.g.outcome === OUTCOME_CASH && !s.mayCashOut) throw new Error(`${spec.policy} cashed out, but it never should`);
    return s.g.outcome;
  };
  const a = seat(job.a, job.n);
  const b = seat(job.b, job.n);
  const table = new Array<number>(9).fill(0);
  for (let i = 0; i < job.games; i++) {
    const index = job.first + i;
    const outcomeA = outcomeOf(job.a, a, index);
    table[3 * outcomeA + outcomeOf(job.b, b, index)] += 1;
  }
  return { table };
}

export function runEscapeJob(job: EscapeJob): EscapeResult {
  switch (job.kind) {
    case 'games':
      return playGames(job);
    case 'census':
      return census(job);
    case 'paired':
      return playPaired(job);
  }
}

/** Buffers of a result that can move to the main thread without a copy. */
export function transferables(result: EscapeResult): ArrayBuffer[] {
  if ('table' in result) return [];
  if ('counts' in result) return [result.counts.buffer as ArrayBuffer];
  return [result.outcome, result.steps, result.pathLength, result.exactP].map((column) => column.buffer as ArrayBuffer);
}
