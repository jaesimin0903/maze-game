// pnpm agent:play [--games 1] [--size 5] [--bet 0.01] [--cashout-below 0.2]
//
// The agent wallet plays on its own, without a language model: every game pays its bet on chain,
// takes at each cell the opening with the largest exit probability, and cashes out once the exit
// can still be reached with probability under `--cashout-below`. Every payment is printed with
// its transaction.

import { parseEther } from 'viem';
import { option } from '../../../scripts/env-file';
import { dirOf } from './advise';
import { AgentClient } from './client';
import { loadSettings } from './settings';

function percent(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const games = Number(option(args, '--games') ?? '1');
  const size = Number(option(args, '--size') ?? '5');
  const betWei = parseEther(option(args, '--bet') ?? '0.01');
  const cashoutBelow = Number(option(args, '--cashout-below') ?? '0.2');
  if (!Number.isInteger(games) || games < 1) throw new Error('--games must be a positive whole number');
  if (!(cashoutBelow >= 0 && cashoutBelow <= 1)) throw new Error('--cashout-below must be between 0 and 1');

  const client = await AgentClient.connect(loadSettings());
  const tier = client.tierOfSize(size);
  const startBalance = await client.balance();
  const log = (line: string): void => void process.stdout.write(`${line}\n`);
  log(`agent ${client.address} on ${client.chain.name}, balance ${client.amount(startBalance)}`);

  let paidOut = 0n;
  let wagered = 0n;
  for (let game = 1; game <= games; game++) {
    const { view, createTxHash } = await client.newGame({ tier, betWei });
    wagered += betWei;
    log(`\n[game ${game}/${games}] ${size}×${size}, paid ${client.amount(betWei)}  ${client.txUrl(createTxHash) ?? createTxHash}`);
    let current = view;
    while (current.status === 'active') {
      const advice = await client.advice();
      const options = advice.options.map((o) => `${o.dir} ${percent(o.exitProbability)}`).join(', ');
      if (advice.best === null || advice.reachable < cashoutBelow) {
        log(`  step ${advice.step}: exit reachable ${percent(advice.reachable)} → cash out ${client.amount(current.refundableWei)}`);
        current = await client.cashOut();
        break;
      }
      log(`  step ${advice.step} at (${current.cell.x}, ${current.cell.y}): ${options} → ${advice.best}`);
      current = await client.move(dirOf(advice.best));
    }
    const result = await client.finish();
    paidOut += BigInt(result.payoutWei);
    const settle = result.settleTxHash === null ? 'settlement pending' : (client.txUrl(result.settleTxHash) ?? result.settleTxHash);
    log(`  ${result.outcome} after ${result.steps} moves, paid back ${client.amount(result.payoutWei)}  ${settle}`);
  }

  const endBalance = await client.balance();
  log(`\nwagered ${client.amount(wagered)}, paid back ${client.amount(paidOut)}, net ${client.amount(paidOut - wagered)}`);
  log(`balance ${client.amount(startBalance)} → ${client.amount(endBalance)} (network fees included)`);
}

main().catch((error: unknown) => {
  process.stderr.write(`agent:play: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
