// pnpm agent:wallet [--server <url>] [--fund-local <amount>]
//
// Creates the agent wallet in `.env.agent` when there is none (mode 600, never overwritten), then
// prints its address and its balance on the chain the game server names. `--fund-local` sets that
// balance on a local Anvil (the `pnpm dev:up` stack); on any other chain, fund the address from
// the faucet the output names.

import { existsSync } from 'node:fs';
import { createPublicClient, createTestClient, formatEther, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { ConfigResponse } from '@maze/shared';
import { option, shown, writeSecretFile } from '../../../scripts/env-file';
import { agentEnvFile, DEFAULT_SERVER, loadSettings, readAgentEnv } from './settings';

const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = agentEnvFile();
  if (!existsSync(file)) {
    const content = [
      `# The maze agent's wallet, written by "pnpm agent:wallet" on ${new Date().toISOString().slice(0, 10)}.`,
      '# This file holds the only copy of the key. Fund it with test currency only.',
      `MAZE_AGENT_KEY=${generatePrivateKey()}`,
      `MAZE_AGENT_SERVER=${option(args, '--server') ?? DEFAULT_SERVER}`,
      '# Most the agent may bet in total per session, and on one game.',
      'MAZE_AGENT_BUDGET=0.5',
      'MAZE_AGENT_MAX_BET=0.1',
      '',
    ].join('\n');
    writeSecretFile(file, content, { create: true });
    process.stdout.write(`agent:wallet: wrote ${shown(file)} (mode 600)\n`);
  }

  const settings = loadSettings(readAgentEnv(file));
  const address = privateKeyToAccount(settings.key).address;
  process.stdout.write(`address   ${address}\nserver    ${settings.serverUrl}\n`);

  let config: ConfigResponse;
  try {
    const response = await fetch(`${settings.serverUrl}/api/config`);
    if (!response.ok) throw new Error(`answered ${response.status}`);
    config = (await response.json()) as ConfigResponse;
  } catch (error) {
    process.stdout.write(
      `The game server did not answer (${error instanceof Error ? error.message : String(error)}). ` +
        'Start it (pnpm dev:up) or set MAZE_AGENT_SERVER, then run this again for the balance.\n',
    );
    return;
  }
  const rpcUrl = settings.rpcUrl ?? config.rpcUrl;
  const symbol = config.network?.symbol ?? 'ETH';

  const fund = option(args, '--fund-local');
  if (fund !== undefined) {
    if (!LOCAL_RPC.test(rpcUrl)) throw new Error(`--fund-local works only on a local Anvil, not on ${rpcUrl}`);
    await createTestClient({ mode: 'anvil', transport: http(rpcUrl) }).setBalance({ address, value: parseEther(fund) });
  }

  const balance = await createPublicClient({ transport: http(rpcUrl) }).getBalance({ address });
  process.stdout.write(`network   ${config.network?.name ?? `chain ${config.chainId}`}\n`);
  process.stdout.write(`balance   ${formatEther(balance)} ${symbol}\n`);
  const limit = (wei: bigint | null): string => (wei === null ? 'none' : `${formatEther(wei)} ${symbol}`);
  process.stdout.write(`budget    ${limit(settings.budgetWei)} per session, ${limit(settings.maxBetWei)} per game\n`);
  if (balance === 0n && config.network?.faucetUrl) {
    process.stdout.write(`Fund the address from ${config.network.faucetUrl}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`agent:wallet: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
