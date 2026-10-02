// R_c of plan §3.3: the cells reachable from a cell by stepping only on unvisited cells. Walls
// are unknown there, so plain grid adjacency is used.

import { VISITED, type Game } from '../engine';

export class Region {
  private readonly stamp: Int32Array;
  private readonly queue: Int32Array;
  private generation = 0;
  /** Size of the last filled region. */
  size = 0;
  /** Whether the last filled region contains the exit. */
  hasExit = false;

  constructor(cells: number) {
    this.stamp = new Int32Array(cells);
    this.queue = new Int32Array(cells);
  }

  /**
   * Fills the region of `start` (an unvisited cell). `blocked`, when not -1, is treated as
   * visited too: it is the cell the player would be standing on in a lookahead.
   */
  fill(g: Game, start: number, blocked = -1): void {
    const { status, nbr, exit } = g;
    const { stamp, queue } = this;
    const mark = ++this.generation;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    stamp[start] = mark;
    let hasExit = start === exit;
    while (head < tail) {
      const cell = queue[head++];
      for (let dir = 0; dir < 4; dir++) {
        const next = nbr[cell * 4 + dir];
        if (next < 0 || next === blocked || stamp[next] === mark || status[next] === VISITED) continue;
        stamp[next] = mark;
        if (next === exit) hasExit = true;
        queue[tail++] = next;
      }
    }
    this.size = tail;
    this.hasExit = hasExit;
  }
}
