// naiveChoice (plan §3.3): the deterministic "head for the exit" rule shared by the greedy bots.
//
//   one candidate                → it
//   B = candidates of least d    → the only one, or
//   B = {E, S}                   → E when dx(u) > dy(u), S when dy(u) > dx(u),
//                                  on a tie E when x + y is even and S when it is odd
//   B = {N, W}                   → N when dx(u) >= dy(u), otherwise W
//
// `u` is the current cell, `dx` / `dy` its remaining horizontal / vertical distance to the exit.

import type { Game } from '../engine';

/**
 * `naiveChoice` over the children whose bit is set in `allowed` (bit `i` ↔ child `i`). Returns
 * a child index. `allowed` must select at least one child.
 */
export function naiveChoiceAmong(g: Game, allowed: number): number {
  let best = -1;
  let second = -1;
  let bestD = 0;
  for (let i = 0; i < g.nc; i++) {
    if (((allowed >> i) & 1) === 0) continue;
    const d = g.dist[g.childCell[i]];
    if (best === -1 || d < bestD) {
      best = i;
      second = -1;
      bestD = d;
    } else if (d === bestD) {
      second = i;
    }
  }
  if (second === -1) return best;
  // Children are listed in the order N, E, S, W, so `best` is E (or N) and `second` is S (or W).
  const dx = g.w - 1 - g.xs[g.cell];
  const dy = g.h - 1 - g.ys[g.cell];
  if (g.childDir[best] === 1) {
    if (dx > dy) return best;
    if (dy > dx) return second;
    return (g.xs[g.cell] + g.ys[g.cell]) % 2 === 0 ? best : second;
  }
  return dx >= dy ? best : second;
}

/** `naiveChoice` over all children of the current cell. */
export function naiveChoice(g: Game): number {
  return g.nc === 1 ? 0 : naiveChoiceAmong(g, (1 << g.nc) - 1);
}
