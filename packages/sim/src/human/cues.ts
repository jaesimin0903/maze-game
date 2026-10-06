// What a player can see at a decision point.
//
// The engine marks every cell VISITED (stood on), HEAD (not stood on, behind an open side of a
// visited cell) or FREE (nothing known about it). Walls are known only around visited cells.
// Every cue here is computed from `g.status`, `g.back`, the grid geometry and the current
// cell's forward openings (`childCell`, `childDir`); none reads `g.open`. The tests wrap
// `g.open` to prove it.
//
// In a perfect maze the route from a head to the exit cannot pass through a visited cell or
// another head: either would close a loop through the visited path. So a head can still lead
// to the exit only through FREE cells, and "walled off" below is exact: a head is walled off
// exactly when the exact posterior gives it probability 0 (also checked by the tests). On the
// screen a person sees it as a pocket that their own path and the walls they have seen close
// off from the exit.

import { FREE, HEAD, type Game } from '../engine';

/** `route` of a head that cannot reach the exit any more. */
export const WALLED = -1;
const CONTESTED = -2;
const UNSEEN = -1;

export class Cues {
  /** Forward openings of the current cell, in the engine's child order. */
  nc = 0;
  /** +1 when the child is closer to the exit than the current cell, -1 when it is farther. */
  readonly toward = new Int8Array(4);
  /** Steps from the child to the exit through unknown cells if every unknown wall were open; WALLED when it is closed off. */
  readonly route = new Int32Array(4);
  /** Unknown cells nearer to this child than to any other head, the child included: "open space on that side". Filled by `fillSpace`. */
  readonly space = new Int32Array(4);
  /** 1 when the child continues in the direction of the last move. */
  readonly straight = new Uint8Array(4);
  /** Bit `i` set: child `i` can still lead to the exit. */
  viableMask = 0;
  viable = 0;
  /** Index of the child that is the exit, or -1. */
  exitChild = -1;

  /** Every head: the children of the current cell first (same order), then the earlier untaken branches. */
  heads = 0;
  readonly headCell: Int32Array;
  readonly headRoute: Int32Array;
  /** Filled by `fillSpace`. */
  readonly headSpace: Int32Array;
  readonly headToward: Int8Array;
  /** 1 when the head steps toward the exit along the axis on which its parent cell is farther from it (or equally far): keeping to the diagonal. */
  readonly headDiagonal: Int8Array;
  /** Heads that can still lead to the exit. */
  openHeads = 0;
  private componentsReady = false;

  private readonly exitDist: Int32Array;
  private readonly owner: Int32Array;
  private readonly depth: Int32Array;
  private readonly component: Int32Array;
  private readonly componentSize: Int32Array;
  private readonly headOf: Int32Array;
  private readonly queue: Int32Array;
  private readonly seenComponents = new Int32Array(4);

  constructor(cells: number) {
    this.headCell = new Int32Array(cells);
    this.headRoute = new Int32Array(cells);
    this.headSpace = new Int32Array(cells);
    this.headToward = new Int8Array(cells);
    this.headDiagonal = new Int8Array(cells);
    this.exitDist = new Int32Array(cells);
    this.owner = new Int32Array(cells);
    this.depth = new Int32Array(cells);
    this.component = new Int32Array(cells);
    this.componentSize = new Int32Array(cells + 1);
    this.headOf = new Int32Array(cells);
    this.queue = new Int32Array(cells);
  }

