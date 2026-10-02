// AC-E2: when the server falls silent, anyone can reclaim the bet for the player after the
// settle deadline, through `scripts/reclaim.sh` (the path that needs no server). The restarted
// server then recognizes the reclaim and reveals the seed.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitmentOf, mazeBetAbi, type GameView, type RevealResponse } from '@maze/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, exitRoute } from '../server/helpers';
import {
  BET,
  jump,
  linesOf,
  onchainGame,
  openGame,
  playerOf,
  reclaimRevert,
  settlements,
  startHarness,
  startServer,
  walk,
  type Harness,
  type LiveGame,
  type Server,
} from './setup';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RECLAIM = path.join(ROOT, 'scripts/reclaim.sh');
/** Anvil account #9, the script's default sender: neither the player nor the server. */
const THIRD_PARTY = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720';

let h: Harness;
let server: Server | null = null;
let dataDir: string;
let game: LiveGame;

beforeAll(async () => {
  h = await startHarness();
  server = await startServer(h);
  dataDir = server.dataDir;
});

afterAll(async () => {
  await server?.stop();
  await h?.stop();
});

function reclaimScript(gameId: string): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.RECLAIM_PRIVATE_KEY;
  return spawnSync('bash', [RECLAIM, gameId, '--rpc-url', h.rpcUrl, '--address', h.contract], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
}

describe('AC-E2: reclaim after server silence', () => {
  it('is refused before the deadline and pays the whole bet to the player after it', async () => {
    const player = playerOf(h, 0);
    game = await openGame(h, player);
    await walk(game, exitRoute(game.maze).slice(0, 1));

    // The server goes away with the game in play.
    await server!.stop();
    server = null;
    const balance = await h.publicClient.getBalance({ address: player.address });

    const early = reclaimScript(game.gameId);
    expect(early.status).toBe(1);
    expect(early.stderr).toContain('DeadlineNotReached');
    expect(await reclaimRevert(h, game.gameId, player.address)).toBe('DeadlineNotReached');
    expect((await onchainGame(h, game.gameId)).status).toBe(1);

    await jump(h, h.table.timing.settleWindowSec + 5);
    const done = reclaimScript(game.gameId);
    expect(done.stderr).toBe('');
    expect(done.status).toBe(0);
    expect(done.stdout).toMatch(new RegExp(`^reclaimed ${game.gameId} tx 0x[0-9a-f]{64}\\n$`));

    expect((await onchainGame(h, game.gameId)).status).toBe(3);
    // The whole bet, to the player, although a third party sent the transaction.
    expect(await h.publicClient.getBalance({ address: player.address })).toBe(balance + BET);
    const events = await h.publicClient.getContractEvents({
      address: h.contract,
      abi: mazeBetAbi,
      eventName: 'GameReclaimed',
      args: { gameId: game.gameId },
      fromBlock: 0n,
      strict: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0].args).toMatchObject({ amount: BET });
    expect(events[0].args.player.toLowerCase()).toBe(player.address.toLowerCase());
    const receipt = await h.publicClient.getTransactionReceipt({ hash: events[0].transactionHash });
    expect(receipt.from.toLowerCase()).toBe(THIRD_PARTY.toLowerCase());

    const again = reclaimScript(game.gameId);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('GameNotActive');
  });

  it('rejects a malformed game id without touching the chain', () => {
    const run = spawnSync('bash', [RECLAIM, '0x1234', '--rpc-url', h.rpcUrl, '--address', h.contract], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('usage');
  });

  it('the restarted server sees the reclaim on chain and reveals the seed', async () => {
    server = await startServer(h, { dataDir });
    const record = server.container.service.get(game.gameId)!;
    expect(record.final).toBe('reclaimed');
    expect(record.ended).toBeNull();
    expect(linesOf(server, game.gameId).map((line) => line.event)).toEqual(['reclaimed']);
    // The server never signed a settlement for it, and none exists on chain.
    expect(await settlements(h, game.gameId)).toHaveLength(0);

    const reveal = await api.reveal<RevealResponse>(game.gameId);
    expect(reveal.status).toBe(200);
    expect(reveal.body.reason).toBe('reclaimed');
    expect(commitmentOf({ mazeVersion: 1, n: game.n, serverSeed: reveal.body.serverSeed })).toBe(
      game.ticket.commitment,
    );

    // The game takes no more moves and the player's address is free for a new ticket.
    const move = await api.move(game.gameId, game.token, { step: 1, dir: exitRoute(game.maze)[1] });
    expect(move.status).toBe(409);
    const read = await api.game<GameView>(game.gameId, game.token);
    expect(read.body.step).toBe(1);
    expect(read.body.terminal).toBeUndefined();
    const next = await openGame(h, game.player);
    expect(next.gameId).not.toBe(game.gameId);
  });
});
