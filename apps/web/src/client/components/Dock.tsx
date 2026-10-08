'use client';

import type { ReactNode } from 'react';
import type { FoundChest, GameView, Hex, StartSide } from '@maze/shared';
import type { Preset } from '../bet-form';
import { formatApprox, formatClock, formatEth, formatPercent, formatPoints, shortHex } from '../format';
import { explorerLink, useNetwork } from '../network';
import type { BetStep, GameResult, ReclaimInfo, ResultOutcome } from '../use-game';
import { DomInput } from './DomInput';

export interface TierOption {
  index: number;
  n: number;
  multiplierBps: number;
}

/** The bet's way back straight from the contract, and when it opens. */
export interface DockReclaim {
  info: ReclaimInfo;
  /** Chain time, in seconds. */
  now: number;
  onReclaim(): void;
}

/**
 * What the dock shows. Every mode has the same shape: a figure in the pill with the amounts under
 * it, one row of controls, and a line of small print.
 */
export type DockModel =
  | {
      kind: 'ready';
      tiers: TierOption[];
      tier: number;
      presets: Preset[];
      amountText: string;
      amountWei: bigint | null;
      /** Why the typed amount cannot be bet, or `null`. */
      amountProblem: string | null;
      exitWei: bigint | null;
      multiplier: string;
      /** The connected wallet's balance, or `null` without a wallet or before the first read. */
      balanceWei: bigint | null;
      /** What the wallet lacks for the bet and its network fee, or `null` when it has enough. */
      shortWei: bigint | null;
      /** Where to get test coins, on a chain with a faucet. */
      faucetUrl: string | null;
      /** What placing the bet typically costs in network fees, once the gas price is known. */
      feeWei: bigint | null;
      /** The client seed. Never shown whole: the screen shows its look and short name. */
      seedText: string;
      /** The side the seed opens the start to, for the reroll button's label. */
      startSide: StartSide | null;
      onTier(index: number): void;
      onAmount(text: string): void;
      onSeed(text: string): void;
      onReroll(): void;
      onStart(): void;
    }
  | { kind: 'betting'; step: BetStep; text: string }
  | { kind: 'waiting'; betWei: bigint | null; size: string }
  | {
      kind: 'play';
      view: GameView;
      /** Cash-out value after one more step and the drop to it; `null` on the last step. */
      next: { wei: bigint; dropWei: bigint } | null;
      size: string;
      /** Chain seconds until the forced settlement; `null` while the chain clock is unknown. */
      gameLeftSec: number | null;
      /** Points this game has earned so far, on a server with chests. */
      points: { total: string; count: number } | null;
      busy: boolean;
      /** False once the server has stopped the game, before the page has caught up. */
      canCashOut: boolean;
      walletConnected: boolean;
      /** The direct reclaim, when the server cannot be reached or the settle deadline has passed. */
      reclaim: DockReclaim | null;
      onCashOut(): void;
    }
  | { kind: 'confirm'; refundWei: bigint; choice: 0 | 1; busy: boolean; onTake(): void; onKeep(): void }
  | {
      kind: 'ended';
      gameId: Hex;
      result: GameResult | null;
      betWei: bigint | null;
      confirmed: boolean;
      canSelfSettle: boolean;
      walletConnected: boolean;
      busy: boolean;
      /** Keyboard focus among New game and Verify; `null` while the keys must not leave the game. */
      choice: 0 | 1 | null;
      /**
       * The direct reclaim, when the server is unreachable or the settle deadline has passed. It
       * sits next to the player's own settle, which pays the real outcome and may still be open.
       */
      reclaim: DockReclaim | null;
      onSettleSelf(): void;
      onNewGame(): void;
      /** Opens the fairness check for this game, as a dialog over the page. */
      onVerify(): void;
    }
  | {
      kind: 'reclaim';
      info: ReclaimInfo;
      now: number;
      betWei: bigint | null;
      walletConnected: boolean;
      busy: boolean;
      onReclaim(): void;
    };

const TITLE: Record<ResultOutcome, string> = {
  exit: 'ESCAPED',
  loss: 'DEAD END',
  cashout: 'CASHED OUT',
  'auto-cashout': 'AUTO CASH-OUT',
  reclaimed: 'BET RECLAIMED',
};

/** The pill while a bet is being placed. */
const STEP_PILL: Record<BetStep, string> = { sign: 'SIGN', ticket: 'COMMIT', tx: 'SEND', confirm: 'CONFIRM' };

