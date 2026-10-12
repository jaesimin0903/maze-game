'use client';

// The device's side panel, folded out beside the console like a Pokédex's: an LCD that holds every
// figure of the bet (difficulty, multiplier, stake, exit payout, odds), the difficulty keys, the
// bet slider, and two small keys, MIX (a new client seed) and RANK (the leaderboard).

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { StartSide } from '@maze/shared';
import {
  BET_STEP_WEI,
  sliderPosition,
  sliderValue,
  stepBet,
  stepPreset,
  tickAt,
  type Preset,
} from '../bet-form';
import { escapeOdds, tierTone } from '../config';
import { formatEth, formatEthFixed, formatMultiplier, formatMultiplierShort } from '../format';
import { useNetwork } from '../network';
import { DomInput } from './DomInput';

export interface DexTier {
  index: number;
  n: number;
  multiplierBps: number;
  /** EASY, NORMAL, HARD. */
  name: string;
}

const three = (wei: bigint): string => formatEthFixed(wei, 3);

/** Wei rounded up to three decimals: what the wallet must add at least. */
function threeUp(wei: bigint): string {
  return three(((wei + BET_STEP_WEI - 1n) / BET_STEP_WEI) * BET_STEP_WEI);
}

export function DexPanel(p: {
  tiers: DexTier[];
  /** The chosen tier, or the game's. */
  tier: number;
  ticks: Preset[];
  /** The slider's bet, or the game's. */
  betWei: bigint;
  exitWei: bigint;
  /** The largest bet the wallet pays with the fee reserved; `null` while it is not known. */
  affordWei: bigint | null;
  /** What the wallet lacks for the bet and its fee, or `null` when it has enough. */
  shortWei: bigint | null;
  faucetUrl: string | null;
  /** The client seed, kept in a hidden field; the screen shows its look. */
  seedText: string;
  /** The side the seed opens the start to, for MIX. */
  startSide: StartSide | null;
  /** What locks the panel (a bet being placed, a game on or over), or `null` in the lobby. */
  lock: 'SIGNING' | 'PLACING BET' | 'IN GAME' | 'GAME OVER' | null;
  /** Changes on every A pressed while the wallet is short: the NEED bubble pulses. */
  pulse: number;
  onTier(index: number): void;
  onBet(wei: bigint): void;
  onSeed(text: string): void;
  onReroll(): void;
  onRank(): void;
}) {
  const { symbol } = useNetwork();
  const tier = p.tiers[p.tier] ?? p.tiers[0];
  const odds = escapeOdds(tier.n);
  const locked = p.lock !== null;
  return (
    <div className="dex" data-testid="side-panel" data-locked={locked} role="group" aria-label="Difficulty and bet">
      <span className="screw" style={{ left: 12, top: 12 }} aria-hidden="true" />
      <span className="screw" style={{ right: 14, top: 12 }} aria-hidden="true" />
      <span className="screw" style={{ left: 12, bottom: 14 }} aria-hidden="true" />

      {/* Every figure of the bet lives here. The slider speaks its own value, so this is not live. */}
      <div className="lcd" data-testid="lcd" data-tier={tier.index}>
        <div className="lr">
          <span className={`t-${tierTone(tier.index)}`}>
            {tier.name} {tier.n}×{tier.n}
          </span>
          <span className="y" title={`The exit pays ${formatMultiplier(tier.multiplierBps)} the bet`}>
            {formatMultiplierShort(tier.multiplierBps)}
          </span>
        </div>
        <div className="lr">
          <span>
            {three(p.betWei)} {symbol}
          </span>
          <span className="y">
            →{' '}
            <span data-testid="escape-payout" data-wei={p.exitWei.toString()} title="The exit pays">
              {three(p.exitWei)}
              <span className="sr-only"> {symbol} at the exit</span>
            </span>
          </span>
        </div>
        <div
          className="lr small"
          data-testid="lcd-odds"
          title={p.lock === null && odds !== null ? 'Exit-seeking player, simulated (docs/escape-report.md)' : undefined}
        >
          {p.lock !== null ? (
            <>
              <span>{p.lock}</span>
              <span>LOCKED</span>
            </>
          ) : odds !== null ? (
            <>
              <span>WIN ~{odds.percent}</span>
              <span>~1 IN {odds.oneIn}</span>
              <span className="sr-only"> for a player who heads for the exit, simulated</span>
            </>
          ) : (
            <span>WIN —</span>
          )}
        </div>
      </div>

      <div className="drow" role="group" aria-label="Difficulty">
        {p.tiers.map((t) => {
          const on = t.index === tier.index;
          return (
            <button
              key={t.index}
              type="button"
              className={`dk dk-${tierTone(t.index)}${on ? ' on' : ''}`}
              data-testid={`tier-${t.index}`}
              data-selected={on}
              data-n={t.n}
              data-multiplier-bps={t.multiplierBps}
              aria-pressed={on}
              aria-label={`${t.name}, ${t.n}×${t.n}, ${formatMultiplierShort(t.multiplierBps)}`}
              disabled={locked}
              onClick={() => p.onTier(t.index)}
            >
              {t.name}
            </button>
          );
        })}
      </div>

      <BetSlider
        ticks={p.ticks}
        betWei={p.betWei}
        affordWei={p.affordWei}
        shortWei={p.shortWei}
        faucetUrl={p.faucetUrl}
        disabled={locked}
        pulse={p.pulse}
        onBet={p.onBet}
      />

      <div className="grow">
        <button
          type="button"
          className="gk"
          data-testid="reroll"
          data-start-side={p.startSide ?? ''}
          aria-label="Mix the dungeon: a new client seed"
          title="A new client seed: a new look, and maybe the other start side"
          disabled={locked}
          onClick={p.onReroll}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="8" cy="8" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="16" cy="16" r="1.8" />
          </svg>
          MIX
        </button>
        <button type="button" className="gk" data-testid="rank-open" aria-label="Show the leaderboard" onClick={p.onRank}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 20 V13 M10 20 V6 M16 20 V10 M2 20 H22" />
          </svg>
          RANK
        </button>
      </div>

      <div className="slots" aria-hidden="true">
        <i />
        <i />
      </div>

      {/* The seed itself, kept out of sight; scripts may set it, and the screen follows. */}
      {!locked && (
        <DomInput
          type="hidden"
          id="client-seed"
          name="client-seed"
          data-testid="client-seed-input"
          value={p.seedText}
          onValue={p.onSeed}
        />
      )}
    </div>
  );
}

