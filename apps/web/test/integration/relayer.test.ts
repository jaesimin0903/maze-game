// AC-S11: at-least-once settlement on a real chain. A `settle` transaction that is dropped from
// the node's pool is sent again and mined; a game still unsettled 300 s before its deadline
// raises an alert; and however many copies are sent, a game is settled exactly once.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mazeBetAbi, type GameView } from '@maze/shared';
import { parseEther } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChainApi, type ChainApi } from '../../src/client/chain';
import { api } from '../server/helpers';
import {
  chainTime,
  jump,
  linesOf,
  onchainGame,
  openGame,
  playerOf,
  settlements,
  startHarness,
  startServer,
  until,
  waitSettled,
  type Harness,
  type LogLine,
  type Server,
} from './setup';

interface RpcCall {
  method: string;
  params: unknown[];
}

/** A JSON-RPC proxy in front of Anvil that records every call the server makes. */
async function recordingProxy(target: string): Promise<{ url: string; calls: RpcCall[]; close(): Promise<void> }> {
  const calls: RpcCall[] = [];
  const proxy = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const parsed = JSON.parse(body) as RpcCall | RpcCall[];
      for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
        calls.push({ method: call.method, params: call.params ?? [] });
      }
      fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
        .then(async (upstream) => {
          response.writeHead(upstream.status, { 'content-type': 'application/json' });
          response.end(await upstream.text());
        })
        .catch(() => {
          response.writeHead(502);
          response.end();
        });
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        proxy.closeAllConnections();
        proxy.close(() => resolve());
      }),
  };
}

let h: Harness;
let server: Server;

beforeAll(async () => {
  h = await startHarness();
  server = await startServer(h);
});

afterAll(async () => {
  await h?.testClient.setIntervalMining({ interval: 1 }).catch(() => undefined);
  await server?.stop();
  await h?.stop();
});

function sent(gameId: `0x${string}`): LogLine[] {
  return linesOf(server, gameId).filter((line) => line.event === 'settle-sent');
}

/** The page's own read access to the chain: what it asks before it names a settlement transaction. */
function browserChain(): ChainApi {
  return createChainApi({ chainId: 31337, rpcUrl: h.rpcUrl, contract: h.contract });
}

async function waitRecorded(gameId: `0x${string}`): Promise<void> {
  await until(`the server to record the settlement of ${gameId}`, async () =>
    server.container.service.get(gameId)?.final === 'settled',
  );
}

describe('plan §3.6: how the relayer sends', () => {
  it('uses the pending nonce and a fixed 300,000 gas limit, and never estimates gas', async () => {
    await server.stop();
    const proxy = await recordingProxy(h.rpcUrl);
    try {
      server = await startServer(h, { rpcUrl: proxy.url });
      const game = await openGame(h, playerOf(h, 5));
      proxy.calls.length = 0;
      await api.cashout(game.gameId, game.token, { step: 0 });
      const settled = await waitSettled(h, game.gameId);
      await waitRecorded(game.gameId);

      const methods = proxy.calls.map((call) => call.method);
      expect(methods).toContain('eth_sendRawTransaction');
      expect(methods).not.toContain('eth_estimateGas');
      expect(methods).not.toContain('eth_sendTransaction');
      const nonceReads = proxy.calls.filter((call) => call.method === 'eth_getTransactionCount');
      expect(nonceReads.length).toBeGreaterThan(0);
      for (const call of nonceReads) {
        expect((call.params[0] as string).toLowerCase()).toBe(h.relayer.toLowerCase());
        expect(call.params[1]).toBe('pending');
      }
      const tx = await h.publicClient.getTransaction({ hash: settled.txHash });
      expect(tx.gas).toBe(300_000n);
      expect(methods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1);
    } finally {
      await server.stop();
      await proxy.close();
      server = await startServer(h);
    }
  });
});

