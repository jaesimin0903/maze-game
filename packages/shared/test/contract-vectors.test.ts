// TypeScript against the contract, without a chain.
//
// 1. The golden constants of contracts/test/MazeBet.t.sol (a ticket and a settlement signed for
//    the table of `_tinyTable()`) are read from the Solidity source and reproduced here with the
//    frozen EIP-712 types, `commitmentOf` and `tableHash`. The Foundry test accepts the same
//    constants on chain, so a change of a type, a domain field or an encoding on either side
//    fails one of the two suites.
// 2. test/vectors/contract-vectors.json pins, per certified table, the table hash, the
//    commitment per size and the exit payout and refund of one bet at every tier and step.
//    contracts/test/MazeBetProduction.t.sol checks the deployed production table against the
//    same file. The file is written by test/vectors/make-contract-vectors.ts, which does not
//    use the modules tested here.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashTypedData, parseEther, recoverTypedDataAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  commitmentOf,
  EIP712_TYPES,
  exitPayoutWei,
  loadTuning,
  mazeBetDomain,
  refundBps,
  refundWei,
  tableHash,
  type Hex,
  type TuningTable,
} from '../src';
import vectors from './vectors/contract-vectors.json';

const here = dirname(fileURLToPath(import.meta.url));
const solidity = readFileSync(resolve(here, '../../../contracts/test/MazeBet.t.sol'), 'utf8');

/** The value of `<type> internal constant <name> = <value>;` in the Solidity test. */
function constant(name: string): string {
  const match = new RegExp(`\\bconstant ${name}\\s*=\\s*(hex")?([0-9A-Za-z_]+)"?;`).exec(solidity);
  if (match === null) throw new Error(`contracts/test/MazeBet.t.sol has no constant ${name}`);
  const value = match[2].replace(/_/g, '');
  return match[1] === undefined ? value : `0x${value}`;
}

const hex = (name: string): Hex => constant(name) as Hex;

