// MCP server (stdio) that lets an AI agent play the maze with its own wallet: `pnpm agent:mcp`.
//
// Every new game pays its bet on chain from the agent wallet (`.env.agent`), and the server pays
// the result back to the same wallet. The spending limits of `settings.ts` are checked before any
// bet is sent.
//
// The protocol is newline-delimited JSON-RPC 2.0 on stdin/stdout, and this server needs only
// `initialize`, `ping`, `tools/list` and `tools/call` of it, so it is written out here rather
// than pulling in the SDK. stdout carries the protocol: nothing else may be written to it.

import { createInterface } from 'node:readline';
import { parseEther } from 'viem';
import type { GameView, StartSide } from '@maze/shared';
import { DIR_NAMES, dirOf, type Advice, type DirName } from './advise';
import { AgentClient, type FinishedGame } from './client';
import { loadSettings } from './settings';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'maze-agent', version: '0.1.0' };

const RULES = [
  'A maze betting game. You play with your own wallet: maze_new_game pays the bet on chain, and the',
  'game server pays the result back to the same wallet on chain.',
  'Rules: you start on the top-left cell (0, 0); the exit is the bottom-right cell (n-1, n-1). Each move',
  'goes one cell through an open side (N, E, S, W; y grows southward) into a cell you have not visited,',
  'so you can never go back. Reaching the exit pays bet × multiplier. Reaching a cell with no way',
  'forward loses the bet. Before any move you may cash out for a refund that shrinks with every move.',
  'You only see the walls of cells you have stood on. Every position lists, for each way forward, the',
  'exact probability that the exit lies beyond it, computed from the walls seen so far; their sum is',
  'the probability that the exit can still be reached at all. A game left without a move for too long',
  'is cashed out by the server.',
].join(' ');

// ----- the agent -----

let connecting: Promise<AgentClient> | null = null;

function agent(): Promise<AgentClient> {
  connecting ??= AgentClient.connect(loadSettings()).catch((error: unknown) => {
    connecting = null;
    throw error;
  });
  return connecting;
}

function round(p: number): number {
  return Math.round(p * 10_000) / 10_000;
}

function position(a: AgentClient, view: GameView, advice: Advice) {
  return {
    gameId: view.gameId,
    board: `${view.n}×${view.n}`,
    status: view.status,
    movesMade: view.step,
    at: view.cell,
    exitAt: { x: view.n - 1, y: view.n - 1 },
    waysForward: advice.options.map((o) => ({ dir: o.dir, exitProbability: round(o.exitProbability) })),
    exitStillReachable: round(advice.reachable),
    cashOutNowPays: a.amount(view.refundableWei),
    exitPays: a.amount(view.exitPayoutWei),
    secondsUntilIdleCashOut: Math.max(0, view.idleDeadlineSec - view.chainNowSec),
  };
}

function result(a: AgentClient, game: FinishedGame) {
  return {
    gameId: game.gameId,
    outcome: game.outcome,
    movesMade: game.steps,
    bet: a.amount(game.betWei),
    paidBack: a.amount(game.payoutWei),
    net: a.amount(BigInt(game.payoutWei) - BigInt(game.betWei)),
    betTx: a.txUrl(game.createTxHash) ?? game.createTxHash,
    payoutTx: game.settleTxHash === null ? 'pending' : (a.txUrl(game.settleTxHash) ?? game.settleTxHash),
  };
}

/** The position after a move, or the settled result once the game has ended. */
async function after(a: AgentClient, view: GameView) {
  if (view.status !== 'active') return { ended: true, ...result(a, await a.finish()) };
  return { ended: false, ...position(a, view, await a.advice()) };
}

// ----- tools -----

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run(a: AgentClient, args: Args): Promise<unknown>;
}

function argument<T>(args: Args, name: string, check: (value: unknown) => value is T, expected: string): T {
  const value = args[name];
  if (!check(value)) throw new Error(`${name} must be ${expected}`);
  return value;
}

