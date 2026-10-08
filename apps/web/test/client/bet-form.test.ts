// The bet the lobby sets up: the dock's chips, the amount checks, why a bet is blocked and what
// the page says at each wallet and chain step.

import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  BET_GAS,
  betBlocked,
  betPresets,
  betShortfall,
  initialAmount,
  readAmount,
  stepPreset,
  stepTag,
  stepText,
  type Preset,
} from '../../src/client/bet-form';
import type { BetStep } from '../../src/client/use-game';

const eth = (value: string): bigint => parseEther(value);
const labels = (presets: Preset[]): string[] => presets.map((p) => p.label);
const STEPS: BetStep[] = ['sign', 'ticket', 'tx', 'confirm'];

describe('betPresets', () => {
  it('offers the chips 0.01, 0.05 and 0.1 that lie within the limits, smallest first', () => {
    const presets = betPresets(eth('0.001'), eth('0.1'));
    expect(labels(presets)).toEqual(['.01', '.05', '.1']);
    expect(presets.map((p) => p.wei)).toEqual(['0.01', '0.05', '0.1'].map(eth));
    // The limits themselves need not be chips: a smaller or larger amount is typed into the field.
    expect(labels(betPresets(eth('0.0001'), eth('10')))).toEqual(['.01', '.05', '.1']);
  });

  it('leaves out the chips outside the limits', () => {
    expect(labels(betPresets(eth('0.02'), eth('1')))).toEqual(['.05', '.1']);
    expect(labels(betPresets(eth('0.001'), eth('0.04')))).toEqual(['.01']);
    expect(labels(betPresets(eth('0.05'), eth('0.05')))).toEqual(['.05']);
    expect(labels(betPresets(eth('0.1'), eth('10')))).toEqual(['.1']);
    for (const [min, max] of [
      ['0.02', '1'],
      ['0.001', '0.04'],
      ['0.1', '10'],
    ] as const) {
      expect(betPresets(eth(min), eth(max)).every((p) => p.wei >= eth(min) && p.wei <= eth(max))).toBe(true);
    }
  });

  it('falls back to the limits themselves when no chip fits', () => {
    expect(betPresets(eth('0.011'), eth('0.019'))).toEqual([
      { wei: eth('0.011'), label: '.011' },
      { wei: eth('0.019'), label: '.019' },
    ]);
    expect(betPresets(eth('0.2'), eth('1'))).toEqual([
      { wei: eth('0.2'), label: '.2' },
      { wei: eth('1'), label: '1' },
    ]);
    expect(betPresets(eth('0.0015'), eth('0.0015'))).toEqual([{ wei: eth('0.0015'), label: '.0015' }]);
  });
});

describe('stepPreset', () => {
  const presets = betPresets(eth('0.001'), eth('0.1'));
  const step = (wei: bigint | null, delta: 1 | -1): string | undefined => stepPreset(presets, wei, delta)?.label;

  it('moves one chip up or down from an amount on a chip, and stays at the ends', () => {
    expect(step(eth('0.05'), 1)).toBe('.1');
    expect(step(eth('0.05'), -1)).toBe('.01');
    expect(step(eth('0.1'), -1)).toBe('.05');
    expect(step(eth('0.1'), 1)).toBe('.1');
    expect(step(eth('0.01'), -1)).toBe('.01');
  });

  it('from an amount between two chips goes to the chip above or below it', () => {
    expect(step(eth('0.03'), 1)).toBe('.05');
    expect(step(eth('0.03'), -1)).toBe('.01');
    // Outside every chip: the nearest end. A typed 0.005 lies below the first chip.
    expect(step(eth('0.5'), 1)).toBe('.1');
    expect(step(eth('0.5'), -1)).toBe('.1');
    expect(step(eth('0.005'), 1)).toBe('.01');
    expect(step(eth('0.005'), -1)).toBe('.01');
  });

  it('starts at the first chip when the amount is unreadable, and has nothing without chips', () => {
    expect(step(null, 1)).toBe('.01');
    expect(step(null, -1)).toBe('.01');
    expect(stepPreset([], eth('0.01'), 1)).toBeNull();
  });
});

describe('initialAmount and readAmount', () => {
  it('starts the field at 0.05, kept within the limits', () => {
    expect(initialAmount(eth('0.001'), eth('0.1'))).toBe('0.05');
    expect(initialAmount(eth('0.1'), eth('1'))).toBe('0.1');
    expect(initialAmount(eth('0.0001'), eth('0.002'))).toBe('0.002');
  });

  it('reads a plain decimal amount within the limits, and names the problem otherwise', () => {
    const min = eth('0.001');
    const max = eth('0.1');
    expect(readAmount('0.01', min, max)).toEqual({ betWei: eth('0.01') });
    expect(readAmount(' 0.05 ', min, max)).toEqual({ betWei: eth('0.05') });
    expect(readAmount('0.001', min, max)).toEqual({ betWei: min });
    expect(readAmount('0.1', min, max)).toEqual({ betWei: max });
    expect(readAmount('0.0001', min, max)).toEqual({ reason: 'The minimum bet is 0.001 ETH' });
    expect(readAmount('1', min, max)).toEqual({ reason: 'The maximum bet is 0.1 ETH' });
    for (const garbage of ['abc', '', '1e-2', '-0.01', '0,01', '.01', '0.01 ETH']) {
      expect(readAmount(garbage, min, max), garbage).toEqual({ reason: 'Enter the bet in ETH, for example 0.01' });
    }
  });
});

describe('betBlocked', () => {
  it('names the first thing in the way: the wallet, then the amount, then the seed', () => {
    expect(betBlocked({ walletConnected: false, amountReason: 'too small', seedOk: false })).toBe(
      'Connect a wallet first',
    );
    expect(betBlocked({ walletConnected: true, amountReason: 'too small', seedOk: false })).toBe('too small');
    expect(betBlocked({ walletConnected: true, amountReason: null, seedOk: false })).toBe(
      'The client seed must be 0x followed by 64 hex digits',
    );
    expect(betBlocked({ walletConnected: true, amountReason: null, seedOk: true })).toBeNull();
  });

  it('then a balance that cannot pay the bet and its fee, naming what is missing', () => {
    expect(betBlocked({ walletConnected: true, amountReason: null, seedOk: true, shortWei: eth('0.0123'), symbol: 'MON' })).toBe(
      'Not enough MON: the bet and its network fee need 0.0123 MON more',
    );
    expect(betBlocked({ walletConnected: true, amountReason: null, seedOk: true, shortWei: null })).toBeNull();
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
    expect(stepText('ticket', 'dev')).toContain('commit');
    expect(stepText('confirm', 'dev')).toContain('block');
  });

  it('every step has its own screen tag', () => {
    const tags = STEPS.map(stepTag);
    expect(new Set(tags).size).toBe(STEPS.length);
    for (const tag of tags) expect(tag).toMatch(/^[A-Z ]+\.\.\.$/);
  });
});