/**
 * The bet, on a track with a tick at every mark, evenly spaced. A pointer that lets go near a tick
 * puts the bet on it (the bubble shows ◆); everywhere else it moves in steps of 0.001. Arrow keys
 * step 0.001, PageUp and PageDown jump between ticks, Home and End go to the limits; neither they
 * nor assistive technology ever snap. The track past what the wallet can pay is hatched; a bet
 * past it turns the fill and the thumb red.
 */
export function BetSlider(p: {
  ticks: Preset[];
  betWei: bigint;
  affordWei: bigint | null;
  shortWei: bigint | null;
  faucetUrl: string | null;
  disabled: boolean;
  /** Changes on every A pressed while short: the NEED bubble pulses. */
  pulse: number;
  onBet(wei: bigint): void;
}) {
  const { symbol } = useNetwork();
  const { ticks, betWei } = p;
  const last = ticks[ticks.length - 1];
  const gaps = Math.max(1, ticks.length - 1);
  const position = sliderPosition(ticks, betWei);
  const thumb = String(Math.round(position * 1000));
  const onTick = tickAt(ticks, betWei);
  const red = p.shortWei !== null;
  // Where the hatching starts: at what the wallet can pay, or the whole track when it cannot pay
  // the smallest bet.
  const hatch = p.affordWei === null || p.affordWei >= last.wei ? null : sliderPosition(ticks, p.affordWei);
  const below = ticks.reduce((index, t, k) => (t.wei <= betWei ? k : index), -1);

  // The range input's DOM value is read by native listeners, so a value set by script (browser
  // automation) counts as one set by hand; React's own change tracking drops those. It is put back
  // on the bet's own place after every render and after every change that left the bet as it was.
  const input = useRef<HTMLInputElement>(null);
  const pointer = useRef(false);
  const latest = useRef({ ticks, betWei, onBet: p.onBet });
  useEffect(() => {
    latest.current = { ticks, betWei, onBet: p.onBet };
  });
  useLayoutEffect(() => {
    const el = input.current;
    if (el && el.value !== thumb) el.value = thumb;
  });
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const listener = (event: Event): void => {
      const { ticks: marks, betWei: now, onBet } = latest.current;
      // The bet's own place, in the input's units.
      const here = Math.round(sliderPosition(marks, now) * 1000);
      const value = Number(el.value);
      const fromPointer = pointer.current;
      // The change that ends a drag is the pointer's last word.
      if (event.type === 'change') pointer.current = false;
      // Nothing moved: the change after a release, or the same place set again.
      if (value === here) return;
      // The nearest 0.001 on the line (or, for a pointer, the tick it lets go near).
      let next = sliderValue(marks, value / 1000, fromPointer);
      // Assistive technology steps the input by one unit, which can be less than 0.001 of bet: such
      // a step from the bet's place still moves the bet by 0.001.
      if (!fromPointer && next === now && Math.abs(value - here) === 1) next = stepBet(marks, now, value > here ? 1 : -1);
      if (next !== now) onBet(next);
      else el.value = String(here);
    };
    el.addEventListener('input', listener);
    el.addEventListener('change', listener);
    return () => {
      el.removeEventListener('input', listener);
      el.removeEventListener('change', listener);
    };
  }, []);

  const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    let next: bigint | null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = stepBet(ticks, betWei, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = stepBet(ticks, betWei, -1);
        break;
      case 'PageUp':
        next = stepPreset(ticks, betWei, 1)?.wei ?? null;
        break;
      case 'PageDown':
        next = stepPreset(ticks, betWei, -1)?.wei ?? null;
        break;
      case 'Home':
        next = ticks[0].wei;
        break;
      case 'End':
        next = last.wei;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next !== null && next !== betWei) p.onBet(next);
  };

  return (
    <div className={p.disabled ? 'sl dimmed' : 'sl'}>
      <div className="slh">
        <span className="eng" aria-hidden="true">
          BET
        </span>
        {red && p.faucetUrl !== null && (
          <a className="sl-link" data-testid="bet-faucet" href={p.faucetUrl} target="_blank" rel="noreferrer">
            GET {symbol}
          </a>
        )}
        {p.shortWei !== null ? (
          <span className="bub red" data-testid="bet-short" data-wei={p.shortWei.toString()}>
            <span key={p.pulse} className={p.pulse > 0 ? 'need pulse' : 'need'}>
              NEED {threeUp(p.shortWei)}
            </span>
            <span className="sr-only"> {symbol} more for the bet and its network fee</span>
            {/* Said once, when the bet becomes too much; the amount above changes silently. */}
            <span className="sr-only" role="alert" data-testid="bet-short-alert">
              Not enough {symbol} for this bet
            </span>
          </span>
        ) : (
          <span className="bub" data-testid="bet-bubble" aria-hidden="true">
            {three(betWei)}
            {onTick !== null ? ' ◆' : ''}
          </span>
        )}
      </div>
      <div className="trk">
        {hatch !== null && (
          <i className="no" data-testid="bet-hatch" data-from={hatch.toFixed(4)} style={{ left: `${hatch * 100}%` }} />
        )}
        <i className={red ? 'fill red' : 'fill'} style={{ width: `${position * 100}%` }} />
        {ticks.map((t, k) => (
          <i key={t.label} className={t.wei <= betWei ? 'tk on' : 'tk'} style={{ left: `${(k / gaps) * 100}%` }} />
        ))}
        <i className={red ? 'th red' : 'th'} style={{ left: `${position * 100}%` }} />
        <input
          ref={input}
          type="range"
          className="rng"
          min={0}
          max={1000}
          step={1}
          defaultValue={thumb}
          onKeyDown={onKey}
          onPointerDown={() => {
            pointer.current = true;
          }}
          onPointerUp={(event) => {
            // Let go: the bet is set, and Space, Z and the arrows are the game's keys again. The
            // change a browser sends after the release still counts as the pointer's.
            event.currentTarget.blur();
            setTimeout(() => {
              pointer.current = false;
            }, 0);
          }}
          onPointerCancel={() => {
            pointer.current = false;
          }}
          disabled={p.disabled}
          data-testid="bet-slider"
          data-wei={betWei.toString()}
          data-short={red}
          aria-label={`Bet in ${symbol}`}
          aria-valuetext={`${three(betWei)} ${symbol}`}
        />
      </div>
      <div className="tl">
        {ticks.map((t, k) => (
          <button
            key={t.label}
            type="button"
            className={k === below ? 'on' : undefined}
            data-testid={`bet-preset-${t.label}`}
            style={{ left: `${(k / gaps) * 100}%` }}
            aria-label={`Bet ${formatEth(t.wei)} ${symbol}`}
            aria-pressed={t.wei === betWei}
            disabled={p.disabled}
            onClick={() => p.onBet(t.wei)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
