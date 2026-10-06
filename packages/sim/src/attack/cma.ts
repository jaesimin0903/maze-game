// Derivative-free search over parameterised players: CMA-ES (Hansen's (μ/μ_w, λ) form with
// rank-one and rank-μ updates) over the θ of `ParamBot`, maximising the mean payout over a
// fixed set of training mazes (common random numbers: every θ plays the same mazes).

import { Game, MazeFeed, play, type TierEconomics } from '../engine';
import type { ValueTable } from '../lsm';
import type { StreamName } from '../streams';
import { ParamBot } from './bots';

export interface FitnessJob {
  kind: 'attack-fitness';
  econ: TierEconomics;
  table: ValueTable;
  thetas: number[][];
  stream: StreamName;
  first: number;
  from: number;
  to: number;
}

export interface FitnessResult {
  games: number;
  /** Sum of payouts (bps) per θ. */
  sums: number[];
}

export function runFitness(job: FitnessJob): FitnessResult {
  const g = new Game(job.econ);
  const bots = job.thetas.map((theta) => new ParamBot(g, job.table, theta));
  const feed = new MazeFeed({ kind: 'rng', mode: 'fast', stream: job.stream }, g.w, g.h);
  const sums = new Array<number>(bots.length).fill(0);
  for (let i = job.from; i < job.to; i++) {
    feed.load(job.first + i);
    for (let b = 0; b < bots.length; b++) {
      play(g, bots[b], feed.open, feed.rng);
      sums[b] += g.payoutBps;
    }
  }
  return { games: job.to - job.from, sums };
}

/** Deterministic generator of standard normal numbers for the search itself. */
class Normal {
  private state: number;
  private spare = Number.NaN;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  private uniform(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return (this.state + 0.5) / 4294967296;
  }

  next(): number {
    if (this.spare === this.spare) {
      const value = this.spare;
      this.spare = Number.NaN;
      return value;
    }
    const u = this.uniform();
    const v = this.uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}

/** Eigen-decomposition of a symmetric matrix by cyclic Jacobi rotations: C = B diag(d) Bᵀ. */
export function symmetricEigen(c: number[][]): { values: number[]; vectors: number[][] } {
  const n = c.length;
  const a = c.map((row) => row.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(t * t + 1);
        const sin = t * cos;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = cos * akp - sin * akq;
          a[k][q] = sin * akp + cos * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = cos * apk - sin * aqk;
          a[q][k] = sin * apk + cos * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = cos * vkp - sin * vkq;
          v[k][q] = sin * vkp + cos * vkq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}

export interface CmaOptions {
  dim: number;
  lambda: number;
  sigma0: number;
  generations: number;
  seed: number;
}

export interface CmaGeneration {
  generation: number;
  sigma: number;
  mean: number[];
  /** Best θ of the generation and its fitness. */
  best: number[];
  bestFitness: number;
  /** Fitness of the mean before the step (the first candidate of every generation is the mean). */
  meanFitness: number;
}

export interface CmaResult {
  best: number[];
  bestFitness: number;
  /** Fitness of θ = 0, on the same mazes. */
  originFitness: number;
  history: CmaGeneration[];
  evaluations: number;
}

/**
 * Maximises `fitness` (a batch evaluator over a list of θ) from θ = 0. Every generation also
 * evaluates the current mean, and the first generation evaluates θ = 0, so the result is never
 * worse than the start on the training mazes.
 */
export async function cmaes(fitness: (thetas: number[][]) => Promise<number[]>, options: CmaOptions): Promise<CmaResult> {
  const n = options.dim;
  const lambda = options.lambda;
  const mu = Math.floor(lambda / 2);
  const rawWeights = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1));
  const weightSum = rawWeights.reduce((s, x) => s + x, 0);
  const weights = rawWeights.map((x) => x / weightSum);
  const muEff = 1 / weights.reduce((s, x) => s + x * x, 0);
  const cSigma = (muEff + 2) / (n + muEff + 5);
  const dSigma = 1 + 2 * Math.max(0, Math.sqrt((muEff - 1) / (n + 1)) - 1) + cSigma;
  const cc = (4 + muEff / n) / (n + 4 + (2 * muEff) / n);
  const c1 = 2 / ((n + 1.3) ** 2 + muEff);
  const cMu = Math.min(1 - c1, (2 * (muEff - 2 + 1 / muEff)) / ((n + 2) ** 2 + muEff));
  const chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
  const normal = new Normal(options.seed);

