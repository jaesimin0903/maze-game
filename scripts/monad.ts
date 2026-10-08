// Operations on the deployed MazeBet of `.env.monad` (docs/deploy-monad.md).
//
//   pnpm monad:fund <amount>    deposits <amount> of the deployer's MON as house liquidity
//   pnpm monad:withdraw-house <amount|all> [--contract <address>]
//                               pays house liquidity back to the deployer (the owner); --contract
//                               names an earlier deployment, as `monad:deploy --redeploy` prints
//   pnpm monad:status           balances, liquidity, how many games it covers, relayer runway
//   pnpm monad:verify [--only sourcify|etherscan]
//                               source verification on MonadVision (Sourcify, no key) and on
//                               Monadscan (needs ETHERSCAN_API_KEY in the env file or environment)
//   pnpm monad:server-env [--out <path>]
//                               writes .env.monad.server: the server's variables only, without
//                               the deployer key and without comment lines, for
//                               `docker run --env-file` or `fly secrets import`. Refuses a
//                               PRIVY_APP_ID that is not 25 characters long
//
// Every command takes --env <path> (default `.env.monad`). No private key is printed.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadTuning, mazeBetAbi, tableHash, type Hex } from '@maze/shared';
import { formatEther, formatGwei, getAddress, isAddress, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SETTLE_GAS_LIMIT } from '../apps/web/src/server/chain';
import { loadConfig } from '../apps/web/src/server/config';
import {
  assertChain,
  chainSettings,
  deploymentFile,
  encodeConstructorArgs,
  fundHouse,
  parseAmount,
  publicClientOf,
  readDeployment,
  recordFunding,
  walletOf,
  type ChainSettings,
} from './deploy-chain';
import {
  envFileOption,
  option,
  readEnvFile,
  requireValue,
  ROOT,
  shown,
  writeSecretFile,
  type EnvValues,
} from './env-file';
import { addresses } from './monad-keys';

/** MonadVision's Sourcify endpoint (docs.monad.xyz, "Verify a contract"). */
const SOURCIFY_URL = 'https://sourcify-api-monad.blockvision.org/';
/** Monad's reserve balance: the gas of the transactions in flight may not exceed min(this, balance). */
const RESERVE_BALANCE_WEI = parseEther('10');

/** Every variable the server reads (apps/web/src/server/config.ts), and nothing else. */
const SERVER_VARIABLES = [
  'RPC_URL',
  'PUBLIC_RPC_URL',
  'CHAIN_ID',
  'CHAIN_NAME',
  'NATIVE_SYMBOL',
  'EXPLORER_URL',
  'FAUCET_URL',
  'MAZEBET_ADDRESS',
  'MAZE_SCAN_TAG',
  'MAZE_START_BLOCK',
  'MAZE_LOG_CHUNK_BLOCKS',
  'SERVER_SIGNER_PRIVATE_KEY',
  'RELAYER_PRIVATE_KEY',
  'MAZE_DATA_DIR',
  'MAZE_IDLE_TIMEOUT_SEC',
  'MAZE_MAX_GAME_SEC',
  'PRIVY_APP_ID',
] as const;

interface Context {
  file: string;
  env: EnvValues;
  settings: ChainSettings;
}

