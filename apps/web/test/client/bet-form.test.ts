// The bet the lobby sets up: the slider's ticks and its mapping (snapping, 0.001 steps, the
// table's limits), the bet it starts on, why a bet is blocked and what the page says at each
// wallet and chain step.

import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  BET_GAS,
  BET_STEP_WEI,
  SNAP,
  betBlocked,
  betShortfall,
  betTicks,
  initialBet,
  maxAffordable,
  normalizeBet,
  sliderPosition,
  sliderValue,
  stepBet,
  stepPreset,
  stepTag,
  stepText,
  tickAt,
  type Preset,
} from '../../src/client/bet-form';
import type { BetStep } from '../../src/client/use-game';

const eth = (value: string): bigint => parseEther(value);
const labels = (presets: Preset[]): string[] => presets.map((p) => p.label);
const STEPS: BetStep[] = ['sign', 'ticket', 'tx', 'confirm'];
/** The tables in use bet from 0.001 to 0.1. */
const TICKS = betTicks(eth('0.001'), eth('0.1'));

describe('betTicks', () => {
  it('marks the table\'s limits and 0.01 and 0.05 between them, smallest first', () => {
    expect(labels(TICKS)).toEqual(['.001', '.01', '.05', '.1']);
    expect(TICKS.map((p) => p.wei)).toEqual(['0.001', '0.01', '0.05', '0.1'].map(eth));
    // The ends are always the limits; a mark on or outside them is left out.
    expect(labels(betTicks(eth('0.01'), eth('1')))).toEqual(['.01', '.05', '1']);
    expect(labels(betTicks(eth('0.001'), eth('0.04')))).toEqual(['.001', '.01', '.04']);
    expect(labels(betTicks(eth('0.02'), eth('0.03')))).toEqual(['.02', '.03']);
    expect(betTicks(eth('0.05'), eth('0.05'))).toEqual([{ wei: eth('0.05'), label: '.05' }]);
  });
});

describe('the slider mapping', () => {
  const at = (position: number): string => (Number(sliderValue(TICKS, position)) / 1e18).toFixed(3);

  it('spaces the ticks evenly: .001 at 0, .01 at a third, .05 at two thirds, .1 at the end', () => {
    expect(TICKS.map((t) => sliderPosition(TICKS, t.wei))).toEqual([0, 1 / 3, 2 / 3, 1]);
    expect([0, 1 / 3, 2 / 3, 1].map(at)).toEqual(['0.001', '0.010', '0.050', '0.100']);
  });

  it('is a straight line between two ticks, both ways', () => {
    // .01 to .05 over the middle third: 0.032 sits 22/40 of the way, at 0.5167.
    expect(sliderPosition(TICKS, eth('0.032'))).toBeCloseTo((1 + 22 / 40) / 3, 10);
    expect(at(0.517)).toBe('0.032');
    // .001 to .01 over the first third, .05 to .1 over the last.
    expect(sliderPosition(TICKS, eth('0.0055'))).toBeCloseTo(0.5 / 3, 10);
    expect(at(0.2)).toBe('0.006');
    expect(sliderPosition(TICKS, eth('0.075'))).toBeCloseTo(2.5 / 3, 10);
    expect(at(0.85)).toBe('0.078');
    // Every 0.001 maps to a position on the input (0..1000) and back to itself: without a pointer
    // nothing snaps, the amounts next to a tick included.
    for (let milli = 1; milli <= 100; milli++) {
      const wei = BigInt(milli) * BET_STEP_WEI;
      const position = Math.round(sliderPosition(TICKS, wei) * 1000) / 1000;
      expect(sliderValue(TICKS, position), `${milli} milli`).toBe(wei);
    }
  });

  it('snaps a pointer to a tick within 2% of the track, and not beyond; other input never snaps', () => {
    expect(SNAP).toBe(0.02);
    for (const [index, tick] of TICKS.entries()) {
      const p = index / 3;
      for (const d of [-0.02, -0.01, 0, 0.0199, 0.02]) {
        if (p + d < 0 || p + d > 1) continue;
        expect(sliderValue(TICKS, p + d, true), `${tick.label} ${d}`).toBe(tick.wei);
      }
    }
    const pointer = (position: number): bigint => sliderValue(TICKS, position, true);
    expect(pointer(2 / 3 + 0.021)).not.toBe(eth('0.05'));
    expect(pointer(2 / 3 - 0.021)).not.toBe(eth('0.05'));
    // Without a pointer the same positions are the amounts on the line.
    expect(at(2 / 3 + 0.02)).toBe('0.053');
    expect(at(2 / 3 - 0.01)).toBe('0.049');
    expect(at(1 / 3 + 0.0083)).toBe('0.011');
    expect(tickAt(TICKS, eth('0.05'))?.label).toBe('.05');
    expect(tickAt(TICKS, eth('0.032'))).toBeNull();
  });

  it('moves in steps of 0.001 between ticks', () => {
    for (let k = 0; k <= 1000; k++) {
      expect(sliderValue(TICKS, k / 1000) % BET_STEP_WEI, String(k)).toBe(0n);
    }
  });

  it('keeps the bet within the table\'s limits', () => {
    expect(sliderValue(TICKS, -1)).toBe(eth('0.001'));
    expect(sliderValue(TICKS, 2)).toBe(eth('0.1'));
    expect(sliderPosition(TICKS, eth('0.0001'))).toBe(0);
    expect(sliderPosition(TICKS, eth('5'))).toBe(1);
    // A minimum that is not a multiple of 0.001 is still the left end.
    const odd = betTicks(eth('0.0015'), eth('0.1'));
    expect(sliderValue(odd, 0)).toBe(eth('0.0015'));
    for (let k = 0; k <= 100; k++) {
      const v = sliderValue(odd, k / 100);
      expect(v >= eth('0.0015') && v <= eth('0.1'), String(k)).toBe(true);
    }
    // One tick only: the bet is that tick.
    const one = betTicks(eth('0.05'), eth('0.05'));
    expect([0, 0.5, 1].map((p) => sliderValue(one, p))).toEqual([eth('0.05'), eth('0.05'), eth('0.05')]);
  });

  it('steps 0.001 a key press, and stops at the limits', () => {
    expect(stepBet(TICKS, eth('0.032'), 1)).toBe(eth('0.033'));
    expect(stepBet(TICKS, eth('0.032'), -1)).toBe(eth('0.031'));
    expect(stepBet(TICKS, eth('0.1'), 1)).toBe(eth('0.1'));
    expect(stepBet(TICKS, eth('0.001'), -1)).toBe(eth('0.001'));
  });
});

