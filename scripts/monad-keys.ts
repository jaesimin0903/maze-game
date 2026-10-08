// Creates `.env.monad`: three fresh private keys and the Monad Testnet settings
// (docs/deploy-monad.md).
//
//   pnpm monad:keys [--env <path>]
//
// The file is created only when it does not exist, with mode 600. An existing file is never
// overwritten; its addresses are printed again. No private key is ever printed.
//
// The three accounts:
//   DEPLOYER_PRIVATE_KEY       owner of MazeBet and the house account: deploys the contract and
//                              deposits the bankroll. Never given to the server.
//   SERVER_SIGNER_PRIVATE_KEY  signs tickets and settlements; the contract trusts its address.
//                              Sends no transaction and needs no MON.
//   RELAYER_PRIVATE_KEY        sends the `settle` transactions and pays their gas.
//
// MAZEBET_ADDRESS stays empty here; `pnpm monad:deploy` fills it in.

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Hex } from '@maze/shared';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { envFileOption, readEnvFile, requireValue, shown, writeSecretFile, type EnvValues } from './env-file';

/** Monad Testnet (docs.monad.xyz, "Network information"). */
const MONAD_TESTNET = {
  RPC_URL: 'https://testnet-rpc.monad.xyz',
  CHAIN_ID: '10143',
  CHAIN_NAME: 'Monad Testnet',
  NATIVE_SYMBOL: 'MON',
  EXPLORER_URL: 'https://testnet.monadvision.com',
  FAUCET_URL: 'https://faucet.monad.xyz',
  // The public RPC answers eth_getLogs for at most 100 blocks.
  MAZE_LOG_CHUNK_BLOCKS: '100',
} as const;

export const ACCOUNTS = [
  { key: 'DEPLOYER_PRIVATE_KEY', label: 'deployer', role: 'owner and house: deploy gas plus the bankroll' },
  { key: 'SERVER_SIGNER_PRIVATE_KEY', label: 'server signer', role: 'signs tickets and settlements: needs no MON' },
  { key: 'RELAYER_PRIVATE_KEY', label: 'relayer', role: 'sends settle transactions: needs MON for gas' },
] as const;

export type AccountKey = (typeof ACCOUNTS)[number]['key'];

/** The address of each account key in `env`. */
export function addresses(env: EnvValues, file: string): Record<AccountKey, Hex> {
  const result = {} as Record<AccountKey, Hex>;
  for (const { key } of ACCOUNTS) {
    const value = requireValue(env, key, file);
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${key} in ${file} is not 32 bytes of 0x-prefixed hex`);
    result[key] = privateKeyToAccount(value as Hex).address;
  }
  return result;
}

function template(keys: Record<AccountKey, Hex>): string {
  const settings = Object.entries(MONAD_TESTNET).map(([name, value]) => `${name}=${value}`);
  return [
    `# Monad Testnet settings of the maze game, written by "pnpm monad:keys" on ${new Date().toISOString().slice(0, 10)}.`,
    '# Holds private keys: never commit, paste or upload this file. See docs/deploy-monad.md.',
    '',
    '# Owner of MazeBet and the house account. Used by the monad:* scripts only, never by the server.',
    `DEPLOYER_PRIVATE_KEY=${keys.DEPLOYER_PRIVATE_KEY}`,
    '# Signs tickets and settlements; the contract trusts its address. Needs no MON.',
    `SERVER_SIGNER_PRIVATE_KEY=${keys.SERVER_SIGNER_PRIVATE_KEY}`,
    '# Sends the settle transactions. Needs MON for gas.',
    `RELAYER_PRIVATE_KEY=${keys.RELAYER_PRIVATE_KEY}`,
    '',
    ...settings,
    '# Set by "pnpm monad:deploy".',
    'MAZEBET_ADDRESS=',
    '# The event log directory inside the container: mount a persistent volume there.',
    'MAZE_DATA_DIR=/data',
    '# App id from dashboard.privy.io. Empty: the browser offers no Privy login.',
    'PRIVY_APP_ID=',
    '',
  ].join('\n');
}

function printAccounts(env: EnvValues, file: string): void {
  const byKey = addresses(env, file);
  for (const account of ACCOUNTS) {
    process.stdout.write(`  ${account.label.padEnd(14)} ${byKey[account.key]}  ${account.role}\n`);
  }
}

function main(): void {
  const file = envFileOption(process.argv.slice(2));
  if (existsSync(file)) {
    process.stdout.write(`monad:keys: ${shown(file)} exists and was left unchanged. Its accounts:\n`);
    printAccounts(readEnvFile(file), file);
    return;
  }
  const keys = {
    DEPLOYER_PRIVATE_KEY: generatePrivateKey(),
    SERVER_SIGNER_PRIVATE_KEY: generatePrivateKey(),
    RELAYER_PRIVATE_KEY: generatePrivateKey(),
  };
  // Never replaces a file that appeared in the meantime, and never leaves a half-written one.
  writeSecretFile(file, template(keys), { create: true });
  process.stdout.write(`monad:keys: wrote ${shown(file)} (mode 600). Its accounts:\n`);
  printAccounts(readEnvFile(file), file);
  process.stdout.write(
    `Fund the deployer and the relayer at ${MONAD_TESTNET.FAUCET_URL}, then run ` +
      '"pnpm monad:deploy --fund <MON>" (amounts: docs/deploy-monad.md).\n',
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`monad:keys: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
