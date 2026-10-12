# Maze Bet

**A provably fair maze you bet on, built on Monad. People play it in the browser, and AI agents play it with their own wallets.**

- **Live:** https://maze-monad.fly.dev (Monad testnet, chain 10143)
- **Contract:** [`0x19803911DC8121523452b1Dd05f4cA13abCCCD22`](https://testnet.monadvision.com/address/0x19803911DC8121523452b1Dd05f4cA13abCCCD22)
- **Monad Metropolis:** Track 02, Consumer Products & Payments

## The game

Pick a board (5×5, 7×7 or 9×9) and a bet. You start in the top-left corner of a hidden maze and walk toward the exit in the bottom-right corner, one cell at a time. You see only the walls of the cells you have stood on, and you can never step back.

| Board | Exit pays |
|---|---|
| 5×5 | 2.6088× |
| 7×7 | 6.6112× |
| 9×9 | 18.4695× |

A dead end loses the bet. Before any step you can cash out for a refund that shrinks as you walk: 95% before the first step, then less with every step.

## Why it feels like a consumer app

- **Log in with email, Google or a passkey (Privy).** A new player gets an embedded wallet. Ticket signing and the bet go through without wallet popups: pressing "Sign and bet" is the consent. External wallets also work.
- **Monad makes every step feel instant.** The bet is one transaction. Moves are off-chain calls to the game server. The server's relayer settles the result on chain, so the player never sends or pays for a second transaction.
- **The UI shows the fees.** The bet panel shows the network fee and the net result.

## Provably fair

1. **Commitment.** The server commits to its seed in a signed ticket before the player's client seed is sent.
2. **Bet.** The player sends `createGame` with the bet, the client seed and the server's ticket. The commitment is now on chain.
3. **Maze.** The maze is derived from the server seed, the client seed and the game id. Neither side can steer it alone.
4. **Settlement.** The server signs an EIP-712 settlement and its relayer submits it. If the server goes quiet, the player can submit the signed settlement themselves, or reclaim the bet after the deadline.
5. **Verification.** After the game, `/verify/<gameId>` rebuilds the maze from public data only: the on-chain commitment, the client seed, the game id and the revealed server seed. It then checks what the server showed during the game.

## Safe against the smartest player, including AI

The payout tables were tuned with a simulator (`packages/sim`) and then attacked. See [`docs/ai-attack-report.md`](docs/ai-attack-report.md):

- **5×5 is solved exactly.** The Bayes-optimal policy computes the exact posterior over every maze consistent with the walls seen. It returns **95.88%** of what is bet, so even a perfect player loses about 4%.
- **7×7 and 9×9 are bounded empirically.** The strongest strategies found return at most 95.92%. Every 95% confidence bound stays under the 96.5% ceiling.

That is why the game can be opened to AI agents instead of fighting bots.

## Agent play: AI agents that pay with their own wallet

`packages/agent` lets an AI agent, such as Claude Code, play over MCP. Every game pays its bet on chain from the agent's wallet, and the payout comes back to the same wallet. Each position comes with the exact probability that the exit lies beyond each opening, computed from the walls seen so far: the same information a human has. Spending limits per game and per session are checked before any bet is sent.

```sh
pnpm agent:wallet --server https://maze-monad.fly.dev   # create the agent wallet, then fund it
pnpm agent:play --games 3 --size 5 --bet 0.01            # play without a model
# or open this repo in Claude Code: .mcp.json registers the maze-agent MCP server
```

Verified on Monad testnet. Bet and payout transactions are linked in [`docs/agent-play.md`](docs/agent-play.md).

## Repository

| Path | What |
|---|---|
| `contracts/` | `MazeBet.sol` (Foundry): bets, house liquidity, signed settlement, reclaim. Unit, exploit, invariant and production-table tests. `contracts/lib/` is vendored OpenZeppelin. |
| `apps/web/` | Next.js app: the game UI and the game server API (tickets, moves, relayer, reveal). |
| `packages/shared/` | Maze generation, seeds and hashing, EIP-712 types, payout table, verification. Used by the server, the browser and the simulator. |
| `packages/sim/` | Simulator: bots, exact posterior, calibration and certification of the payout table, attack and escape reports. |
| `packages/agent/` | Agent client, MCP server and autoplay CLI. |
| `e2e/aside/` | Browser scenarios driven through the Aside CLI. |
| `docs/` | Deployment runbook, exploit audit, tuning, AI-attack, escape and agent-play reports. |

## Run it locally

Requirements: Node 25, pnpm 10, Foundry.

```sh
pnpm install
pnpm dev:up                       # Anvil + contract + funded house + app on http://localhost:3000
pnpm --filter @maze/web test      # server and client tests
forge test --root contracts       # contract tests
pnpm --filter @maze/agent test    # agent posterior tests
pnpm dev:down
```

To deploy to Monad testnet, see [`docs/deploy-monad.md`](docs/deploy-monad.md).

## Built during Metropolis

The first commit is dated 2026-10-02. All project code was written during the hackathon window; only `contracts/lib/` is third-party.