describe('normalizeBet', () => {
  it('rounds a carried-over bet down to the 0.001 grid and keeps it within the table\'s limits', () => {
    expect(normalizeBet(TICKS, eth('0.0125'))).toBe(eth('0.012'));
    expect(normalizeBet(TICKS, eth('0.032'))).toBe(eth('0.032'));
    expect(normalizeBet(TICKS, eth('0.0329999'))).toBe(eth('0.032'));
    // Nothing, or less than the minimum: the minimum.
    expect(normalizeBet(TICKS, 0n)).toBe(eth('0.001'));
    expect(normalizeBet(TICKS, -1n)).toBe(eth('0.001'));
    expect(normalizeBet(TICKS, eth('0.0005'))).toBe(eth('0.001'));
    // More than the maximum: the maximum.
    expect(normalizeBet(TICKS, eth('0.5'))).toBe(eth('0.1'));
    expect(normalizeBet(TICKS, eth('0.1001'))).toBe(eth('0.1'));
    // A minimum off the grid is still the floor.
    expect(normalizeBet(betTicks(eth('0.0015'), eth('0.1')), eth('0.0019'))).toBe(eth('0.0015'));
  });
});

describe('maxAffordable', () => {
  it('is the balance less 250,000 gas at the fee bid, or nothing when that is more than the balance', () => {
    const price = 100_000_000_000n;
    expect(maxAffordable(eth('0.06'), price)).toBe(eth('0.035'));
    expect(maxAffordable(eth('0.025'), price)).toBe(0n);
    expect(maxAffordable(eth('0.02'), price)).toBeNull();
    // It is the boundary of betShortfall: that much is enough, a wei more is short.
    expect(betShortfall(eth('0.06'), eth('0.035'), price)).toBeNull();
    expect(betShortfall(eth('0.06'), eth('0.035') + 1n, price)).toBe(1n);
  });
});

describe('stepPreset', () => {
  const step = (wei: bigint | null, delta: 1 | -1): string | undefined => stepPreset(TICKS, wei, delta)?.label;

  it('moves one tick up or down from an amount on a tick (PageUp, PageDown, the D-pad), and stays at the ends', () => {
    expect(step(eth('0.05'), 1)).toBe('.1');
    expect(step(eth('0.05'), -1)).toBe('.01');
    expect(step(eth('0.1'), -1)).toBe('.05');
    expect(step(eth('0.1'), 1)).toBe('.1');
    expect(step(eth('0.01'), -1)).toBe('.001');
    expect(step(eth('0.001'), -1)).toBe('.001');
  });

  it('from an amount between two ticks goes to the tick above or below it', () => {
    expect(step(eth('0.03'), 1)).toBe('.05');
    expect(step(eth('0.03'), -1)).toBe('.01');
    expect(step(eth('0.005'), 1)).toBe('.01');
    expect(step(eth('0.005'), -1)).toBe('.001');
    // Outside every tick: the nearest end.
    expect(step(eth('0.5'), 1)).toBe('.1');
    expect(step(eth('0.5'), -1)).toBe('.1');
  });

  it('starts at the first tick when there is no amount, and has nothing without ticks', () => {
    expect(step(null, 1)).toBe('.001');
    expect(step(null, -1)).toBe('.001');
    expect(stepPreset([], eth('0.01'), 1)).toBeNull();
  });
});

