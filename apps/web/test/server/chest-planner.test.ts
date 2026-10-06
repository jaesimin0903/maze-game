// AC-P7: the offline planner of browser scenario 12 (e2e/aside/plan-chest.ts, plan-moves.ts
// --goal chest). The scenario walks the planned route in a real browser; this checks, without a
// browser, that the plan is right: its route passes at least one path chest and ends in a dead
// end that holds a chest, it is the shortest such route, and a server with the same seed-hook
// secret awards exactly those chests, the path chests during the walk.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chestAt,
  chestPoints,
  chestsOf,
  deriveFinalSeed,
  exitCell,
  generateMaze,
  Outcome,
  replayMoves,
  type Dir,
  type GameView,
  type Hex,
  type PointsResponse,
} from '@maze/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { planChest } from '../../../../e2e/aside/plan-chest';
import { testServerSeed } from '../../src/server/test-hooks';
import { api, BET, cellsOf, makeEnv, PLAYERS, requestTicket, routeTo, type TestEnv } from './helpers';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SECRET = 'chest-planner-secret';
const LETTERS = ['N', 'E', 'S', 'W'] as const;

let env: TestEnv | null = null;

afterEach(async () => {
  await env?.close();
  env = null;
});

function hex32(): Hex {
  return `0x${randomBytes(32).toString('hex')}`;
}

