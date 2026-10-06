// Writes chest-v1.json: fixed vectors of chest rule v1 (packages/shared/src/chest.ts), pinned by
// test/chest.test.ts and test/chest-vectors.browser.test.ts.
//
//   pnpm exec tsx packages/shared/test/vectors/make-chest-vectors.ts
//
// An independent reference implementation: nothing here is imported from ../../src. The hash is
// node:crypto, the tag is the value `cast keccak "MazeBet.chest.v1"` (Foundry) printed, the
// 128-bit words are read with BigInt from hex, and the dead ends are found from the open masks
// of the maze vectors (maze-v1.json, themselves made by an independent implementation) by
// counting bits. Regenerating therefore cannot bless a change of the module under test.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Hex = `0x${string}`;

const here = dirname(fileURLToPath(import.meta.url));

/** `cast keccak "MazeBet.chest.v1"` */
const CHEST_TAG: Hex = '0x3c8b942a79c7fa68d1656db6f4b84d2924c6d9c8748cf22e58e2f7e7f8c9b50e';

/** Bets the points are pinned for: the minimum, an amount with a remainder, the maximum. */
const BETS = ['1000000000000000', '12345678901234567', '100000000000000000'];

interface MazeVectorFile {
  vectors: { id: number; n: number; finalSeed: Hex; open: Hex }[];
}

function draw(finalSeed: Hex, cell: number): { placed: boolean; rewardBps: number; hash: Hex } {
  const counter = Buffer.alloc(2);
  counter.writeUInt16BE(cell);
  const digest = createHash('sha256')
    .update(Buffer.from(CHEST_TAG.slice(2), 'hex'))
    .update(Buffer.from(finalSeed.slice(2), 'hex'))
    .update(counter)
    .digest('hex');
  const first = BigInt(`0x${digest.slice(0, 32)}`);
  const second = BigInt(`0x${digest.slice(32, 64)}`);
  return { placed: first % 10000n < 3000n, rewardBps: 1000 + Number(second % 2001n), hash: `0x${digest}` };
}

function bits(mask: number): number {
  return (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
}

const mazes = JSON.parse(readFileSync(join(here, 'maze-v1.json'), 'utf8')) as MazeVectorFile;

const games = mazes.vectors.map((vector) => {
  const open = Buffer.from(vector.open.slice(2), 'hex');
  const last = vector.n * vector.n - 1;
  const sites: { cell: number; placed: boolean; rewardBps: number }[] = [];
  for (let cell = 1; cell < last; cell++) {
    if (bits(open[cell]) !== 1) continue;
    const { placed, rewardBps } = draw(vector.finalSeed, cell);
    sites.push({ cell, placed, rewardBps });
  }
  const chests = sites.filter((site) => site.placed).map(({ cell, rewardBps }) => ({ cell, rewardBps }));
  return {
    mazeVector: vector.id,
    n: vector.n,
    finalSeed: vector.finalSeed,
    sites,
    chests,
    points: chests.map(({ cell, rewardBps }) => ({
      cell,
      byBet: BETS.map((bet) => ((BigInt(bet) * BigInt(rewardBps)) / (10000n * 10n ** 12n)).toString()),
    })),
  };
});

// Raw draws for cells that pin the uint16be encoding of the cell number.
const rawSeed = mazes.vectors[0].finalSeed;
const raw = [0, 1, 24, 255, 256, 4097, 65535].map((cell) => ({ finalSeed: rawSeed, cell, ...draw(rawSeed, cell) }));

const out = {
  chestRule: 1,
  note:
    'Fixed vectors of chest rule v1. h = sha256(CHEST_TAG || finalSeed || uint16be(cell)); placed = uint128be(h[0..16]) mod 10000 < 3000; ' +
    'rewardBps = 1000 + uint128be(h[16..32]) mod 2001; a chest site is a cell with exactly one opening that is neither the start (0) nor the exit (n*n-1); ' +
    'points = floor(bet * rewardBps / (10000 * 10^12)). Produced by test/vectors/make-chest-vectors.ts, an independent reference implementation ' +
    '(node:crypto, tag from `cast keccak "MazeBet.chest.v1"`, dead ends counted from the open masks of maze-v1.json), not by the module under test.',
  chestTag: CHEST_TAG,
  bets: BETS,
  raw,
  games,
};

writeFileSync(join(here, 'chest-v1.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`chest-v1.json: ${games.length} games, ${games.reduce((sum, game) => sum + game.chests.length, 0)} chests, ${raw.length} raw draws`);
