// Calibration of the thoughtful player's intuition, per grid size, on training mazes.
//
// 1. The cue model. At positions reached by heading for the exit, the exact posterior
//    (posterior.ts) gives the probability that the exit lies behind each head. The thoughtful
//    player's felt share is a softmax over the heads of
//        z = −route · (route length / L) + space · ln(open space) + toward · (±1) + diagonal · (0/1)
//    and the four weights are fitted to the exact probabilities by maximum likelihood (Newton's
//    method on the cross-entropy, which is convex). The result is "a person whose sense of where
//    the exit is matches the true odds as well as these four cues allow"; the player then adds
//    noise to it. The fit's agreement with the posterior is reported.
// 2. The gut feel. The felt chance of winning from a branch is `share × reach[route]`, with
//    `reach` chosen so that, over the decisions of the thoughtful player's own games (moves only,
//    playing to the end), the felt chances add up to the games actually won, at every route
//    length: calibrated on average.

import { naiveChoiceAmong } from '../bots/naive';
import { FREE, Game, play, type TierEconomics } from '../engine';
import { Posterior } from '../posterior';
import { Cues, WALLED } from './cues';
import { HumanFeed, NoiseSource } from './feed';
import { exitChild, lastDirection, ThoughtfulPlayer, type CueWeights, type HumanPolicy } from './models';
import { TK1992 } from './prospect';

const FEATURES = 4;

export interface CueFit {
  weights: CueWeights;
  /** Positions with two or more heads that can still lead to the exit. */
  positions: number;
  /** Forks with two or more open branches. */
  forks: number;
  /** Share of those forks at which the cue model's likeliest branch is the posterior's likeliest. */
  agreement: number;
  /** The same share for "toward the exit" (the naive-greedy choice among the open branches). */
  naiveAgreement: number;
  /** Mean cross-entropy against the exact posterior, nats per position: the fit and a uniform guess over the heads. */
  crossEntropy: number;
  uniformCrossEntropy: number;
}

/** Economics without money: the fit only needs the grid. */
function gridOnly(w: number, h: number): TierEconomics {
  return { w, h, multiplierBps: 10_000, refundBps: new Array<number>(w * h).fill(0) };
}

/** Plays naive-greedy and collects, at every position with two or more open heads, the cue features and the exact posterior of each head. */
class PositionCollector implements HumanPolicy {
  private readonly cues: Cues;
  private readonly posterior: Posterior;
  readonly features: number[] = [];
  readonly target: number[] = [];
  /** Position `p` holds heads `offsets[p] .. offsets[p + 1] - 1`. */
  readonly offsets: number[] = [0];
  forks = 0;
  modelAgrees = 0;
  naiveAgrees = 0;

  constructor(
    g: Game,
    private readonly provisional: CueWeights | null,
  ) {
    this.cues = new Cues(g.cells);
    this.posterior = new Posterior(g.w, g.h);
  }

  newPlayer(): void {}
  startGame(): void {}
  begin(): void {}
  endGame(): void {}

  decide(g: Game): number {
    const exit = exitChild(g);
    if (exit >= 0) return exit;
    const { cues, posterior } = this;
    cues.compute(g, lastDirection(g));
    const allowed = cues.viable > 0 ? cues.viableMask : (1 << g.nc) - 1;
    let open = 0;
    for (let h = 0; h < cues.heads; h++) if (cues.headRoute[h] !== WALLED) open += 1;
    if (open >= 2 && g.status[g.exit] === FREE) {
      cues.fillSpace(g);
      if (!posterior.factor(g.status)) throw new Error('calibrate: the observed position admits no spanning tree');
      posterior.solveExit();
      const q = new Float64Array(cues.heads);
      for (let h = 0; h < cues.heads; h++) {
        if (cues.headRoute[h] === WALLED) continue;
        const cell = cues.headCell[h];
        for (let dir = 0; dir < 4; dir++) {
          const u = g.nbr[cell * 4 + dir];
          if (u >= 0 && g.status[u] === FREE) q[h] += posterior.y[u];
        }
        this.features.push(-cues.headRoute[h] / g.shortest, Math.log(cues.headSpace[h]), cues.headToward[h], cues.headDiagonal[h]);
        this.target.push(q[h]);
      }
      this.offsets.push(this.target.length);
      if (cues.viable >= 2) {
        this.forks += 1;
        let truth = -1;
        let model = -1;
        let modelZ = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < g.nc; i++) {
          if (((cues.viableMask >> i) & 1) === 0) continue;
          if (truth === -1 || q[i] > q[truth]) truth = i;
          if (this.provisional !== null) {
            const z = ThoughtfulPlayer.headLogit(cues, i, this.provisional, g.shortest);
            if (z > modelZ) {
              modelZ = z;
              model = i;
            }
          }
        }
        if (model === truth) this.modelAgrees += 1;
        if (naiveChoiceAmong(g, cues.viableMask) === truth) this.naiveAgrees += 1;
      }
    }
    return naiveChoiceAmong(g, allowed);
  }
}

