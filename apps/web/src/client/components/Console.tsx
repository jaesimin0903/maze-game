'use client';

import type { CSSProperties, ReactNode } from 'react';
import type { Dir, FoundChest, Hex, Observation } from '@maze/shared';
import { DIRS, DIR_NAMES, boardCells } from '../board-view';
import { tierTone } from '../config';
import type { Dungeon } from '../dungeon';
import { formatEth, formatPoints } from '../format';
import { useNetwork } from '../network';
import { cellBox, playTiles, readyTiles, screenCols, type Facing } from '../screen-model';
import type { PlaceStep } from '../bet-form';
import type { ResultOutcome } from '../use-game';

export interface ScreenTimer {
  text: string;
  urgent: boolean;
  remainingSec: number | null;
  deadlineSec: number;
}

export interface EndFigures {
  payoutWei: bigint;
  /** The bet, when known: a dead end shows it as the loss. */
  betWei: bigint | null;
  /**
   * What the bet transaction cost in fees, from its receipt; `null` when the page does not have
   * it (a game restored without its transaction, a receipt that could not be read).
   */
  feeWei: bigint | null;
  /** Treasure points found in this game; they have no cash value. */
  points: bigint;
}

export interface ScreenNotice {
  text: string;
  /** Set when the notice announces a chest the last move found. */
  chest?: FoundChest;
  /** The server has not shown the first cell yet. */
  waiting?: boolean;
  /** The step the message waits on, while the bet is being placed. */
  step?: PlaceStep;
  /** The message is why the last bet failed. */
  error?: boolean;
}

interface Props {
  n: number;
  /** `null` before a game exists: the screen shows the empty grid of the chosen size. */
  gameId: Hex | null;
  /** What the server has shown, in order; empty before the first cell. */
  observations: Observation[];
  facing: Facing;
  /** Directions the player may move in right now. */
  legal: Dir[];
  /** A move is on its way to the server. */
  moving: boolean;
  /** Changes on every refused press, to replay the bump animation. */
  bumpTick: number;
  ended: ResultOutcome | null;
  /** The dead-end chest of the ending, once the server named it. */
  deadEndChest: { x: number; y: number } | null;
  /** The chests found so far, as the server listed them. */
  found: FoundChest[];
  /** What the game paid and the points it found, for the end screen; `null` until it has ended. */
  endFigures: EndFigures | null;
  /** The client seed's look (theme, torches, start side); `null` for a seed that is not valid hex. */
  dungeon: Dungeon | null;
  /** Before the bet: the seed's short name in the corner, the rest of the seed stays hidden. */
  showSeed: boolean;
  tag: string | null;
  timer: ScreenTimer | null;
  notice: ScreenNotice | null;
  /** What the console is showing, as `data-mode`: ready, betting, waiting, play, confirm, ended, reclaim. */
  mode: string;
  /** The row between the status line and the screen: the bet, the HP meter or the result. */
  hp: ReactNode;
  /**
   * What lies over the screen: the bet A places, the steps while it is placed, the cash-out
   * question, the end choices; or `null`.
   */
  menu: ReactNode;
  /** The tiers' difficulty names, and the one chosen (or the game's): one LED each, that one lit. */
  difficulty: { names: string[]; index: number };
  /** The connected wallet's balance; `null` without a wallet or before its first read. */
  balanceWei: bigint | null;
  /** What A does now; its name is engraved under it. */
  action: ConsoleAction;
  onDir(dir: Dir): void;
  /** A tap on a cell next to the hero: a step that way, and nothing else. */
  onCell(dir: Dir): void;
  onA(): void;
}

export type ConsoleAction = 'start' | 'cashout' | 'settling' | 'new-game' | 'verify';

const ACTION_TEXT: Record<ConsoleAction, { label: string; aria: string }> = {
  start: { label: 'START', aria: 'A: start' },
  cashout: { label: 'CASH OUT', aria: 'A: cash out' },
  settling: { label: 'SETTLING', aria: 'A: waits while the game settles' },
  'new-game': { label: 'NEW GAME', aria: 'A: new game' },
  verify: { label: 'VERIFY', aria: 'A: verify' },
};

