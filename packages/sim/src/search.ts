// The θ search of param-search (plan §3.3).
//
//   θ ∈ [-4, 4]^6: 256 uniform points → keep the best 8 → three rounds of 16 Gaussian
//   perturbations (σ 0.5) around each kept point, keeping the best 8 of old and new.
//   Fitness = mean payout over the first 200,000 games of stream C (the same games for every θ).
//
// The search runs once per (candidate, tier), at the multiplier where the coarse bisection ended;
// the θ it returns is then fixed and becomes a hyperparameter of the bot's cells.

import { fastRng, type Rng } from '@maze/shared';
import { join } from 'node:path';
import { THETA_LENGTH } from './bots/param-search';
import { cacheKey } from './cache';
import { hashFiles, simPackageRoot } from './codehash';
import type { Runner, TierRef } from './runner';

export interface ThetaSearch {
  theta: number[];
  /** Mean payout of the chosen θ on the search games, as a fraction of the bet (optimistic: it was selected on them). */
  fitness: number;
  evaluated: number;
  multiplierBps: number;
}

/** Fixed seed of the search's own randomness (which points are tried). */
const SEARCH_SEED = 0x7061_7261_6d73_3176n;

function uniform(rng: Rng): number {
  return (rng.nextU32() + 0.5) / 0x1_0000_0000;
}

function gaussian(rng: Rng): number {
  return Math.sqrt(-2 * Math.log(uniform(rng))) * Math.cos(2 * Math.PI * uniform(rng));
}

let searchHash: string | null = null;

export async function searchTheta(runner: Runner, tier: TierRef): Promise<ThetaSearch> {
  const plan = runner.profile.paramSearch;
  searchHash ??= hashFiles([join(simPackageRoot(), 'src', 'search.ts')], simPackageRoot());
  const key = cacheKey(tier.hash, `${runner.codeHash}|${searchHash}`, {
    kind: 'param-search',
    profile: runner.profile.name,
    rng: runner.rngMode,
    plan,
  });
  const cached = runner.store.readArtifact(key);
  if (cached !== null) return cached.meta.result as ThetaSearch;

  const what = `param-search ${tier.econ.w}x${tier.econ.h} at ${tier.econ.multiplierBps} bps`;
  runner.checkpoint(what);
  const rng = fastRng(SEARCH_SEED);
  let points: number[][] = [];
  for (let i = 0; i < plan.initial; i++) {
    points.push(Array.from({ length: THETA_LENGTH }, () => (uniform(rng) * 2 - 1) * plan.range));
  }
  let kept: { theta: number[]; fitness: number }[] = [];
  let evaluated = 0;
  for (let round = 0; round <= plan.rounds; round++) {
    const fitness = await runner.fitness(tier, points, plan.games);
    evaluated += points.length;
    kept = [...kept, ...points.map((theta, i) => ({ theta, fitness: fitness[i] }))]
      .sort((a, b) => b.fitness - a.fitness)
      .slice(0, plan.top);
    if (round === plan.rounds) break;
    runner.checkpoint(what);
    points = [];
    for (const { theta } of kept) {
      for (let i = 0; i < plan.perTop; i++) points.push(theta.map((value) => value + plan.sigma * gaussian(rng)));
    }
  }
  const result: ThetaSearch = {
    theta: kept[0].theta,
    fitness: kept[0].fitness / 10_000,
    evaluated,
    multiplierBps: tier.econ.multiplierBps,
  };
  runner.store.writeArtifact(key, { meta: { kind: 'param-search', result }, arrays: {} });
  runner.newUnits += 1;
  return result;
}