  let mean = new Array<number>(n).fill(0);
  let sigma = options.sigma0;
  let c: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  let pSigma = new Array<number>(n).fill(0);
  let pc = new Array<number>(n).fill(0);
  let best: number[] = mean.slice();
  let bestFitness = Number.NEGATIVE_INFINITY;
  let originFitness = Number.NaN;
  let evaluations = 0;
  const history: CmaGeneration[] = [];

  for (let generation = 0; generation < options.generations; generation++) {
    const { values, vectors } = symmetricEigen(c);
    const d = values.map((x) => Math.sqrt(Math.max(x, 1e-20)));
    const ys: number[][] = [];
    const xs: number[][] = [mean.slice()];
    for (let k = 0; k < lambda; k++) {
      const z = Array.from({ length: n }, () => normal.next());
      const y = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) y[i] += vectors[i][j] * d[j] * z[j];
      ys.push(y);
      xs.push(mean.map((m, i) => m + sigma * y[i]));
    }
    const f = await fitness(xs);
    evaluations += xs.length;
    if (generation === 0) originFitness = f[0];
    const meanFitness = f[0];
    if (meanFitness > bestFitness) {
      bestFitness = meanFitness;
      best = xs[0].slice();
    }
    const order = Array.from({ length: lambda }, (_, k) => k).sort((a, b) => f[b + 1] - f[a + 1]);
    if (f[order[0] + 1] > bestFitness) {
      bestFitness = f[order[0] + 1];
      best = xs[order[0] + 1].slice();
    }
    // Recombination.
    const yw = new Array<number>(n).fill(0);
    for (let r = 0; r < mu; r++) for (let i = 0; i < n; i++) yw[i] += weights[r] * ys[order[r]][i];
    const oldMean = mean;
    mean = oldMean.map((m, i) => m + sigma * yw[i]);
    // C^{-1/2} yw = B diag(1/d) Bᵀ yw.
    const bt = new Array<number>(n).fill(0);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) bt[j] += vectors[i][j] * yw[i];
    const invSqrt = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) invSqrt[i] += (vectors[i][j] * bt[j]) / d[j];
    pSigma = pSigma.map((p, i) => (1 - cSigma) * p + Math.sqrt(cSigma * (2 - cSigma) * muEff) * invSqrt[i]);
    const pSigmaNorm = Math.sqrt(pSigma.reduce((s, x) => s + x * x, 0));
    const hSigma = pSigmaNorm / Math.sqrt(1 - (1 - cSigma) ** (2 * (generation + 1))) / chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
    pc = pc.map((p, i) => (1 - cc) * p + hSigma * Math.sqrt(cc * (2 - cc) * muEff) * yw[i]);
    const next = c.map((row) => row.slice());
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let rankMu = 0;
        for (let r = 0; r < mu; r++) rankMu += weights[r] * ys[order[r]][i] * ys[order[r]][j];
        next[i][j] = (1 - c1 - cMu) * c[i][j] + c1 * (pc[i] * pc[j] + (1 - hSigma) * cc * (2 - cc) * c[i][j]) + cMu * rankMu;
      }
    }
    c = next;
    sigma *= Math.exp((cSigma / dSigma) * (pSigmaNorm / chiN - 1));
    history.push({ generation, sigma, mean: oldMean, best: xs[order[0] + 1], bestFitness: f[order[0] + 1], meanFitness });
  }
  // The final mean is evaluated once more: it is often the best point.
  const last = await fitness([mean]);
  evaluations += 1;
  if (last[0] > bestFitness) {
    bestFitness = last[0];
    best = mean.slice();
  }
  return { best, bestFitness, originFitness, history, evaluations };
}