const DIR_WORD = ['up', 'right', 'down', 'left'] as const;
const STATE_TEXT = { current: 'you are here', visited: 'visited', hidden: 'not visited' } as const;
const ARROWS = ['5,2 9,7 1,7', '8,5 3,1 3,9', '1,3 9,3 5,8', '2,5 7,1 7,9'] as const;
const CONFETTI = [6, 18, 31, 44, 57, 70, 83, 94];

const END_BANNER: Record<ResultOutcome, { text: string; color: string }> = {
  exit: { text: 'ESCAPED!', color: 'var(--brand)' },
  loss: { text: 'GAME OVER', color: 'var(--danger)' },
  cashout: { text: 'CASHED OUT', color: 'var(--text)' },
  'auto-cashout': { text: 'AUTO CASH-OUT', color: 'var(--text)' },
  reclaimed: { text: 'BET RECLAIMED', color: 'var(--text)' },
};

function box(n: number, cell: number): CSSProperties {
  const b = cellBox(n, cell);
  return { left: b.left, top: b.top, width: b.size, height: b.size };
}

/**
 * The handheld: a lens and the difficulty LEDs, a screen that shows only the maze, and the controls
 * under it. Every maze cell keeps its test id and data attributes; a hidden cell carries no wall
 * data (`data-open` empty).
 */
