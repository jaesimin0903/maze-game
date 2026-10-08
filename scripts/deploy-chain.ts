// Deploys MazeBet to a public chain (Monad Testnet) with the production table
// (docs/deploy-monad.md).
//
//   pnpm monad:deploy [--fund <amount>] [--env <path>] [--redeploy]
//
// Settings come from the env file (default `.env.monad`, written by `pnpm monad:keys`): RPC_URL,
// CHAIN_ID, CHAIN_NAME, NATIVE_SYMBOL, DEPLOYER_PRIVATE_KEY (owner and house account) and
// SERVER_SIGNER_PRIVATE_KEY, of which only the address is used: it becomes `serverSigner`.
//
// In order:
//   1. refuses a fixture or uncalibrated table, a node that is not chain CHAIN_ID, an env file that
//      already names a contract (unless --redeploy), and a deployer that cannot pay for it all;
//   2. deploys, then checks `tableHash`, `owner` and `serverSigner` on chain;
//   3. writes deployments/<chain name>-<chain id>.json and sets MAZEBET_ADDRESS in the env file.
//      A MAZE_START_BLOCK left there is cleared: a server on a fresh volume starts at the head.
//      With --redeploy the record of the previous contract is kept as
//      deployments/<chain name>-<chain id>-<previous address>.json, and its address is printed:
//      its house funds stay in it until `pnpm monad:withdraw-house` takes them out;
//   4. with --fund, deposits that amount as house liquidity (`fund()`) once the chain is
//      `RESERVE_GAP_BLOCKS` past the deploy block. Monad's reserve balance rule lets an account
//      take its balance below 10 MON only in a transaction that follows none of its own in the
//      3 blocks before; otherwise the transaction reverts and its gas is lost.
//
// The bytecode is read from contracts/out (the package script runs `forge build` first). No
// private key is printed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { constructorArgs, loadTuning, mazeBetAbi, tableHash, type Hex, type TuningTable } from '@maze/shared';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeDeployData,
  formatEther,
  getAddress,
  http,
  parseEther,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readBytecode } from './deploy-local';
import {
  envFileOption,
  option,
  readEnvFile,
  requireValue,
  ROOT,
  shown,
  updateEnvFile,
  type EnvValues,
} from './env-file';

/** `fund` is sent once the head is this many blocks past the deploy block (Monad: k = 3, plus one). */
export const RESERVE_GAP_BLOCKS = 4n;
/** Gas set aside for `fund` when checking that the deployer can pay. */
const FUND_GAS_ALLOWANCE = 100_000n;
/** How long to wait for a block or a receipt before giving up. */
const WAIT_MS = 120_000;

export interface ChainSettings {
  file: string;
  rpcUrl: string;
  chainId: number;
  chainName: string;
  symbol: string;
  chain: Chain;
}

/** Content of `deployments/<chain name>-<chain id>.json`. */
export interface ChainDeployment {
  chainId: number;
  chainName: string;
  mazeBetAddress: Hex;
  deployBlock: number;
  deployTxHash: Hex;
  owner: Hex;
  serverSigner: Hex;
  tableHash: Hex;
  tableVersion: number;
  /** ABI-encoded constructor arguments, for source verification. */
  constructorArgs: Hex;
  deployedAt: string;
  fundings: { txHash: Hex; blockNumber: number; amountWei: string }[];
  /** Sum of `fundings`. */
  fundedWei: string;
}

