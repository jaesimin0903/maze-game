// Settings of the agent player: its wallet key, the game server it plays on and its spending
// limits. They come from `.env.agent` at the repository root (git-ignored, mode 600, written by
// `pnpm agent:wallet`), and the process environment overrides the file.
//
//   MAZE_AGENT_KEY         the agent wallet's private key
//   MAZE_AGENT_SERVER      game server URL (default http://127.0.0.1:3000, the `pnpm dev:up` app)
//   MAZE_AGENT_BUDGET      most the agent may bet in total per session, in the native currency
//   MAZE_AGENT_MAX_BET     most the agent may bet on one game, in the native currency
//   MAZE_AGENT_RPC_URL     RPC to send transactions through (default: the one the server names)
//   MAZE_AGENT_DATA_DIR    where the active game and the game history are kept

import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseEther } from 'viem';
import type { Hex } from '@maze/shared';
import { ROOT, readEnvFile, type EnvValues } from '../../../scripts/env-file';

export const AGENT_ENV_FILE = path.join(ROOT, '.env.agent');
export const DEFAULT_SERVER = 'http://127.0.0.1:3000';

export interface AgentSettings {
  key: Hex;
  serverUrl: string;
  budgetWei: bigint | null;
  maxBetWei: bigint | null;
  rpcUrl: string | null;
  dataDir: string;
}

const KEY = /^0x[0-9a-fA-F]{64}$/;

export function agentEnvFile(): string {
  return process.env.MAZE_AGENT_ENV ?? AGENT_ENV_FILE;
}

export function readAgentEnv(file = agentEnvFile()): EnvValues {
  const fromFile = existsSync(file) ? readEnvFile(file) : {};
  const fromProcess: EnvValues = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('MAZE_AGENT_') && value !== undefined && value !== '') fromProcess[name] = value;
  }
  return { ...fromFile, ...fromProcess };
}

function amount(env: EnvValues, name: string): bigint | null {
  const value = env[name];
  if (value === undefined || value === '') return null;
  try {
    return parseEther(value);
  } catch {
    throw new Error(`${name} must be an amount such as 0.5, not "${value}"`);
  }
}

export function loadSettings(env: EnvValues = readAgentEnv()): AgentSettings {
  const key = env.MAZE_AGENT_KEY;
  if (key === undefined || !KEY.test(key)) {
    throw new Error('MAZE_AGENT_KEY is missing; run "pnpm agent:wallet" to create the agent wallet');
  }
  return {
    key: key as Hex,
    serverUrl: (env.MAZE_AGENT_SERVER ?? DEFAULT_SERVER).replace(/\/+$/, ''),
    budgetWei: amount(env, 'MAZE_AGENT_BUDGET'),
    maxBetWei: amount(env, 'MAZE_AGENT_MAX_BET'),
    rpcUrl: env.MAZE_AGENT_RPC_URL ?? null,
    dataDir: env.MAZE_AGENT_DATA_DIR ?? path.join(ROOT, '.data', 'agent'),
  };
}
