// How a client seed dresses the console screen. Only the start side is about the maze (the
// seed picks it, see `deriveFinalSeed`); the theme and the torches are decoration drawn from the
// seed's bytes, so each reroll looks different without telling anything about the maze.

import { startSideOf, type Hex, type StartSide } from '@maze/shared';

export const THEMES = ['stone', 'moss', 'crypt', 'ember'] as const;
export type Theme = (typeof THEMES)[number];

export interface Dungeon {
  /** The side the start opens to, or `null` for a seed that does not pick one. */
  side: StartSide | null;
  theme: Theme;
  /**
   * Torches on the outer wall, alternating between the left and the right edge, each at a height
   * given as a fraction of the screen (kept off the top row and the exit's corner).
   */
  torches: { side: 'L' | 'R'; at: number }[];
  /** A short name for the seed, its first four hex digits: "3F9A". */
  code: string;
}

export function dungeonOf(clientSeed: Hex): Dungeon {
  const byte = (k: number): number => parseInt(clientSeed.slice(2 + 2 * k, 4 + 2 * k), 16);
  const count = 2 + (byte(3) % 3);
  const first = byte(3) & 0x80 ? 'L' : 'R';
  const torches: Dungeon['torches'] = [];
  for (let k = 0; k < count; k++) {
    const side = (k % 2 === 0) === (first === 'L') ? 'L' : 'R';
    // Between 15% and 70% of the screen height: off the top row and the exit's corner.
    torches.push({ side, at: 0.15 + (byte(4 + k) / 255) * 0.55 });
  }
  return {
    side: startSideOf(clientSeed),
    theme: THEMES[byte(2) % THEMES.length],
    torches,
    code: clientSeed.slice(2, 6).toUpperCase(),
  };
}
