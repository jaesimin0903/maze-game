// Models of people playing the maze game.
//
// Each model is a legal player: it decides from what the player has seen (the cues of cues.ts,
// the step count, the refund on screen) and from its own random draws, which come from a
// generator handed to it per game (`startGame`), never from the maze generator. The tests check
// both by wrapping the maze and by poisoning the maze generator.
//
// MODELLING ASSUMPTIONS. The behaviours below are inspired by findings of behavioural research
// on decisions under risk and on gambling: bounded rationality (people use a few cues, not the
// exact odds), noisy choice (softmax / random utility), loss aversion and probability weighting
// (prospect theory), learning from feedback (the delta rule, from one's own games),
// near-miss and gambler's-fallacy effects (sessions.ts). Those findings come from other games
// and from laboratory studies; the parameters here are illustrative choices, not measurements
// of people playing this game. Every default is listed in the report with the model.

import type { Rng } from '@maze/shared';
import { naiveChoiceAmong } from '../bots/naive';
import type { Bot } from '../bots/types';
import { CASH_OUT, markSolution, OUTCOME_EXIT, OUTCOME_LOSS, SolutionScratch, type Game } from '../engine';
import { Cues, WALLED } from './cues';
import { gaussian, uniform } from './feed';
import { cashOutUtility, goOnUtility, TK1992, type ProspectParams } from './prospect';

/** A model of a person: a bot plus what happens around a game. */
export interface HumanPolicy extends Bot {
  /** Draws the personal traits of a new individual and forgets anything learned. */
  newPlayer(rng: Rng): void;
  /** Hands over the generator of this game's random draws. Called before every game. */
  startGame(rng: Rng): void;
  /** Called once the game is over (outcome and payout are on `g`). Learning models update here. */
  endGame(g: Game): void;
}

const NO_RNG: Rng = {
  nextU32: () => {
    throw new Error('human model: startGame was not called');
  },
  nextBelow: () => {
    throw new Error('human model: startGame was not called');
  },
};

/** Index of the child that is the exit, or -1. Every model steps onto a visible exit. */
export function exitChild(g: Game): number {
  for (let i = 0; i < g.nc; i++) if (g.childCell[i] === g.exit) return i;
  return -1;
}

/** Direction of the move that led to the current cell, or -1 on the start cell. */
export function lastDirection(g: Game): number {
  if (g.k === 0) return -1;
  const from = g.path[g.k - 1];
  for (let dir = 0; dir < 4; dir++) if (g.nbr[from * 4 + dir] === g.cell) return dir;
  return -1;
}

/** Draws index `i` of `mask` with probability proportional to `exp(utility[i] / temperature)`. */
function softmaxPick(rng: Rng, utility: Float64Array, mask: number, n: number, temperature: number): number {
  let top = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) if ((mask >> i) & 1 && utility[i] > top) top = utility[i];
  let total = 0;
  const weight = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (((mask >> i) & 1) === 0) continue;
    weight[i] = Math.exp((utility[i] - top) / temperature);
    total += weight[i];
  }
  let u = uniform(rng) * total;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (((mask >> i) & 1) === 0) continue;
    last = i;
    u -= weight[i];
    if (u < 0) return i;
  }
  return last;
}

export function bitCount(mask: number): number {
  let count = 0;
  for (let m = mask; m !== 0; m &= m - 1) count += 1;
  return count;
}

// ---------------------------------------------------------------------------------- novice

export interface NoviceParams {
  /** Softmax temperature of the choice at a fork. High: the cue only tilts a near coin flip. */
  temperature: number;
  /** Utility of a branch that gets closer to the exit (one that gets farther has minus this). */
  dirWeight: number;
  /** Utility of keeping the current heading (people like to keep going straight). */
  straightWeight: number;
  /** Chance of cashing out at each fork after the first move (a rare panic). */
  panicRate: number;
}

export const NOVICE_DEFAULTS: NoviceParams = { temperature: 1, dirWeight: 1, straightWeight: 0.5, panicRate: 0.02 };