/** The floating bar at the bottom of the window: everything money goes through. */
export function Dock({ model }: { model: DockModel }) {
  return (
    <section className="dock" data-testid="dock" data-mode={model.kind} aria-label="Bet and cash out">
      <DockRows model={model} />
    </section>
  );
}

/** `part / whole` as the pill shows a multiple: 2.6088, 0.95, 0. */
function multiple(part: bigint, whole: bigint): string {
  if (whole <= 0n) return '0';
  const bps = Number((part * 10_000n) / whole);
  return (bps / 10_000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** A signed difference in the chain's coin: "+0.0161" or "-0.0027". */
function signed(wei: bigint): { sign: string; abs: bigint } {
  return wei >= 0n ? { sign: '+', abs: wei } : { sign: '-', abs: -wei };
}

/** An amount of the chain's coin with the diamond in front; its symbol is there for screen readers. */
function Ether({ wei, sign = '' }: { wei: bigint; sign?: string }) {
  const { symbol } = useNetwork();
  return (
    <>
      {sign}
      <EthIcon />
      {formatEth(wei, 4)}
      <span className="sr-only"> {symbol}</span>
    </>
  );
}

/** The pill with the headline figure, and the amounts under it. */
function Head({ pill, tone, children }: { pill: ReactNode; tone?: string; children?: ReactNode }) {
  return (
    <div className="dhead">
      <div className="dpillrow">
        <span className={tone ? `dpill ${tone}` : 'dpill'}>{pill}</span>
        <span
          className="dfair"
          role="img"
          aria-label="Provably fair"
          title="Provably fair: every game can be checked once it ends"
        >
          <FairIcon />
        </span>
      </div>
      {children !== undefined && <div className="dstats">{children}</div>}
    </div>
  );
}

function DockRows({ model: m }: { model: DockModel }) {
  const { symbol } = useNetwork();
  switch (m.kind) {
    case 'ready': {
      const tier = m.tiers[m.tier];
      const profit = m.exitWei !== null && m.amountWei !== null ? signed(m.exitWei - m.amountWei) : null;
      return (
        <>
          <Head
            pill={
              <>
                {m.multiplier.replace(/^×/, '')}
                <small>x</small>
              </>
            }
          >
            {m.amountProblem !== null ? (
              <span className="dnote drop" data-testid="bet-invalid" role="alert">
                {m.amountProblem}
              </span>
            ) : m.shortWei !== null ? (
              <span className="dnote drop" data-testid="bet-short" data-wei={m.shortWei.toString()} role="alert">
                Need {formatEth(m.shortWei)} {symbol} more for the bet and its fee
                {m.faucetUrl !== null && (
                  <>
                    {' · '}
                    <a data-testid="dock-faucet" href={m.faucetUrl} target="_blank" rel="noreferrer">
                      Get {symbol}
                    </a>
                  </>
                )}
              </span>
            ) : (
              <>
                <span
                  className="deth"
                  data-testid="escape-payout"
                  data-wei={m.exitWei?.toString() ?? ''}
                  title="The exit pays"
                >
                  {m.exitWei === null ? '—' : <Ether wei={m.exitWei} />}
                </span>
                {profit !== null && (
                  <span className="dgain" title="Profit at the exit">
                    <FaceIcon />
                    <span className="sr-only">Profit at the exit </span>
                    {profit.sign}
                    {formatEth(profit.abs, 4)}
                    <span className="sr-only"> {symbol}</span>
                  </span>
                )}
              </>
            )}
          </Head>
          <div className="dctrl">
            {/* The seed itself, kept out of sight; scripts may set it, and the screen follows. */}
            <DomInput
              type="hidden"
              id="client-seed"
              name="client-seed"
              data-testid="client-seed-input"
              value={m.seedText}
              onValue={m.onSeed}
            />
            <button
              type="button"
              className="dshuffle"
              data-testid="reroll"
              data-start-side={m.startSide ?? ''}
              aria-label="Reroll the dungeon: a new client seed"
              title="A new client seed: a new look, and maybe the other start side"
              onClick={m.onReroll}
            >
              <Dice />
              <span className="dwide">Reroll Dungeon</span>
            </button>
            <span className="dseglab dwide">SIZE</span>
            {/* A phone has room for one size chip: it steps to the next size on every tap. */}
            <span className="dsegbox dnarrow">
              <button
                type="button"
                className="dsegopt on"
                data-testid="tier-cycle"
                aria-label={`Maze size ${tier?.n ?? ''}×${tier?.n ?? ''}, tap for the next size`}
                onClick={() => m.onTier((m.tier + 1) % m.tiers.length)}
              >
                {tier?.n}×{tier?.n}
              </button>
            </span>
            <div className="dsegbox dwide" role="group" aria-label="Maze size">
              {m.tiers.map((t) => (
                <button
                  key={t.index}
                  type="button"
                  className={m.tier === t.index ? 'dsegopt on' : 'dsegopt'}
                  data-testid={`tier-${t.index}`}
                  data-selected={m.tier === t.index}
                  data-n={t.n}
                  data-multiplier-bps={t.multiplierBps}
                  aria-pressed={m.tier === t.index}
                  onClick={() => m.onTier(t.index)}
                >
                  {t.n}×{t.n}
                </button>
              ))}
            </div>
            <span className="dseglab dwide">BET</span>
            <div className="dsegbox" role="group" aria-label={`Bet presets in ${symbol}`}>
              {m.presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={m.amountWei === p.wei ? 'dsegopt on' : 'dsegopt'}
                  data-testid={`bet-preset-${p.label}`}
                  aria-pressed={m.amountWei === p.wei}
                  onClick={() => m.onAmount(formatEth(p.wei, 18))}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <button type="button" className="dgo" data-testid="bet-start" onClick={m.onStart}>
              START
            </button>
          </div>
          <div className="dprint">
            {m.balanceWei !== null && (
              <>
                <span
                  className="dbal"
                  data-testid="dock-balance"
                  data-wei={m.balanceWei.toString()}
                  title="Wallet balance"
                >
                  <WalletIcon />
                  <EthIcon />
                  {formatEth(m.balanceWei, 4)}
                  <span className="sr-only"> {symbol} in the wallet</span>
                </span>
                <span className="dslash" aria-hidden="true">
                  /
                </span>
              </>
            )}
            <label className="dcustom" htmlFor="bet-amount">
              CUSTOM BET
            </label>
            <DomInput
              id="bet-amount"
              name="bet-amount"
              className="damount"
              data-testid="bet-amount"
              inputMode="decimal"
              autoComplete="off"
              aria-label={`Custom bet in ${symbol}`}
              value={m.amountText}
              onValue={m.onAmount}
              aria-invalid={m.amountProblem !== null}
            />
            <span className="dunit">{symbol}</span>
            {m.feeWei !== null && (
              <span
                className="dfee"
                data-testid="dock-fee"
                data-wei={m.feeWei.toString()}
                title="What sending the bet typically costs in network fees, on top of the bet"
              >
                <span className="dwide">Network </span>fee ~{formatApprox(m.feeWei)} {symbol}
              </span>
            )}
          </div>
        </>
      );
    }

    case 'betting':
      return (
        <>
          <Head pill={STEP_PILL[m.step]} tone="dim">
            <span className="dnote" data-step={m.step}>
              {m.text}
            </span>
          </Head>
          <div className="dctrl">
            <button type="button" className="dgo" disabled>
              Starting
            </button>
          </div>
          <div className="dprint">
            <span>Keep this page open until the first cell shows up.</span>
          </div>
        </>
      );

    case 'waiting':
      return (
        <>
          <Head pill="BET PLACED" tone="dim">
            <span className="deth">{m.betWei === null ? '—' : <Ether wei={m.betWei} />}</span>
            <span className="dnote">{m.size}</span>
          </Head>
          <div className="dctrl">
            <button type="button" className="dgo" disabled>
              Starting
            </button>
          </div>
          <div className="dprint">
            <span>The server is confirming your bet on chain.</span>
          </div>
        </>
      );

    case 'play': {
      const v = m.view;
      const bet = BigInt(v.betWei);
      const refundable = BigInt(v.refundableWei);
      const net = signed(refundable - bet);
      return (
        <>
          <Head
            pill={
              <>
                {multiple(refundable, bet)}
                <small>x</small>
              </>
            }
          >
            <span
              className="deth"
              data-testid="refundable-amount"
              data-wei={v.refundableWei}
              data-step={v.step}
              title="Cash out now"
            >
              <Ether wei={refundable} />
            </span>
            <span className="dgain" title="Against the bet">
              <FaceIcon sad={net.sign === '-'} />
              <span className="sr-only">Against the bet </span>
              {net.sign}
              {formatEth(net.abs, 4)}
              <span className="sr-only"> {symbol}</span>
            </span>
          </Head>
          <div className="dctrl">
            {/* With the server out of reach no step can be taken, so this row turns to the reclaim;
                the step figures stay for screen readers. */}
            {m.next !== null && (
              <span
                className={m.reclaim === null ? 'dnext' : 'sr-only'}
                data-testid="next-step"
                data-wei={m.next.wei.toString()}
              >
                Next <Ether wei={m.next.wei} /> <span className="drop">-{formatEth(m.next.dropWei, 4)}</span>
              </span>
            )}
            {m.reclaim !== null && (
              <button
                type="button"
                className="dshuffle"
                data-testid="reclaim-button"
                disabled={!m.reclaim.info.ready || !m.walletConnected || m.busy}
                onClick={m.reclaim.onReclaim}
              >
                Reclaim bet
              </button>
            )}
            <button
              type="button"
              className="dgo dcash"
              data-testid="cashout-open"
              disabled={m.busy || !m.canCashOut}
              onClick={m.onCashOut}
            >
              CASH OUT
            </button>
          </div>
          <div className="dprint">
            {m.reclaim !== null && <ReclaimCountdown reclaim={m.reclaim} walletConnected={m.walletConnected} />}
            <span className={m.reclaim === null ? undefined : 'sr-only'}>
              Exit{' '}
              <span className="dacc" data-testid="exit-payout" data-wei={v.exitPayoutWei}>
                <Ether wei={BigInt(v.exitPayoutWei)} />
              </span>
              <span className="dwide"> · {m.size}</span> · Ends in{' '}
              <span
                data-testid="game-countdown"
                data-remaining-sec={m.gameLeftSec ?? ''}
                data-deadline-sec={v.gameDeadlineSec}
              >
                {m.gameLeftSec === null ? '—' : formatClock(m.gameLeftSec)}
              </span>
            </span>
            {m.points !== null && (
              <span className="sr-only" data-testid="game-points" data-points={m.points.total} data-count={m.points.count}>
                Treasure this game: {formatPoints(m.points.total)} points, no cash value
              </span>
            )}
          </div>
        </>
      );
    }

    case 'confirm':
      return (
        <>
          <Head pill="CASH OUT?">
            <span className="deth">
              Take <Ether wei={m.refundWei} />
            </span>
          </Head>
          <div className="dctrl">
            <button
              type="button"
              className={m.choice === 1 ? 'dshuffle on' : 'dshuffle'}
              data-testid="cashout-cancel"
              onClick={m.onKeep}
            >
              Keep going
            </button>
            <button
              type="button"
              className={m.choice === 0 ? 'dgo dcash on' : 'dgo dcash'}
              data-testid="cashout-button"
              disabled={m.busy}
              onClick={m.onTake}
            >
              Take it
            </button>
          </div>
          <div className="dprint">
            <span>Stop here and take this amount. Nothing is sent until you choose.</span>
          </div>
        </>
      );

    case 'ended':
      return <EndedRows m={m} />;

    case 'reclaim':
      return (
        <>
          <Head pill="RECLAIM" tone="dim">
            <span className="deth">{m.betWei === null ? 'Your bet' : <Ether wei={m.betWei} />}</span>
          </Head>
          <div className="dctrl">
            <button
              type="button"
              className="dgo"
              data-testid="reclaim-button"
              disabled={!m.info.ready || !m.walletConnected || m.busy}
              onClick={m.onReclaim}
            >
              {m.busy ? 'Reclaiming...' : 'Reclaim bet'}
            </button>
          </div>
          <div className="dprint">
            <span>The server has not settled this game. The contract hands the bet back.</span>
            <ReclaimCountdown reclaim={m} walletConnected={m.walletConnected} />
          </div>
        </>
      );
  }
}

function EndedRows({ m }: { m: Extract<DockModel, { kind: 'ended' }> }) {
  const { symbol, explorerUrl } = useNetwork();
  const r = m.result;
  if (r === null) {
    return (
      <>
        <Head pill="GAME OVER" tone="dim">
          <span className="dnote" aria-live="polite">
            Loading the result...
          </span>
        </Head>
        <div className="dctrl">
          <a
            className="button-link dshuffle"
            data-testid="verify-link"
            href={`/?verify=${m.gameId}`}
            onClick={(event) => {
              event.preventDefault();
              m.onVerify();
            }}
          >
            Verify
          </a>
        </div>
      </>
    );
  }
  const tone = r.outcome === 'exit' ? 'win' : r.outcome === 'loss' ? 'loss' : 'even';
  const net = m.betWei === null ? null : r.payoutWei - m.betWei;
  const shownNet = net === null ? null : signed(net);
  const chests = r.chests ?? [];
  const total = chests.reduce((sum, c) => sum + BigInt(c.points), 0n);
  const settle =
    r.txHash !== null
      ? `${r.outcome === 'reclaimed' ? 'Reclaimed' : 'Settled'} · tx ${shortHex(r.txHash)}`
      : m.confirmed
        ? 'Settled on chain'
        : 'The server is settling on chain...';
  const settleUrl = r.txHash === null ? null : explorerLink(explorerUrl, 'tx', r.txHash);
  // Extra actions crowd a phone's row: there the labels shorten and Verify, which the footer
  // also links, gives way.
  const tight = m.reclaim !== null || m.canSelfSettle;
  return (
    <>
      <div className="dreveal" aria-live="polite">
        <Head
          pill={
            m.betWei === null ? (
              TITLE[r.outcome]
            ) : (
              <>
                {multiple(r.payoutWei, m.betWei)}
                <small>x</small>
              </>
            )
          }
          tone={tone}
        >
          <span className={`dres ${tone}`} data-testid="result-outcome" data-outcome={r.outcome}>
            {TITLE[r.outcome]}
          </span>
          <span className="deth" data-testid="result-payout" data-wei={r.payoutWei.toString()}>
            {r.outcome === 'loss' && m.betWei !== null ? (
              <Ether wei={m.betWei} sign="-" />
            ) : (
              <Ether wei={r.payoutWei} sign={r.outcome === 'exit' ? '+' : ''} />
            )}
          </span>
          {net !== null && shownNet !== null && (
            <span className="dgain" data-testid="result-net" data-wei={net.toString()}>
              <FaceIcon sad={shownNet.sign === '-'} />
              <span className="sr-only">Net </span>
              {shownNet.sign}
              {formatEth(shownNet.abs, 4)}
              <span className="sr-only"> {symbol}</span>
            </span>
          )}
        </Head>
      </div>
      <ChestDetails result={r} chests={chests} />
      <div className="dctrl dreveal">
        {m.reclaim !== null && (
          <button
            type="button"
            className="dshuffle"
            data-testid="reclaim-button"
            disabled={!m.reclaim.info.ready || !m.walletConnected || m.busy}
            onClick={m.reclaim.onReclaim}
          >
            {m.reclaim.info.ready ? 'Reclaim bet' : `Reclaim · ${formatClock(m.reclaim.info.remainingSec)}`}
          </button>
        )}
        {m.canSelfSettle && (
          <button
            type="button"
            className="dshuffle"
            data-testid="settle-self"
            disabled={m.busy || !m.walletConnected}
            title={
              m.walletConnected
                ? 'The server has not settled yet. Send its signed settlement yourself.'
                : 'Connect a wallet to send the settlement yourself.'
            }
            onClick={m.onSettleSelf}
          >
            Settle<span className="dwide"> myself</span>
            {!m.walletConnected && <span className="sr-only"> (connect a wallet to send it)</span>}
          </button>
        )}
        <button
          type="button"
          className={m.choice === 0 ? 'dgo on' : 'dgo'}
          data-testid="new-game"
          onClick={m.onNewGame}
        >
          New game
        </button>
        <a
          className={`button-link dshuffle${m.choice === 1 ? ' on' : ''}${tight ? ' dwide' : ''}`}
          data-testid="verify-link"
          href={`/?verify=${m.gameId}`}
          onClick={(event) => {
            event.preventDefault();
            m.onVerify();
          }}
        >
          Verify
        </a>
      </div>
      <div className="dprint dreveal">
        <span data-testid="settle-tx" data-tx={r.txHash ?? ''} data-confirmed={m.confirmed} title={r.txHash ?? undefined}>
          {settleUrl === null ? (
            settle
          ) : (
            <a href={settleUrl} target="_blank" rel="noreferrer">
              {settle}
            </a>
          )}
        </span>
        {m.reclaim !== null && <ReclaimCountdown reclaim={m.reclaim} walletConnected={m.walletConnected} />}
        {m.reclaim === null && m.canSelfSettle && !m.walletConnected && (
          <span aria-hidden="true">Connect a wallet to settle it yourself.</span>
        )}
        {chests.length > 0 && (
          <span className="dacc" data-testid="game-points-total" data-points={total.toString()}>
            Treasure +{formatPoints(total)} PT · no cash value
          </span>
        )}
      </div>
    </>
  );
}

/** A pixel die showing five. */
function Dice() {
  return (
    <svg className="dice" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />
      <rect className="pip" x="2" y="2" width="2" height="2" />
      <rect className="pip" x="6" y="2" width="2" height="2" />
      <rect className="pip" x="4" y="4" width="2" height="2" />
      <rect className="pip" x="2" y="6" width="2" height="2" />
      <rect className="pip" x="6" y="6" width="2" height="2" />
    </svg>
  );
}

function EthIcon() {
  return (
    <svg className="ic-eth" viewBox="0 0 10 16" aria-hidden="true">
      <polygon points="5,0 10,8 5,11 0,8" />
      <polygon points="5,12 10,9 5,16 0,9" />
    </svg>
  );
}

function FaceIcon({ sad = false }: { sad?: boolean }) {
  return (
    <svg className="ic-face" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7.5" />
      <circle className="f" cx="5.4" cy="6.4" r="1.1" />
      <circle className="f" cx="10.6" cy="6.4" r="1.1" />
      <path className="m" d={sad ? 'M4.8 11.6Q8 8.6 11.2 11.6' : 'M4.6 9.4Q8 13 11.4 9.4'} />
    </svg>
  );
}

function FairIcon() {
  return (
    <svg className="ic-fair" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="9" />
      <path d="M6 10.4l2.7 2.7L14.2 7.6" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg className="ic-wallet" viewBox="0 0 14 12" aria-hidden="true">
      <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="1.5" />
      <path d="M9 6h4.3" />
    </svg>
  );
}

/** When the contract will hand the bet back. The countdown runs on block time. */
function ReclaimCountdown({
  reclaim,
  walletConnected,
}: {
  reclaim: { info: ReclaimInfo; now: number };
  walletConnected: boolean;
}) {
  const { info, now } = reclaim;
  return (
    <span
      data-testid="reclaim-countdown"
      data-remaining-sec={info.remainingSec}
      data-deadline-sec={info.deadlineSec}
      data-chain-now-sec={now}
      data-ready={info.ready}
    >
      {info.ready
        ? 'The settle deadline has passed. You can reclaim the bet now.'
        : `Bet reclaim opens in ${formatClock(info.remainingSec)} (block time)`}
      {!walletConnected && ' · Connect a wallet to send it.'}
    </span>
  );
}

const KIND_TEXT = { path: 'path chest', 'dead-end': 'dead-end chest' } as const;

/**
 * The chest details behind the one-line treasure figure: read by screen readers and kept for the
 * page's tests. Points have no cash value.
 */
function ChestDetails({ result, chests }: { result: GameResult; chests: FoundChest[] }) {
  const total = chests.reduce((sum, c) => sum + BigInt(c.points), 0n).toString();
  return (
    <div className="sr-only">
      {result.chest !== undefined && result.chest !== null && (
        <p
          data-testid="chest-found"
          data-points={result.chest.points}
          data-reward-bps={result.chest.rewardBps}
          data-x={result.chest.cell.x}
          data-y={result.chest.cell.y}
        >
          Chest found: +{formatPoints(result.chest.points)} points (
          <span data-testid="chest-points" data-points={result.chest.points}>
            {formatPercent(result.chest.rewardBps)} of the bet
          </span>
          ). <span data-testid="chest-no-cash-value">No cash value: points stay on this wallet and cannot be exchanged or withdrawn. The payout follows the dead-end rule above.</span>
        </p>
      )}
      {result.chest === null && <p data-testid="chest-none">This dead end held no chest.</p>}
      {chests.length > 0 && (
        <section data-testid="game-chests" data-count={chests.length} data-points={total}>
          <p>Treasure chests found in this game: {chests.length}</p>
          <ol>
            {chests.map((chest, k) => (
              <li
                key={`${chest.cell.x}-${chest.cell.y}`}
                data-testid={`game-chest-${k}`}
                data-kind={chest.kind}
                data-x={chest.cell.x}
                data-y={chest.cell.y}
                data-step={chest.step}
                data-reward-bps={chest.rewardBps}
                data-points={chest.points}
              >
                {KIND_TEXT[chest.kind]} ({chest.cell.x},{chest.cell.y}) after {chest.step} steps: +
                {formatPoints(chest.points)} points ({formatPercent(chest.rewardBps)} of the bet)
              </li>
            ))}
          </ol>
          <p>Total +{formatPoints(total)} points. No cash value: points cannot be exchanged or withdrawn and do not change the payout.</p>
        </section>
      )}
    </div>
  );
}
