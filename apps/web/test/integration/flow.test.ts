// AC-E1: the three endings on a real chain, from ticket to on-chain settlement and public
// verification. Also AC-R2, AC-R3, AC-R4, AC-M3, AC-M6, AC-S3 and AC-T8.

import {
  exitPayoutWei,
  mazeBetAbi,
  refundWei,
  tableHash,
  verifyGame,
  type ConfigResponse,
  type GameView,
  type Observation,
  type RevealResponse,
} from '@maze/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, deadEndRoute, exitRoute } from '../server/helpers';
import {
  BET,
  createOnChain,
  onchainGame,
  openGame,
  playerOf,
  requestTicket,
  settleRevert,
  startHarness,
  startServer,
  until,
  waitSettled,
  walk,
  type Harness,
  type LiveGame,
  type Server,
} from './setup';

let h: Harness;
let server: Server;

beforeAll(async () => {
  h = await startHarness();
  server = await startServer(h);
});

afterAll(async () => {
  await server?.stop();
  await h?.stop();
});

function observation(view: GameView): Observation {
  return { step: view.step, cell: view.cell.y * view.n + view.cell.x, open: view.open };
}

function totalReserved(): Promise<bigint> {
  return h.publicClient.readContract({
    address: h.contract,
    abi: mazeBetAbi,
    functionName: 'totalReserved',
  });
}

/** The read of an ended game once it carries the mined settle transaction. */
async function settledRead(game: LiveGame, txHash: string): Promise<GameView> {
  return until('the settle transaction in the read', async () => {
    const reply = await api.game<GameView>(game.gameId, game.token);
    return reply.body.terminal?.settleTxHash === txHash ? reply.body : null;
  });
}

describe('AC-E1: one game per ending', () => {
  it('AC-R2: exit: bet × multiplier is paid, and anyone can verify the game afterwards', async () => {
    const player = playerOf(h, 0);
    const game = await openGame(h, player);
    const balanceAfterBet = await h.publicClient.getBalance({ address: player.address });
    expect(await totalReserved()).toBe(exitPayoutWei(h.table, BET, 0));

    const route = exitRoute(game.maze);
    const first = await api.game<GameView>(game.gameId, game.token);
    const views = await walk(game, route);
    const last = views[views.length - 1];
    expect(last.status).toBe('won');
    expect(last.terminal!.payoutWei).toBe((BET * 2n).toString());

    const settled = await waitSettled(h, game.gameId);
    expect(settled).toMatchObject({
      outcome: 0,
      steps: route.length,
      payoutWei: BET * 2n,
      serverSeed: last.terminal!.serverSeed,
    });
    // The server's relayer submitted it, within the fixed gas limit.
    expect(settled.from.toLowerCase()).toBe(h.relayer.toLowerCase());
    expect(settled.gasUsed).toBeLessThanOrEqual(300_000n);
    expect(await h.publicClient.getBalance({ address: player.address })).toBe(
      balanceAfterBet + BET * 2n,
    );
    expect(await totalReserved()).toBe(0n);

    const onchain = await onchainGame(h, game.gameId);
    expect(onchain.status).toBe(2);
    const read = await settledRead(game, settled.txHash);
    expect(read.path).toHaveLength(route.length + 1);

    // AC-M6: the maze is reproduced from on-chain data and the revealed seed alone.
    const reveal = await api.reveal<RevealResponse>(game.gameId);
    expect(reveal.body).toEqual({
      gameId: game.gameId,
      commitment: onchain.commitment,
      serverSeed: settled.serverSeed,
      reason: 'settled',
    });
    const report = verifyGame({
      table: h.table,
      commitment: onchain.commitment,
      serverSeed: reveal.body.serverSeed,
      clientSeed: onchain.clientSeed,
      gameId: game.gameId,
      tier: onchain.tier,
      observations: [observation(first.body), ...views.map(observation)],
      moves: route,
      settled: {
        outcome: settled.outcome,
        steps: settled.steps,
        payoutWei: settled.payoutWei,
        betWei: onchain.bet,
      },
    });
    expect(report.commitmentOk).toBe(true);
    expect(report.outcomeOk).toBe(true);
    expect(report.payoutOk).toBe(true);
    expect(report.cells).toHaveLength(route.length + 1);
    expect(report.cells.every((cell) => cell.match)).toBe(true);
  });

  it('AC-R4: dead end: the game is settled as a loss with payout 0', async () => {
    const player = playerOf(h, 1);
    const game = await openGame(h, player, { deadEnd: true });
    const balanceAfterBet = await h.publicClient.getBalance({ address: player.address });

    const route = deadEndRoute(game.maze);
    const views = await walk(game, route);
    expect(views[views.length - 1].status).toBe('lost');

    const settled = await waitSettled(h, game.gameId);
    expect(settled).toMatchObject({ outcome: 2, steps: route.length, payoutWei: 0n });
    expect(await h.publicClient.getBalance({ address: player.address })).toBe(balanceAfterBet);
    expect((await onchainGame(h, game.gameId)).status).toBe(2);
    expect(await totalReserved()).toBe(0n);
  });

  it('AC-R3: cash-out after 3 moves pays bet × refundBps[3] / 10000', async () => {
    const player = playerOf(h, 2);
    const game = await openGame(h, player);
    const balanceAfterBet = await h.publicClient.getBalance({ address: player.address });

    const views = await walk(game, exitRoute(game.maze).slice(0, 3));
    for (const view of views) {
      expect(view.refundableWei).toBe(refundWei(h.table, BET, 0, view.step).toString());
    }
    const reply = await api.cashout<GameView>(game.gameId, game.token, { step: 3 });
    expect(reply.body.status).toBe('cashed_out');
    expect(reply.body.auto).toBe(false);

    const expected = (BET * BigInt(h.table.tiers[0].refundBps[3])) / 10_000n;
    const settled = await waitSettled(h, game.gameId);
    expect(settled).toMatchObject({ outcome: 1, steps: 3, payoutWei: expected });
    expect(await h.publicClient.getBalance({ address: player.address })).toBe(
      balanceAfterBet + expected,
    );
  });
});

