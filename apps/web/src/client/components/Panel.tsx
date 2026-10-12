'use client';

// What the console shows around its screen at each moment of a game: the row above the screen
// (the stake before a game, the HP meter during it, the result after it) and the menu on the
// screen (the bet A places and its fee, the steps while it is placed, the cash-out question, the
// choices after the end, the bet's reclaim).

import { refundBps, refundWei, type FoundChest, type GameView, type Hex, type TuningTable } from '@maze/shared';
import type { PlaceStep } from '../bet-form';
import { formatApprox, formatClock, formatEth, formatEthFixed, formatPercent, formatPoints, shortHex } from '../format';
import { explorerLink, useNetwork } from '../network';
import type { GameResult, ReclaimInfo, ResultOutcome } from '../use-game';

/** The bet's way back straight from the contract, and when it opens. */
export interface PanelReclaim {
  info: ReclaimInfo;
  /** Chain time, in seconds. */
  now: number;
  onReclaim(): void;
}

export type PanelModel =
  | {
      /** Before a game: the stake, and what A does with it. */
      kind: 'ready';
      betWei: bigint;
      /** What sending the bet typically costs in network fees; `null` while the gas price is unknown. */
      feeWei: bigint | null;
      /** Why A does not bet now, in a few words for the screen, or `null` when A bets. */
      blocked: string | null;
    }
  | {
      /** The bet being placed: the balance read, then the wallet's, the server's and the chain's steps. */
      kind: 'betting';
      betWei: bigint;
      step: PlaceStep;
      /** The chain's name, for the last step: "Monad Testnet", or "chain" without one. */
      chainName: string;
    }
  | { kind: 'waiting'; betWei: bigint | null }
  | {
      kind: 'play';
      view: GameView;
      /** The payout table: the meter reads the refund from it as the server does. */
      table: TuningTable;
      size: string;
      /** Chain seconds until the forced settlement; `null` while the chain clock is unknown. */
      gameLeftSec: number | null;
      /** Points this game has earned so far, on a server with chests. */
      points: { total: string; count: number } | null;
      walletConnected: boolean;
      busy: boolean;
      /** The direct reclaim, when the server cannot be reached or the settle deadline has passed. */
      reclaim: PanelReclaim | null;
      /** The cash-out question while it is asked: `choice` 0 is "Take it", 1 is "Keep going". */
      confirm: { choice: 0 | 1; onTake(): void; onKeep(): void } | null;
    }
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
      reclaim: PanelReclaim | null;
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

/** The console's `data-mode`: the panel's kind, with the cash-out question as a mode of its own. */
export function panelMode(m: PanelModel): string {
  return m.kind === 'play' && m.confirm !== null ? 'confirm' : m.kind;
}

const TITLE: Record<ResultOutcome, string> = {
  exit: 'ESCAPED',
  loss: 'DEAD END',
  cashout: 'CASHED OUT',
  'auto-cashout': 'AUTO CASH-OUT',
  reclaimed: 'BET RECLAIMED',
};

/** The meter turns yellow below 60% of the bet and red below 40%. */
export function hpTone(bps: number): 'g' | 'y' | 'r' {
  return bps >= 6000 ? 'g' : bps >= 4000 ? 'y' : 'r';
}

const four = (wei: bigint): string => formatEthFixed(wei, 4);
const three = (wei: bigint): string => formatEthFixed(wei, 3);

/** A signed difference in the chain's coin: "+0.0161" or "-0.0027". */
function signed(wei: bigint): string {
  return wei >= 0n ? `+${four(wei)}` : `-${four(-wei)}`;
}

// ------------------------------------------------------------------ the row above the screen