export class NovicePlayer implements HumanPolicy {
  private rng: Rng = NO_RNG;
  private readonly utility = new Float64Array(4);

  constructor(readonly params: NoviceParams) {}

  newPlayer(): void {}

  startGame(rng: Rng): void {
    this.rng = rng;
  }

  begin(): void {}

  endGame(): void {}

  decide(g: Game): number {
    if (g.nc === 1) return 0;
    const exit = exitChild(g);
    if (exit >= 0) return exit;
    const { params, utility, rng } = this;
    if (g.k >= 1 && uniform(rng) < params.panicRate) return CASH_OUT;
    const heading = lastDirection(g);
    const here = g.dist[g.cell];
    for (let i = 0; i < g.nc; i++) {
      utility[i] = (g.dist[g.childCell[i]] < here ? params.dirWeight : -params.dirWeight) + (g.childDir[i] === heading ? params.straightWeight : 0);
    }
    return softmaxPick(rng, utility, (1 << g.nc) - 1, g.nc, params.temperature);
  }
}

// --------------------------------------------------------------------------------- average

export interface AverageParams {
  /** Chance at a fork of taking a random branch instead of the one toward the exit. */
  lapse: number;
  /** Walled-off pockets of at most this many cells are noticed and avoided; 0 notices none. */
  pocketLimit: number;
  /**
   * Personal stop-loss, drawn uniformly per person, as a share of the refund the screen shows
   * after a straight walk to the exit (refund[shortest path]): cash out once the refund falls
   * below that share of it… (A floor in absolute terms would make every 9×9 game end in a
   * cash-out before the exit can be reached, which a person would not keep doing.)
   */
  refundFloor: [number, number];
  /** …unless the exit is at most this many cells away (people push on near the goal). */
  pushDistance: number;
  /** This many moves in a row away from the exit is a scare… */
  scareRun: number;
  /** …after which the player cashes out with this chance (drawn once per scare). */
  scareQuit: number;
}

export const AVERAGE_DEFAULTS: AverageParams = { lapse: 0.05, pocketLimit: 6, refundFloor: [0.6, 1], pushDistance: 3, scareRun: 2, scareQuit: 0.3 };

/** Parameters with which the average player makes exactly the moves of `naive-greedy` and never cashes out. */
export const AVERAGE_AS_NAIVE: AverageParams = { lapse: 0, pocketLimit: 0, refundFloor: [0, 0], pushDistance: 0, scareRun: 1, scareQuit: 0 };

export class AveragePlayer implements HumanPolicy {
  private rng: Rng = NO_RNG;
  private floor = 0;
  /** Moves in a row away from the exit, and whether this run has already been judged. */
  private awayRun = 0;
  private scareJudged = false;
  private readonly cues: Cues;

  constructor(
    g: Game,
    readonly params: AverageParams,
  ) {
    this.cues = new Cues(g.cells);
  }

  newPlayer(rng: Rng): void {
    const [lo, hi] = this.params.refundFloor;
    this.floor = lo + (hi - lo) * uniform(rng);
  }

  startGame(rng: Rng): void {
    this.rng = rng;
  }

  begin(): void {
    this.awayRun = 0;
    this.scareJudged = false;
  }

  endGame(): void {}

