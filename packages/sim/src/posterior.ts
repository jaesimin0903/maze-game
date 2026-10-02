// Exact posterior over the unseen part of the maze (plan §3.3).
//
// The maze is a uniform spanning tree. After the player has seen the walls of the visited cells,
// the rest of the maze is a uniform spanning tree of the graph in which the visited cells and
// the heads (unvisited cells behind a known opening) are merged into one root and every edge of
// a visited cell that is known to be closed is deleted. Its reduced Laplacian `L` has one row
// per free cell: the diagonal is the number of neighbours that are free or heads, and free
// neighbours are joined by -1.
//
//   q_h   = P(the exit lies below head h) = harmonic measure of h seen from the exit
//         = sum over the free neighbours u of h of G(exit, u),         G = L^-1
//   P(m)  = (spanning trees of the graph after observing pattern m) / (spanning trees now)
//
// `L` is banded with half-width `w` in row-major order, so one banded Cholesky factorisation
// gives the log-determinant and, because the exit is the last cell, `G(exit, ·)` by a single
// back-substitution.

import type { Rng } from '@maze/shared';
import { BIT, FREE, HEAD, VISITED, type Game } from './engine';

/** A pivot at or below this means the graph has no spanning tree. Regular pivots are far larger. */
const SINGULAR_PIVOT = 1e-9;
/** Patterns less likely than this are impossible up to rounding. */
const IMPOSSIBLE = 1e-12;

const SMALL_A = new Float64Array(9);
const SMALL_B = new Float64Array(9);
const SMALL_KINV = new Float64Array(9);
const SMALL_MINV = new Float64Array(9);
const SMALL_RHS = new Float64Array(3);

/**
 * Inverts the leading `n × n` block (`n <= 3`, row stride 3) of `a` into `out` and returns its
 * determinant. `out` is meaningless when the determinant is zero.
 */
function invertSmall(a: Float64Array, n: number, out: Float64Array): number {
  if (n === 0) return 1;
  if (n === 1) {
    out[0] = 1 / a[0];
    return a[0];
  }
  if (n === 2) {
    const det = a[0] * a[4] - a[1] * a[3];
    out[0] = a[4] / det;
    out[1] = -a[1] / det;
    out[3] = -a[3] / det;
    out[4] = a[0] / det;
    return det;
  }
  const c00 = a[4] * a[8] - a[5] * a[7];
  const c01 = a[5] * a[6] - a[3] * a[8];
  const c02 = a[3] * a[7] - a[4] * a[6];
  const det = a[0] * c00 + a[1] * c01 + a[2] * c02;
  out[0] = c00 / det;
  out[1] = (a[2] * a[7] - a[1] * a[8]) / det;
  out[2] = (a[1] * a[5] - a[2] * a[4]) / det;
  out[3] = c01 / det;
  out[4] = (a[0] * a[8] - a[2] * a[6]) / det;
  out[5] = (a[2] * a[3] - a[0] * a[5]) / det;
  out[6] = c02 / det;
  out[7] = (a[1] * a[6] - a[0] * a[7]) / det;
  out[8] = (a[0] * a[4] - a[1] * a[3]) / det;
  return det;
}

export class Posterior {
  readonly w: number;
  readonly h: number;
  readonly cells: number;
  private readonly stride: number;
  /** Banded lower Cholesky factor: entry `(i, j)`, `i - w <= j <= i`, at `i * stride + j - i + w`. */
  private readonly band: Float64Array;
  /** Reciprocal of the factor's diagonal. */
  private readonly inv: Float64Array;
  private readonly free: Uint8Array;
  /** `G(exit, ·)` of the last factorisation; zero when the exit is not a free cell. */
  readonly y: Float64Array;
  private readonly z: Float64Array;
  private readonly x: Float64Array;
  /** Natural logarithm of the number of spanning trees of the last factorised graph. */
  logTrees = 0;