export function HpRow({ model: m }: { model: PanelModel }) {
  const { symbol } = useNetwork();
  switch (m.kind) {
    case 'ready':
    case 'betting':
    case 'waiting':
      return <StakeRow betWei={m.betWei} />;

    case 'play': {
      const v = m.view;
      return (
        <>
          <HpMeter table={m.table} betWei={BigInt(v.betWei)} tier={v.tier} step={v.step} refundableWei={v.refundableWei} />
          {/* The figures behind the meter, for screen readers and the page's tests. */}
          <p className="sr-only">
            <NextStep table={m.table} view={v} />
            Exit pays{' '}
            <span data-testid="exit-payout" data-wei={v.exitPayoutWei}>
              {formatEth(BigInt(v.exitPayoutWei), 4)} {symbol}
            </span>
            , {m.size}. The game ends in{' '}
            <span
              data-testid="game-countdown"
              data-remaining-sec={m.gameLeftSec ?? ''}
              data-deadline-sec={v.gameDeadlineSec}
            >
              {m.gameLeftSec === null ? '—' : formatClock(m.gameLeftSec)}
            </span>
            .
            {m.points !== null && (
              <span data-testid="game-points" data-points={m.points.total} data-count={m.points.count}>
                {' '}
                Treasure this game: {formatPoints(m.points.total)} points, no cash value.
              </span>
            )}
          </p>
        </>
      );
    }

    case 'ended': {
      const r = m.result;
      if (r === null) {
        return (
          <div className="hp">
            <span className="hpl">END</span>
            <span className="hpt">LOADING THE RESULT...</span>
          </div>
        );
      }
      const tone = r.outcome === 'exit' ? 'win' : r.outcome === 'loss' ? 'loss' : 'even';
      // What the game paid against what was bet: not a net result, which would count the fee.
      const diff = m.betWei === null ? null : r.payoutWei - m.betWei;
      return (
        <div className="hp" aria-live="polite">
          <span className="hpl">END</span>
          <span className="hpt">
            <span className="sr-only" data-testid="result-outcome" data-outcome={r.outcome}>
              {TITLE[r.outcome]}: paid{' '}
            </span>
            <b className={tone} data-testid="result-payout" data-wei={r.payoutWei.toString()}>
              {four(r.payoutWei)} {symbol}
            </b>
            {diff !== null && (
              <>
                {' · '}
                <span className={diff > 0n ? 'win' : diff < 0n ? 'loss' : undefined} data-testid="result-net" data-wei={diff.toString()}>
                  {signed(diff)} vs BET
                </span>
              </>
            )}
          </span>
        </div>
      );
    }

    case 'reclaim':
      return (
        <div className="hp">
          <span className="hpl">BET</span>
          <span className="hpt">
            <b>{m.betWei === null ? '—' : `${four(m.betWei)} ${symbol}`}</b> · NOT SETTLED
          </span>
        </div>
      );
  }
}

/**
 * Before the game: the stake, as a full bar. It is not a meter yet: nothing has been lost.
 */
function StakeRow({ betWei }: { betWei: bigint | null }) {
  const { symbol } = useNetwork();
  return (
    <div className="hp" data-testid="hp-stake" data-wei={betWei?.toString() ?? ''}>
      <span className="hpl" aria-hidden="true">
        HP
      </span>
      <span className="bar-wrap" aria-hidden="true">
        <span className="bar">
          <i className="fill g" style={{ width: '100%' }} />
          <i className="seg" />
        </span>
      </span>
      <span className="hpv" aria-hidden="true">
        {betWei === null ? '—' : four(betWei)} <small>{symbol}</small>
      </span>
      <span className="sr-only">Stake {betWei === null ? 'not known yet' : `${formatEthFixed(betWei, 3)} ${symbol}`}</span>
    </div>
  );
}

/**
 * What a cash-out pays right now, as a share of the bet, in 20 segments. It reads the refund from
 * the table with the function the server pays with. On every step the part just lost shows for a
 * moment as a white ghost, with the amount rising off the bar.
 */