function say(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** At most six decimals, cut rather than rounded. */
function amount(wei: bigint, symbol: string): string {
  const [whole, fraction = ''] = formatEther(wei).split('.');
  const kept = fraction.slice(0, 6).replace(/0+$/, '');
  return `${whole}${kept === '' ? '' : `.${kept}`} ${symbol}`;
}

/** `--contract <address>`, or MAZEBET_ADDRESS of the env file. */
function contractOf(ctx: Context, args: readonly string[] = []): Hex {
  const given = option(args, '--contract');
  const value = given ?? requireValue(ctx.env, 'MAZEBET_ADDRESS', ctx.file);
  if (!isAddress(value, { strict: false })) {
    throw new Error(given === undefined ? `MAZEBET_ADDRESS in ${ctx.file} is not an address` : '--contract is not an address');
  }
  return getAddress(value);
}

async function fund(ctx: Context, args: string[]): Promise<void> {
  const amountWei = parseAmount(args[0], ctx.settings.symbol);
  const contract = contractOf(ctx);
  await assertChain(ctx.settings);
  const funding = await fundHouse({
    settings: ctx.settings,
    ownerKey: requireValue(ctx.env, 'DEPLOYER_PRIVATE_KEY', ctx.file) as Hex,
    contract,
    amountWei,
  });
  recordFunding(deploymentFile(ctx.settings), contract, { ...funding, amountWei });
  const liquidity = await publicClientOf(ctx.settings).readContract({
    address: contract,
    abi: mazeBetAbi,
    functionName: 'availableLiquidity',
  });
  say(`monad:fund: deposited ${amount(amountWei, ctx.settings.symbol)} in block ${funding.blockNumber} (tx ${funding.txHash})`);
  say(`monad:fund: available liquidity ${amount(liquidity, ctx.settings.symbol)}`);
}

async function withdrawHouse(ctx: Context, positional: readonly string[], args: readonly string[]): Promise<void> {
  const { settings } = ctx;
  const contract = contractOf(ctx, args);
  const ownerKey = requireValue(ctx.env, 'DEPLOYER_PRIVATE_KEY', ctx.file) as Hex;
  const owner = privateKeyToAccount(ownerKey).address;
  await assertChain(settings);
  const client = publicClientOf(settings);
  const read = { address: contract, abi: mazeBetAbi } as const;
  const [onchainOwner, available] = await Promise.all([
    client.readContract({ ...read, functionName: 'owner' }),
    client.readContract({ ...read, functionName: 'availableLiquidity' }),
  ]);
  if (onchainOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`the owner of ${contract} is ${onchainOwner}, not the address of DEPLOYER_PRIVATE_KEY`);
  }
  // Money reserved for Active games and pending player payments is not the house's to take.
  const amountWei = positional[0] === 'all' ? available : parseAmount(positional[0], settings.symbol);
  if (amountWei === 0n) throw new Error(`${contract} has no available liquidity to withdraw`);
  if (amountWei > available) {
    throw new Error(`only ${amount(available, settings.symbol)} of ${contract} is available (the rest is reserved for games)`);
  }
  const txHash = await walletOf(settings, ownerKey).writeContract({
    ...read,
    functionName: 'withdrawHouse',
    args: [amountWei, owner],
  });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`the withdrawal ${txHash} reverted`);
  say(`monad:withdraw-house: paid ${amount(amountWei, settings.symbol)} from ${contract} to ${owner} in block ${receipt.blockNumber} (tx ${txHash})`);
}