export function chainSettings(env: EnvValues, file: string): ChainSettings {
  const rpcUrl = requireValue(env, 'RPC_URL', file);
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error(`RPC_URL in ${file} must be an http(s) URL`);
  const chainId = Number(requireValue(env, 'CHAIN_ID', file));
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`CHAIN_ID in ${file} is not a chain id`);
  const chainName = env.CHAIN_NAME || `Chain ${chainId}`;
  const symbol = env.NATIVE_SYMBOL || 'ETH';
  const chain = defineChain({
    id: chainId,
    name: chainName,
    nativeCurrency: { name: symbol, symbol, decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  return { file, rpcUrl, chainId, chainName, symbol, chain };
}

export function publicClientOf(settings: ChainSettings) {
  return createPublicClient({
    chain: settings.chain,
    transport: http(settings.rpcUrl),
    pollingInterval: 250,
    cacheTime: 0,
  });
}

export function walletOf(settings: ChainSettings, key: Hex) {
  return createWalletClient({ chain: settings.chain, transport: http(settings.rpcUrl), account: privateKeyToAccount(key) });
}

/** Fails unless the node behind RPC_URL is chain CHAIN_ID. */
export async function assertChain(settings: ChainSettings): Promise<void> {
  const nodeChainId = await publicClientOf(settings).getChainId();
  if (nodeChainId !== settings.chainId) {
    throw new Error(`the node at RPC_URL is chain ${nodeChainId}, CHAIN_ID in ${settings.file} says ${settings.chainId}`);
  }
}

export function deploymentFile(settings: ChainSettings): string {
  const slug = settings.chainName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return path.join(ROOT, 'deployments', `${slug || 'chain'}-${settings.chainId}.json`);
}

/** A positive amount of the native currency, such as "5" or "0.25", in wei. */
export function parseAmount(text: string | undefined, symbol: string): bigint {
  if (text === undefined || !/^\d+(\.\d{1,18})?$/.test(text)) {
    throw new Error(`the amount must be a number of ${symbol}, such as 5 or 0.25`);
  }
  const wei = parseEther(text);
  if (wei === 0n) throw new Error('the amount must be more than 0');
  return wei;
}

export function encodeConstructorArgs(table: TuningTable, owner: Hex, serverSigner: Hex): Hex {
  const inputs = mazeBetAbi.find((item) => item.type === 'constructor')!.inputs;
  return encodeAbiParameters(inputs, constructorArgs(table, owner, serverSigner));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves once the chain's head is at least `block`. */
async function waitForBlock(settings: ChainSettings, block: bigint): Promise<void> {
  const client = publicClientOf(settings);
  const until = Date.now() + WAIT_MS;
  while ((await client.getBlockNumber({ cacheTime: 0 })) < block) {
    if (Date.now() > until) throw new Error(`the chain did not reach block ${block} within ${WAIT_MS / 1000} s`);
    await sleep(200);
  }
}

/**
 * Deposits `amountWei` of the owner's as house liquidity. With `notBeforeBlock`, waits until the
 * chain's head has reached it first (the reserve balance rule, see the top of this file).
 */
export async function fundHouse(p: {
  settings: ChainSettings;
  ownerKey: Hex;
  contract: Hex;
  amountWei: bigint;
  notBeforeBlock?: bigint;
}): Promise<{ txHash: Hex; blockNumber: number }> {
  if (p.notBeforeBlock !== undefined) await waitForBlock(p.settings, p.notBeforeBlock);
  const publicClient = publicClientOf(p.settings);
  const txHash = await walletOf(p.settings, p.ownerKey).writeContract({
    address: p.contract,
    abi: mazeBetAbi,
    functionName: 'fund',
    value: p.amountWei,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: WAIT_MS });
  if (receipt.status !== 'success') {
    throw new Error(
      `the fund transaction ${txHash} reverted. On Monad an account holding less than 10 MON may ` +
        'only spend in a transaction that follows none of its own in the 3 blocks before: wait a few ' +
        'seconds and run "pnpm monad:fund <amount>"',
    );
  }
  return { txHash, blockNumber: Number(receipt.blockNumber) };
}

export function readDeployment(file: string): ChainDeployment | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as ChainDeployment;
}

export function writeChainDeployment(file: string, deployment: ChainDeployment): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
}

/** Adds a funding to the deployment record of `contract`, when there is one. */
export function recordFunding(
  file: string,
  contract: Hex,
  funding: { txHash: Hex; blockNumber: number; amountWei: bigint },
): boolean {
  const deployment = readDeployment(file);
  if (deployment === null || deployment.mazeBetAddress.toLowerCase() !== contract.toLowerCase()) return false;
  deployment.fundings.push({ ...funding, amountWei: funding.amountWei.toString() });
  deployment.fundedWei = (BigInt(deployment.fundedWei) + funding.amountWei).toString();
  writeChainDeployment(file, deployment);
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = envFileOption(args);
  const env = readEnvFile(file);
  const settings = chainSettings(env, file);
  const fundText = option(args, '--fund');
  const fundWei = fundText === undefined ? 0n : parseAmount(fundText, settings.symbol);
  const { symbol } = settings;
  const say = (line: string) => process.stdout.write(`deploy-chain: ${line}\n`);

  const table = loadTuning();
  if (table.fixture === true || !table.calibration.calibrated) {
    throw new Error('the production table is a fixture or is not calibrated; a public chain gets a calibrated table only');
  }
  if ((env.MAZEBET_ADDRESS ?? '') !== '' && !args.includes('--redeploy')) {
    throw new Error(
      `${file} already names the contract ${env.MAZEBET_ADDRESS}. Pass --redeploy to deploy a new one; the ` +
        'old one keeps its house funds until the owner withdraws them, and the server needs a fresh data directory',
    );
  }
  const ownerKey = requireValue(env, 'DEPLOYER_PRIVATE_KEY', file) as Hex;
  const owner = privateKeyToAccount(ownerKey);
  const serverSigner = privateKeyToAccount(requireValue(env, 'SERVER_SIGNER_PRIVATE_KEY', file) as Hex).address;
  await assertChain(settings);

  const publicClient = publicClientOf(settings);
  const bytecode = readBytecode();
  const ctorArgs = constructorArgs(table, owner.address, serverSigner);
  // Monad charges the gas limit, so the deployment is sent with exactly the estimate.
  const gas = await publicClient.estimateGas({
    account: owner,
    data: encodeDeployData({ abi: mazeBetAbi, bytecode, args: ctorArgs }),
  });
  const { maxFeePerGas } = await publicClient.estimateFeesPerGas();
  const needed = (gas + (fundWei > 0n ? FUND_GAS_ALLOWANCE : 0n)) * maxFeePerGas + fundWei;
  const balance = await publicClient.getBalance({ address: owner.address });
  if (balance < needed) {
    throw new Error(
      `the deployer ${owner.address} holds ${formatEther(balance)} ${symbol} and needs up to ` +
        `${formatEther(needed)} ${symbol} (deploy gas ${gas} at ${formatEther(maxFeePerGas, 'gwei')} gwei` +
        `${fundWei > 0n ? ` plus ${formatEther(fundWei)} ${symbol} to fund` : ''})`,
    );
  }

  say(`deploying MazeBet to ${settings.chainName} (chain ${settings.chainId}) from ${owner.address}`);
  const deployTxHash = await walletOf(settings, ownerKey).deployContract({
    abi: mazeBetAbi,
    bytecode,
    args: ctorArgs,
    gas,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTxHash, timeout: WAIT_MS });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`the deployment transaction ${deployTxHash} failed`);
  }
  const address = getAddress(receipt.contractAddress);

  const contract = { address, abi: mazeBetAbi } as const;
  const [onchainHash, onchainOwner, onchainSigner] = await Promise.all([
    publicClient.readContract({ ...contract, functionName: 'tableHash' }),
    publicClient.readContract({ ...contract, functionName: 'owner' }),
    publicClient.readContract({ ...contract, functionName: 'serverSigner' }),
  ]);
  const expected = tableHash(table);
  if (onchainHash.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`deployed tableHash ${onchainHash} differs from the table's ${expected}`);
  }
  if (onchainOwner.toLowerCase() !== owner.address.toLowerCase() || onchainSigner.toLowerCase() !== serverSigner.toLowerCase()) {
    throw new Error(`the deployed contract has owner ${onchainOwner} and serverSigner ${onchainSigner}`);
  }

  const record = deploymentFile(settings);
  const previous = env.MAZEBET_ADDRESS ?? '';
  const previousRecord = readDeployment(record);
  if (previousRecord !== null && previousRecord.mazeBetAddress.toLowerCase() !== address.toLowerCase()) {
    const archive = record.replace(/\.json$/, `-${previousRecord.mazeBetAddress}.json`);
    renameSync(record, archive);
    say(`kept the record of the previous contract as ${shown(archive)}`);
  }
  const deployBlock = receipt.blockNumber;
  writeChainDeployment(record, {
    chainId: settings.chainId,
    chainName: settings.chainName,
    mazeBetAddress: address,
    deployBlock: Number(deployBlock),
    deployTxHash,
    owner: owner.address,
    serverSigner,
    tableHash: expected,
    tableVersion: table.tableVersion,
    constructorArgs: encodeConstructorArgs(table, owner.address, serverSigner),
    deployedAt: new Date().toISOString(),
    fundings: [],
    fundedWei: '0',
  });
  updateEnvFile(file, {
    MAZEBET_ADDRESS: address,
    ...((env.MAZE_START_BLOCK ?? '') === '' ? {} : { MAZE_START_BLOCK: '' }),
  });
  say(`MazeBet ${address} deployed in block ${deployBlock} (tx ${deployTxHash})`);
  say(`tableHash ${expected} matches the production table; owner ${owner.address}, serverSigner ${serverSigner}`);
  say(`wrote ${shown(record)}; set MAZEBET_ADDRESS in ${shown(file)}`);
  if (previous !== '') {
    say(
      `the previous contract ${previous} keeps its house funds; take them out with ` +
        `"pnpm monad:withdraw-house all --contract ${previous}". The server needs a fresh data directory`,
    );
  }

  if (fundWei > 0n) {
    say(`funding ${formatEther(fundWei)} ${symbol} once the chain is at block ${deployBlock + RESERVE_GAP_BLOCKS}`);
    const funding = await fundHouse({
      settings,
      ownerKey,
      contract: address,
      amountWei: fundWei,
      notBeforeBlock: deployBlock + RESERVE_GAP_BLOCKS,
    });
    recordFunding(record, address, { ...funding, amountWei: fundWei });
    const liquidity = await publicClient.readContract({ ...contract, functionName: 'availableLiquidity' });
    say(`funded in block ${funding.blockNumber} (tx ${funding.txHash}); available liquidity ${formatEther(liquidity)} ${symbol}`);
  } else {
    say('not funded: run "pnpm monad:fund <amount>" before taking bets');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`deploy-chain: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