export function HpMeter(p: { table: TuningTable; betWei: bigint; tier: number; step: number; refundableWei: string }) {
  const { symbol } = useNetwork();
  const steps = p.table.tiers[p.tier]?.refundBps.length ?? 0;
  if (p.step < 0 || p.step >= steps) return null;
  const bps = refundBps(p.table, p.tier, p.step);
  const wei = refundWei(p.table, p.betWei, p.tier, p.step);
  const percent = bps / 100;
  const tone = hpTone(bps);
  const prevBps = p.step > 0 ? refundBps(p.table, p.tier, p.step - 1) : null;
  const lostWei = p.step > 0 ? refundWei(p.table, p.betWei, p.tier, p.step - 1) - wei : null;
  return (
    <div
      className="hp"
      role="meter"
      aria-label="Cash out now"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${four(wei)} ${symbol}, ${percent}% of the bet`}
      data-testid="refundable-amount"
      data-wei={p.refundableWei}
      data-step={p.step}
    >
      <span className="hpl" aria-hidden="true">
        HP
      </span>
      <span className="bar-wrap">
        <span className="bar" data-testid="hp-bar" data-bps={bps} data-wei={wei.toString()} data-tone={tone}>
          {prevBps !== null && (
            <i key={p.step} className="ghost" style={{ left: `${percent}%`, width: `${(prevBps - bps) / 100}%` }} />
          )}
          <i className={`fill ${tone}`} style={{ width: `${percent}%` }} />
          <i className="seg" />
        </span>
        {lostWei !== null && prevBps !== null && (
          <span
            key={p.step}
            className="dmg"
            data-testid="hp-damage"
            data-wei={lostWei.toString()}
            aria-hidden="true"
            style={{ left: `${(bps + prevBps) / 200}%` }}
          >
            −{four(lostWei)}
          </span>
        )}
      </span>
      <span className="hpv" data-testid="hp-text">
        {four(wei)} <small>{symbol}</small>
      </span>
    </div>
  );
}

/** What one more step leaves to cash out, and the drop to it; nothing on the last step. */
function NextStep({ table, view }: { table: TuningTable; view: GameView }) {
  const { symbol } = useNetwork();
  const next = view.step + 1;
  if (next >= (table.tiers[view.tier]?.refundBps.length ?? 0)) return null;
  const wei = refundWei(table, BigInt(view.betWei), view.tier, next);
  const refundable = BigInt(view.refundableWei);
  return (
    <span data-testid="next-step" data-wei={wei.toString()}>
      After one more step {formatEth(wei, 4)} {symbol} (-{formatEth(refundable > wei ? refundable - wei : 0n, 4)}).{' '}
    </span>
  );
}

// ------------------------------------------------------------------------- the screen's menu

export function ScreenMenu({ model: m }: { model: PanelModel }) {
  switch (m.kind) {
    case 'ready':
      return <BetPrompt m={m} />;
    case 'betting':
      return <BetLoading m={m} />;
    case 'play':
      if (m.confirm !== null) return <ConfirmMenu m={m} confirm={m.confirm} />;
      if (m.reclaim !== null) {
        return (
          <ReclaimMenu
            text="The server cannot be reached. The contract hands the bet back once the deadline passes."
            reclaim={m.reclaim}
            walletConnected={m.walletConnected}
            busy={m.busy}
          />
        );
      }
      return null;
    case 'ended':
      return <EndedMenu m={m} />;
    case 'reclaim':
      return (
        <ReclaimMenu
          text="The server has not settled this game. The contract hands the bet back."
          reclaim={m}
          walletConnected={m.walletConnected}
          busy={m.busy}
        />
      );
    default:
      return null;
  }
}

/**
 * The lobby's consent line on the screen: the bet A places and what sending it typically costs in
 * network fees. A bets at once, so the screen names the bet before the press; when A cannot bet
 * yet, a second line says why in a few words.
 */
function BetPrompt({ m }: { m: Extract<PanelModel, { kind: 'ready' }> }) {
  const { symbol } = useNetwork();
  return (
    <div
      className="scr-prompt"
      data-testid="bet-prompt"
      data-wei={m.betWei.toString()}
      data-ready={m.blocked === null}
    >
      <p className="scr-prompt-line">
        <span className="scr-prompt-arrow" aria-hidden="true">
          ▶{' '}
        </span>
        A: BET {three(m.betWei)} {symbol}
        {' · '}
        <span
          data-testid="bet-fee"
          data-wei={m.feeWei?.toString() ?? ''}
          title="What sending the bet typically costs in network fees, on top of the bet"
        >
          FEE {m.feeWei === null ? '—' : `~${formatApprox(m.feeWei)}`}
        </span>
      </p>
      {m.blocked !== null && (
        <p className="scr-prompt-why" data-testid="bet-prompt-why">
          {m.blocked}
        </p>
      )}
    </div>
  );
}

const BET_STEPS: { key: PlaceStep; label(chainName: string): string }[] = [
  { key: 'check', label: () => 'Check balance' },
  { key: 'sign', label: () => 'Sign ticket' },
  { key: 'ticket', label: () => 'Server locks the maze' },
  { key: 'tx', label: () => 'Send bet' },
  { key: 'confirm', label: (chainName) => `Confirm on ${chainName}` },
];

/**
 * The screen while the bet is placed, from the press of A on: the balance read and the bet's four
 * steps, done, under way or still to come, and the hero walking in place. What the step under way waits for (a wallet prompt, a block) is said
 * under the screen.
 */
function BetLoading({ m }: { m: Extract<PanelModel, { kind: 'betting' }> }) {
  const at = BET_STEPS.findIndex((s) => s.key === m.step);
  return (
    <div className="scr-load" data-testid="bet-loading" data-step={m.step}>
      <p className="scr-title">PLACING BET</p>
      <div className="load-hero" aria-hidden="true">
        <div className="hero walking">
          <div className="body">
            <div className="fr f0 spr s-R0" />
            <div className="fr f1 spr s-R1" />
            <div className="fr f2 spr s-R2" />
          </div>
        </div>
      </div>
      <ol className="load-steps" aria-label="Bet progress">
        {BET_STEPS.map((s, k) => (
          <li key={s.key} data-testid={`bet-step-${s.key}`} data-state={k < at ? 'done' : k === at ? 'now' : 'todo'}>
            {s.label(m.chainName)}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ConfirmMenu({
  m,
  confirm,
}: {
  m: Extract<PanelModel, { kind: 'play' }>;
  confirm: NonNullable<Extract<PanelModel, { kind: 'play' }>['confirm']>;
}) {
  const { symbol } = useNetwork();
  const v = m.view;
  // The server's figure, should the view name a tier or step the table does not have.
  const inTable = v.step >= 0 && v.step < (m.table.tiers[v.tier]?.refundBps.length ?? 0);
  const wei = inTable ? refundWei(m.table, BigInt(v.betWei), v.tier, v.step) : BigInt(v.refundableWei);
  return (
    <div className="scr-menu" role="group" aria-label="Cash out?">
      <p className="scr-title">CASH OUT?</p>
      <p className="scr-line">
        Take <b>{four(wei)} {symbol}</b> and stop here.
      </p>
      <div className="scr-opts">
        <button
          type="button"
          className={confirm.choice === 1 ? 'scr-opt on' : 'scr-opt'}
          data-testid="cashout-cancel"
          onClick={confirm.onKeep}
        >
          KEEP GOING
        </button>
        <button
          type="button"
          className={confirm.choice === 0 ? 'scr-opt cash on' : 'scr-opt cash'}
          data-testid="cashout-button"
          disabled={m.busy}
          onClick={confirm.onTake}
        >
          TAKE IT
        </button>
      </div>
    </div>
  );
}

function ReclaimMenu({
  text,
  reclaim,
  walletConnected,
  busy,
}: {
  text: string;
  reclaim: { info: ReclaimInfo; now: number; onReclaim(): void };
  walletConnected: boolean;
  busy: boolean;
}) {
  return (
    <div className="scr-menu" role="group" aria-label="Reclaim the bet">
      <p className="scr-line">{text}</p>
      <p className="scr-print">
        <ReclaimCountdown reclaim={reclaim} walletConnected={walletConnected} />
      </p>
      <div className="scr-opts">
        <button
          type="button"
          className="scr-opt"
          data-testid="reclaim-button"
          disabled={!reclaim.info.ready || !walletConnected || busy}
          onClick={reclaim.onReclaim}
        >
          {busy ? 'RECLAIMING...' : 'RECLAIM BET'}
        </button>
      </div>
    </div>
  );
}

function EndedMenu({ m }: { m: Extract<PanelModel, { kind: 'ended' }> }) {
  const { explorerUrl } = useNetwork();
  const r = m.result;
  const verify = (
    <a
      className={`button-link scr-opt${m.choice === 1 ? ' on' : ''}`}
      data-testid="verify-link"
      href={`/?verify=${m.gameId}`}
      onClick={(event) => {
        event.preventDefault();
        m.onVerify();
      }}
    >
      VERIFY
    </a>
  );
  if (r === null) {
    return (
      <div className="scr-menu" aria-live="polite">
        <p className="scr-line">Loading the result...</p>
        <div className="scr-opts">{verify}</div>
      </div>
    );
  }
  const chests = r.chests ?? [];
  const total = chests.reduce((sum, c) => sum + BigInt(c.points), 0n);
  const settle =
    r.txHash !== null
      ? `${r.outcome === 'reclaimed' ? 'Reclaimed' : 'Settled'} · tx ${shortHex(r.txHash)}`
      : m.confirmed
        ? 'Settled on chain'
        : 'The server is settling on chain...';
  const settleUrl = r.txHash === null ? null : explorerLink(explorerUrl, 'tx', r.txHash);
  return (
    <div className="scr-menu reveal" role="group" aria-label="Game over">
      <div className="scr-opts">
        {m.reclaim !== null && (
          <button
            type="button"
            className="scr-opt"
            data-testid="reclaim-button"
            disabled={!m.reclaim.info.ready || !m.walletConnected || m.busy}
            onClick={m.reclaim.onReclaim}
          >
            {m.reclaim.info.ready ? 'RECLAIM' : `RECLAIM ${formatClock(m.reclaim.info.remainingSec)}`}
          </button>
        )}
        {m.canSelfSettle && (
          <button
            type="button"
            className="scr-opt"
            data-testid="settle-self"
            disabled={m.busy || !m.walletConnected}
            title={
              m.walletConnected
                ? 'The server has not settled yet. Send its signed settlement yourself.'
                : 'Connect a wallet to send the settlement yourself.'
            }
            onClick={m.onSettleSelf}
          >
            SETTLE<span className="sr-only"> myself</span>
            {!m.walletConnected && <span className="sr-only"> (connect a wallet to send it)</span>}
          </button>
        )}
        <button
          type="button"
          className={m.choice === 0 ? 'scr-opt go on' : 'scr-opt go'}
          data-testid="new-game"
          onClick={m.onNewGame}
        >
          NEW GAME
        </button>
        {verify}
      </div>
      <p className="scr-print">
        <span data-testid="settle-tx" data-tx={r.txHash ?? ''} data-confirmed={m.confirmed} title={r.txHash ?? undefined}>
          {settleUrl === null ? (
            settle
          ) : (
            <a href={settleUrl} target="_blank" rel="noreferrer">
              {settle}
            </a>
          )}
        </span>
        {m.reclaim !== null && (
          <>
            {' · '}
            <ReclaimCountdown reclaim={m.reclaim} walletConnected={m.walletConnected} />
          </>
        )}
        {m.reclaim === null && m.canSelfSettle && !m.walletConnected && ' · Connect a wallet to settle it yourself.'}
      </p>
      <ChestDetails result={r} chests={chests} total={total} />
    </div>
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
 * The chest details behind the end screen's treasure figure: read by screen readers and kept for
 * the page's tests. Points have no cash value.
 */
function ChestDetails({ result, chests, total }: { result: GameResult; chests: FoundChest[]; total: bigint }) {
  return (
    <div className="sr-only">
      {chests.length > 0 && (
        <p data-testid="game-points-total" data-points={total.toString()}>
          Treasure +{formatPoints(total)} PT · no cash value
        </p>
      )}
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
        <section data-testid="game-chests" data-count={chests.length} data-points={total.toString()}>
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