  decide(g: Game): number {
    const exit = exitChild(g);
    if (exit >= 0) return exit;
    const { params, rng } = this;
    if (g.k >= 1) {
      if (g.dist[g.cell] > g.dist[g.path[g.k - 1]]) this.awayRun += 1;
      else {
        this.awayRun = 0;
        this.scareJudged = false;
      }
    }

    let allowed = (1 << g.nc) - 1;
    if (params.pocketLimit > 0) {
      const cues = this.cues;
      cues.compute(g, lastDirection(g));
      for (let i = 0; i < g.nc; i++) if (cues.route[i] === WALLED && cues.roomOf(g, i) <= params.pocketLimit) allowed &= ~(1 << i);
      // Every way on is a small closed pocket: the player sees the game is lost and takes the refund.
      if (allowed === 0) return CASH_OUT;
    }

    if (g.k >= 1) {
      if (this.awayRun >= params.scareRun && !this.scareJudged) {
        this.scareJudged = true;
        if (params.scareQuit > 0 && uniform(rng) < params.scareQuit) return CASH_OUT;
      }
      if (g.refund[g.k] < this.floor * g.refund[g.shortest] && g.dist[g.cell] > params.pushDistance) return CASH_OUT;
    }

    const count = bitCount(allowed);
    if (count >= 2 && params.lapse > 0 && uniform(rng) < params.lapse) {
      let pick = Math.floor(uniform(rng) * count);
      for (let i = 0; i < g.nc; i++) {
        if (((allowed >> i) & 1) === 0) continue;
        if (pick === 0) return i;
        pick -= 1;
      }
    }
    return naiveChoiceAmong(g, allowed);
  }
}

// ------------------------------------------------------------------------------ thoughtful

/** Weights of the cue model of "how likely is the exit behind this branch". */
export interface CueWeights {
  /** Per shortest-path length of the route to the exit, as a fraction of the grid's shortest path (shorter is likelier). */
  route: number;
  /** Per unit of log open space on that side. */
  space: number;
  /** For a branch that steps toward the exit. */
  toward: number;
  /** For a branch that keeps to the diagonal (steps along the axis with more distance left). */
  diagonal: number;
}

export interface ThoughtfulParams {
  /** The cue model; null takes the weights fitted to the exact posterior for the grid size (calibrate.ts). */
  cue: CueWeights | null;
  /** Standard deviation of the noise on each branch's log-odds: how rough the estimate is. */
  perception: number;
  /** Standard deviation of the noise on the log-odds of the felt chance of winning. */
  gutNoise: number;
  /**
   * `reach[r]`: felt chance of making it to the exit from the right branch when its route is `r`
   * cells long ("from about here I make it one time in three"); null takes the values calibrated
   * for the grid size from the player's own games.
   */
  reach: number[] | null;
  /** Share of the games that go wrong in which the player expects to see it coming and bail out later… */
  salvage: number;
  /** …this many moves later, for the refund then on screen. */
  bailLag: number;
  /** Distortions of the comparison between going on and cashing out. */
  prospect: ProspectParams;
  /** Never cashes out before the first move (the bet was placed to play). */
  commitStart: boolean;
}

export const THOUGHTFUL_DEFAULTS: ThoughtfulParams = {
  cue: null,
  perception: 0.3,
  gutNoise: 0.3,
  reach: null,
  salvage: 0.5,
  bailLag: 2,
  prospect: TK1992,
  commitStart: true,
};

/** A thoughtful player's parameters with the per-size values filled in. */
export interface ResolvedThoughtful extends Omit<ThoughtfulParams, 'cue' | 'reach'> {
  cue: CueWeights;
  reach: number[];
}

/** What the gut-feel calibration records at each decision: the felt share of the chosen branch and its route length. */
export interface GutRecorder {
  share: number[];
  route: number[];
}

const LOGIT_CAP = 30;

export class ThoughtfulPlayer implements HumanPolicy {
  private rng: Rng = NO_RNG;
  private readonly cues: Cues;
  private readonly logit: Float64Array;
  private readonly scale: number;
  /** When set, decisions are recorded and the player never cashes out (gut-feel calibration). */
  recorder: GutRecorder | null = null;

  constructor(
    g: Game,
    readonly params: ResolvedThoughtful,
  ) {
    this.cues = new Cues(g.cells);
    this.logit = new Float64Array(g.cells);
    this.scale = g.shortest;
  }

  newPlayer(): void {}

  startGame(rng: Rng): void {
    this.rng = rng;
  }

  begin(): void {}

  endGame(): void {}

