// @vitest-environment happy-dom
//
// AC-P1: the chest vectors, run in a browser-like environment. The verify screen recomputes the
// chests in the browser, so the module must not depend on anything that only Node provides.

import { describe, expect, it } from 'vitest';
import { chestGames, expectChestGame } from './chest-vectors';

describe('chest vectors in a browser environment', () => {
  it('AC-P1 runs with a browser window and document', () => {
    expect('window' in globalThis).toBe(true);
    expect('document' in globalThis).toBe(true);
  });

  it.each(chestGames)('AC-P1 vector game $mazeVector (n = $n) is reproduced in the browser environment', (game) => {
    expectChestGame(game);
  });
});