  /** Free neighbours of the child prepared by `prepareChild`. */
  readonly patternCell = new Int32Array(3);
  patternCells = 0;
  /** After `pattern(o)`: posterior of each opened neighbour, indexed like `patternCell`. */
  readonly patternQ = new Float64Array(3);
  private readonly gff = new Float64Array(9);
  private readonly yf = new Float64Array(3);
  private readonly closed = new Int32Array(3);
  private readonly opened = new Int32Array(3);

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cells = w * h;
    this.stride = w + 1;
    this.band = new Float64Array(this.cells * this.stride);
    this.inv = new Float64Array(this.cells);
    this.free = new Uint8Array(this.cells);
    this.y = new Float64Array(this.cells);
    this.z = new Float64Array(this.cells);
    this.x = new Float64Array(this.cells);
  }

  /**
   * Factorises the reduced Laplacian of the graph described by `status`. Returns false when
   * that graph has no spanning tree (some free cell cannot reach the root).
   */
  factor(status: Uint8Array): boolean {
    const { w, cells, stride, band, inv, free } = this;
    let logTrees = 0;
    for (let i = 0; i < cells; i++) free[i] = status[i] === FREE ? 1 : 0;
    for (let i = 0; i < cells; i++) {
      const row = i * stride;
      if (free[i] === 0) {
        for (let c = 0; c < stride; c++) band[row + c] = 0;
        inv[i] = 1;
        continue;
      }
      const x = i % w;
      const up = i - w;
      let degree = 0;
      if (up >= 0 && status[up] !== VISITED) degree += 1;
      if (i + w < cells && status[i + w] !== VISITED) degree += 1;
      if (x > 0 && status[i - 1] !== VISITED) degree += 1;
      if (x < w - 1 && status[i + 1] !== VISITED) degree += 1;

      const jmin = up > 0 ? up : 0;
      const oi = row - i + w;
      let diag = degree;
      for (let j = jmin; j < i; j++) {
        if (free[j] === 0) {
          band[oi + j] = 0;
          continue;
        }
        let s = j === up || (j === i - 1 && x > 0) ? -1 : 0;
        const oj = j * stride - j + w;
        for (let k = jmin; k < j; k++) s -= band[oi + k] * band[oj + k];
        s *= inv[j];
        band[oi + j] = s;
        diag -= s * s;
      }
      if (!(diag > SINGULAR_PIVOT)) {
        this.logTrees = Number.NEGATIVE_INFINITY;
        return false;
      }
      logTrees += Math.log(diag);
      const d = Math.sqrt(diag);
      band[oi + i] = d;
      inv[i] = 1 / d;
    }
    this.logTrees = logTrees;
    return true;
  }

  /** `y = G(exit, ·)` for the last factorisation. */
  solveExit(): void {
    const { w, cells, stride, band, inv, free, y } = this;
    const exit = cells - 1;
    if (free[exit] === 0) {
      y.fill(0);
      return;
    }
    y[exit] = inv[exit] * inv[exit];
    for (let i = exit - 1; i >= 0; i--) {
      if (free[i] === 0) {
        y[i] = 0;
        continue;
      }
      const last = i + w < exit ? i + w : exit;
      let s = 0;
      for (let k = i + 1; k <= last; k++) s += band[k * stride + i - k + w] * y[k];
      y[i] = -s * inv[i];
    }
  }

  /** `x = G(v, ·)` for the last factorisation, valid for indices `>= lowest`. */
  private solveColumn(v: number, lowest: number): void {
    const { w, cells, stride, band, inv, free, z, x } = this;
    z[v] = inv[v];
    for (let i = v + 1; i < cells; i++) {
      if (free[i] === 0) {
        z[i] = 0;
        continue;
      }
      const first = i - w > v ? i - w : v;
      const oi = i * stride - i + w;
      let s = 0;
      for (let k = first; k < i; k++) s += band[oi + k] * z[k];
      z[i] = -s * inv[i];
    }
    for (let i = cells - 1; i >= lowest; i--) {
      if (free[i] === 0) {
        x[i] = 0;
        continue;
      }
      const last = i + w < cells - 1 ? i + w : cells - 1;
      let s = i >= v ? z[i] : 0;
      for (let k = i + 1; k <= last; k++) s -= band[k * stride + i - k + w] * x[k];
      x[i] = s * inv[i];
    }
  }

  /**
   * Factorises the graph of the game's current position and writes into `q` the posterior
   * probability that the exit lies below each child of the current cell.
   */
  childPosterior(g: Game, q: Float64Array): void {
    const { status, nbr, exit } = g;
    if (!this.factor(status)) {
      throw new Error('posterior: the observed position admits no spanning tree');
    }
    this.solveExit();
    const y = this.y;
    const exitFree = status[exit] === FREE;
    for (let i = 0; i < g.nc; i++) {
      const child = g.childCell[i];
      if (!exitFree) {
        q[i] = child === exit ? 1 : 0;
        continue;
      }
      let sum = 0;
      for (let dir = 0; dir < 4; dir++) {
        const u = nbr[child * 4 + dir];
        if (u >= 0 && status[u] === FREE) sum += y[u];
      }
      q[i] = sum;
    }
  }

  /**
   * Prepares the one-step lookahead of the head `child`: finds its free neighbours (the cells
   * whose edge to `child` is still unknown) and the block of `G` between them. Must follow
   * `childPosterior` for the same position. Returns the number of unknown edges (0 .. 3).
   */
  prepareChild(g: Game, child: number): number {
    const { status, nbr } = g;
    let r = 0;
    for (let dir = 0; dir < 4; dir++) {
      const u = nbr[child * 4 + dir];
      if (u >= 0 && status[u] === FREE) this.patternCell[r++] = u;
    }
    this.patternCells = r;
    let lowest = this.cells;
    for (let a = 0; a < r; a++) if (this.patternCell[a] < lowest) lowest = this.patternCell[a];
    for (let a = 0; a < r; a++) {
      this.solveColumn(this.patternCell[a], lowest);
      for (let b = 0; b < r; b++) this.gff[b * 3 + a] = this.x[this.patternCell[b]];
      this.yf[a] = this.y[this.patternCell[a]];
    }
    return r;
  }

  /**
   * Probability that exactly the unknown edges in `openMask` (bit `a` ↔ `patternCell[a]`) are
   * open and the rest closed, given everything observed so far. For a non-empty `openMask` of
   * positive probability it also fills `patternQ[a]` with the posterior of each newly opened
   * neighbour after that observation.
   *
   * With `C` the closed set and `O` the open set: deleting the closed edges turns `L` into
   * `L' = L - sum_{v in C} e_v e_v^T`, so `det L' / det L = det(I - G[C, C])` and
   * `G' = G + G[·, C] (I - G[C, C])^-1 G[C, ·]`; contracting the open edges removes the rows and
   * columns of `O`, which multiplies the tree count by `det G'[O, O]`. The walk from the exit
   * then first reaches `O` at `o` with probability `(G'[O, O]^-1 G'[O, exit])_o`.
   */
  pattern(openMask: number): number {
    const r = this.patternCells;
    const { gff, yf, closed, opened } = this;
    let nc = 0;
    let no = 0;
    for (let a = 0; a < r; a++) {
      if ((openMask >> a) & 1) opened[no++] = a;
      else closed[nc++] = a;
    }

    for (let a = 0; a < nc; a++) {
      for (let b = 0; b < nc; b++) SMALL_A[a * 3 + b] = (a === b ? 1 : 0) - gff[closed[a] * 3 + closed[b]];
    }
    const detClosed = invertSmall(SMALL_A, nc, SMALL_KINV);
    if (!(detClosed > IMPOSSIBLE)) return 0;
    if (no === 0) return detClosed;

    for (let a = 0; a < no; a++) {
      const oa = opened[a];
      let ge = yf[oa];
      for (let b = 0; b < no; b++) SMALL_B[a * 3 + b] = gff[oa * 3 + opened[b]];
      for (let c = 0; c < nc; c++) {
        // t = (G[oa, C] (I - G[C, C])^-1)[c]
        let t = 0;
        for (let c2 = 0; c2 < nc; c2++) t += gff[oa * 3 + closed[c2]] * SMALL_KINV[c2 * 3 + c];
        for (let b = 0; b < no; b++) SMALL_B[a * 3 + b] += t * gff[closed[c] * 3 + opened[b]];
        ge += t * yf[closed[c]];
      }
      SMALL_RHS[a] = ge;
    }
    const detOpen = invertSmall(SMALL_B, no, SMALL_MINV);
    const probability = detClosed * detOpen;
    if (!(probability > IMPOSSIBLE)) return 0;
    for (let a = 0; a < no; a++) {
      let hit = 0;
      for (let b = 0; b < no; b++) hit += SMALL_MINV[a * 3 + b] * SMALL_RHS[b];
      this.patternQ[opened[a]] = hit < 0 ? 0 : hit > 1 ? 1 : hit;
    }
    return probability;
  }
}