  /** Noise-free log-odds of head `h` under the cue model; `scale` is the grid's shortest path. */
  static headLogit(cues: Cues, h: number, cue: CueWeights, scale: number): number {
    return (
      -cue.route * (cues.headRoute[h] / scale) + cue.space * Math.log(cues.headSpace[h]) + cue.toward * cues.headToward[h] + cue.diagonal * cues.headDiagonal[h]
    );
  }

  decide(g: Game): number {
    const exit = exitChild(g);
    if (exit >= 0) return exit;
    const { cues, logit, params, rng } = this;
    cues.compute(g, lastDirection(g));
    if (cues.viable === 0) return CASH_OUT;

    // Felt share of the chance that the exit lies behind each head, current children included.
    // With one open head there is nothing to weigh: the exit is behind it.
    let best = -1;
    let share = 1;
    if (cues.openHeads === 1) {
      for (let i = 0; i < g.nc; i++) if ((cues.viableMask >> i) & 1) best = i;
    } else {
      cues.fillSpace(g);
      let top = Number.NEGATIVE_INFINITY;
      for (let h = 0; h < cues.heads; h++) {
        if (cues.headRoute[h] === WALLED) continue;
        logit[h] = ThoughtfulPlayer.headLogit(cues, h, params.cue, this.scale) + params.perception * gaussian(rng);
        if (logit[h] > top) top = logit[h];
      }
      let total = 0;
      for (let h = 0; h < cues.heads; h++) if (cues.headRoute[h] !== WALLED) total += Math.exp(logit[h] - top);
      for (let i = 0; i < g.nc; i++) {
        if (((cues.viableMask >> i) & 1) === 0) continue;
        if (best === -1 || logit[i] > logit[best]) best = i;
      }
      share = Math.exp(logit[best] - top) / total;
    }
    const route = cues.route[best];
    if (this.recorder !== null) {
      this.recorder.share.push(share);
      this.recorder.route.push(route);
      return best;
    }
    if (g.k === 0 && params.commitStart) return best;

    let felt = share * params.reach[Math.min(route, params.reach.length - 1)];
    if (felt >= 1) return best;
    if (felt <= 0) return CASH_OUT;
    if (params.gutNoise > 0) {
      const z = Math.log(felt / (1 - felt)) + params.gutNoise * gaussian(rng);
      felt = 1 / (1 + Math.exp(-Math.max(-LOGIT_CAP, Math.min(LOGIT_CAP, z))));
    }
    const multiplier = g.multiplierBps / 10_000;
    const refund = g.refund[g.k] / 10_000;
    const later = g.refund[Math.min(g.cells - 1, g.k + params.bailLag)] / 10_000;
    return goOnUtility(felt, multiplier, params.salvage, later, params.prospect) < cashOutUtility(refund, params.prospect) ? CASH_OUT : best;
  }
}

// -------------------------------------------------------------------------------- learning

/** Cue weights of the learning player's choice at a fork. */
export interface LearnedWeights {
  /** For the obvious move: the branch naive-greedy would take (toward the exit, keeping to the diagonal). */
  obvious: number;
  /** For a branch toward the exit (-1 for one away from it). */
  toward: number;
}

export interface LearningParams {
  /** Weights a beginner starts with. */
  start: LearnedWeights;
  /**
   * First step of the delta rule that moves the cue weights toward the branch that really led to
   * the exit; the step shrinks as `rate / (1 + forks reviewed / rateHalfLife)` (practice makes
   * the weights settle).
   */
  rate: number;
  rateHalfLife: number;
  /** Chance at a fork of a slip: a random branch instead of the one that looks best. */
  lapse: number;
  /** Chance per decision of noticing that a branch is walled off, at first… */
  startAttention: number;
  /** …and how far each lesson (a dead end after a closed-off pocket went unnoticed) moves it toward 1. */
  lessonRate: number;
  /** What a beginner believes the chance of pushing on to the exit from a fork to be (optimism)… */
  priorWin: number;
  /** …held as if it were based on this many games. */
  priorWeight: number;
  /** Chance per game of deciding to go all the way this time ("feeling lucky"); the chances are learned from those games. */
  explore: number;
}

