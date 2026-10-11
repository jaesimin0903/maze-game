// Exact escape probabilities of `sim:escape`.
//
// Per maze: the maze is a tree and the engine never lets the player step back, so a walk reaches
// the exit only by following the unique start-to-exit path, and a random walk that chooses
// uniformly among the engine's forward moves follows it with probability
//
//   P(escape | maze) = Π over the path's cells before the exit of 1 / (forward moves there).
//
// `SolutionWalker` finds the path and walks it with the engine's own `Game`, so the move counts
// are the engine's rules and not a copy of them.
//
// Over all mazes (3×3 and 4×4): the generator (maze.ts) draws the start direction b uniformly
// and then runs Wilson's algorithm on the grid without the start cell's other edge. Wilson's
// algorithm draws a uniform spanning tree of that graph, and its spanning trees are exactly the
// corridor mazes opening in direction b. So a maze opening east has probability 1 / (2 T_E) and
// one opening south 1 / (2 T_S), where T_E and T_S count the corridor mazes of each kind; on a
// square grid the diagonal mirror swaps the two kinds, T_E = T_S, and the generator is uniform
// over the corridor mazes. `fullExact` weights every enumerated maze that way (so it would stay
// right on a grid where T_E ≠ T_S), and the generator census in run.ts checks the weights
// against the generator itself.

import type { Rng } from '@maze/shared';
import { createBot } from '../bots/index';
import { BIT, Game, OUTCOME_EXIT, play } from '../engine';
import { enumeratedGrid, exactOptimal, type EnumeratedMazes } from '../exact';

const NO_RNG: Rng = { nextU32: () => 0, nextBelow: () => 0 };

/** Finds the start-to-exit path of a maze and walks it with the engine. */
export class SolutionWalker {
  /** Moves on the path of the last maze walked. */
  length = 0;
  private readonly g: Game;
  private readonly parent: Int32Array;
  private readonly queue: Int32Array;
  private readonly path: Int32Array;

  constructor(w: number, h: number) {
    this.g = new Game({ w, h, multiplierBps: 10_000, refundBps: new Array<number>(w * h).fill(0) });
    this.parent = new Int32Array(w * h);
    this.queue = new Int32Array(w * h);
    this.path = new Int32Array(w * h);
  }

  /**
   * The probability that a walk choosing uniformly among the engine's forward moves reaches the
   * exit of `open`. The path comes from a breadth-first search over the passages; it is then
   * walked with `Game.begin` / `Game.advance`, and every cell contributes 1 / `g.nc`.
   */
  walk(open: Uint8Array): number {
    const { g, parent, queue, path } = this;
    parent.fill(-1);
    parent[0] = 0;
    queue[0] = 0;
    let tail = 1;
    for (let head = 0; head < tail && parent[g.exit] === -1; head++) {
      const cell = queue[head];
      for (let dir = 0; dir < 4; dir++) {
        if ((open[cell] & BIT[dir]) === 0) continue;
        const next = g.nbr[cell * 4 + dir];
        if (next < 0 || parent[next] !== -1) continue;
        parent[next] = cell;
        queue[tail++] = next;
      }
    }
    if (parent[g.exit] === -1) throw new RangeError('SolutionWalker: the exit is not reachable from the start');
    // `path[length - 1]` is the cell after the start and `path[0]` the exit.
    let length = 0;
    for (let cell = g.exit; cell !== 0; cell = parent[cell]) path[length++] = cell;

    g.begin(open, NO_RNG);
    let probability = 1;
    for (let at = length - 1; at >= 0; at--) {
      let i = 0;
      while (i < g.nc && g.childCell[i] !== path[at]) i++;
      if (i === g.nc) throw new RangeError(`SolutionWalker: the engine offers no move from cell ${g.cell} to cell ${path[at]}`);
      probability /= g.nc;
      g.advance(i);
    }
    this.length = length;
    return probability;
  }
}

/**
 * The maze as a number: bit `e` is set when edge `e` is open, with the edges in the order of
 * `enumerateCorridorMazes` (each cell's east edge, then its south edge, row by row).
 */
export function edgeKey(open: Uint8Array, w: number, h: number): number {
  if (w * (h - 1) + h * (w - 1) > 52) throw new RangeError(`edgeKey: a ${w}x${h} grid has too many edges for a number`);
  const cells = w * h;
  let key = 0;
  let weight = 1;
  for (let cell = 0; cell < cells; cell++) {
    if (cell % w < w - 1) {
      if ((open[cell] & BIT[1]) !== 0) key += weight;
      weight *= 2;
    }
    if (cell + w < cells) {
      if ((open[cell] & BIT[2]) !== 0) key += weight;
      weight *= 2;
    }
  }
  return key;
}

const indexes = new Map<number, Map<number, number>>();

/** `edgeKey` of every enumerated maze of the `n × n` grid → its index in the enumeration. */
export function enumeratedIndex(n: number): Map<number, number> {
  let index = indexes.get(n);
  if (index === undefined) {
    const e = enumeratedGrid(n, n);
    const cells = n * n;
    index = new Map();
    for (let i = 0; i < e.count; i++) index.set(edgeKey(e.mazes.subarray(i * cells, (i + 1) * cells), n, n), i);
    if (index.size !== e.count) throw new Error(`enumeratedIndex: two enumerated ${n}x${n} mazes have the same edges`);
    indexes.set(n, index);
  }
  return index;
}