describe('what the server takes from the chain', () => {
  it('AC-M3: the first cell is not shown before createGame is on chain', async () => {
    const player = playerOf(h, 3);
    const { ticket, token } = await requestTicket(player.address);
    const before = await api.start(ticket.gameId, token);
    expect(before.status).toBe(409);
    expect(before.body).toEqual({ error: { code: 'NOT_ON_CHAIN', message: expect.any(String) } });
    expect((await api.game(ticket.gameId, token)).status).toBe(409);

    const created = await createOnChain(h, player, ticket, BET, `0x${'42'.repeat(32)}`);
    const started = await api.start<GameView>(ticket.gameId, token);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ step: 0, cell: { x: 0, y: 0 }, betWei: BET.toString() });
    // The game's clock is the creation block's, not the time of this call.
    expect(started.body.idleDeadlineSec).toBe(created.createdAtSec + h.table.timing.idleTimeoutSec);
    expect(started.body.gameDeadlineSec).toBe(created.createdAtSec + h.table.timing.maxGameSec);
    expect(started.body.settleDeadlineSec).toBe(Number((await onchainGame(h, ticket.gameId)).settleDeadline));

    await api.cashout(ticket.gameId, token, { step: 0 });
    await waitSettled(h, ticket.gameId);
  });

  it('AC-S3: a settlement without the server signature is refused by the contract', async () => {
    const player = playerOf(h, 4);
    const game = await openGame(h, player);
    const refund = refundWei(h.table, BET, 0, 0);
    const seed = `0x${'00'.repeat(32)}` as const;
    expect(
      await settleRevert(
        h,
        [game.gameId, 1, 0, refund, seed, `0x${'11'.repeat(65)}`],
        player.address,
      ),
    ).toBe('InvalidSignature');
    // And a table-violating amount is refused before the signature is even looked at.
    expect(
      await settleRevert(
        h,
        [game.gameId, 1, 0, BET, seed, `0x${'11'.repeat(65)}`],
        player.address,
      ),
    ).toBe('PayoutMismatch');

    // The player may submit the server-signed result; the relayer's own copy then changes nothing.
    const ended = await api.cashout<GameView>(game.gameId, game.token, { step: 0 });
    const settled = await waitSettled(h, game.gameId);
    expect(settled.payoutWei).toBe(refund);
    expect(ended.body.terminal!.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(
      await settleRevert(
        h,
        [game.gameId, 1, 0, refund, settled.serverSeed, ended.body.terminal!.signature],
        player.address,
      ),
    ).toBe('GameNotActive');
  });

  it('AC-T8: /api/config, the contract and the table agree', async () => {
    const config = (await api.config<ConfigResponse>()).body;
    const contract = { address: h.contract, abi: mazeBetAbi } as const;
    expect(config.rpcUrl).toBe(h.rpcUrl);
    expect(config.chainId).toBe(31337);
    expect(config.contract.toLowerCase()).toBe(h.contract.toLowerCase());
    expect(config.tableHash).toBe(tableHash(h.table));
    expect(await h.publicClient.readContract({ ...contract, functionName: 'tableHash' })).toBe(
      config.tableHash,
    );
    for (const tier of config.tiers) {
      const [n, multiplierBps] = await h.publicClient.readContract({
        ...contract,
        functionName: 'tiers',
        args: [tier.id],
      });
      expect([n, multiplierBps]).toEqual([tier.n, tier.multiplierBps]);
      for (const step of [0, 1, tier.n * tier.n - 1]) {
        expect(
          await h.publicClient.readContract({
            ...contract,
            functionName: 'refundBps',
            args: [tier.id, step],
          }),
        ).toBe(tier.refundBps[step]);
      }
    }
    expect(BigInt(config.minBetWei)).toBe(
      await h.publicClient.readContract({ ...contract, functionName: 'minBet' }),
    );
    expect(BigInt(config.maxBetWei)).toBe(
      await h.publicClient.readContract({ ...contract, functionName: 'maxBet' }),
    );
    expect(BigInt(config.settleWindowSec)).toBe(
      await h.publicClient.readContract({ ...contract, functionName: 'settleWindow' }),
    );
    const now = Number((await h.publicClient.getBlock({ blockTag: 'latest' })).timestamp);
    expect(Math.abs(config.chainNowSec - now)).toBeLessThanOrEqual(2);
  });
});