async function status(ctx: Context): Promise<void> {
  const { settings } = ctx;
  const { symbol } = settings;
  const contract = contractOf(ctx);
  const accounts = addresses(ctx.env, ctx.file);
  await assertChain(settings);
  const client = publicClientOf(settings);
  const read = { address: contract, abi: mazeBetAbi } as const;
  if ((await client.getCode({ address: contract })) === undefined) {
    throw new Error(`there is no contract at ${contract} on ${settings.chainName}`);
  }

  const [head, gasPrice, deployer, relayer, signer, balance] = await Promise.all([
    client.getBlockNumber(),
    client.getGasPrice(),
    client.getBalance({ address: accounts.DEPLOYER_PRIVATE_KEY }),
    client.getBalance({ address: accounts.RELAYER_PRIVATE_KEY }),
    client.getBalance({ address: accounts.SERVER_SIGNER_PRIVATE_KEY }),
    client.getBalance({ address: contract }),
  ]);
  const [available, reserved, pending, onchainSigner, onchainOwner, onchainHash, minBet, maxBet, tierCount] =
    await Promise.all([
      client.readContract({ ...read, functionName: 'availableLiquidity' }),
      client.readContract({ ...read, functionName: 'totalReserved' }),
      client.readContract({ ...read, functionName: 'totalPending' }),
      client.readContract({ ...read, functionName: 'serverSigner' }),
      client.readContract({ ...read, functionName: 'owner' }),
      client.readContract({ ...read, functionName: 'tableHash' }),
      client.readContract({ ...read, functionName: 'minBet' }),
      client.readContract({ ...read, functionName: 'maxBet' }),
      client.readContract({ ...read, functionName: 'tierCount' }),
    ]);
  const tiers = await Promise.all(
    Array.from({ length: tierCount }, (_, tier) => client.readContract({ ...read, functionName: 'tiers', args: [tier] })),
  );

  const settleWei = SETTLE_GAS_LIMIT * gasPrice;
  say(`${settings.chainName} (chain ${settings.chainId}), block ${head}`);
  say(`MazeBet ${contract}`);
  say();
  say('accounts');
  say(`  deployer       ${accounts.DEPLOYER_PRIVATE_KEY}  ${amount(deployer, symbol)}`);
  say(
    `  relayer        ${accounts.RELAYER_PRIVATE_KEY}  ${amount(relayer, symbol)}: ` +
      `${relayer / settleWei} settles at ${amount(settleWei, symbol)} each ` +
      `(${SETTLE_GAS_LIMIT} gas at ${formatGwei(gasPrice)} gwei, the full limit is charged)`,
  );
  say(`  server signer  ${accounts.SERVER_SIGNER_PRIVATE_KEY}  ${amount(signer, symbol)} (sends nothing, needs none)`);
  say();
  say('house');
  say(`  contract balance      ${amount(balance, symbol)}`);
  say(`  reserved for games    ${amount(reserved, symbol)} (games that are Active now)`);
  say(`  pending withdrawals   ${amount(pending, symbol)}`);
  say(`  available liquidity   ${amount(available, symbol)}`);
  say();

  // Every game reserves max(bet, bet x multiplier) until it is settled or reclaimed.
  const bets = [...new Set([minBet, parseEther('0.01'), maxBet])]
    .filter((bet) => bet >= minBet && bet <= maxBet)
    .sort((a, b) => (a < b ? -1 : 1));
  say('games the available liquidity covers at once, per bet and tier');
  say(`  ${'bet'.padEnd(18)}${tiers.map(([n, bps]) => `${n}x${n} (x${(bps / 10_000).toFixed(4)})`.padEnd(20)).join('')}`);
  for (const bet of bets) {
    const cells = tiers.map(([, bps]) => {
      const payout = (bet * BigInt(bps)) / 10_000n;
      return String(available / (payout > bet ? payout : bet)).padEnd(20);
    });
    say(`  ${amount(bet, symbol).padEnd(18)}${cells.join('')}`);
  }
  say();

  const problems: string[] = [];
  if (onchainSigner.toLowerCase() !== accounts.SERVER_SIGNER_PRIVATE_KEY.toLowerCase()) {
    problems.push(`the contract trusts signer ${onchainSigner}, not the address of SERVER_SIGNER_PRIVATE_KEY`);
  }
  if (onchainOwner.toLowerCase() !== accounts.DEPLOYER_PRIVATE_KEY.toLowerCase()) {
    problems.push(`the contract's owner is ${onchainOwner}, not the address of DEPLOYER_PRIVATE_KEY`);
  }
  if (onchainHash.toLowerCase() !== tableHash(loadTuning()).toLowerCase()) {
    problems.push(`the contract's tableHash ${onchainHash} is not the production table's: the server will refuse to boot`);
  }
  if (relayer < 50n * settleWei) problems.push(`the relayer can pay for fewer than 50 settles: send it ${symbol}`);
  const inflight = (relayer < RESERVE_BALANCE_WEI ? relayer : RESERVE_BALANCE_WEI) / settleWei;
  if (inflight < 20n) problems.push(`the relayer can have only ${inflight} settles in flight at once (Monad reserve balance)`);
  const [lastN, lastBps] = tiers[tiers.length - 1];
  if (available < (maxBet * BigInt(lastBps)) / 10_000n) {
    problems.push(`the liquidity does not cover one maximum bet on ${lastN}x${lastN}; such bets are refused`);
  }
  if (problems.length === 0) say('ok: signer, owner and table match; the relayer and the house are funded');
  for (const problem of problems) say(`warning: ${problem}`);
}

