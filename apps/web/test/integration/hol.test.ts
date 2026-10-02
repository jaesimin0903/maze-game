// AC-X9 and the contract-player case of AC-X4: a player contract whose `receive` burns all the
// gas it is given cannot make its own settlement fail, and its settlement being in flight does
// not delay the settlement of another player's loss.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mazeBetAbi, refundWei, type GameView, type Hex } from '@maze/shared';
import { createWalletClient, http, parseEther, type Abi } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, deadEndRoute } from '../server/helpers';
import {
  BET,
  onchainGame,
  openGame,
  playerOf,
  reclaimRevert,
  requestTicket,
  startHarness,
  startServer,
  waitSettled,
  walk,
  type Harness,
  type Server,
} from './setup';

const ARTIFACT = fileURLToPath(
  new URL('../../../../contracts/out/GasBurnPlayer.sol/GasBurnPlayer.json', import.meta.url),
);

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

/** Deploys the gas-burning player contract and lets the tests send transactions as it. */
async function deployBurner(): Promise<Hex> {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  const deployer = playerOf(h, 7);
  const hash = await deployer.wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  });
  const receipt = await h.publicClient.waitForTransactionReceipt({ hash });
  const address = receipt.contractAddress;
  if (!address) throw new Error('GasBurnPlayer was not deployed');
  await h.testClient.setBalance({ address, value: parseEther('1') });
  await h.testClient.impersonateAccount({ address });
  return address;
}

describe('AC-X9: no head-of-line blocking', () => {
  it("a gas-burning player's cash-out does not delay another game's loss settlement", async () => {
    const burner = await deployBurner();
    const burnerWallet = createWalletClient({
      chain: h.chain,
      transport: http(h.rpcUrl),
      account: burner,
    });

    // The contract is the player of its own game.
    const { ticket, token } = await requestTicket(burner);
    const createHash = await burnerWallet.writeContract({
      address: h.contract,
      abi: mazeBetAbi,
      functionName: 'createGame',
      args: [
        ticket.gameId,
        ticket.tier,
        ticket.commitment,
        BigInt(ticket.expirySec),
        `0x${'b0'.repeat(32)}`,
        ticket.signature,
      ],
      value: BET,
    });
    const created = await h.publicClient.waitForTransactionReceipt({ hash: createHash });
    expect(created.status).toBe('success');
    expect((await api.start(ticket.gameId, token)).status).toBe(200);
    expect((await onchainGame(h, ticket.gameId)).player.toLowerCase()).toBe(burner.toLowerCase());

    // An ordinary player is one move away from a dead end.
    const victim = await openGame(h, playerOf(h, 0), { deadEnd: true });
    const route = deadEndRoute(victim.maze);
    const k = route.length - 1;
    await walk(victim, route.slice(0, k));

    // The burner cashes out and, at the same moment, the other player loses.
    const [cashed, lost] = await Promise.all([
      api.cashout<GameView>(ticket.gameId, token, { step: 0 }),
      api.move<GameView>(victim.gameId, victim.token, { step: k, dir: route[k] }),
    ]);
    expect(cashed.body.status).toBe('cashed_out');
    expect(lost.body.status).toBe('lost');

    const lossSettled = await waitSettled(h, victim.gameId);
    expect(lossSettled).toMatchObject({ outcome: 2, payoutWei: 0n });
    // Within 5 chain seconds of the loss.
    expect(lossSettled.timestamp - lost.body.chainNowSec).toBeLessThanOrEqual(5);

    // The burner's settlement also went through: `settle` did not revert, the payment that
    // could not be delivered is credited instead.
    const refund = refundWei(h.table, BET, 0, 0);
    const burnSettled = await waitSettled(h, ticket.gameId);
    expect(burnSettled).toMatchObject({ outcome: 1, steps: 0, payoutWei: refund });
    expect(burnSettled.gasUsed).toBeLessThanOrEqual(300_000n);
    expect(burnSettled.timestamp - cashed.body.chainNowSec).toBeLessThanOrEqual(5);
    expect(
      await h.publicClient.readContract({
        address: h.contract,
        abi: mazeBetAbi,
        functionName: 'pendingWithdrawals',
        args: [burner],
      }),
    ).toBe(refund);
    const deferred = await h.publicClient.getContractEvents({
      address: h.contract,
      abi: mazeBetAbi,
      eventName: 'PayoutDeferred',
      fromBlock: 0n,
      strict: true,
    });
    expect(deferred.map((log) => log.transactionHash)).toEqual([burnSettled.txHash]);

    // AC-X4: so the contract player did not turn a 95% refund into a full reclaim.
    expect((await onchainGame(h, ticket.gameId)).status).toBe(2);
    expect(await reclaimRevert(h, ticket.gameId, burner)).toBe('GameNotActive');
    expect(await h.publicClient.getBalance({ address: burner })).toBeLessThan(parseEther('1') - BET + refund);
  });
});