const isInteger = (value: unknown): value is number => Number.isInteger(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isDir = (value: unknown): value is DirName => DIR_NAMES.includes(value as DirName);
const isSide = (value: unknown): value is StartSide | undefined => value === undefined || value === 'E' || value === 'S';

const NO_INPUT = { type: 'object', properties: {} } as const;

const TOOLS: Tool[] = [
  {
    name: 'maze_wallet',
    title: 'Agent wallet',
    description:
      'The agent wallet: address, network, balance, spending limits, the boards with their multipliers, and any game in progress.',
    inputSchema: NO_INPUT,
    async run(a) {
      const { config, settings } = a;
      return {
        address: a.address,
        network: a.chain.name,
        balance: a.amount(await a.balance()),
        betRange: `${a.amount(config.minBetWei)} to ${a.amount(config.maxBetWei)}`,
        limits: {
          perGame: settings.maxBetWei === null ? 'none' : a.amount(settings.maxBetWei),
          sessionBudget: settings.budgetWei === null ? 'none' : a.amount(settings.budgetWei),
          budgetLeft: a.budgetLeftWei === null ? 'unlimited' : a.amount(a.budgetLeftWei),
        },
        boards: config.tiers.map((tier) => ({
          size: tier.n,
          multiplier: tier.multiplierBps / 10_000,
          cashOutBeforeFirstMove: `${tier.refundBps[0] / 100}% of the bet`,
        })),
        idleCashOutAfterSeconds: config.idleTimeoutSec,
        gameInProgress: a.active?.gameId ?? null,
        ...(a.resumeError === null ? {} : { warning: `the game in progress could not be picked up: ${a.resumeError}` }),
      };
    },
  },
  {
    name: 'maze_new_game',
    title: 'Pay a bet and start a game',
    description:
      'Pays the bet on chain from the agent wallet and starts a game. Returns the bet transaction and the first position.',
    inputSchema: {
      type: 'object',
      properties: {
        size: { type: 'integer', description: 'Board size: one of the sizes maze_wallet lists, e.g. 5' },
        bet: { type: 'string', description: 'Bet in the native currency, e.g. "0.01"' },
        startSide: { type: 'string', enum: ['E', 'S'], description: 'Side the start cell opens to; random when left out' },
      },
      required: ['size', 'bet'],
    },
    async run(a, args) {
      const size = argument(args, 'size', isInteger, 'a whole number such as 5');
      const bet = argument(args, 'bet', isString, 'an amount such as "0.01"');
      const side = argument(args, 'startSide', isSide, '"E" or "S"');
      let betWei: bigint;
      try {
        betWei = parseEther(bet);
      } catch {
        throw new Error(`bet must be an amount such as "0.01", not "${bet}"`);
      }
      const { view, createTxHash } = await a.newGame({ tier: a.tierOfSize(size), betWei, side });
      return { paid: a.amount(betWei), betTx: a.txUrl(createTxHash) ?? createTxHash, ...(await after(a, view)) };
    },
  },
  {
    name: 'maze_look',
    title: 'Look around',
    description: 'The current position, the ways forward with their exit probabilities, and what cashing out pays now.',
    inputSchema: NO_INPUT,
    async run(a) {
      return after(a, await a.view());
    },
  },
  {
    name: 'maze_move',
    title: 'Move one cell',
    description: 'Moves one cell through an open side. Returns the new position, or the result if the game ended.',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string', enum: [...DIR_NAMES], description: 'One of the ways forward' } },
      required: ['dir'],
    },
    async run(a, args) {
      return after(a, await a.move(dirOf(argument(args, 'dir', isDir, 'one of N, E, S, W'))));
    },
  },
  {
    name: 'maze_cash_out',
    title: 'Cash out',
    description: 'Ends the game and takes the current refund. Returns the result with the payout transaction.',
    inputSchema: NO_INPUT,
    async run(a) {
      return after(a, await a.cashOut());
    },
  },
  {
    name: 'maze_history',
    title: 'Payment history',
    description: 'Every game this wallet finished: bet and payout transactions, and the totals.',
    inputSchema: NO_INPUT,
    async run(a) {
      const games = a.history;
      const wagered = games.reduce((sum, g) => sum + BigInt(g.betWei), 0n);
      const paidBack = games.reduce((sum, g) => sum + BigInt(g.payoutWei), 0n);
      return {
        games: games.map((g) => result(a, g)),
        totals: {
          games: games.length,
          wagered: a.amount(wagered),
          paidBack: a.amount(paidBack),
          net: a.amount(paidBack - wagered),
        },
      };
    },
  },
];

// ----- protocol -----

let queue: Promise<unknown> = Promise.resolve();

/** Runs tool calls one at a time: one wallet, one game. A failure is the tool's answer, not a protocol error. */
function callTool(tool: Tool, args: Args): Promise<unknown> {
  const answer = queue.then(async () => {
    try {
      const value = await tool.run(await agent(), args);
      return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  queue = answer;
  return answer;
}

type Id = string | number | null;

function reply(id: Id, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function failure(id: Id, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handle(message: unknown): Promise<object | null> {
  if (typeof message !== 'object' || message === null) return failure(null, -32600, 'Invalid Request');
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  // Notifications (no id) and answers to requests this server never sends need no reply.
  if (id === undefined) return null;
  if (typeof id !== 'string' && typeof id !== 'number' && id !== null) return failure(null, -32600, 'Invalid Request');
  if (typeof method !== 'string') return failure(id, -32600, 'Invalid Request');
  try {
    return await answer(id, method, params);
  } catch (error) {
    return failure(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

async function answer(id: Id, method: string, params: Record<string, unknown> | undefined): Promise<object> {
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      const protocolVersion = typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: RULES,
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
      });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (tool === undefined) return failure(id, -32602, `Unknown tool: ${String(params?.name)}`);
      const args = params?.arguments;
      return reply(id, await callTool(tool, typeof args === 'object' && args !== null ? (args as Args) : {}));
    }
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

function send(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function receive(message: unknown): Promise<void> {
  if (Array.isArray(message)) {
    if (message.length === 0) {
      send(failure(null, -32600, 'Invalid Request'));
      return;
    }
    const replies = (await Promise.all(message.map(handle))).filter((r) => r !== null);
    if (replies.length > 0) send(replies);
  } else {
    const reply = await handle(message);
    if (reply !== null) send(reply);
  }
}

/** Messages still being answered. */
const inFlight = new Set<Promise<void>>();

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line.trim() === '') return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    send(failure(null, -32700, 'Parse error'));
    return;
  }
  const answering = receive(message);
  inFlight.add(answering);
  void answering.finally(() => inFlight.delete(answering));
});
// The client closed stdin: let the calls in flight (a bet, a move) finish and their replies go out, then stop.
lines.on('close', () => {
  void Promise.allSettled([...inFlight]).then(() => process.exit(0));
});
