// Bot interface of the simulator (plan §3.3).

import type { Game } from '../engine';

export interface Bot {
  /** Called once per game, after the engine has put the player on the start cell. */
  begin(g: Game): void;
  /**
   * Called at every decision point (the game is in progress and the current cell has at least
   * one forward opening). Returns the index of the child to move to, or `CASH_OUT`.
   */
  decide(g: Game): number;
  /**
   * Present on bots that are scored by their exact conditional expectation given the maze
   * instead of by a sampled game: the probability that the bot reaches the exit of `open`.
   */
  winProbability?(g: Game, open: Uint8Array): number;
}
