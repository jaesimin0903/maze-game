// Plans a route through a game's maze offline (plan §9.1 "경로 계산").
//
//   tsx e2e/aside/plan-moves.ts --secret <MAZE_TEST_SEED_SECRET> --game-id 0x.. \
//       --client-seed 0x.. --n <size> --goal <goal>
//
// While the seed hook is on, the server seed of a game is a function of its game id:
//
//   serverSeed = sha256( "maze-test-seed" (14 ASCII bytes) ‖ UTF-8 bytes of the secret ‖ 32 raw bytes of gameId )
//
// (the same formula as `testServerSeed` in apps/web/src/server/test-hooks.ts; every scenario
// also asserts that the seed the server reveals afterwards equals the one computed here).
// The scenario reads the game id from the page, and this script rebuilds the maze with
// `generateMaze(deriveFinalSeed({ serverSeed, clientSeed, gameId }), n)` from @maze/shared.
// There is no API that hands out a maze, and this script does not talk to the server.
//
// Goals:
//   exit          the moves of the solution
//   deadend       the shortest route that ends in a dead end without passing the exit
//   cashout:<k>   the first k moves of the solution (the game is still open after them)
//   junction      a route to a cell with two different onward moves that both keep the game
//                 open, plus those two moves (`a`, `b`): the two-tab race of scenario 08
//   invalid       a route of at least one move to a cell that has a wall inside the grid, plus
//                 that wall's direction (`wall`) and the direction back (`visited`)
//
// Output: one JSON object on stdout. `moves` are direction letters (N, E, S, W).
// Exit codes: 0 planned, 3 this maze cannot serve the goal (the scenario starts another game),
// 2 usage error.

import { createHash } from 'node:crypto';
import {
  deriveFinalSeed,
  exitCell,
  generateMaze,
  isDeadEnd,
  neighbor,
  openDirs,
  replayMoves,
  solve,
  START_CELL,
  type Dir,
  type Hex,
  type Maze,
} from '@maze/shared';

const LETTERS = ['N', 'E', 'S', 'W'] as const;
const DIRS: readonly Dir[] = [0, 1, 2, 3];
/** `replayMoves` outcome numbers (the contract's): 0 exit, 1 cash-out, 2 loss. */
const OUTCOME_NAMES = ['exit', 'cashout', 'loss'] as const;

function usage(message: string): never {
  console.error(`plan-moves: ${message}`);
  console.error(
    'usage: plan-moves.ts --secret S --game-id 0x.. --client-seed 0x.. --n N --goal exit|deadend|cashout:<k>|junction|invalid',
  );
  process.exit(2);
}

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name?.startsWith('--') || value === undefined) usage(`bad argument "${name ?? ''}"`);
    out[name.slice(2)] = value;
  }
  return out;
}

function hex32(value: string | undefined, name: string): Hex {
  if (value === undefined || !/^0x[0-9a-fA-F]{64}$/.test(value)) usage(`--${name} must be 32 bytes of 0x-prefixed hex`);
  return value.toLowerCase() as Hex;
}

function testServerSeed(secret: string, gameId: Hex): Hex {
  const digest = createHash('sha256')
    .update('maze-test-seed', 'utf8')
    .update(secret, 'utf8')
    .update(Buffer.from(gameId.slice(2), 'hex'))
    .digest('hex');
  return `0x${digest}`;
}

function dirBetween(maze: Maze, from: number, to: number): Dir {
  for (const dir of DIRS) if (neighbor(maze, from, dir) === to) return dir;
  throw new Error(`cells ${from} and ${to} are not adjacent`);
}

function dirsOf(maze: Maze, cells: readonly number[]): Dir[] {
  return cells.slice(1).map((cell, index) => dirBetween(maze, cells[index], cell));
}

/** Cells of the only path from the start to `target` (the maze is a tree), both ends included. */
function pathTo(maze: Maze, target: number): number[] {
  const parent = new Int32Array(maze.w * maze.h).fill(-1);
  parent[START_CELL] = START_CELL;
  const queue = [START_CELL];
  for (let head = 0; head < queue.length && parent[target] === -1; head++) {
    const cell = queue[head];
    for (const dir of openDirs(maze, cell)) {
      const next = neighbor(maze, cell, dir);
      if (next !== null && parent[next] === -1) {
        parent[next] = cell;
        queue.push(next);
      }
    }
  }
  if (parent[target] === -1) throw new Error(`cell ${target} cannot be reached`);
  const path = [target];
  while (path[path.length - 1] !== START_CELL) path.push(parent[path[path.length - 1]]);
  return path.reverse();
}

