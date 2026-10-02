// Writes contract-vectors.json: the values that TypeScript and the contract must both produce for
// the certified tables (pinned by test/contract-vectors.test.ts and by
// contracts/test/MazeBetProduction.t.sol).
//
//   pnpm exec tsx packages/shared/test/vectors/make-contract-vectors.ts <table.json> [<table.json> ...]
//
// Run it from the repository root with every table that may become the production table, for
// example packages/sim/reports/tuning.candidate.json packages/sim/reports/tuning.house-max.json.
//
// Nothing here is imported from ../../src: the amounts are plain BigInt arithmetic, the
// commitment is node:crypto, and the table hash is encoded from a type string written out
// below. Regenerating therefore cannot bless a change of the modules under test.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToBytes } from 'viem';

interface TableFile {
  tableVersion: number;
  mazeVersion: number;
  tiers: { n: number; multiplierBps: number; refundBps: number[] }[];
  limits: { minBetWei: string; maxBetWei: string };
  timing: { settleWindowSec: number };
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

/** Inside the bet limits, and not a multiple of anything that would hide a remainder. */
const BET_WEI = 12_345_678_901_234_567n;
const SERVER_SEED = sha256Hex(Buffer.from('MazeBet contract vectors serverSeed', 'utf8'));

function sha256Hex(data: Buffer): `0x${string}` {
  return `0x${createHash('sha256').update(data).digest('hex')}`;
}

function bytesOf(hex: string): Buffer {
  return Buffer.from(hex.slice(2), 'hex');
}

/** keccak256(abi.encode(uint32, uint16, TierInit[], uint256, uint256, uint64)), as in the constructor. */
function tableHashOf(t: TableFile): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'uint32 tableVersion, uint16 mazeVersion, (uint8 n, uint32 multiplierBps, uint16[] refundBps)[] tiers, uint256 minBet, uint256 maxBet, uint64 settleWindow',
      ),
      [
        t.tableVersion,
        t.mazeVersion,
        t.tiers.map(({ n, multiplierBps, refundBps }) => ({ n, multiplierBps, refundBps })),
        BigInt(t.limits.minBetWei),
        BigInt(t.limits.maxBetWei),
        BigInt(t.timing.settleWindowSec),
      ],
    ),
  );
}

/** sha256( keccak256("MazeBet.commit.v1") ‖ uint16be(mazeVersion) ‖ uint8(n) ‖ serverSeed ). */
function commitment(mazeVersion: number, n: number): `0x${string}` {
  const version = Buffer.alloc(2);
  version.writeUInt16BE(mazeVersion);
  return sha256Hex(
    Buffer.concat([bytesOf(keccak256(stringToBytes('MazeBet.commit.v1'))), version, Buffer.from([n]), bytesOf(SERVER_SEED)]),
  );
}

const sources = process.argv.slice(2);
if (sources.length === 0) {
  console.error('usage: tsx make-contract-vectors.ts <table.json> [<table.json> ...]');
  process.exit(2);
}

const tables = sources.map((source) => {
  const path = resolve(source);
  const t = JSON.parse(readFileSync(path, 'utf8')) as TableFile;
  return {
    source: relative(repoRoot, path),
    tableHash: tableHashOf(t),
    mazeVersion: t.mazeVersion,
    tiers: t.tiers.map((tier) => {
      const exact = BET_WEI * BigInt(tier.multiplierBps);
      return {
        n: tier.n,
        multiplierBps: tier.multiplierBps,
        commitment: commitment(t.mazeVersion, tier.n),
        exitPayoutWei: (exact / 10_000n).toString(),
        exitRemainder: Number(exact % 10_000n),
        refundWei: tier.refundBps.map((bps) => ((BET_WEI * BigInt(bps)) / 10_000n).toString()),
      };
    }),
  };
});

const file = {
  note:
    'Pinned TypeScript-vs-contract vectors, one entry per certified table. betWei is the bet of every amount; ' +
    'serverSeed is sha256 of the UTF-8 text "MazeBet contract vectors serverSeed". Per tier: commitment = ' +
    'sha256(keccak256("MazeBet.commit.v1") ‖ uint16be(mazeVersion) ‖ uint8(n) ‖ serverSeed); exitPayoutWei = ' +
    'floor(betWei × multiplierBps / 10000) and exitRemainder is what the division drops; refundWei[k] = ' +
    'floor(betWei × refundBps[k] / 10000). tableHash = keccak256(abi.encode(tableVersion, mazeVersion, tiers, minBet, ' +
    'maxBet, settleWindow)). Written by make-contract-vectors.ts, which computes them without the modules under test.',
  betWei: BET_WEI.toString(),
  serverSeed: SERVER_SEED,
  tables,
};

writeFileSync(join(here, 'contract-vectors.json'), `${JSON.stringify(file, null, 2)}\n`);
console.log(`contract-vectors.json: ${tables.map((table) => `${table.source} ${table.tableHash}`).join(', ')}`);