/** Solves `a x = b` for a small dense system (row-major `a`) by Gaussian elimination with partial pivoting. */
function solveDense(a: readonly number[], b: readonly number[]): number[] {
  const n = b.length;
  const m = Array.from({ length: n }, (_, r) => [...a.slice(r * n, r * n + n), b[r]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, r) => row[n] / row[r]);
}

/**
 * Maximum-likelihood weights of a softmax over `FEATURES` features for soft targets, by damped
 * Newton steps. `features` holds `FEATURES` numbers per head; position `p` is heads
 * `offsets[p] .. offsets[p + 1] - 1`, whose targets add up to 1.
 */
export function fitSoftmax(
  features: readonly number[],
  target: readonly number[],
  offsets: readonly number[],
): { weights: number[]; crossEntropy: number; uniformCrossEntropy: number } {
  const positions = offsets.length - 1;
  const z: number[] = [];
  const evaluate = (weights: number[]): { loss: number; grad: number[]; hess: number[] } => {
    let loss = 0;
    const grad = new Array<number>(FEATURES).fill(0);
    const hess = new Array<number>(FEATURES * FEATURES).fill(0);
    for (let p = 0; p < positions; p++) {
      const from = offsets[p];
      const to = offsets[p + 1];
      let top = Number.NEGATIVE_INFINITY;
      for (let j = from; j < to; j++) {
        let s = 0;
        for (let f = 0; f < FEATURES; f++) s += weights[f] * features[j * FEATURES + f];
        z[j - from] = s;
        if (s > top) top = s;
      }
      let total = 0;
      for (let j = from; j < to; j++) total += Math.exp(z[j - from] - top);
      const logTotal = top + Math.log(total);
      const mean = new Array<number>(FEATURES).fill(0);
      for (let j = from; j < to; j++) {
        const pj = Math.exp(z[j - from] - logTotal);
        loss -= target[j] * (z[j - from] - logTotal);
        for (let f = 0; f < FEATURES; f++) {
          const x = features[j * FEATURES + f];
          grad[f] += (pj - target[j]) * x;
          mean[f] += pj * x;
          for (let e = 0; e < FEATURES; e++) hess[f * FEATURES + e] += pj * x * features[j * FEATURES + e];
        }
      }
      for (let f = 0; f < FEATURES; f++) for (let e = 0; e < FEATURES; e++) hess[f * FEATURES + e] -= mean[f] * mean[e];
    }
    return { loss, grad, hess };
  };
  let beta = new Array<number>(FEATURES).fill(0);
  let current = evaluate(beta);
  for (let iteration = 0; iteration < 50; iteration++) {
    for (let f = 0; f < FEATURES; f++) current.hess[f * (FEATURES + 1)] += 1e-9;
    const step = solveDense(current.hess, current.grad);
    // Halve the step until the loss does not rise.
    let scale = 1;
    let next = beta.map((value, f) => value - step[f]);
    let trial = evaluate(next);
    while (trial.loss > current.loss + 1e-12 && scale > 1e-6) {
      scale /= 2;
      next = beta.map((value, f) => value - scale * step[f]);
      trial = evaluate(next);
    }
    const moved = Math.max(...next.map((value, f) => Math.abs(value - beta[f])));
    beta = next;
    current = trial;
    if (moved < 1e-9) break;
  }
  let uniform = 0;
  for (let p = 0; p < positions; p++) {
    const heads = offsets[p + 1] - offsets[p];
    for (let j = offsets[p]; j < offsets[p + 1]; j++) uniform += target[j] * Math.log(heads);
  }
  return { weights: beta, crossEntropy: current.loss / Math.max(1, positions), uniformCrossEntropy: uniform / Math.max(1, positions) };
}

