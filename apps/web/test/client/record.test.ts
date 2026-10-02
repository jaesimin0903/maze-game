import { beforeEach, describe, expect, it } from 'vitest';
import type { GameView, Hex } from '@maze/shared';
import { formatClock, formatEth, formatMultiplier, formatPercent, parseEthInput } from '../../src/client/format';
import {
  activeGameId,
  dirBetween,
  loadRecord,
  parseRecord,
  recordKey,
  saveRecord,
  setActiveGameId,
  withView,
  type PlayRecord,
} from '../../src/client/record';
import { hashSessionToken, isHex32, newSessionToken, randomHex32 } from '../../src/client/seed';

const GAME_ID: Hex = `0x${'a1'.repeat(32)}`;
const COMMITMENT: Hex = `0x${'b2'.repeat(32)}`;
const CLIENT_SEED: Hex = `0x${'c3'.repeat(32)}`;

const fresh = (): PlayRecord => ({
  gameId: GAME_ID,
  tier: 0,
  n: 5,
  commitment: COMMITMENT,
  clientSeed: CLIENT_SEED,
  token: 'token',
  observations: [],
  moves: [],
});

const view = (over: Partial<GameView>): GameView => ({
  gameId: GAME_ID,
  tier: 0,
  n: 5,
  status: 'active',
  auto: false,
  step: 0,
  cell: { x: 0, y: 0 },
  open: 2,
  betWei: '10000000000000000',
  refundableWei: '9500000000000000',
  exitPayoutWei: '20000000000000000',
  chainNowSec: 100,
  idleDeadlineSec: 220,
  gameDeadlineSec: 1000,
  settleDeadlineSec: 1900,
  ...over,
});

beforeEach(() => window.localStorage.clear());

describe('withView', () => {
  it('appends one observation per answer and the move that led to it', () => {
    let record = withView(fresh(), view({}));
    record = withView(record, view({ step: 1, cell: { x: 1, y: 0 }, open: 12 }), 1);
    record = withView(record, view({ step: 2, cell: { x: 1, y: 1 }, open: 7 }), 2);
    expect(record.observations).toEqual([
      { step: 0, cell: 0, open: 2 },
      { step: 1, cell: 1, open: 12 },
      { step: 2, cell: 6, open: 7 },
    ]);
    expect(record.moves).toEqual([1, 2]);
  });

  it('never overwrites what the server showed first', () => {
    const first = withView(fresh(), view({}));
    const again = withView(first, view({ open: 6, path: [{ x: 0, y: 0, open: 6 }] }));
    expect(again.observations).toEqual([{ step: 0, cell: 0, open: 2 }]);
  });

  it('rebuilds missing steps and their moves from the path of a resume read', () => {
    const first = withView(fresh(), view({}));
    const resumed = withView(
      first,
      view({
        step: 2,
        cell: { x: 1, y: 1 },
        open: 7,
        path: [
          { x: 0, y: 0, open: 2 },
          { x: 1, y: 0, open: 12 },
          { x: 1, y: 1, open: 7 },
        ],
      }),
    );
    expect(resumed.observations.map((o) => o.cell)).toEqual([0, 1, 6]);
    expect(resumed.moves).toEqual([1, 2]);
  });

  it('does not record an answer that skips a step', () => {
    const first = withView(fresh(), view({}));
    const skipped = withView(first, view({ step: 2, cell: { x: 1, y: 1 }, open: 7 }));
    expect(skipped.observations).toHaveLength(1);
    expect(skipped.moves).toEqual([]);
  });

  it('keeps the terminal data and whether the server ended the game itself', () => {
    const terminal = {
      serverSeed: `0x${'d4'.repeat(32)}` as Hex,
      clientSeed: CLIENT_SEED,
      outcome: 1 as const,
      steps: 0,
      payoutWei: '9500000000000000',
      signature: '0x00' as Hex,
      settleTxHash: null,
    };
    const ended = withView(fresh(), view({ status: 'cashed_out', auto: true, terminal }));
    expect(ended.terminal).toEqual(terminal);
    expect(ended.auto).toBe(true);
  });
});