/** The cell a move from `cell` in direction `dir` leads to, when that side is open. */
function step(maze: Maze, cell: number, dir: Dir): number | null {
  return openDirs(maze, cell).includes(dir) ? neighbor(maze, cell, dir) : null;
}

/** True when arriving at `cell` from `from` ends the game (exit or dead end). */
function ends(maze: Maze, cell: number, from: number): boolean {
  return cell === exitCell(maze) || isDeadEnd(maze, cell, from);
}

interface Plan {
  cells: number[];
  extra?: Record<string, unknown>;
}

function planExit(maze: Maze): Plan | null {
  const cells = solve(maze);
  return cells.length > 1 ? { cells } : null;
}

function planDeadEnd(maze: Maze): Plan | null {
  const exit = exitCell(maze);
  let best: number[] | null = null;
  for (let cell = 1; cell < exit; cell++) {
    if (openDirs(maze, cell).length !== 1) continue;
    const cells = pathTo(maze, cell);
    if (cells.includes(exit)) continue;
    if (best === null || cells.length < best.length) best = cells;
  }
  return best === null ? null : { cells: best };
}

function planCashout(maze: Maze, k: number): Plan | null {
  const solution = solve(maze);
  // After k moves the player must still be short of the exit.
  if (k > solution.length - 2) return null;
  return { cells: solution.slice(0, k + 1) };
}

function planJunction(maze: Maze): Plan | null {
  const exit = exitCell(maze);
  let best: Plan | null = null;
  for (let cell = 0; cell < exit; cell++) {
    const cells = pathTo(maze, cell);
    if (cells.includes(exit)) continue;
    const from = cells.length > 1 ? cells[cells.length - 2] : null;
    // Standing on `cell` must leave the game open.
    if (from !== null && ends(maze, cell, from)) continue;
    const onward = openDirs(maze, cell).filter((dir) => {
      const next = step(maze, cell, dir);
      return next !== null && next !== from && !ends(maze, next, cell);
    });
    if (onward.length < 2) continue;
    if (best === null || cells.length < best.cells.length) {
      best = { cells, extra: { a: LETTERS[onward[0]], b: LETTERS[onward[1]] } };
    }
  }
  return best;
}

function planInvalid(maze: Maze): Plan | null {
  const solution = solve(maze);
  for (let k = 1; k <= solution.length - 2; k++) {
    const cell = solution[k];
    const open = openDirs(maze, cell);
    const wall = DIRS.find((dir) => !open.includes(dir) && neighbor(maze, cell, dir) !== null);
    if (wall === undefined) continue;
    const visited = dirBetween(maze, cell, solution[k - 1]);
    return { cells: solution.slice(0, k + 1), extra: { wall: LETTERS[wall], visited: LETTERS[visited] } };
  }
  return null;
}

const a = args();
const gameId = hex32(a['game-id'], 'game-id');
const clientSeed = hex32(a['client-seed'], 'client-seed');
const secret = a.secret ?? usage('--secret is required');
const n = Number(a.n);
if (!Number.isInteger(n) || n < 2 || n > 255) usage('--n must be the maze size');
const goal = a.goal ?? usage('--goal is required');

const serverSeed = testServerSeed(secret, gameId);
const maze = generateMaze(deriveFinalSeed({ serverSeed, clientSeed, gameId }), n);

let plan: Plan | null;
let cashOutAt: number | undefined;
if (goal === 'exit') plan = planExit(maze);
else if (goal === 'deadend') plan = planDeadEnd(maze);
else if (goal === 'junction') plan = planJunction(maze);
else if (goal === 'invalid') plan = planInvalid(maze);
else if (/^cashout:\d+$/.test(goal)) {
  cashOutAt = Number(goal.slice('cashout:'.length));
  plan = planCashout(maze, cashOutAt);
} else usage(`unknown goal "${goal}"`);

if (plan === null) {
  console.error(`plan-moves: the maze of ${gameId} cannot serve the goal "${goal}"`);
  process.exit(3);
}

const dirs = dirsOf(maze, plan.cells);
// The rules decide what the route amounts to, not this script's own search.
const replay = replayMoves(maze, dirs, cashOutAt);
if (replay.invalidAt !== null) throw new Error(`the planned route is invalid at move ${replay.invalidAt}`);

console.log(
  JSON.stringify({
    goal,
    n,
    gameId,
    serverSeed,
    moves: dirs.map((dir) => LETTERS[dir]),
    cells: plan.cells,
    steps: replay.steps,
    outcome: replay.outcome === null ? null : OUTCOME_NAMES[replay.outcome],
    solutionLength: solve(maze).length - 1,
    ...plan.extra,
  }),
);
