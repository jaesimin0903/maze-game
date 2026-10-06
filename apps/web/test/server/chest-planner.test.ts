// AC-P7: the offline planner of browser scenario 12 (e2e/aside/plan-chest.ts, plan-moves.ts
// --goal chest). The scenario walks the planned route in a real browser; this checks, without a
// browser, that the plan is right: its route ends in a dead end that holds a chest, it is the
// shortest such route, and a server with the same seed-hook secret awards exactly that chest.

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
  it('AC-P7 plans the shortest route into a dead end that holds a chest, never through the exit, and lists every chest', () => {
    let planned = 0;
    for (let i = 0; i < 300; i++) {
      const n = [5, 7, 9][i % 3];
      const finalSeed = hex32();
      const maze = generateMaze(finalSeed, n);
      const plan = planChest(maze, finalSeed);
      const reachable = chestsOf(finalSeed, maze)
        .map((chest) => cellsOf(maze, routeTo(maze, chest.cell)))
        .filter((cells) => !cells.includes(exitCell(maze)));
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
      expect(chestAt(finalSeed, maze, plan!.chest.cell)).toEqual({ cell: plan!.chest.cell, rewardBps: plan!.chest.rewardBps });
      expect(plan!.cells.length).toBe(Math.min(...reachable.map((cells) => cells.length)));
      expect(plan!.chests.map((chest) => chest.cell)).toEqual(chestsOf(finalSeed, maze).map((chest) => chest.cell));
      expect(plan!.chestRule).toBe(1);
    }
    expect(planned).toBeGreaterThan(150);
  });

  it('AC-P7 the command line plans from the game id alone, and the server awards exactly the planned chest', async () => {
    env = await makeEnv({ config: { testSeedSecret: SECRET } });
    const { ticket, token } = await requestTicket({ player: PLAYERS[0], tier: 1 });
    const n = env.table.tiers[1].n;
    const serverSeed = testServerSeed(SECRET, ticket.gameId);
    expect(env.container.service.get(ticket.gameId)!.serverSeed).toBe(serverSeed);

    // A client seed whose maze has a chest that can be reached before the exit.
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
    const plan = JSON.parse(run.stdout) as {
      moves: (typeof LETTERS)[number][];
      outcome: string;
      serverSeed: Hex;
      chest: { cell: number; x: number; y: number; rewardBps: number };
      chests: { cell: number }[];
      chestRule: number;
    };
    expect(plan.outcome).toBe('loss');
    expect(plan.serverSeed).toBe(serverSeed);
    expect(plan.chestRule).toBe(1);
    expect(plan.chests.some((chest) => chest.cell === plan.chest.cell)).toBe(true);

    for (let k = 0; k < plan.moves.length; k++) {
      const reply = await api.move<GameView>(ticket.gameId, token, { step: k, dir: LETTERS.indexOf(plan.moves[k]) });
      expect(reply.status).toBe(200);
      if (k < plan.moves.length - 1) expect(reply.body.status).toBe('active');
      else {
        expect(reply.body.status).toBe('lost');
        expect(reply.body.terminal?.chest).toEqual({
          cell: { x: plan.chest.x, y: plan.chest.y },
          rewardBps: plan.chest.rewardBps,
          points: chestPoints(BET, plan.chest.rewardBps).toString(),
        });
      }
    }
    const ledger = await api.points<PointsResponse>(ticket.player);
    expect(ledger.body.totalPoints).toBe(chestPoints(BET, plan.chest.rewardBps).toString());
    expect(ledger.body.awards[0]).toMatchObject({ gameId: ticket.gameId, cell: { x: plan.chest.x, y: plan.chest.y } });
  });

  it('AC-P7 the command line exits 3 when no chest can be reached before the exit', () => {
    // A game id and client seed whose maze has no reachable chest, found offline.
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
    throw new Error('every one of 2000 mazes had a reachable chest');
  });
});