function verify(ctx: Context, args: string[]): void {
  const only = option(args, '--only');
  if (only !== undefined && only !== 'sourcify' && only !== 'etherscan') throw new Error('--only takes sourcify or etherscan');
  if (ctx.settings.chainId !== 10143) throw new Error('monad:verify knows the verifiers of Monad Testnet (chain 10143) only');
  const contract = contractOf(ctx);
  const deployment = readDeployment(deploymentFile(ctx.settings));
  let ctorArgs: Hex;
  if (deployment !== null && deployment.mazeBetAddress.toLowerCase() === contract.toLowerCase()) {
    ctorArgs = deployment.constructorArgs;
  } else {
    const accounts = addresses(ctx.env, ctx.file);
    ctorArgs = encodeConstructorArgs(loadTuning(), accounts.DEPLOYER_PRIVATE_KEY, accounts.SERVER_SIGNER_PRIVATE_KEY);
  }
  // Compiler settings (solc, optimizer, via_ir, evm version) come from contracts/foundry.toml, the
  // file the deployed bytecode was built with.
  const common = [
    'verify-contract',
    contract,
    'src/MazeBet.sol:MazeBet',
    '--root',
    path.join(ROOT, 'contracts'),
    '--chain',
    String(ctx.settings.chainId),
    '--constructor-args',
    ctorArgs,
  ];
  const apiKey = ctx.env.ETHERSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '';
  let failed = false;
  if (only !== 'etherscan') {
    say('monad:verify: MonadVision (Sourcify)');
    const run = spawnSync('forge', [...common, '--verifier', 'sourcify', '--verifier-url', SOURCIFY_URL], { stdio: 'inherit' });
    failed ||= run.status !== 0;
  }
  if (only !== 'sourcify') {
    if (apiKey === '') {
      say('monad:verify: Monadscan skipped: set ETHERSCAN_API_KEY (an Etherscan API V2 key) in the env file');
      failed ||= only === 'etherscan';
    } else {
      say('monad:verify: Monadscan (Etherscan)');
      // The key reaches forge through its environment, never its command line.
      const run = spawnSync('forge', [...common, '--verifier', 'etherscan', '--watch'], {
        stdio: 'inherit',
        env: { ...process.env, ETHERSCAN_API_KEY: apiKey },
      });
      failed ||= run.status !== 0;
    }
  }
  if (failed) throw new Error('verification did not succeed (see above)');
}

function serverEnv(ctx: Context, args: string[]): void {
  const given = option(args, '--out');
  const out = given === undefined ? path.join(ROOT, '.env.monad.server') : path.resolve(process.env.INIT_CWD ?? process.cwd(), given);
  const values: EnvValues = {};
  for (const name of SERVER_VARIABLES) {
    const value = ctx.env[name];
    if (value !== undefined && value !== '') values[name] = value;
  }
  // The server's own parser: what it would refuse at boot is refused here.
  loadConfig(values);
  // The server accepts any well-formed id so that a typo cannot stop it, but the browser's Privy
  // SDK takes exactly 25 characters and offers no login otherwise.
  const privyAppId = values.PRIVY_APP_ID;
  if (privyAppId !== undefined && privyAppId.length !== 25) {
    throw new Error(`PRIVY_APP_ID in ${ctx.file} has ${privyAppId.length} characters; a Privy app id has 25`);
  }
  if (privyAppId === undefined) say('monad:server-env: warning: PRIVY_APP_ID is not set, so the browser offers no Privy login');
  // No comment lines: every line of this file is a variable, whatever reads it.
  writeSecretFile(out, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(''));
  say(`monad:server-env: wrote ${shown(out)} (mode 600): ${Object.keys(values).join(', ')}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== '--');
  const file = envFileOption(rest);
  const env = readEnvFile(file);
  const ctx: Context = { file, env, settings: chainSettings(env, file) };
  const positional = rest.filter((arg, i) => !arg.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));
  if (command === 'fund') await fund(ctx, positional);
  else if (command === 'withdraw-house') await withdrawHouse(ctx, positional, rest);
  else if (command === 'status') await status(ctx);
  else if (command === 'verify') verify(ctx, rest);
  else if (command === 'server-env') serverEnv(ctx, rest);
  else {
    throw new Error(
      'usage: tsx scripts/monad.ts fund <amount> | withdraw-house <amount|all> | status | verify | server-env [--env <path>]',
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`monad: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