describe('storage', () => {
  it('stores the record under the key of plan §7.6 and reads it back', () => {
    const record = withView(fresh(), view({}));
    saveRecord(record);
    expect(recordKey(GAME_ID)).toBe(`maze:record:${GAME_ID}`);
    const stored = JSON.parse(window.localStorage.getItem(`maze:record:${GAME_ID}`) as string);
    expect(Object.keys(stored)).toEqual(
      expect.arrayContaining([
        'gameId',
        'tier',
        'n',
        'commitment',
        'clientSeed',
        'token',
        'observations',
        'moves',
      ]),
    );
    expect(loadRecord(GAME_ID)).toEqual(record);
  });

  it('answers null for an unknown game and for unreadable content', () => {
    expect(loadRecord(GAME_ID)).toBeNull();
    window.localStorage.setItem(recordKey(GAME_ID), '{broken');
    expect(loadRecord(GAME_ID)).toBeNull();
  });

  it('remembers which game to resume', () => {
    expect(activeGameId()).toBeNull();
    setActiveGameId(GAME_ID);
    expect(activeGameId()).toBe(GAME_ID);
    setActiveGameId(null);
    expect(activeGameId()).toBeNull();
  });
});

describe('parseRecord', () => {
  it('accepts a record with exactly the §7.6 fields', () => {
    const parsed = parseRecord(JSON.parse(JSON.stringify(withView(fresh(), view({})))));
    expect(parsed.observations).toEqual([{ step: 0, cell: 0, open: 2 }]);
    expect(parsed.betWei).toBeUndefined();
  });

  it('rejects malformed records with a message naming the field', () => {
    expect(() => parseRecord(null)).toThrow(/JSON 객체/);
    expect(() => parseRecord({ ...fresh(), gameId: '0x12' })).toThrow(/gameId/);
    expect(() => parseRecord({ ...fresh(), observations: [{ step: 0, cell: 0, open: 16 }] })).toThrow(
      /observations\[0\]/,
    );
    expect(() => parseRecord({ ...fresh(), moves: [4] })).toThrow(/moves\[0\]/);
    expect(() => parseRecord({ ...fresh(), terminal: { outcome: 3 } })).toThrow(/terminal/);
  });
});

describe('dirBetween', () => {
  it('names the direction between adjacent cells and nothing else', () => {
    expect(dirBetween(5, 6, 1)).toBe(0);
    expect(dirBetween(5, 6, 7)).toBe(1);
    expect(dirBetween(5, 6, 11)).toBe(2);
    expect(dirBetween(5, 6, 5)).toBe(3);
    expect(dirBetween(5, 4, 5)).toBeNull();
    expect(dirBetween(5, 0, 12)).toBeNull();
  });
});

describe('seed', () => {
  it('produces 32-byte hex seeds and a token whose hash is sha256 of its UTF-8 bytes', () => {
    expect(isHex32(randomHex32())).toBe(true);
    expect(randomHex32()).not.toBe(randomHex32());
    expect(newSessionToken()).toMatch(/^[0-9a-f]{64}$/);
    // sha256("abc")
    expect(hashSessionToken('abc')).toBe(
      '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('format', () => {
  it('prints wei as ETH rounded down, never overstating an amount', () => {
    expect(formatEth(10n ** 16n)).toBe('0.01');
    expect(formatEth(9_500_000_000_000_000n)).toBe('0.0095');
    expect(formatEth(1_999_999_999_999_999_999n)).toBe('1.999999');
    expect(formatEth(0n)).toBe('0');
    expect(formatEth(1n)).toBe('<0.000001');
    expect(formatEth(2n * 10n ** 18n)).toBe('2');
  });

  it('parses a typed ETH amount and rejects anything that is not a plain decimal', () => {
    expect(parseEthInput(' 0.01 ')).toBe(10n ** 16n);
    expect(parseEthInput('1')).toBe(10n ** 18n);
    expect(parseEthInput('')).toBeNull();
    expect(parseEthInput('-1')).toBeNull();
    expect(parseEthInput('1e-2')).toBeNull();
    expect(parseEthInput('0.0000000000000000001')).toBeNull();
  });

  it('prints basis points, multipliers and chain-second countdowns', () => {
    expect(formatPercent(9500)).toBe('95.00%');
    expect(formatPercent(7300)).toBe('73.00%');
    expect(formatMultiplier(25500)).toBe('2.55배');
    expect(formatClock(125)).toBe('2:05');
    expect(formatClock(-3)).toBe('0:00');
  });
});