export const LEARNING_DEFAULTS: LearningParams = {
  start: { obvious: 1, toward: 1 },
  rate: 0.2,
  rateHalfLife: 100,
  lapse: 0.02,
  startAttention: 0.1,
  lessonRate: 0.25,
  priorWin: 0.5,
  priorWeight: 5,
  explore: 0.2,
};

/** Distance bands of the learning player's experience: near, middle, far third of the shortest path. */
export const BANDS = 3;

export function bandOf(distance: number, shortest: number): number {
  return Math.min(BANDS - 1, Math.floor((BANDS * distance) / (shortest + 1)));
}

const FEATURES = 2;
/** Forks remembered per game; a longer game reviews only its first forks. */
const FORK_MEMORY = 64;

export interface TierMemory {
  /** Per band: forks pushed on from in games played to the end, and how many of those games reached the exit. */
  forks: number[];
  wins: number[];
}

/**
 * A beginner who learns three things from their own games:
 *   - which cues point to the right branch: after each game the whole maze is shown (the game's
 *     verification screen) and the cue weights move toward the branch that really led on (delta rule);
 *   - to watch for closed-off pockets: every dead end that a visible closed pocket would have
 *     predicted raises the chance of noticing such pockets (and cashing out when every way on is
 *     closed);
 *   - when pushing on pays: the share of the games played to the end from a fork at each distance
 *     that reached the exit, compared with the refund (risk-neutral).
 */
export class LearningPlayer implements HumanPolicy {
  private rng: Rng = NO_RNG;
  private readonly cues: Cues;
  readonly weights = new Float64Array(FEATURES);
  attention = 0;
  private readonly memory = new Map<number, TierMemory>();
  private readonly utility = new Float64Array(4);
  private readonly scratch: SolutionScratch;
  /** This game's forks: the features and cell of every branch, and the softmax probabilities. */
  private readonly forkFeatures = new Float64Array(FORK_MEMORY * 4 * FEATURES);
  private readonly forkCells = new Int32Array(FORK_MEMORY * 4);
  private readonly forkProbability = new Float64Array(FORK_MEMORY * 4);
  private readonly forkBranches = new Int8Array(FORK_MEMORY);
  private forks = 0;
  /** Bands of the forks this game went on from. */
  private readonly continued: number[] = [];
  /** This game is played to the end whatever happens. */
  private allTheWay = false;
  /** A closed-off pocket was in view this game and went unnoticed. */
  private missedPocket = false;
  /** Forks reviewed after games so far. */
  private reviewed = 0;

  constructor(
    g: Game,
    readonly params: LearningParams,
  ) {
    this.cues = new Cues(g.cells);
    this.scratch = new SolutionScratch(g.cells);
  }

  newPlayer(): void {
    const { start } = this.params;
    this.weights.set([start.obvious, start.toward]);
    this.attention = this.params.startAttention;
    this.memory.clear();
    this.reviewed = 0;
  }

  startGame(rng: Rng): void {
    this.rng = rng;
    this.allTheWay = uniform(rng) < this.params.explore;
  }

  begin(): void {
    this.forks = 0;
    this.continued.length = 0;
    this.missedPocket = false;
  }

  /** The learner's experience on the grid of `g` (created on first use). */
  tierMemory(g: Game): TierMemory {
    let memory = this.memory.get(g.cells);
    if (memory === undefined) {
      memory = { forks: new Array<number>(BANDS).fill(0), wins: new Array<number>(BANDS).fill(0) };
      this.memory.set(g.cells, memory);
    }
    return memory;
  }

  /** The learner's belief about pushing on to the end from a fork in `band`. */
  winChance(g: Game, band: number): number {
    const memory = this.tierMemory(g);
    const { priorWin, priorWeight } = this.params;
    return (priorWin * priorWeight + memory.wins[band]) / (priorWeight + memory.forks[band]);
  }

