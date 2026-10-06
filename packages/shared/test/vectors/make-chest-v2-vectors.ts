// Writes chest-v2.json: fixed vectors of chest rule v2 (packages/shared/src/chest.ts), pinned by
// test/chest.test.ts and test/chest-vectors.browser.test.ts. chest-v1.json and its generator
// (make-chest-vectors.ts) are left as they are: v1 games are still verified with them.
//
//   pnpm exec tsx packages/shared/test/vectors/make-chest-v2-vectors.ts
//
// An independent reference implementation: nothing here is imported from ../../src. The hash is
// node:crypto, both tags are the values `cast keccak "MazeBet.chest.v1"` and
// `cast keccak "MazeBet.chest.v2"` (Foundry) printed, the 128-bit words are read with BigInt from
// hex, and each cell's kind is found from the open masks of the maze vectors (maze-v1.json) by
// counting its bits: one opening is a dead end, two or more a path cell; the start (0) and the
// exit (n*n-1) hold nothing.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Hex = `0x${string}`;
type Kind = 'dead-end' | 'path';

const here = dirname(fileURLToPath(import.meta.url));

/** `cast keccak "MazeBet.chest.v1"`: dead ends draw as in rule v1. */
const DEAD_END_TAG: Hex = '0x3c8b942a79c7fa68d1656db6f4b84d2924c6d9c8748cf22e58e2f7e7f8c9b50e';
/** `cast keccak "MazeBet.chest.v2"`: path cells. */
const PATH_TAG: Hex = '0xba87334dd820c7bbc6b8f10f9621856f71e979d0e3a9ce15af711b52c42ea8ce';

/** Bets the points are pinned for: the minimum, an amount with a remainder, the maximum. */
const BETS = ['1000000000000000', '12345678901234567', '100000000000000000'];

interface MazeVectorFile {
  vectors: { id: number; n: number; finalSeed: Hex; open: Hex }[];
}

function draw(finalSeed: Hex, cell: number, kind: Kind): { placed: boolean; rewardBps: number; hash: Hex } {
  const counter = Buffer.alloc(2);
  counter.writeUInt16BE(cell);
  const digest = createHash('sha256')
    .update(Buffer.from((kind === 'dead-end' ? DEAD_END_TAG : PATH_TAG).slice(2), 'hex'))
    .update(Buffer.from(finalSeed.slice(2), 'hex'))
    .update(counter)
    .digest('hex');
  const first = BigInt(`0x${digest.slice(0, 32)}`);
  const second = BigInt(`0x${digest.slice(32, 64)}`);
  const placed = kind === 'dead-end' ? first % 10000n < 3000n : first % 10000n < 1000n;
  const rewardBps = kind === 'dead-end' ? 1000 + Number(second % 2001n) : 200 + Number(second % 301n);
  return { placed, rewardBps, hash: `0x${digest}` };
}

function bits(mask: number): number {
  return (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
}

const mazes = JSON.parse(readFileSync(join(here, 'maze-v1.json'), 'utf8')) as MazeVectorFile;

const games = mazes.vectors.map((vector) => {
  const open = Buffer.from(vector.open.slice(2), 'hex');
  const last = vector.n * vector.n - 1;
  const cells: { cell: number; kind: Kind; placed: boolean; rewardBps: number }[] = [];
  for (let cell = 1; cell < last; cell++) {
    const kind: Kind = bits(open[cell]) === 1 ? 'dead-end' : 'path';
    const { placed, rewardBps } = draw(vector.finalSeed, cell, kind);
    cells.push({ cell, kind, placed, rewardBps });
  }
  const chests = cells.filter((entry) => entry.placed).map(({ cell, kind, rewardBps }) => ({ cell, kind, rewardBps }));
  return {
    mazeVector: vector.id,
    n: vector.n,
    finalSeed: vector.finalSeed,
    cells,
    chests,
    points: chests.map(({ cell, rewardBps }) => ({
      cell,
      byBet: BETS.map((bet) => ((BigInt(bet) * BigInt(rewardBps)) / (10000n * 10n ** 12n)).toString()),
    })),
  };
});

// Raw path draws for cells that pin the uint16be encoding of the cell number.
const rawSeed = mazes.vectors[0].finalSeed;
const raw = [0, 1, 24, 255, 256, 4097, 65535].map((cell) => ({ finalSeed: rawSeed, cell, kind: 'path' as const, ...draw(rawSeed, cell, 'path') }));

const out = {
  chestRule: 2,
  note:
    'Fixed vectors of chest rule v2. A cell other than the start (0) and the exit (n*n-1) is a dead end when it has exactly one opening, a path cell otherwise. ' +
    'Dead end: h = sha256(DEAD_END_TAG || finalSeed || uint16be(cell)), placed = uint128be(h[0..16]) mod 10000 < 3000, rewardBps = 1000 + uint128be(h[16..32]) mod 2001 (as in rule v1). ' +
    'Path cell: h = sha256(PATH_TAG || finalSeed || uint16be(cell)), placed = uint128be(h[0..16]) mod 10000 < 1000, rewardBps = 200 + uint128be(h[16..32]) mod 301. ' +
    'points = floor(bet * rewardBps / (10000 * 10^12)). Produced by test/vectors/make-chest-v2-vectors.ts, an independent reference implementation ' +
    '(node:crypto, tags from `cast keccak "MazeBet.chest.v1"` and `cast keccak "MazeBet.chest.v2"`, cell kinds counted from the open masks of maze-v1.json), not by the module under test.',
  deadEndTag: DEAD_END_TAG,
  pathTag: PATH_TAG,
  bets: BETS,
  raw,
  games,
};

writeFileSync(join(here, 'chest-v2.json'), `${JSON.stringify(out, null, 2)}\n`);
const count = (kind: Kind): number => games.reduce((sum, game) => sum + game.chests.filter((chest) => chest.kind === kind).length, 0);
console.log(`chest-v2.json: ${games.length} games, ${count('dead-end')} dead-end chests, ${count('path')} path chests, ${raw.length} raw draws`);