describe('initialBet', () => {
  it('starts at 0.05, kept within the table\'s limits', () => {
    expect(initialBet(TICKS)).toBe(eth('0.05'));
    expect(initialBet(betTicks(eth('0.1'), eth('1')))).toBe(eth('0.1'));
    expect(initialBet(betTicks(eth('0.001'), eth('0.04')))).toBe(eth('0.04'));
    expect(initialBet(betTicks(eth('0.0001'), eth('0.002')))).toBe(eth('0.002'));
    expect(initialBet(betTicks(eth('0.06'), eth('0.09')))).toBe(eth('0.06'));
  });
});

describe('betBlocked', () => {
  const limits = { minWei: eth('0.001'), maxWei: eth('0.1') };
  const ok = { walletConnected: true, betWei: eth('0.05'), ...limits, seedOk: true };

  it('names the first thing in the way: the wallet, then the amount, then the seed', () => {
    expect(betBlocked({ ...ok, walletConnected: false, seedOk: false })).toBe('Connect a wallet first');
    expect(betBlocked({ ...ok, walletConnected: false, shortWei: eth('1') })).toBe('Connect a wallet first');
    expect(betBlocked({ ...ok, betWei: 0n, seedOk: false })).toBe('Choose a bet');
    expect(betBlocked({ ...ok, seedOk: false })).toBe('The client seed must be 0x followed by 64 hex digits');
    expect(betBlocked(ok)).toBeNull();
  });

  it('never lets an amount outside the table\'s limits through', () => {
    expect(betBlocked({ ...ok, betWei: 0n })).toBe('Choose a bet');
    expect(betBlocked({ ...ok, betWei: -1n })).toBe('Choose a bet');
    expect(betBlocked({ ...ok, betWei: eth('0.0009'), symbol: 'MON' })).toBe('The minimum bet is 0.001 MON');
    expect(betBlocked({ ...ok, betWei: eth('0.1001'), symbol: 'MON' })).toBe('The maximum bet is 0.1 MON');
    expect(betBlocked({ ...ok, betWei: eth('0.001') })).toBeNull();
    expect(betBlocked({ ...ok, betWei: eth('0.1') })).toBeNull();
  });

  it('then a balance that cannot pay the bet and its fee, naming what is missing', () => {
    expect(betBlocked({ ...ok, shortWei: eth('0.0123'), symbol: 'MON' })).toBe(
      'Not enough MON: the bet and its network fee need 0.0123 MON more',
    );
    expect(betBlocked({ ...ok, shortWei: null })).toBeNull();
  });
});

describe('betShortfall', () => {
  it('counts the bet and 250,000 gas of the bet transaction at the fee bid per gas', () => {
    expect(BET_GAS).toBe(250_000n);
    // 100 gwei: the fee is 0.025, more than a 0.01 bet.
    const price = 100_000_000_000n;
    expect(betShortfall(eth('0.035'), eth('0.01'), price)).toBeNull();
    expect(betShortfall(eth('0.025'), eth('0.01'), price)).toBe(eth('0.01'));
    expect(betShortfall(eth('0.0349'), eth('0.01'), price)).toBe(eth('0.0001'));
  });
});

describe('stepText', () => {
  it('a browser wallet is told which of its two prompts to approve', () => {
    for (const kind of ['injected', null] as const) {
      expect(stepText('sign', kind)).toContain('Wallet 1 of 2');
      expect(stepText('sign', kind)).toContain('approve the ticket request signature');
      expect(stepText('sign', kind)).toContain('sends no money');
      expect(stepText('tx', kind)).toContain('Wallet 2 of 2');
      expect(stepText('tx', kind)).toContain('approve the bet transaction');
    }
  });

  it('the dev wallet is named and never told to approve anything', () => {
    expect(stepText('sign', 'dev')).toContain('dev wallet');
    expect(stepText('tx', 'dev')).toContain('dev wallet');
    for (const step of STEPS) {
      expect(stepText(step, 'dev')).not.toContain('approve');
      expect(stepText(step, 'dev')).not.toContain('of 2');
    }
  });

  it('the server and chain steps read the same for both wallets', () => {
    for (const step of ['ticket', 'confirm'] as const) {
      expect(stepText(step, 'dev')).toBe(stepText(step, 'injected'));
    }
    expect(stepText('ticket', 'dev')).toContain('maze');
    expect(stepText('confirm', 'dev')).toContain('block');
  });

  it('says what the step waits for in plain words: no hashes or commitments on the console', () => {
    for (const kind of ['injected', 'dev', 'privy', null] as const) {
      for (const step of STEPS) {
        expect(stepText(step, kind)).not.toMatch(/hash|commit/i);
        expect(stepTag(step)).not.toMatch(/hash|commit/i);
      }
    }
  });

  it('every step has its own screen tag', () => {
    const tags = STEPS.map(stepTag);
    expect(new Set(tags).size).toBe(STEPS.length);
    for (const tag of tags) expect(tag).toMatch(/^[A-Z ]+\.\.\.$/);
  });
});