describe('AC-S11: at-least-once settlement', () => {
  it('a dropped settle transaction is re-sent after 10 chain seconds and mined once', async () => {
    const game = await openGame(h, playerOf(h, 0));

    // No blocks for a moment, so the transaction stays in the pool and can be dropped from it.
    await h.testClient.setIntervalMining({ interval: 0 });
    let droppedHash: `0x${string}`;
    try {
      const ended = await api.cashout<GameView>(game.gameId, game.token, { step: 0 });
      expect(ended.status).toBe(200);
      const first = await until('the first send', async () => sent(game.gameId)[0]);
      droppedHash = first.txHash!;
      expect(await h.publicClient.getTransaction({ hash: droppedHash })).toMatchObject({
        blockNumber: null,
      });
      await h.testClient.dropTransaction({ hash: droppedHash });
      const pool = await h.testClient.getTxpoolStatus();
      expect(pool.pending + pool.queued).toBe(0);
    } finally {
      await h.testClient.setIntervalMining({ interval: 1 });
    }

    const settled = await waitSettled(h, game.gameId, 60_000);
    await waitRecorded(game.gameId);
    const sends = sent(game.gameId);
    expect(sends).toHaveLength(2);
    expect(sends[1].chainSec! - sends[0].chainSec!).toBeGreaterThanOrEqual(10);
    expect(settled.txHash).toBe(sends[1].txHash);
    expect(settled.from.toLowerCase()).toBe(h.relayer.toLowerCase());
    expect(await settlements(h, game.gameId)).toHaveLength(1);
    expect(linesOf(server, game.gameId).filter((line) => line.event === 'settle-mined')).toHaveLength(1);

    const read = await api.game<GameView>(game.gameId, game.token);
    expect(read.body.terminal!.settleTxHash).toBe(settled.txHash);

    // The page shows a settlement transaction only when the chain says it settled the game:
    // the dropped one, which the server had reported first, never qualifies.
    expect(await browserChain().settledBy(droppedHash, game.gameId)).toBe(false);
    expect(await browserChain().settledBy(settled.txHash, game.gameId)).toBe(true);
  });

  it("the player's own copy and the relayer's copy settle the game once", async () => {
    const player = playerOf(h, 1);
    const game = await openGame(h, player);
    const balanceAfterBet = await h.publicClient.getBalance({ address: player.address });

    await h.testClient.setIntervalMining({ interval: 0 });
    let playerTx: `0x${string}`;
    try {
      const ended = await api.cashout<GameView>(game.gameId, game.token, { step: 0 });
      const terminal = ended.body.terminal!;
      await until('the relayer send', async () => sent(game.gameId)[0]);
      // The player submits the signed result from the response as well.
      playerTx = await player.wallet.writeContract({
        address: h.contract,
        abi: mazeBetAbi,
        functionName: 'settle',
        args: [
          game.gameId,
          terminal.outcome,
          terminal.steps,
          BigInt(terminal.payoutWei),
          terminal.serverSeed,
          terminal.signature,
        ],
        gas: 300_000n,
      });
    } finally {
      await h.testClient.setIntervalMining({ interval: 1 });
    }

    const settled = await waitSettled(h, game.gameId);
    await waitRecorded(game.gameId);
    const playerReceipt = await h.publicClient.waitForTransactionReceipt({ hash: playerTx });
    const relayerReceipt = await h.publicClient.waitForTransactionReceipt({
      hash: sent(game.gameId)[0].txHash!,
    });
    // Both were mined; exactly one of them took effect.
    expect([playerReceipt.status, relayerReceipt.status].sort()).toEqual(['reverted', 'success']);
    expect(await settlements(h, game.gameId)).toHaveLength(1);
    // Paid once.
    const gasPaid = playerReceipt.gasUsed * playerReceipt.effectiveGasPrice;
    expect(await h.publicClient.getBalance({ address: player.address })).toBe(
      balanceAfterBet + settled.payoutWei - gasPaid,
    );
    const read = await api.game<GameView>(game.gameId, game.token);
    expect(read.body.terminal!.settleTxHash).toBe(settled.txHash);
    expect(sent(game.gameId)).toHaveLength(1);

    // Of the two mined copies, the page accepts only the one that took effect, and only for
    // this game.
    const reverted = [playerTx, sent(game.gameId)[0].txHash!].find((hash) => hash !== settled.txHash)!;
    expect(await browserChain().settledBy(settled.txHash, game.gameId)).toBe(true);
    expect(await browserChain().settledBy(reverted, game.gameId)).toBe(false);
    expect(await browserChain().settledBy(settled.txHash, `0x${'ab'.repeat(32)}`)).toBe(false);
  });

  it('alerts 300 s before the deadline while unsettled, and still settles before it', async () => {
    const game = await openGame(h, playerOf(h, 2));
    const deadline = Number((await onchainGame(h, game.gameId)).settleDeadline);

    // The relayer cannot pay for gas: every send fails at the node.
    const relayerBalance = await h.publicClient.getBalance({ address: h.relayer });
    await h.testClient.setBalance({ address: h.relayer, value: 0n });
    await api.cashout(game.gameId, game.token, { step: 0 });
    await until('a failed send', async () =>
      linesOf(server, game.gameId).find((line) => line.event === 'settle-send-failed'),
    );
    expect(linesOf(server, game.gameId).some((line) => line.event === 'settle-overdue')).toBe(false);

    await jump(h, deadline - 300 - (await chainTime(h)));
    const alert = await until('the alert', async () =>
      linesOf(server, game.gameId).find((line) => line.event === 'settle-overdue'),
    );
    expect(alert).toMatchObject({ level: 'alert', outcome: 1, step: 0 });
    expect(alert.chainSec!).toBeGreaterThanOrEqual(deadline - 300);
    expect(sent(game.gameId)).toHaveLength(0);
    expect((await onchainGame(h, game.gameId)).status).toBe(1);

    // The relayer is funded again: the very next pass settles the game, before the deadline.
    await h.testClient.setBalance({ address: h.relayer, value: relayerBalance });
    const settled = await waitSettled(h, game.gameId);
    expect(settled.timestamp).toBeLessThanOrEqual(deadline);
    expect(settled.from.toLowerCase()).toBe(h.relayer.toLowerCase());
    await waitRecorded(game.gameId);
    expect(await settlements(h, game.gameId)).toHaveLength(1);
    expect(linesOf(server, game.gameId).filter((line) => line.event === 'settle-overdue')).toHaveLength(1);
    expect(relayerBalance).toBeGreaterThan(parseEther('1'));
  });
});