export function Console(p: Props) {
  const { n, observations, ended } = p;
  const { symbol } = useNetwork();
  const cols = screenCols(n);
  const playing = observations.length > 0;
  const dungeon = p.dungeon;
  const tiles = playing ? playTiles(n, observations, ended === null) : readyTiles(n, dungeon?.side ?? null);
  const cells = boardCells(n, observations);
  const current = observations.at(-1)?.cell ?? 0;
  const step = Math.max(0, observations.length - 1);
  const exit = n * n - 1;

  const pathChests = new Map(
    p.found.filter((c) => c.kind === 'path').map((c) => [c.cell.y * n + c.cell.x, c] as const),
  );
  const fresh = ended === null ? (p.found.find((c) => c.kind === 'path' && c.step === step) ?? null) : null;

  let heroClass = p.moving ? 'walking' : '';
  if (p.bumpTick > 0) heroClass += p.bumpTick % 2 ? ' bumpA' : ' bumpB';
  if (ended === 'loss') heroClass += ' fall';
  else if (ended === 'exit') heroClass += ' enter';
  else if (ended === 'cashout' || ended === 'auto-cashout') heroClass += ' warp';

  const light = playing
    ? `radial-gradient(circle at ${(((2 * (current % n) + 1.5) * 100) / cols).toFixed(2)}% ${(
        ((2 * Math.floor(current / n) + 1.5) * 100) /
        cols
      ).toFixed(2)}%, rgba(10,8,20,0) 0%, rgba(10,8,20,0) 14%, rgba(10,8,20,.5) 38%, rgba(10,8,20,.72) 100%)`
    : 'rgba(10,8,20,.12)';

  return (
    <section className="console" data-console="" data-testid="console" data-mode={p.mode} aria-label="Game console">
      <span className="screw" style={{ left: 12, top: 12 }} aria-hidden="true" />
      <span className="screw" style={{ left: 12, bottom: 14 }} aria-hidden="true" />
      <div className="topbar">
        <span className="lens" aria-hidden="true" />
        <div
          className="leds"
          role="img"
          aria-label={`Difficulty ${p.difficulty.names[p.difficulty.index] ?? ''}`}
          data-testid="difficulty-leds"
          data-tier={p.difficulty.index}
        >
          {p.difficulty.names.map((name, k) => (
            <i key={name} className={`led t-${tierTone(k)}${k === p.difficulty.index ? ' on' : ''}`} />
          ))}
        </div>
      </div>
      <div className="bezel">
        {/* The status line sits above the screen, so nothing covers the maze. */}
        <div className="hud">
          <span className="hud-left">
            {p.tag !== null && <span data-testid="screen-tag">{p.tag}</span>}
          </span>
          {p.timer !== null ? (
            <span
              className="hud-right"
              data-testid="idle-countdown"
              data-remaining-sec={p.timer.remainingSec ?? ''}
              data-deadline-sec={p.timer.deadlineSec}
              data-urgent={p.timer.urgent}
              title="Auto cash-out if you do not move"
            >
              {p.timer.text}
            </span>
          ) : (
            p.showSeed &&
            dungeon !== null && (
              <span className="hud-right" data-testid="seed-tag" title="Your client seed, shortened">
                SEED {dungeon.code}
              </span>
            )
          )}
        </div>
        {p.hp}
        <div
          className={ended === 'loss' ? 'screen shake' : 'screen'}
          data-testid="board"
          data-game-id={p.gameId ?? ''}
          data-n={n}
          data-step={step}
          data-theme={dungeon?.theme ?? 'stone'}
          data-start-side={dungeon?.side ?? ''}
          aria-label={`${n}×${n} maze${
            !playing && dungeon?.side ? `, the start opens ${dungeon.side === 'E' ? 'east' : 'south'}` : ''
          }`}
        >
          <div
            className="screen-grid"
            role="list"
            style={{
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${cols}, minmax(0, 1fr))`,
            }}
          >
            {tiles.map((tile, index) => {
              if (tile.cell === null) return <div key={index} className={`t t-${tile.kind}`} />;
              const cell = cells[tile.cell];
              const enter = cell.via !== null && p.legal.includes(cell.via) ? cell.via : null;
              const pathChest = cell.state === 'hidden' ? undefined : pathChests.get(cell.cell);
              const deadEnd =
                p.deadEndChest !== null && p.deadEndChest.x === cell.x && p.deadEndChest.y === cell.y;
              const marked = deadEnd || pathChest !== undefined;
              return (
                <div
                  key={index}
                  role="listitem"
                  className={`t t-${tile.kind}`}
                  data-testid={`cell-${cell.x}-${cell.y}`}
                  data-state={cell.state}
                  data-open={cell.open === null ? '' : String(cell.open)}
                  data-start={cell.start}
                  data-exit={cell.exit}
                  data-enter={enter === null ? undefined : DIR_NAMES[enter]}
                  data-chest={marked ? 'true' : undefined}
                  data-chest-kind={deadEnd ? 'dead-end' : pathChest !== undefined ? 'path' : undefined}
                  aria-label={`Column ${cell.x + 1}, row ${cell.y + 1}, ${STATE_TEXT[cell.state]}${
                    cell.start ? ', start' : ''
                  }${cell.exit ? ', exit' : ''}${marked ? ', treasure chest' : ''}`}
                  onClick={enter === null ? undefined : () => p.onCell(enter)}
                />
              );
            })}
          </div>

          {ended === 'exit' ? (
            <div
              className="ov rays"
              style={{
                left: `${(((2 * (n - 1) + 0.25) * 100) / cols).toFixed(4)}%`,
                top: `${(((2 * (n - 1) + 0.25) * 100) / cols).toFixed(4)}%`,
                width: `${((250 / cols)).toFixed(4)}%`,
                height: `${((250 / cols)).toFixed(4)}%`,
              }}
            />
          ) : (
            <div className="ov doorglow" style={box(n, exit)} />
          )}
          <div className={`ov spr ${ended === 'exit' ? 's-doorOpen' : 's-door'}`} style={box(n, exit)} />

          {[...pathChests.entries()].map(([cell, chest]) => (
            <div
              key={cell}
              className="ov spr s-chestOpen"
              style={box(n, cell)}
              data-testid={`chest-cell-${chest.cell.x}-${chest.cell.y}`}
              data-kind="path"
              data-points={chest.points}
              data-step={chest.step}
            />
          ))}
          {p.deadEndChest !== null && (
            <div
              className="ov spr s-chestOpen pop"
              style={box(n, p.deadEndChest.y * n + p.deadEndChest.x)}
              data-testid="chest-reveal"
              data-x={p.deadEndChest.x}
              data-y={p.deadEndChest.y}
            />
          )}

          {ended === 'loss' && <div className="ov pit" style={box(n, current)} />}
          {(ended === 'cashout' || ended === 'auto-cashout') && (
            <div className="ov beam" style={{ left: box(n, current).left, width: box(n, current).width }} />
          )}

          <div className="hero-pos" style={box(n, current)} aria-hidden="true">
            <span className="shadow" />
            <div className={`hero ${heroClass}`}>
              <div className="body">
                <div className={`fr f0 spr s-${p.facing}0`} />
                <div className={`fr f1 spr s-${p.facing}1`} />
                <div className={`fr f2 spr s-${p.facing}2`} />
              </div>
            </div>
          </div>

          {dungeon?.torches.map((torch, k) => (
            <span
              key={k}
              className="torch"
              aria-hidden="true"
              style={{
                [torch.side === 'L' ? 'left' : 'right']: 0,
                top: `${(torch.at * 100).toFixed(2)}%`,
                width: `${(100 / cols).toFixed(4)}%`,
                height: `${(100 / cols).toFixed(4)}%`,
                animationDelay: `${(k * 0.37).toFixed(2)}s`,
              }}
            />
          ))}

          <div className="light" style={{ background: light }} />

          {/* A reroll redraws the screen: the overlay replays its sweep for every new seed. */}
          {!playing && dungeon !== null && <div key={dungeon.code} className="ov reroll" aria-hidden="true" />}

          {fresh !== null && (
            <div key={`fx-${fresh.step}`} className="ov fx" style={box(n, current)}>
              <div className="burst" />
              <div
                className="rise"
                data-testid="chest-pop"
                data-x={fresh.cell.x}
                data-y={fresh.cell.y}
                data-points={fresh.points}
              >
                +{formatPoints(fresh.points)} PT
              </div>
            </div>
          )}

          {ended !== null && <EndEffect outcome={ended} figures={p.endFigures} />}
          {p.menu}
        </div>
        {/* Messages take the balance's place under the screen instead of covering the maze. */}
        <div className="bezel-foot">
          {p.notice !== null ? (
            <Notice notice={p.notice} />
          ) : (
            <span
              className="bezel-bal"
              data-testid="console-balance"
              data-wei={p.balanceWei?.toString() ?? ''}
              title="Wallet balance"
            >
              BALANCE <b>{p.balanceWei === null ? '—' : `${formatEth(p.balanceWei, 4)} ${symbol}`}</b>
            </span>
          )}
        </div>
      </div>

      <div className="ctl-row">
        <div className="dpad-grid" role="group" aria-label="D-pad">
          {DIRS.map((dir) => (
            <button
              key={dir}
              type="button"
              className={`dpad dpad-${DIR_NAMES[dir].toLowerCase()}`}
              data-testid={`move-${DIR_NAMES[dir]}`}
              data-legal={p.legal.includes(dir)}
              aria-label={`Move ${DIR_WORD[dir]}`}
              onClick={() => p.onDir(dir)}
            >
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <polygon points={ARROWS[dir]} />
              </svg>
            </button>
          ))}
          <span className="dpad-hub" />
        </div>
        <div className="a-wrap">
          <button
            type="button"
            className="btn-a"
            data-testid="btn-a"
            data-action={p.action}
            aria-label={ACTION_TEXT[p.action].aria}
            onClick={p.onA}
          >
            A
          </button>
          <span className="ctl-label" aria-hidden="true">
            {ACTION_TEXT[p.action].label}
          </span>
        </div>
      </div>
      <div className="slots con-slots" aria-hidden="true">
        <i />
        <i />
      </div>
    </section>
  );
}

function Notice({ notice }: { notice: ScreenNotice }): ReactNode {
  if (notice.chest !== undefined) {
    const c = notice.chest;
    return (
      <div
        className="lcd-msg win"
        role="status"
        data-testid="chest-just-found"
        data-kind={c.kind}
        data-x={c.cell.x}
        data-y={c.cell.y}
        data-reward-bps={c.rewardBps}
        data-points={c.points}
      >
        {notice.text}
      </div>
    );
  }
  if (notice.step !== undefined) {
    return (
      <div className="lcd-msg" role="status" data-testid="bet-status" data-step={notice.step}>
        {notice.text}
      </div>
    );
  }
  if (notice.error) {
    return (
      <div className="lcd-msg err" role="status" data-testid="bet-error">
        {notice.text}
      </div>
    );
  }
  return (
    <div className="lcd-msg" role="status" data-testid={notice.waiting ? 'board-waiting' : 'screen-msg'}>
      {notice.text}
    </div>
  );
}

/**
 * The money line under the banner: what the escape won, what a stop handed back, what a dead end
 * cost. `null` when the bet is not known for a dead end.
 */
function endMoney(
  outcome: ResultOutcome,
  f: EndFigures,
  symbol: string,
): { text: string; wei: bigint; tone: string } | null {
  if (outcome === 'loss') {
    return f.betWei === null ? null : { text: `-${formatEth(f.betWei, 4)} ${symbol}`, wei: f.betWei, tone: 'loss' };
  }
  if (outcome === 'exit') return { text: `+${formatEth(f.payoutWei, 4)} ${symbol}`, wei: f.payoutWei, tone: 'win' };
  return { text: `${formatEth(f.payoutWei, 4)} ${symbol} BACK`, wei: f.payoutWei, tone: 'even' };
}

/**
 * The line under the money: the bet transaction's fee and what the game came to with it counted,
 * payout less bet less fee ("fee -0.0177 · net -0.0016 MON"). A win smaller than the fee is a
 * loss for the wallet. `null` without the fee or the bet.
 */
export function endFee(
  f: EndFigures,
  symbol: string,
): { feeWei: bigint; netWei: bigint; fee: string; net: string; tone: string } | null {
  if (f.feeWei === null || f.betWei === null) return null;
  const netWei = f.payoutWei - f.betWei - f.feeWei;
  const net = netWei >= 0n ? `+${formatEth(netWei, 4)}` : `-${formatEth(-netWei, 4)}`;
  return {
    feeWei: f.feeWei,
    netWei,
    fee: `fee -${formatEth(f.feeWei, 4)}`,
    net: `net ${net} ${symbol}`,
    tone: netWei > 0n ? 'win' : netWei < 0n ? 'loss' : 'even',
  };
}

function EndEffect({ outcome, figures }: { outcome: ResultOutcome; figures: EndFigures | null }) {
  const { symbol } = useNetwork();
  const banner = END_BANNER[outcome];
  const money = figures === null ? null : endMoney(outcome, figures, symbol);
  const fee = figures === null ? null : endFee(figures, symbol);
  return (
    <>
      {outcome === 'loss' && <div className="flash" />}
      <div className="endfx" data-testid="end-effect" data-outcome={outcome}>
        <div className="dim" />
        {outcome === 'exit' &&
          CONFETTI.map((left, k) => (
            <span
              key={left}
              className="cf"
              style={{
                left: `${left}%`,
                background: k % 2 ? 'var(--text)' : 'var(--brand)',
                animationDelay: `${1 + (k % 4) * 0.12}s`,
              }}
            />
          ))}
        <div className="end-banner" style={{ top: outcome === 'loss' ? '12%' : '22%' }}>
          {outcome === 'loss' && <div className="spr s-skull skull pop" style={{ animationDelay: '1.3s' }} />}
          <span className="px pop" style={{ color: banner.color, animationDelay: '1.1s' }}>
            {banner.text}
          </span>
          {money !== null && (
            <span
              className={`end-amt pop ${money.tone}`}
              data-testid="end-amount"
              data-wei={money.wei.toString()}
              style={{ animationDelay: '1.4s' }}
            >
              {money.text}
            </span>
          )}
          {fee !== null && (
            <span className="end-net pop" style={{ animationDelay: '1.5s' }}>
              <span data-testid="end-fee" data-wei={fee.feeWei.toString()}>
                {fee.fee}
              </span>
              {' · '}
              <span className={fee.tone} data-testid="end-net" data-wei={fee.netWei.toString()}>
                {fee.net}
              </span>
            </span>
          )}
          {figures !== null && figures.points > 0n && (
            <span
              className="end-pts pop"
              data-testid="end-points"
              data-points={figures.points.toString()}
              style={{ animationDelay: '1.65s' }}
            >
              <span className="spr s-chestOpen" aria-hidden="true" />+{formatPoints(figures.points)} PT
            </span>
          )}
        </div>
      </div>
    </>
  );
}