/** One observation pattern of a lookahead: which unknown edges of the child turn out open. */
export interface PatternOutcome {
  /** Bit `a` set: the edge to `cells[a]` is open. */
  openMask: number;
  probability: number;
  /** Posterior of each opened neighbour after the observation (0 for closed ones). */
  q: number[];
}

/**
 * Reference implementation of the lookahead by the definition: for every pattern the modified
 * graph is factorised from scratch and `P(m)` is the ratio of spanning-tree counts obtained from
 * the two banded log-determinants. `Posterior.pattern` must agree with it; the tests compare
 * both with full enumeration.
 */
export function lookaheadByLogDeterminant(g: Game, child: number): { cells: number[]; patterns: PatternOutcome[] } {
  const { status, nbr, exit } = g;
  const cells: number[] = [];
  for (let dir = 0; dir < 4; dir++) {
    const u = nbr[child * 4 + dir];
    if (u >= 0 && status[u] === FREE) cells.push(u);
  }
  const post = new Posterior(g.w, g.h);
  if (!post.factor(status)) throw new Error('lookahead: the observed position admits no spanning tree');
  const logNow = post.logTrees;
  const patterns: PatternOutcome[] = [];
  const next = new Uint8Array(status.length);
  for (let openMask = 0; openMask < 1 << cells.length; openMask++) {
    next.set(status);
    // Standing on `child` makes it visited: its edges to cells that stay free are then closed.
    next[child] = VISITED;
    for (let a = 0; a < cells.length; a++) if ((openMask >> a) & 1) next[cells[a]] = HEAD;
    const q = cells.map(() => 0);
    if (!post.factor(next)) {
      patterns.push({ openMask, probability: 0, q });
      continue;
    }
    const probability = Math.exp(post.logTrees - logNow);
    post.solveExit();
    for (let a = 0; a < cells.length; a++) {
      if (((openMask >> a) & 1) === 0) continue;
      if (next[exit] !== FREE) {
        q[a] = cells[a] === exit ? 1 : 0;
        continue;
      }
      for (let dir = 0; dir < 4; dir++) {
        const u = nbr[cells[a] * 4 + dir];
        if (u >= 0 && next[u] === FREE) q[a] += post.y[u];
      }
    }
    patterns.push({ openMask, probability, q });
  }
  return { cells, patterns };
}