/** Fits the cue model on the naive-greedy positions of training games `first .. first + games - 1`. */
export function fitCueWeights(w: number, h: number, first: number, games: number): CueFit {
  const g = new Game(gridOnly(w, h));
  const feed = new HumanFeed(w, h);
  const collect = (provisional: CueWeights | null): PositionCollector => {
    const collector = new PositionCollector(g, provisional);
    for (let index = first; index < first + games; index++) {
      feed.load(index);
      play(g, collector, feed.open, feed.rng);
    }
    return collector;
  };
  const sample = collect(null);
  const fit = fitSoftmax(sample.features, sample.target, sample.offsets);
  // Feature 0 is minus the scaled route length, the term `−route · length / L` of the model.
  const weights: CueWeights = { route: fit.weights[0], space: fit.weights[1], toward: fit.weights[2], diagonal: fit.weights[3] };
  // The agreement needs the fitted weights, so the same games are walked once more.
  const check = collect(weights);
  return {
    weights,
    positions: sample.offsets.length - 1,
    forks: check.forks,
    agreement: check.modelAgrees / Math.max(1, check.forks),
    naiveAgreement: check.naiveAgrees / Math.max(1, check.forks),
    crossEntropy: fit.crossEntropy,
    uniformCrossEntropy: fit.uniformCrossEntropy,
  };
}

/** Decisions a route length needs before its own count is used; thinner lengths borrow from their neighbours. */
export const REACH_MIN_DECISIONS = 200;

export interface ReachFit {
  /** `reach[r]`: felt chance of making it from the right branch when its route is `r` cells long. */
  reach: number[];
  decisions: number;
  /** Mean felt share of the chosen branch, and the share of decisions whose game was won. */
  meanShare: number;
  winRate: number;
}

/**
 * `reach[r]` = (games won) / (sum of felt shares) over the thoughtful player's own decisions
 * whose chosen branch had a route of `r` cells, so that `share × reach[route]` adds up to the
 * wins at every route length: an experienced player's sense of "from this far I make it about
 * this often". The player plays to the end here (moves only, no cash-outs).
 */
export function calibrateReach(w: number, h: number, cue: CueWeights, perception: number, first: number, games: number): ReachFit {
  const g = new Game(gridOnly(w, h));
  const feed = new HumanFeed(w, h);
  const noise = new NoiseSource(`calibrate-reach/${w}x${h}`);
  const player = new ThoughtfulPlayer(g, { cue, perception, gutNoise: 0, reach: [1], salvage: 0, bailLag: 0, prospect: TK1992, commitStart: true });
  const recorder = { share: [] as number[], route: [] as number[] };
  player.recorder = recorder;
  const lengths = g.cells + 1;
  const shareAt = new Float64Array(lengths);
  const winsAt = new Float64Array(lengths);
  const countAt = new Float64Array(lengths);
  let wins = 0;
  for (let index = first; index < first + games; index++) {
    feed.load(index);
    recorder.share.length = 0;
    recorder.route.length = 0;
    player.startGame(noise.at(index));
    play(g, player, feed.open, feed.rng);
    const win = g.cell === g.exit ? 1 : 0;
    for (let i = 0; i < recorder.share.length; i++) {
      const r = recorder.route[i];
      shareAt[r] += recorder.share[i];
      winsAt[r] += win;
      countAt[r] += 1;
      wins += win;
    }
  }
  const reach: number[] = [];
  let decisions = 0;
  let shares = 0;
  for (let r = 0; r < lengths; r++) {
    decisions += countAt[r];
    shares += shareAt[r];
    let share = shareAt[r];
    let won = winsAt[r];
    let count = countAt[r];
    for (let delta = 1; count < REACH_MIN_DECISIONS && delta < lengths; delta++) {
      for (const at of [r - delta, r + delta]) {
        if (at < 0 || at >= lengths) continue;
        share += shareAt[at];
        won += winsAt[at];
        count += countAt[at];
      }
    }
    reach.push(r === 0 ? 1 : Math.min(1, Math.max(1e-4, share > 0 ? won / share : 1e-4)));
  }
  return { reach, decisions, meanShare: shares / Math.max(1, decisions), winRate: wins / Math.max(1, decisions) };
}
