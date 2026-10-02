// AC-S7: every state transition is one JSON log line with `chainSec`, `gameId`, `event`,
// `step`, `outcome` and `txHash`; the lines of one game rebuild its history.

import type { GameView } from '@maze/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/server/log';
import { api, exitRoute } from '../server/helpers';
import {
  linesOf,
  openGame,
  playerOf,
  startHarness,
  startServer,
  until,
  waitSettled,
  walk,
  type Harness,
  type LogLine,
  type Server,
} from './setup';

const KEYS = ['level', 'event', 'chainSec', 'gameId', 'step', 'outcome', 'txHash'];

let h: Harness;
let server: Server;

beforeAll(async () => {
  h = await startHarness();
  server = await startServer(h, { idleTimeoutSec: 5 });
});

afterAll(async () => {
  await server?.stop();
  await h?.stop();
});

async function history(gameId: `0x${string}`): Promise<LogLine[]> {
  await until('the settle-mined line', async () =>
    linesOf(server, gameId).some((line) => line.event === 'settle-mined'),
  );
  return linesOf(server, gameId);
}

function expectWellFormed(lines: LogLine[]): void {
  for (const line of lines) {
    expect(Object.keys(line).slice(0, KEYS.length)).toEqual(KEYS);
    expect(line.chainSec).toEqual(expect.any(Number));
  }
  const times = lines.map((line) => line.chainSec!);
  expect([...times].sort((a, b) => a - b)).toEqual(times);
  // No line carries a seed.
  expect(JSON.stringify(lines)).not.toMatch(/[sS]eed/);
}

describe('AC-S7: structured logs', () => {
  it('the lines of a game played to the exit rebuild its transitions in order', async () => {
    const game = await openGame(h, playerOf(h, 0));
    const route = exitRoute(game.maze);
    await walk(game, route);
    const settled = await waitSettled(h, game.gameId);
    const lines = await history(game.gameId);
    expectWellFormed(lines);

    expect(lines.map((line) => line.event)).toEqual([
      'ticket-issued',
      'chain-created',
      'start',
      ...route.map(() => 'move'),
      'ended',
      'settle-sent',
      'settle-mined',
    ]);
    const byEvent = (event: string): LogLine[] => lines.filter((line) => line.event === event);
    expect(byEvent('chain-created')[0]).toMatchObject({ step: 0, txHash: game.createTxHash });
    expect(byEvent('move').map((line) => line.step)).toEqual(route.map((_, index) => index + 1));
    expect(byEvent('ended')[0]).toMatchObject({
      step: route.length,
      outcome: 0,
      detail: { cause: 'exit', auto: false, payoutWei: settled.payoutWei.toString() },
    });
    expect(byEvent('settle-sent')[0]).toMatchObject({ outcome: 0, txHash: settled.txHash });
    expect(byEvent('settle-mined')[0]).toMatchObject({
      step: route.length,
      outcome: 0,
      txHash: settled.txHash,
    });
  });

  it('a game that idles out shows the automatic ending and its settlement', async () => {
    const game = await openGame(h, playerOf(h, 1), { start: false });
    const settled = await waitSettled(h, game.gameId);
    const lines = await history(game.gameId);
    expectWellFormed(lines);
    expect(lines.map((line) => line.event)).toEqual([
      'ticket-issued',
      'chain-created',
      'ended',
      'settle-sent',
      'settle-mined',
    ]);
    expect(lines[2]).toMatchObject({ step: 0, outcome: 1, detail: { cause: 'idle', auto: true } });
    expect(lines[4].txHash).toBe(settled.txHash);

    const read = await api.game<GameView>(game.gameId, game.token);
    expect(read.body.auto).toBe(true);
  });

  it('by default a line is written to stdout as one line of JSON', () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      createLogger().event({
        event: 'move',
        chainSec: 1_700_000_000,
        gameId: `0x${'ab'.repeat(32)}`,
        step: 3,
        detail: { payoutWei: 12n },
      });
    } finally {
      spy.mockRestore();
    }
    expect(written).toHaveLength(1);
    expect(written[0].endsWith('\n')).toBe(true);
    expect(written[0].trimEnd()).not.toContain('\n');
    expect(JSON.parse(written[0])).toEqual({
      level: 'info',
      event: 'move',
      chainSec: 1_700_000_000,
      gameId: `0x${'ab'.repeat(32)}`,
      step: 3,
      outcome: null,
      txHash: null,
      detail: { payoutWei: '12' },
    });
  });
});