  /**
   * Fills the cheap cues of the game's current decision point (heads, routes, direction,
   * which branches are walled off). `lastDir` is the direction of the last move (-1 before the
   * first). Open space (`fillSpace`) and pocket size (`roomOf`) are computed on request.
   */
  compute(g: Game, lastDir: number): void {
    const { status, nbr, cells, exit } = g;
    const { headCell, headOf, queue } = this;

    // Heads, current children first.
    headOf.fill(-1);
    let heads = 0;
    for (let i = 0; i < g.nc; i++) {
      headCell[heads] = g.childCell[i];
      headOf[g.childCell[i]] = heads;
      heads += 1;
    }
    for (let cell = 0; cell < cells; cell++) {
      if (status[cell] === HEAD && headOf[cell] === -1) {
        headCell[heads] = cell;
        headOf[cell] = heads;
        heads += 1;
      }
    }
    this.heads = heads;

    // Distance to the exit through FREE cells.
    const exitDist = this.exitDist;
    exitDist.fill(UNSEEN);
    const exitFree = status[exit] === FREE;
    if (exitFree) {
      let head = 0;
      let tail = 0;
      queue[tail++] = exit;
      exitDist[exit] = 0;
      while (head < tail) {
        const cell = queue[head++];
        for (let dir = 0; dir < 4; dir++) {
          const next = nbr[cell * 4 + dir];
          if (next < 0 || status[next] !== FREE || exitDist[next] !== UNSEEN) continue;
          exitDist[next] = exitDist[cell] + 1;
          queue[tail++] = next;
        }
      }
    }
    for (let h = 0; h < heads; h++) {
      const cell = headCell[h];
      let route = WALLED;
      if (cell === exit) route = 0;
      else if (exitFree) {
        for (let dir = 0; dir < 4; dir++) {
          const next = nbr[cell * 4 + dir];
          if (next < 0 || exitDist[next] === UNSEEN) continue;
          if (route === WALLED || exitDist[next] + 1 < route) route = exitDist[next] + 1;
        }
      }
      this.headRoute[h] = route;
      // A head hangs off the visited cell behind its back side.
      const parent = h < g.nc ? g.cell : nbr[cell * 4 + (31 - Math.clz32(g.back[cell]))];
      this.headToward[h] = g.dist[cell] < g.dist[parent] ? 1 : -1;
      const dx = g.w - 1 - g.xs[parent];
      const dy = g.h - 1 - g.ys[parent];
      this.headDiagonal[h] = (cell === parent + 1 && dx >= dy) || (cell === parent + g.w && dy >= dx) ? 1 : 0;
    }

    this.componentsReady = false;
    this.nc = g.nc;
    this.viableMask = 0;
    this.viable = 0;
    this.exitChild = -1;
    this.openHeads = 0;
    for (let h = 0; h < heads; h++) if (this.headRoute[h] !== WALLED) this.openHeads += 1;
    for (let i = 0; i < g.nc; i++) {
      this.toward[i] = this.headToward[i];
      this.route[i] = this.headRoute[i];
      this.straight[i] = g.childDir[i] === lastDir ? 1 : 0;
      if (g.childCell[i] === exit) this.exitChild = i;
      if (this.route[i] !== WALLED) {
        this.viableMask |= 1 << i;
        this.viable += 1;
      }
    }
  }

  /** Unknown cells child `i` could still lead to, the child included: the size of its pocket when it is walled off. */
  roomOf(g: Game, i: number): number {
    if (!this.componentsReady) {
      this.fillComponents(g);
      this.componentsReady = true;
    }
    const cell = g.childCell[i];
    const { nbr, status } = g;
    const seen = this.seenComponents;
    let count = 0;
    let room = 1;
    for (let dir = 0; dir < 4; dir++) {
      const next = nbr[cell * 4 + dir];
      if (next < 0 || status[next] !== FREE) continue;
      const label = this.component[next];
      let known = false;
      for (let j = 0; j < count; j++) if (seen[j] === label) known = true;
      if (known) continue;
      seen[count++] = label;
      room += this.componentSize[label];
    }
    return room;
  }

  /** Labels the connected components of FREE cells (grid adjacency) and their sizes. */
  private fillComponents(g: Game): void {
    const { status, nbr, cells } = g;
    const { component, componentSize, queue } = this;
    component.fill(0);
    let label = 0;
    for (let start = 0; start < cells; start++) {
      if (status[start] !== FREE || component[start] !== 0) continue;
      label += 1;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      component[start] = label;
      while (head < tail) {
        const cell = queue[head++];
        for (let dir = 0; dir < 4; dir++) {
          const next = nbr[cell * 4 + dir];
          if (next < 0 || status[next] !== FREE || component[next] !== 0) continue;
          component[next] = label;
          queue[tail++] = next;
        }
      }
      componentSize[label] = tail;
    }
  }

  /**
   * Fills `headSpace` and `space`: a multi-source breadth-first search from every head over
   * FREE cells. A cell belongs to the head that reaches it first; a cell two heads reach at the
   * same depth belongs to neither, and so do the cells reached only through it. Must follow
   * `compute` for the same position.
   */
  fillSpace(g: Game): void {
    const { status, nbr } = g;
    const { owner, depth, queue, headCell, headSpace, heads } = this;
    owner.fill(UNSEEN);
    let head = 0;
    let tail = 0;
    for (let h = 0; h < heads; h++) {
      owner[headCell[h]] = h;
      depth[headCell[h]] = 0;
      headSpace[h] = 1;
      queue[tail++] = headCell[h];
    }
    while (head < tail) {
      const cell = queue[head++];
      const from = owner[cell];
      for (let dir = 0; dir < 4; dir++) {
        const next = nbr[cell * 4 + dir];
        if (next < 0 || status[next] !== FREE) continue;
        if (owner[next] === UNSEEN) {
          owner[next] = from;
          depth[next] = depth[cell] + 1;
          queue[tail++] = next;
        } else if (owner[next] !== from && depth[next] === depth[cell] + 1) {
          owner[next] = CONTESTED;
        }
      }
    }
    // Counted after the search: a cell can turn contested after it was first claimed.
    for (let i = heads; i < tail; i++) {
      const who = owner[queue[i]];
      if (who >= 0) headSpace[who] += 1;
    }
    for (let i = 0; i < this.nc; i++) this.space[i] = headSpace[i];
  }
}
