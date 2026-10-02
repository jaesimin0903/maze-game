// Per-game records for `sim:stats`.
//
// The certification keeps only sums per cell. The statistics command needs the games one by
// one, so this plays them with the same engine, mazes and bots and returns one code per game.
// It is a pure function of the job, on any thread.
//
// This file is the whole dependency of the statistics worker. It must not import `./worker`
// (directly or through another module): that module installs its own message handler when it
// is loaded inside a pool thread.

import { createBot, type BotSpec } from './bots/index';
import { Game, MazeFeed, play, type MazeSource, type TierEconomics } from './engine';

/** A game's code is `moves × 4 + outcome`, with the engine's outcome numbering. */
export const CODE_OUTCOMES = 4;
/** Largest grid whose move count fits the code. */
export const MAX_RECORD_CELLS = 0x1_0000 / CODE_OUTCOMES;

export interface RecordJob {
  econ: TierEconomics;
  bot: BotSpec;
  source: MazeSource;
  /** Games `from .. to - 1` of the source's stream. */
  from: number;
  to: number;
}

/** Plays the games of `job` and returns the code of each, in game order. */
export function recordGames(job: RecordJob): Uint16Array {
  const g = new Game(job.econ);
  if (g.cells > MAX_RECORD_CELLS) throw new RangeError(`recordGames: a ${g.w}x${g.h} grid has too many cells for a game code`);
  const bot = createBot(job.bot, g);
  const feed = new MazeFeed(job.source, g.w, g.h);
  const codes = new Uint16Array(job.to - job.from);
  for (let index = job.from; index < job.to; index++) {
    feed.load(index);
    play(g, bot, feed.open, feed.rng);
    codes[index - job.from] = g.k * CODE_OUTCOMES + g.outcome;
  }
  return codes;
}
