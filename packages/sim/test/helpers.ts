// Shared by the simulator tests.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRefundTable, type CurveParams } from '@maze/shared';
import { CacheStore } from '../src/cache';
import { BIT, type Game, type TierEconomics } from '../src/engine';
import type { EnumeratedMazes } from '../src/exact';
import { InlineExecutor } from '../src/pool';
import { PRODUCTION, type Profile } from '../src/profile';
import { Runner } from '../src/runner';

/** Candidate (ii) of the plan: the Phase 0 default curve. */
export const CURVE_II: CurveParams = { family: 'two-stage-geometric', e0Bps: 500, aBps: 7300, phi: 0.5 };

export function econFor(w: number, h: number, multiplierBps: number, curve: CurveParams = CURVE_II): TierEconomics {
  return { w, h, multiplierBps, refundBps: buildRefundTable({ cells: w * h, shortestPath: w + h - 2, curve }) };
}

export function mazeAt(e: EnumeratedMazes, index: number): Uint8Array {
  const cells = e.w * e.h;
  return e.mazes.subarray(index * cells, (index + 1) * cells);
}

/** Indices of the enumerated mazes that agree with everything the player of `g` has seen. */
export function consistentMazes(e: EnumeratedMazes, g: Game): number[] {
  const cells = e.w * e.h;
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) {
    let same = true;
    for (let t = 0; t <= g.k && same; t++) same = e.mazes[i * cells + g.path[t]] === g.open[g.path[t]];
    if (same) out.push(i);
  }
  return out;
}

/** Whether the exit of `open` can be reached from `head` without stepping on a cell marked in `blocked`. */
export function exitBelow(open: Uint8Array, w: number, head: number, blocked: Uint8Array): boolean {
  const cells = open.length;
  const offset = [-w, 1, w, -1];
  const seen = new Uint8Array(cells);
  const stack = [head];
  seen[head] = 1;
  while (stack.length > 0) {
    const cell = stack.pop()!;
    if (cell === cells - 1) return true;
    for (let dir = 0; dir < 4; dir++) {
      if ((open[cell] & BIT[dir]) === 0) continue;
      const next = cell + offset[dir];
      if (seen[next] === 0 && blocked[next] === 0) {
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  return false;
}

/** Marks the cells the player of `g` has visited. */
export function visitedCells(g: Game): Uint8Array {
  const visited = new Uint8Array(g.cells);
  for (let t = 0; t <= g.k; t++) visited[g.path[t]] = 1;
  return visited;
}

export function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'maze-sim-test-'));
}

/** A runner on the calling thread with its cache in `directory`. */
export function testRunner(
  directory: string,
  profile: Partial<Profile> = {},
  options: { codeHash?: string; deadline?: number; readOnly?: boolean; now?: () => number } = {},
): Runner {
  return new Runner({
    executor: new InlineExecutor(),
    store: new CacheStore(join(directory, 'cache')),
    profile: { ...PRODUCTION, ...profile },
    codeHash: options.codeHash ?? 'test-code-hash',
    rngMode: 'fast',
    deadline: options.deadline ?? Number.POSITIVE_INFINITY,
    readOnly: options.readOnly,
    now: options.now,
  });
}
