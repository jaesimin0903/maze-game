// Deploys MazeBet to a local Anvil with viem and funds the house (plan §7.2).
//
//   tsx scripts/deploy-local.ts [--port 8545 | --rpc-url http://127.0.0.1:8545] [--table <file>]
//
// The constructor arguments come from `constructorArgs(table, …)`, the same encoder `tableHash`
// uses, so the deployed table and the hash the server checks at boot cannot drift apart.
//
// The only file written is `deployments/local-<port>.json`. No `.env*` file is read or written.
//
// Environment (all optional):
//   RPC_URL                    used when neither --rpc-url nor --port is given
//   MAZE_TUNING_FIXTURE        table file, used when --table is not given
//   DEPLOYER_PRIVATE_KEY       owner and house account (default: Anvil account #0)
//   SERVER_SIGNER_PRIVATE_KEY  the server's signing key; its address becomes `serverSigner`
//                              (default: Anvil account #1)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  constructorArgs,
  loadTuning,
  mazeBetAbi,
  parseTuning,
  tableHash,
  type Hex,
  type TuningTable,
} from '@maze/shared';
import { createPublicClient, createWalletClient, defineChain, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = path.join(ROOT, 'contracts/out/MazeBet.sol/MazeBet.json');

/** Anvil's default accounts #0 and #1. Public, well-known test keys. */
export const ANVIL_OWNER_KEY: Hex =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const ANVIL_SIGNER_KEY: Hex =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const LOCAL_CHAIN_ID = 31337;
const HOUSE_FUND_WEI = parseEther('100');

/** Content of `deployments/local-<port>.json`. */
export interface Deployment {
  chainId: number;
  rpcUrl: string;
  port: number;
  mazeBetAddress: Hex;
  owner: Hex;
  serverSigner: Hex;
  tableHash: Hex;
  tableVersion: number;
  fixture: boolean;
  calibrated: boolean;
  deployTxHash: Hex;
  deployBlock: number;
  fundedWei: string;
}

function portOf(rpcUrl: string): number {
  const url = new URL(rpcUrl);
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function readBytecode(): Hex {
  let artifact: { bytecode?: { object?: string } };
  try {
    artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  } catch {
    throw new Error(`${ARTIFACT} is missing; run "forge build --root contracts" first`);
  }
  const bytecode = artifact.bytecode?.object;
  if (typeof bytecode !== 'string' || !/^0x[0-9a-fA-F]+$/.test(bytecode)) {
    throw new Error(`${ARTIFACT} has no bytecode`);
  }
  return bytecode as Hex;
}

/** Deploys the contract with `table`, deposits the house funds, and returns the record. */
export async function deployMazeBet(p: {
  rpcUrl: string;
  table: TuningTable;
  ownerKey?: Hex;
  serverSigner?: Hex;
  fundWei?: bigint;
}): Promise<Deployment> {
  const owner = privateKeyToAccount(p.ownerKey ?? ANVIL_OWNER_KEY);
  const serverSigner = p.serverSigner ?? privateKeyToAccount(ANVIL_SIGNER_KEY).address;
  const fundWei = p.fundWei ?? HOUSE_FUND_WEI;

  const probe = createPublicClient({ transport: http(p.rpcUrl) });
  const chainId = await probe.getChainId();
  if (chainId !== LOCAL_CHAIN_ID) {
    throw new Error(`deploy-local only deploys to chain ${LOCAL_CHAIN_ID}; the node is chain ${chainId}`);
  }
  const chain = defineChain({
    id: chainId,
    name: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [p.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(p.rpcUrl), pollingInterval: 100 });
  const wallet = createWalletClient({ chain, transport: http(p.rpcUrl), account: owner });

  const deployTxHash = await wallet.deployContract({
    abi: mazeBetAbi,
    bytecode: readBytecode(),
    args: constructorArgs(p.table, owner.address, serverSigner),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTxHash });
  const address = receipt.contractAddress;
  if (receipt.status !== 'success' || !address) {
    throw new Error(`the deployment transaction ${deployTxHash} failed`);
  }

  const expected = tableHash(p.table);
  const onchain = await publicClient.readContract({
    address,
    abi: mazeBetAbi,
    functionName: 'tableHash',
  });
  if (onchain.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`deployed tableHash ${onchain} differs from the table's ${expected}`);
  }

  if (fundWei > 0n) {
    const fundTxHash = await wallet.writeContract({
      address,
      abi: mazeBetAbi,
      functionName: 'fund',
      value: fundWei,
    });
    const funded = await publicClient.waitForTransactionReceipt({ hash: fundTxHash });
    if (funded.status !== 'success') throw new Error(`funding transaction ${fundTxHash} failed`);
  }

  return {
    chainId,
    rpcUrl: p.rpcUrl,
    port: portOf(p.rpcUrl),
    mazeBetAddress: address,
    owner: owner.address,
    serverSigner,
    tableHash: expected,
    tableVersion: p.table.tableVersion,
    fixture: p.table.fixture === true,
    calibrated: p.table.calibration.calibrated,
    deployTxHash,
    deployBlock: Number(receipt.blockNumber),
    fundedWei: fundWei.toString(),
  };
}

/** Writes `deployments/local-<port>.json` and returns its path. */
export function writeDeployment(deployment: Deployment, rootDir: string = ROOT): string {
  const dir = path.join(rootDir, 'deployments');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `local-${deployment.port}.json`);
  writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
  return file;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const port = option(args, '--port');
  const rpcUrl =
    option(args, '--rpc-url') ??
    (port === undefined ? undefined : `http://127.0.0.1:${port}`) ??
    nonEmpty(process.env.RPC_URL) ??
    'http://127.0.0.1:8545';
  const tablePath = option(args, '--table') ?? nonEmpty(process.env.MAZE_TUNING_FIXTURE);
  const table =
    tablePath === undefined
      ? loadTuning()
      : parseTuning(JSON.parse(readFileSync(path.resolve(tablePath), 'utf8')));
  const signerKey = nonEmpty(process.env.SERVER_SIGNER_PRIVATE_KEY) as Hex | undefined;

  const deployment = await deployMazeBet({
    rpcUrl,
    table,
    ownerKey: nonEmpty(process.env.DEPLOYER_PRIVATE_KEY) as Hex | undefined,
    serverSigner: signerKey === undefined ? undefined : privateKeyToAccount(signerKey).address,
  });
  const file = writeDeployment(deployment);
  process.stdout.write(`${JSON.stringify({ ...deployment, file })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`deploy-local: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