/** The table `_tinyTable()` builds, read from its body. */
function tinyTable(): TuningTable {
  const body = /function _tinyTable\(\)[\s\S]*?\n {4}\}\n/.exec(solidity)?.[0];
  if (body === undefined) throw new Error('contracts/test/MazeBet.t.sol has no _tinyTable()');
  const field = (pattern: RegExp): string => {
    const match = pattern.exec(body);
    if (match === null) throw new Error(`_tinyTable(): ${pattern.source} not found`);
    return match[1].replace(/_/g, '');
  };
  const refunds: number[] = [];
  for (const match of body.matchAll(/refunds\[(\d+)\] = (\d+);/g)) refunds[Number(match[1])] = Number(match[2]);
  expect(refunds).toHaveLength(Number(field(/new uint16\[\]\((\d+)\)/)));

  const base = loadTuning();
  return {
    ...base,
    tableVersion: Number(field(/t\.tableVersion = ([\d_]+);/)),
    mazeVersion: Number(field(/t\.mazeVersion = ([\d_]+);/)),
    tiers: [
      {
        id: 0,
        n: Number(field(/TierInit\(\{n: ([\d_]+),/)),
        // The curve is not part of the constructor arguments and so not of the hash.
        curve: base.tiers[0].curve,
        multiplierBps: Number(field(/multiplierBps: ([\d_]+),/)),
        refundBps: refunds,
      },
    ],
    limits: {
      minBetWei: parseEther(field(/t\.minBet = ([\d.]+) ether;/)).toString(),
      maxBetWei: parseEther(field(/t\.maxBet = ([\d.]+) ether;/)).toString(),
    },
    timing: { ...base.timing, settleWindowSec: Number(field(/t\.settleWindow = ([\d_]+);/)) },
  };
}

describe('golden vectors of contracts/test/MazeBet.t.sol', () => {
  const tiny = tinyTable();
  const tier = Number(constant('GOLDEN_TIER'));
  const domain = mazeBetDomain(Number(constant('GOLDEN_CHAIN_ID')), hex('GOLDEN_CONTRACT'));
  const ticket = {
    gameId: hex('GOLDEN_GAME_ID'),
    player: hex('GOLDEN_PLAYER'),
    tier,
    commitment: hex('GOLDEN_COMMITMENT'),
    expiry: BigInt(constant('GOLDEN_EXPIRY')),
  };
  const settlement = {
    gameId: hex('GOLDEN_GAME_ID'),
    player: hex('GOLDEN_PLAYER'),
    outcome: Number(constant('GOLDEN_OUTCOME')),
    steps: Number(constant('GOLDEN_STEPS')),
    payout: BigInt(constant('GOLDEN_PAYOUT')),
    serverSeed: hex('GOLDEN_SERVER_SEED'),
  };

  it('reads the table of _tinyTable() and the inputs the Foundry test signs', () => {
    expect(tiny.tiers).toEqual([expect.objectContaining({ n: 2, multiplierBps: 15_000, refundBps: [9500, 7000, 5000, 2000] })]);
    expect([tiny.tableVersion, tiny.mazeVersion, tiny.timing.settleWindowSec]).toEqual([7, 1, 1800]);
    expect(domain).toEqual({ name: 'MazeBet', version: '1', chainId: 31337, verifyingContract: hex('GOLDEN_CONTRACT') });
    expect(settlement.outcome).toBe(1);
  });

  it('AC-C8 tableHash reproduces GOLDEN_TABLE_HASH', () => {
    expect(tableHash(tiny)).toBe(constant('GOLDEN_TABLE_HASH'));
  });

  it('AC-M4 commitmentOf reproduces GOLDEN_COMMITMENT', () => {
    expect(
      commitmentOf({ mazeVersion: tiny.mazeVersion, n: tiny.tiers[tier].n, serverSeed: hex('GOLDEN_SERVER_SEED') }),
    ).toBe(constant('GOLDEN_COMMITMENT'));
  });

  it('AC-C4 the frozen Ticket type hashes to GOLDEN_TICKET_DIGEST, and GOLDEN_TICKET_SIG is the signer over it', async () => {
    const typed = { domain, types: EIP712_TYPES, primaryType: 'Ticket', message: ticket } as const;
    expect(hashTypedData(typed)).toBe(constant('GOLDEN_TICKET_DIGEST'));
    expect(await recoverTypedDataAddress({ ...typed, signature: hex('GOLDEN_TICKET_SIG') })).toBe(constant('GOLDEN_SIGNER'));
  });

  it('AC-C4 the frozen Settlement type hashes to GOLDEN_SETTLEMENT_DIGEST, and GOLDEN_SETTLEMENT_SIG is the signer over it', async () => {
    const typed = { domain, types: EIP712_TYPES, primaryType: 'Settlement', message: settlement } as const;
    expect(hashTypedData(typed)).toBe(constant('GOLDEN_SETTLEMENT_DIGEST'));
    expect(await recoverTypedDataAddress({ ...typed, signature: hex('GOLDEN_SETTLEMENT_SIG') })).toBe(
      constant('GOLDEN_SIGNER'),
    );
  });

  it('AC-C4 a digest moves with every field of the domain and of the message', () => {
    const base = hashTypedData({ domain, types: EIP712_TYPES, primaryType: 'Ticket', message: ticket });
    const others = [
      hashTypedData({ domain: { ...domain, chainId: 1 }, types: EIP712_TYPES, primaryType: 'Ticket', message: ticket }),
      hashTypedData({ domain: { ...domain, verifyingContract: hex('GOLDEN_PLAYER') }, types: EIP712_TYPES, primaryType: 'Ticket', message: ticket }),
      hashTypedData({ domain, types: EIP712_TYPES, primaryType: 'Ticket', message: { ...ticket, expiry: ticket.expiry + 1n } }),
      hashTypedData({ domain, types: EIP712_TYPES, primaryType: 'Ticket', message: { ...ticket, tier: tier + 1 } }),
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });
});

describe('pinned vectors of the production table (contracts/test/MazeBetProduction.t.sol reads the same file)', () => {
  const table = loadTuning();
  const hash = tableHash(table);
  const bet = BigInt(vectors.betWei);
  const serverSeed = vectors.serverSeed as Hex;

  function pinned(): (typeof vectors.tables)[number] {
    const entry = vectors.tables.find((candidate) => candidate.tableHash === hash);
    if (entry === undefined) {
      throw new Error(
        `test/vectors/contract-vectors.json has no entry for the production table ${hash}: add it with test/vectors/make-contract-vectors.ts`,
      );
    }
    return entry;
  }

  it('AC-C8 tableHash of the production table is a pinned hash, with the pinned sizes and multipliers', () => {
    const entry = pinned();
    expect(entry.mazeVersion).toBe(table.mazeVersion);
    expect(entry.tiers.map(({ n, multiplierBps }) => [n, multiplierBps])).toEqual(
      table.tiers.map(({ n, multiplierBps }) => [n, multiplierBps]),
    );
  });

  it('AC-M4 commitmentOf gives the pinned commitment for every size', () => {
    pinned().tiers.forEach((tier) => {
      expect(commitmentOf({ mazeVersion: table.mazeVersion, n: tier.n, serverSeed })).toBe(tier.commitment);
    });
  });

  it('AC-R1 exitPayoutWei is the pinned floor at every tier, and the bet leaves a remainder there', () => {
    pinned().tiers.forEach((tier, index) => {
      const paid = exitPayoutWei(table, bet, index);
      expect(paid).toBe(BigInt(tier.exitPayoutWei));
      // What the division drops is not zero, so a payout rounded up would be one wei more.
      expect(bet * BigInt(table.tiers[index].multiplierBps) - paid * 10_000n).toBe(BigInt(tier.exitRemainder));
      expect(tier.exitRemainder).toBeGreaterThan(0);
    });
  });

  it('X23 refundWei is the pinned floor at every tier and step', () => {
    pinned().tiers.forEach((tier, index) => {
      expect(tier.refundWei).toHaveLength(tier.n * tier.n);
      let withRemainder = 0;
      tier.refundWei.forEach((wei, k) => {
        const paid = refundWei(table, bet, index, k);
        expect(paid).toBe(BigInt(wei));
        const exact = bet * BigInt(refundBps(table, index, k));
        expect(paid * 10_000n <= exact && exact - paid * 10_000n < 10_000n).toBe(true);
        if (exact !== paid * 10_000n) withRemainder += 1;
      });
      expect(withRemainder).toBeGreaterThan(tier.refundWei.length / 2);
    });
  });

  it('AC-R1 X23 the vectors of the base table are the reviewed literals for a bet of 12345678901234567 wei', () => {
    // Exit: × 26088 / 66112 / 184695 leaves 3896 / 3504 / 2065. The Foundry suite holds the same literals.
    const base = vectors.tables.find(
      (entry) => entry.tableHash === '0xd07642f3561163900d1c90b74a8e4acce618f5d58e51750f4061486d57777caf',
    )!;
    expect(bet).toBe(12_345_678_901_234_567n);
    expect(base.tiers.map((tier) => [tier.n, tier.multiplierBps, tier.exitPayoutWei, tier.exitRemainder])).toEqual([
      [5, 26_088, '32207407117540738', 3896],
      [7, 66_112, '81619752351841969', 3504],
      [9, 184_695, '228018516466351835', 2065],
    ]);
    // Refunds after 0, 1 and 2 moves and at the last cash-out step n² − 2.
    expect(base.tiers.map((tier) => [0, 1, 2, tier.n * tier.n - 2].map((k) => tier.refundWei[k]))).toEqual([
      ['11728394956172838', '9012345597901233', '8264197456486419', '1339506160783950'],
      ['11728394956172838', '9012345597901233', '8506172762950616', '632098759743209'],
      ['11728394956172838', '9012345597901233', '8358024616135801', '24691357802469'],
    ]);
  });
});