  decide(g: Game): number {
    const exit = exitChild(g);
    if (exit >= 0) return exit;
    const { cues, weights, utility, params } = this;
    const rng = this.rng;
    cues.compute(g, lastDirection(g));
    const pocket = cues.viable < g.nc;
    const noticed = pocket && uniform(rng) < this.attention;
    if (pocket && !noticed) this.missedPocket = true;
    if (noticed && cues.viable === 0 && !this.allTheWay) return CASH_OUT;
    if (g.nc === 1) return 0;

    if (g.k >= 1) {
      const band = bandOf(g.dist[g.cell], g.shortest);
      // Risk-neutral by experience: pushing on to the end pays the multiplier as often as it worked before.
      if (!this.allTheWay && this.winChance(g, band) * g.multiplierBps < g.refund[g.k]) return CASH_OUT;
      this.continued.push(band);
    }

    const candidates = noticed && cues.viable > 0 ? cues.viableMask : (1 << g.nc) - 1;
    const obvious = naiveChoiceAmong(g, candidates);
    const slot = this.forks < FORK_MEMORY ? this.forks : -1;
    const features = this.forkFeatures;
    let top = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < g.nc; i++) {
      const at = ((slot < 0 ? 0 : slot) * 4 + i) * FEATURES;
      features[at] = i === obvious ? 1 : 0;
      features[at + 1] = cues.toward[i];
      const u = weights[0] * features[at] + weights[1] * features[at + 1];
      utility[i] = u;
      if ((candidates >> i) & 1 && u > top) top = u;
    }
    let pick = 0;
    if (bitCount(candidates) > 1 && uniform(rng) < params.lapse) {
      let draw = Math.floor(uniform(rng) * bitCount(candidates));
      for (let i = 0; i < g.nc; i++) {
        if (((candidates >> i) & 1) === 0) continue;
        if (draw === 0) {
          pick = i;
          break;
        }
        draw -= 1;
      }
    } else {
      let tied = 0;
      for (let i = 0; i < g.nc; i++) if ((candidates >> i) & 1 && utility[i] >= top - 1e-12) tied |= 1 << i;
      pick = naiveChoiceAmong(g, tied);
    }
    if (slot >= 0) {
      let total = 0;
      for (let i = 0; i < g.nc; i++) total += Math.exp(utility[i] - top);
      for (let i = 0; i < g.nc; i++) {
        this.forkProbability[slot * 4 + i] = Math.exp(utility[i] - top) / total;
        this.forkCells[slot * 4 + i] = g.childCell[i];
      }
      this.forkBranches[slot] = g.nc;
      this.forks += 1;
    }
    return pick;
  }

  /**
   * Learning after the game. Reading the whole maze here is legal: the game is over and the game
   * shows its maze to the player (verification screen). The decisions never read it.
   */
  endGame(g: Game): void {
    const onPath = this.scratch.onPath;
    markSolution(g, g.open, this.scratch);
    const { weights, forkFeatures, forkProbability, forkCells, forkBranches } = this;
    for (let fork = 0; fork < this.forks; fork++) {
      const branches = forkBranches[fork];
      let right = -1;
      for (let i = 0; i < branches; i++) if (onPath[forkCells[fork * 4 + i]] === 1) right = i;
      if (right < 0) continue;
      const step = this.params.rate / (1 + this.reviewed / this.params.rateHalfLife);
      this.reviewed += 1;
      for (let f = 0; f < FEATURES; f++) {
        let expected = 0;
        for (let i = 0; i < branches; i++) expected += forkProbability[fork * 4 + i] * forkFeatures[(fork * 4 + i) * FEATURES + f];
        weights[f] += step * (forkFeatures[(fork * 4 + right) * FEATURES + f] - expected);
      }
    }
    if (this.missedPocket && g.outcome === OUTCOME_LOSS) this.attention += this.params.lessonRate * (1 - this.attention);
    if (this.allTheWay) {
      const memory = this.tierMemory(g);
      const won = g.outcome === OUTCOME_EXIT ? 1 : 0;
      for (const band of this.continued) {
        memory.forks[band] += 1;
        memory.wins[band] += won;
      }
    }
  }
}