function planner(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'e2e/aside/plan-moves.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe('AC-P7: the chest planner of scenario 12', () => {
  it('AC-P7 plans the shortest route past a path chest into a dead end that holds a chest, never through the exit, and lists every chest', () => {
    let planned = 0;
    for (let i = 0; i < 300; i++) {
      const n = [5, 7, 9][i % 3];
      const finalSeed = hex32();
      const maze = generateMaze(finalSeed, n);
      const plan = planChest(maze, finalSeed);
      const chestOn = (cell: number) => chestAt(finalSeed, maze, cell);
      const reachable = chestsOf(finalSeed, maze)
        .filter((chest) => chest.kind === 'dead-end')
        .map((chest) => cellsOf(maze, routeTo(maze, chest.cell)))
        .filter((cells) => !cells.includes(exitCell(maze)))
        .filter((cells) => cells.slice(1, -1).some((cell) => chestOn(cell) !== null));
      if (reachable.length === 0) {
        expect(plan).toBeNull();
        continue;
      }
      planned += 1;
      expect(plan).not.toBeNull();
      const moves = plan!.cells.slice(1).map((cell, k) => {
        const delta = cell - plan!.cells[k];
        return (delta === -n ? 0 : delta === 1 ? 1 : delta === n ? 2 : 3) as Dir;
      });
      const replay = replayMoves(maze, moves);
      expect(replay.invalidAt).toBeNull();
      expect(replay.outcome).toBe(Outcome.Loss);
      expect(replay.path.at(-1)).toBe(plan!.chest.cell);
      expect(chestOn(plan!.chest.cell)).toEqual({ cell: plan!.chest.cell, kind: 'dead-end', rewardBps: plan!.chest.rewardBps });
      // The path chests are exactly the chests on the cells between the start and the dead end.
      const between = plan!.cells.slice(1, -1).flatMap((cell, k) => {
        const chest = chestOn(cell);
        return chest === null ? [] : [{ cell, kind: chest.kind, rewardBps: chest.rewardBps, step: k + 1 }];
      });
      expect(plan!.pathChests.map(({ cell, kind, rewardBps, step }) => ({ cell, kind, rewardBps, step }))).toEqual(between);
      expect(plan!.pathChests.length).toBeGreaterThan(0);
      expect(plan!.pathChests.every((chest) => chest.kind === 'path')).toBe(true);
      expect(plan!.cells.length).toBe(Math.min(...reachable.map((cells) => cells.length)));
      expect(plan!.chests.map(({ cell, kind }) => ({ cell, kind }))).toEqual(
        chestsOf(finalSeed, maze).map(({ cell, kind }) => ({ cell, kind })),
      );
      expect(plan!.chestRule).toBe(2);
    }
    expect(planned).toBeGreaterThan(180);
  });

  it('AC-P7 the command line plans from the game id alone, and the server awards exactly the planned chest', async () => {
    env = await makeEnv({ config: { testSeedSecret: SECRET } });
    const { ticket, token } = await requestTicket({ player: PLAYERS[0], tier: 1 });
    const n = env.table.tiers[1].n;
    const serverSeed = testServerSeed(SECRET, ticket.gameId);
    expect(env.container.service.get(ticket.gameId)!.serverSeed).toBe(serverSeed);

    // A client seed whose maze has a route past a path chest into a chest dead end before the exit.
    let clientSeed = hex32();
    for (;;) {
      const finalSeed = deriveFinalSeed({ serverSeed, clientSeed, gameId: ticket.gameId });
      if (planChest(generateMaze(finalSeed, n), finalSeed) !== null) break;
      clientSeed = hex32();
    }
    env.chain.createGame({ ...ticket, betWei: BET, clientSeed });
    await env.tick();

    const run = planner(['--secret', SECRET, '--game-id', ticket.gameId, '--client-seed', clientSeed, '--n', String(n), '--goal', 'chest']);
    expect(run.status, run.stderr).toBe(0);
    type Planned = { cell: number; x: number; y: number; kind: string; rewardBps: number };
    const plan = JSON.parse(run.stdout) as {
      moves: (typeof LETTERS)[number][];
      outcome: string;
      serverSeed: Hex;
      chest: Planned;
      pathChests: (Planned & { step: number })[];
      chests: Planned[];
      chestRule: number;
    };
    expect(plan.outcome).toBe('loss');
    expect(plan.serverSeed).toBe(serverSeed);
    expect(plan.chestRule).toBe(2);
    expect(plan.chest.kind).toBe('dead-end');
    expect(plan.pathChests.length).toBeGreaterThan(0);
    expect(plan.chests.some((chest) => chest.cell === plan.chest.cell)).toBe(true);
    const listed = (chest: Planned, step: number) => ({
      cell: { x: chest.x, y: chest.y },
      kind: chest.kind,
      rewardBps: chest.rewardBps,
      points: chestPoints(BET, chest.rewardBps).toString(),
      step,
    });

    for (let k = 0; k < plan.moves.length; k++) {
      const reply = await api.move<GameView>(ticket.gameId, token, { step: k, dir: LETTERS.indexOf(plan.moves[k]) });
      expect(reply.status).toBe(200);
      // The path chests show up move by move, as the plan says.
      const sofar = plan.pathChests.filter((chest) => chest.step <= k + 1).map((chest) => listed(chest, chest.step));
      if (k < plan.moves.length - 1) {
        expect(reply.body.status).toBe('active');
        expect(reply.body.chests).toEqual(sofar);
      } else {
        expect(reply.body.status).toBe('lost');
        expect(reply.body.chests).toEqual([...sofar, listed(plan.chest, plan.moves.length)]);
        expect(reply.body.terminal?.chest).toEqual({
          cell: { x: plan.chest.x, y: plan.chest.y },
          rewardBps: plan.chest.rewardBps,
          points: chestPoints(BET, plan.chest.rewardBps).toString(),
        });
      }
    }
    const total = [plan.chest, ...plan.pathChests].reduce((sum, chest) => sum + chestPoints(BET, chest.rewardBps), 0n);
    const ledger = await api.points<PointsResponse>(ticket.player);
    expect(ledger.body.totalPoints).toBe(total.toString());
    expect(ledger.body.awardCount).toBe(plan.pathChests.length + 1);
    expect(ledger.body.awards[0]).toMatchObject({
      gameId: ticket.gameId,
      kind: 'dead-end',
      cell: { x: plan.chest.x, y: plan.chest.y },
    });
  });

  it('AC-P7 the command line exits 3 when no such route exists before the exit', () => {
    // A game id and client seed whose maze has no such route, found offline.
    for (let i = 0; i < 2000; i++) {
      const gameId = hex32();
      const clientSeed = hex32();
      const finalSeed = deriveFinalSeed({ serverSeed: testServerSeed(SECRET, gameId), clientSeed, gameId });
      if (planChest(generateMaze(finalSeed, 5), finalSeed) !== null) continue;
      const run = planner(['--secret', SECRET, '--game-id', gameId, '--client-seed', clientSeed, '--n', '5', '--goal', 'chest']);
      expect(run.status).toBe(3);
      expect(run.stdout).toBe('');
      return;
    }
    throw new Error('every one of 2000 mazes had a planned route');
  });
});
