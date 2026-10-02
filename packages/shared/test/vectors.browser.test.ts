// @vitest-environment happy-dom
//
// AC-M1: the same fixed vectors as maze.test.ts, run in a browser-like environment. The module
// must not depend on anything that only Node provides.

import { describe, expect, it } from 'vitest';
import { expectVector, mazeVectors } from './vectors';

describe('fixed vectors in a browser environment', () => {
  it('AC-M1 runs with a browser window and document', () => {
    expect('window' in globalThis).toBe(true);
    expect('document' in globalThis).toBe(true);
  });

  it.each(mazeVectors)('AC-M1 vector $id (n = $n) is reproduced in the browser environment', (vector) => {
    expectVector(vector);
  });
});