/** The generator's probability of every enumerated maze: 1 / (2 × mazes with the same start direction). */
export function generatorWeights(e: EnumeratedMazes): { east: number; south: number; weights: Float64Array } {
  const cells = e.w * e.h;
  let east = 0;
  for (let i = 0; i < e.count; i++) if ((e.mazes[i * cells] & BIT[1]) !== 0) east += 1;
  const south = e.count - east;
  if (east === 0 || south === 0) throw new RangeError('generatorWeights: the enumeration lacks a start direction');
  const weights = new Float64Array(e.count);
  for (let i = 0; i < e.count; i++) weights[i] = (e.mazes[i * cells] & BIT[1]) !== 0 ? 1 / (2 * east) : 1 / (2 * south);
  return { east, south, weights };
}

export const EXACT_POLICIES = ['random-walk', 'naive-greedy', 'harmonic'] as const;
export type ExactPolicy = (typeof EXACT_POLICIES)[number];

export interface FullExact {
  n: number;
  mazes: number;
  /** Corridor mazes whose start cell opens east / south. */
  eastMazes: number;
  southMazes: number;
  /** True when every maze is equally likely (T_E = T_S). */
  uniform: boolean;
  /** Escape probability of each policy over the generator's distribution. */
  escape: Record<ExactPolicy, number>;
  /** The highest escape probability any policy reaches: expectimax over what the player has seen. */
  optimal: number;
  /** `pathLength[m]`: probability that the start-to-exit path has `m` moves. */
  pathLength: number[];
}

/**
 * Every maze of the `n × n` grid, weighted as the generator draws it. naive-greedy and harmonic
 * are deterministic, so one game per maze is their exact result; the random walk contributes its
 * exact per-maze probability. `optimal` is the ceiling no policy can pass.
 */
export function fullExact(n: number): FullExact {
  const e = enumeratedGrid(n, n);
  const cells = n * n;
  const { east, south, weights } = generatorWeights(e);
  const g = new Game({ w: n, h: n, multiplierBps: 10_000, refundBps: new Array<number>(cells).fill(0) });
  const naive = createBot({ bot: 'naive-greedy' }, g);
  const harmonic = createBot({ bot: 'harmonic' }, g);
  const walker = new SolutionWalker(n, n);
  const escape: Record<ExactPolicy, number> = { 'random-walk': 0, 'naive-greedy': 0, harmonic: 0 };
  const pathLength = new Array<number>(cells).fill(0);
  for (let i = 0; i < e.count; i++) {
    const open = e.mazes.subarray(i * cells, (i + 1) * cells);
    const weight = weights[i];
    escape['random-walk'] += weight * walker.walk(open);
    pathLength[walker.length] += weight;
    play(g, naive, open, NO_RNG);
    if (g.outcome === OUTCOME_EXIT) escape['naive-greedy'] += weight;
    play(g, harmonic, open, NO_RNG);
    if (g.outcome === OUTCOME_EXIT) escape.harmonic += weight;
  }
  // `exactOptimal` with the exit worth 1 and every cash-out worth 0 counts the mazes the best policy escapes.
  const best = exactOptimal(e, { w: n, h: n, multiplierBps: 1, refundBps: new Array<number>(cells).fill(0) });
  const optimal = best.eastBps / (2 * best.eastCount) + best.southBps / (2 * best.southCount);
  return { n, mazes: e.count, eastMazes: east, southMazes: south, uniform: east === south, escape, optimal, pathLength };
}

/** The census fails when the χ² score, or the excess of never-drawn mazes, is more than this many standard deviations. */
export const CENSUS_Z_LIMIT = 4;

export interface CensusCheck {
  n: number;
  draws: number;
  /** Draws that produced no enumerated maze. */
  unknown: number;
  /** Pearson's χ² of the counts against the generator weights. */
  chiSquare: number;
  df: number;
  /** χ² turned into a standard normal score (Wilson–Hilferty). */
  z: number;
  /** Enumerated mazes the generator never produced, and how many a correct generator leaves undrawn on average. */
  zeroCells: number;
  expectedZeroCells: number;
  /** The fewest draws of any maze, and the largest |count − expected| / √expected. */
  minCount: number;
  maxResidual: number;
  pass: boolean;
}

/**
 * How well the generator's draws match `generatorWeights`. Pearson's χ² catches a broad skew but
 * not a few mazes that never come out, so the never-drawn mazes are counted as well: a correct
 * generator leaves Σ (1 − w)^draws of them undrawn on average (practically none at 100 draws per
 * maze), with a variance below that mean.
 */
export function censusCheck(n: number, counts: Float64Array, unknown: number): CensusCheck {
  const { weights } = generatorWeights(enumeratedGrid(n, n));
  if (counts.length !== weights.length) throw new RangeError('censusCheck: counts and enumeration differ in length');
  let draws = unknown;
  for (const count of counts) draws += count;
  let chiSquare = 0;
  let zeroCells = 0;
  let expectedZeroCells = 0;
  let minCount = Number.POSITIVE_INFINITY;
  let maxResidual = 0;
  for (let i = 0; i < counts.length; i++) {
    const expected = draws * weights[i];
    const residual = (counts[i] - expected) / Math.sqrt(expected);
    chiSquare += residual * residual;
    maxResidual = Math.max(maxResidual, Math.abs(residual));
    minCount = Math.min(minCount, counts[i]);
    if (counts[i] === 0) zeroCells += 1;
    expectedZeroCells += Math.exp(draws * Math.log1p(-weights[i]));
  }
  const df = counts.length - 1;
  const v = 2 / (9 * df);
  const z = (Math.cbrt(chiSquare / df) - (1 - v)) / Math.sqrt(v);
  const zeroLimit = expectedZeroCells + CENSUS_Z_LIMIT * Math.sqrt(expectedZeroCells);
  return {
    n,
    draws,
    unknown,
    chiSquare,
    df,
    z,
    zeroCells,
    expectedZeroCells,
    minCount,
    maxResidual,
    pass: unknown === 0 && z <= CENSUS_Z_LIMIT && zeroCells <= zeroLimit,
  };
}