/** Scratch space of `samplePosteriorMaze`. */
export class WilsonScratch {
  readonly inTree: Uint8Array;
  readonly lastExit: Uint8Array;

  constructor(cells: number) {
    this.inTree = new Uint8Array(cells);
    this.lastExit = new Uint8Array(cells);
  }
}

/**
 * Draws a maze from the exact posterior of the game's position (conditional Wilson): visited
 * cells keep their observed walls, and loop-erased random walks over the unvisited cells attach
 * every free cell to the root formed by the visited cells and the heads.
 */
export function samplePosteriorMaze(g: Game, rng: Rng, scratch: WilsonScratch, out: Uint8Array): void {
  const { cells, status, nbr, open, back } = g;
  const { inTree, lastExit } = scratch;
  for (let cell = 0; cell < cells; cell++) {
    const s = status[cell];
    inTree[cell] = s === FREE ? 0 : 1;
    out[cell] = s === VISITED ? open[cell] : s === HEAD ? back[cell] : 0;
  }
  for (let first = 0; first < cells; first++) {
    if (inTree[first] === 1) continue;
    let cell = first;
    while (inTree[cell] === 0) {
      const dir = rng.nextBelow(4);
      const next = nbr[cell * 4 + dir];
      if (next < 0 || status[next] === VISITED) continue;
      lastExit[cell] = dir;
      cell = next;
    }
    cell = first;
    while (inTree[cell] === 0) {
      const dir = lastExit[cell];
      const next = nbr[cell * 4 + dir];
      out[cell] |= BIT[dir];
      out[next] |= BIT[(dir + 2) & 3];
      inTree[cell] = 1;
      cell = next;
    }
  }
}
