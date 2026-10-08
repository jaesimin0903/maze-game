'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ONCHAIN_STATUS, exitPayoutWei, markStartSide, refundWei, type ConfigResponse, type Dir } from '@maze/shared';
import { ApiError, ServerUnreachableError, apiMessage } from './api';
import {
  betBlocked,
  betPresets,
  betShortfall,
  initialAmount,
  readAmount,
  stepPreset,
  stepTag,
  stepText,
} from './bet-form';
import { assertConfig, tableFromConfig } from './config';
import { defaultDeps, type ClientDeps } from './deps';
import { formatClock, formatEth, formatMultiplier, formatPoints, shortHex } from './format';
import { NetworkContext, explorerLink, networkView, useNetwork } from './network';
import { useChainClock } from './poll';
import { dungeonOf } from './dungeon';
import { blockedReason, dirOfFacing, facingOf, startFacing, type Blocked } from './screen-model';
import { isHex32, randomStartSeed } from './seed';
import { useGame } from './use-game';
import type { WalletApi } from './wallet';
import { Console, type ScreenNotice, type ScreenTimer } from './components/Console';
import { Dock, type DockModel } from './components/Dock';
import { PointsBalance } from './components/PointsBalance';
import { Bankroll, Leaderboard, RecentGames } from './components/SidePanels';
import { SignSheet } from './components/SignSheet';
import { TestBeacon } from './components/TestBeacon';
import { VerifyModal } from './components/VerifyView';
import { WalletButton } from './components/WalletButton';

type ConfigFailure = { unreachable: true } | { unreachable: false; message: string };

/** Removes `verify` from the address bar, keeping any other query and the hash. */
function dropVerifyQuery(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('verify')) return;
  url.searchParams.delete('verify');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function Brand() {
  return (
    <a className="brand" href="/" aria-label="Maze Bet home">
      <svg viewBox="0 0 9 9" width="32" height="32" shapeRendering="crispEdges" aria-hidden="true">
        <path
          style={{ fill: 'var(--brand)' }}
          d="M0 0h9v1H0zM0 0h1v9H0zM8 0h1v7H8zM0 8h9v1H0zM2 2h5v1H2zM2 2h1v4H2zM4 4h1v4H4zM6 4h2v1H6z"
        />
      </svg>
      <span className="brand-name">MAZE BET</span>
    </a>
  );
}

/** The game page. Loads the runtime config first; nothing chain-related is known before it. */
export function GameApp({ deps = defaultDeps }: { deps?: ClientDeps }) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [failure, setFailure] = useState<ConfigFailure | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setFailure(null);
    try {
      setConfig(assertConfig(await deps.api.config()));
    } catch (error) {
      if (error instanceof ServerUnreachableError) setFailure({ unreachable: true });
      else {
        const message = error instanceof ApiError ? apiMessage(error) : (error as Error).message;
        setFailure({ unreachable: false, message });
      }
    }
  }, [deps]);

  useEffect(() => {
    void load();
  }, [load]);

  if (config) {
    return (
      <NetworkContext value={networkView(config)}>
        <Game config={config} deps={deps} />
      </NetworkContext>
    );
  }

  return (
    <div className="app">
      <header className="masthead">
        <Brand />
      </header>
      {failure === null && <p className="loading">Loading the game settings...</p>}
      {failure?.unreachable === true && (
        <p className="banner banner-down" role="alert" data-testid="server-unreachable">
          The game server cannot be reached.
          <button type="button" className="quiet" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}
      {failure?.unreachable === false && (
        <p className="banner banner-error" role="alert" data-testid="config-error">
          {failure.message}
          <button type="button" className="quiet" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

const IDLE_URGENT_SEC = 15;
const DIR_WORD = ['north', 'east', 'south', 'west'] as const;
const BLOCKED_TEXT: Record<Blocked, (dir: Dir) => string> = {
  wall: (dir) => `A wall to the ${DIR_WORD[dir]}.`,
  visited: () => 'You came from there. No going back.',
  edge: () => "That's the edge of the maze.",
};

/** Physical keys, so that the controls work under any keyboard layout or input method. */
const KEY_DIR: Record<string, Dir> = {
  ArrowUp: 0,
  ArrowRight: 1,
  ArrowDown: 2,
  ArrowLeft: 3,
  KeyW: 0,
  KeyD: 1,
  KeyS: 2,
  KeyA: 3,
};

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function Game({ config, deps }: { config: ConfigResponse; deps: ClientDeps }) {
  const chain = useMemo(() => deps.chain(config), [deps, config]);
  const table = useMemo(() => tableFromConfig(config), [config]);
  const clock = useChainClock(chain, deps.timing.clockMs, config.chainNowSec);
  const network = useNetwork();

  const [wallet, setWallet] = useState<WalletApi | null>(null);
  const game = useGame({ config, deps, chain, wallet, clock });
  const { state, result } = game;
  const { phase, record, view } = state;

  // The wallet's balance for the dock's small print, and the fee bid for the bet's fee: read on
  // connect, again after every phase change (a bet or a payout moves the balance), when the bet
  // sheet opens, and every 15 seconds while the lobby shows them.
  const [balance, setBalance] = useState<{ address: string; wei: bigint } | null>(null);
  const [maxFeeWei, setMaxFeeWei] = useState<bigint | null>(null);
  const [balanceTick, setBalanceTick] = useState(0);
  const balanceOf = wallet?.address ?? null;
  const balanceWei = balance !== null && balance.address === balanceOf ? balance.wei : null;
  useEffect(() => {
    if (balanceOf === null) return;
    let live = true;
    const read = (): void => {
      // An unreachable RPC is reported by the chain clock already.
      chain
        .balanceOf(balanceOf)
        .then((wei) => live && setBalance({ address: balanceOf, wei }))
        .catch(() => undefined);
      chain
        .maxFeePerGas()
        .then((wei) => live && setMaxFeeWei(wei))
        .catch(() => undefined);
    };
    read();
    const timer = phase === 'lobby' ? setInterval(read, 15_000) : null;
    return () => {
      live = false;
      if (timer !== null) clearInterval(timer);
    };
  }, [chain, balanceOf, phase, balanceTick]);

  // ----- the bet being set up
  const minWei = BigInt(config.minBetWei);
  const maxWei = BigInt(config.maxBetWei);
  const presets = useMemo(() => betPresets(BigInt(config.minBetWei), BigInt(config.maxBetWei)), [config]);
  const [tier, setTier] = useState(0);
  const [amountText, setAmountText] = useState(() => initialAmount(minWei, maxWei));
  const [seedText, setSeedText] = useState<string>(() => randomStartSeed());
  const [sheetOpen, setSheetOpen] = useState(false);
  /** The game the fairness dialog checks, `'import'` for a pasted record, or `null` when closed. */
  const [verifyOf, setVerifyOf] = useState<string | null>(null);
  const modalOpen = sheetOpen || verifyOf !== null;
  const amount = readAmount(amountText, minWei, maxWei, network.symbol);
  const amountWei = 'betWei' in amount ? amount.betWei : null;
  const amountProblem = 'reason' in amount ? amount.reason : null;
  const seedOk = isHex32(seedText.trim());
  // A wallet that cannot pay the bet and its fee is not asked to sign for it.
  const shortWei =
    balanceWei !== null && maxFeeWei !== null && amountWei !== null
      ? betShortfall(balanceWei, amountWei, maxFeeWei)
      : null;
  const blocked = betBlocked({
    walletConnected: wallet !== null,
    amountReason: amountProblem,
    seedOk,
    shortWei,
    symbol: network.symbol,
  });

  // ----- play controls
  const [confirm, setConfirm] = useState<{ open: boolean; choice: 0 | 1 }>({ open: false, choice: 0 });
  const [endChoice, setEndChoice] = useState<0 | 1>(0);
  const [bump, setBump] = useState<{ tick: number; text: string; step: number } | null>(null);
  const [flash, setFlash] = useState(0);

  const rec = phase === 'lobby' || phase === 'betting' ? null : record;
  const inLobby = rec === null;
  const observations = rec?.observations ?? [];
  const step = Math.max(0, observations.length - 1);
  const active =
    phase === 'playing' && view !== null && view.status === 'active' && rec !== null && rec.observations.length > 0;
  const n = rec?.n ?? (phase === 'betting' && record ? record.n : config.tiers[tier].n);
  // The look of the screen comes from the client seed: the one being set up, or the game's own.
  const screenSeed = rec?.clientSeed ?? seedText.trim();
  const dungeon = isHex32(screenSeed) ? dungeonOf(screenSeed) : null;
  const facing =
    rec && rec.observations.length > 0 ? facingOf(rec.observations, rec.moves) : startFacing(dungeon?.side ?? null);
  const betWei =
    view !== null ? BigInt(view.betWei) : record?.betWei !== undefined ? BigInt(record.betWei) : null;
  const settledOnChain = state.onchain?.status === ONCHAIN_STATUS.Settled;
  const confirmed = settledOnChain || state.onchain?.status === ONCHAIN_STATUS.Reclaimed;
  const ended = phase === 'ended' ? (result?.outcome ?? null) : null;
  // A key press may leave a finished game only once the chain shows it settled or reclaimed, so a
  // stray tap after the last step cannot hide a settle or reclaim the game may still need. The
  // New game button itself always works.
  const endKeysFree = phase === 'ended' && result !== null && (confirmed || result.outcome === 'reclaimed');

  // The sheet closes once the bet is on chain; a cash-out question closes when play stops.
  useEffect(() => {
    if (phase === 'playing' || phase === 'ended') setSheetOpen(false);
  }, [phase]);
  useEffect(() => {
    if (!active) setConfirm((c) => (c.open ? { open: false, choice: 0 } : c));
  }, [active]);
  // When play starts on a short screen, scroll the D-pad out from under the dock.
  useEffect(() => {
    if (!active) return;
    const consoleBox = document.querySelector('[data-console]')?.getBoundingClientRect();
    const dockBox = document.querySelector('[data-testid="dock"]')?.getBoundingClientRect();
    if (!consoleBox || !dockBox || dockBox.height === 0) return;
    const hidden = Math.min(consoleBox.bottom - dockBox.top + 8, consoleBox.top);
    if (hidden > 0) window.scrollBy?.({ top: hidden, behavior: 'smooth' });
  }, [active]);

  const openSheet = (): void => {
    if (phase !== 'lobby') return;
    game.dismissError();
    // A seed set by script without an input event is still the one the sheet shows and bets.
    const domSeed = (document.getElementById('client-seed') as HTMLInputElement | null)?.value.trim();
    if (domSeed !== undefined && domSeed !== seedText.trim() && isHex32(domSeed)) setSeedText(domSeed);
    setSheetOpen(true);
    setBalanceTick((t) => t + 1);
    // The wallet controls sit in the header, above the sheet; bring them into view when needed.
    if (wallet === null) window.scrollTo?.({ top: 0, behavior: 'smooth' });
  };

  const submitBet = (): void => {
    // Read the fields from the DOM, so values set by script without events are still honoured.
    const field = (id: string): string | undefined =>
      (document.getElementById(id) as HTMLInputElement | null)?.value;
    const nowAmount = readAmount(field('bet-amount') ?? amountText, minWei, maxWei, network.symbol);
    const nowSeed = (field('client-seed') ?? seedText).trim();
    if (!wallet || 'reason' in nowAmount || !isHex32(nowSeed)) return;
    const bet = { tier, betWei: nowAmount.betWei, clientSeed: nowSeed };
    const address = wallet.address;
    // The balance on screen may be 15 seconds old: read it again before the signature, so a wallet
    // that cannot pay the bet and its fee is stopped here. An unreadable chain leaves it to the wallet.
    void Promise.all([chain.balanceOf(address), chain.maxFeePerGas()]).then(
      ([wei, maxFee]) => {
        setBalance({ address, wei });
        setMaxFeeWei(maxFee);
        if (betShortfall(wei, bet.betWei, maxFee) === null) void game.placeBet(bet);
      },
      () => void game.placeBet(bet),
    );
  };

  const newGame = (): void => {
    game.newGame();
    setConfirm({ open: false, choice: 0 });
    setEndChoice(0);
    setBump(null);
    setSeedText(randomStartSeed());
  };

  /** A new client seed before the bet: a new look, and maybe the other start side. */
  const reroll = (): void => {
    if (phase === 'lobby' && !modalOpen) setSeedText(randomStartSeed());
  };

  const openVerify = (target: string): void => setVerifyOf(target);
  const closeVerify = (): void => {
    setVerifyOf(null);
    dropVerifyQuery();
  };
  // `/verify/<gameId>` and `/verify` now redirect here with `?verify=<gameId|import>`.
  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get('verify');
    if (target === null) return;
    if (target === 'import' || isHex32(target)) setVerifyOf(target);
    else dropVerifyQuery();
  }, []);

  /** The player's own seed from the sheet: kept but for its last four bytes, the start-side mark. */
  const applyOwnSeed = (text: string): void => {
    const seed = text.trim();
    if (phase === 'lobby' && isHex32(seed)) setSeedText(markStartSide(seed, dungeon?.side ?? 'E'));
  };

  const takeCashOut = (): void => {
    setConfirm({ open: false, choice: 0 });
    void game.cashOut();
  };

  const tryMove = (dir: Dir): void => {
    if (!active || state.busy !== null || rec === null) return;
    if (game.legal.includes(dir)) {
      setBump(null);
      void game.move(dir);
      return;
    }
    const why = blockedReason(rec.n, rec.observations, dir);
    if (why === null) return;
    setBump((b) => ({ tick: (b?.tick ?? 0) + 1, text: BLOCKED_TEXT[why](dir), step }));
  };

  const onDir = (dir: Dir): void => {
    if (modalOpen) return;
    if (inLobby) {
      if (phase !== 'lobby') return;
      if (dir === 0 || dir === 2) {
        setTier((t) => Math.max(0, Math.min(config.tiers.length - 1, t + (dir === 2 ? 1 : -1))));
      } else {
        const next = stepPreset(presets, amountWei, dir === 1 ? 1 : -1);
        if (next) setAmountText(formatEth(next.wei, 18));
      }
      return;
    }
    if (phase === 'ended') {
      if (dir === 1 || dir === 3) setEndChoice((c) => (c === 0 ? 1 : 0));
      return;
    }
    if (confirm.open) {
      if (dir === 1 || dir === 3) setConfirm((c) => ({ open: true, choice: c.choice === 0 ? 1 : 0 }));
      return;
    }
    tryMove(dir);
  };

  const goVerify = (): void => {
    if (rec) openVerify(rec.gameId);
  };

  const onA = (): void => {
    if (modalOpen) return;
    if (inLobby) return openSheet();
    if (phase === 'ended') {
      if (endKeysFree) return endChoice === 0 ? newGame() : goVerify();
      return;
    }
    if (!active) return;
    if (confirm.open) return confirm.choice === 0 ? takeCashOut() : setConfirm({ open: false, choice: 0 });
    tryMove(dirOfFacing(facing));
  };

  const onStart = (): void => {
    if (modalOpen) return;
    if (inLobby) return openSheet();
    if (phase === 'ended') {
      if (endKeysFree) newGame();
      return;
    }
    if (active && state.busy === null) setConfirm((c) => ({ open: !c.open, choice: 0 }));
  };

  /** Escape backs out of the cash-out question; it never starts or leaves a game. */
  const onBack = (): void => {
    if (confirm.open) setConfirm({ open: false, choice: 0 });
  };

  const onSelect = (): void => {
    document
      .querySelector('[data-testid="side-leaderboard"]')
      ?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    setFlash((f) => f + 1);
  };

  // Keyboard: arrows/WASD are the D-pad, Space/Z is A, Enter is START, Escape is back, R is SELECT.
  // The handlers are swapped in before paint, so a key pressed right after a render uses the new ones.
  const keyState = {
    onDir,
    onA,
    onStart,
    onBack,
    onSelect,
    sheetOpen,
    closeSheet: () => setSheetOpen(false),
    betting: phase === 'betting',
    verifyOpen: verifyOf !== null,
    closeVerify,
  };
  const keys = useRef(keyState);
  useLayoutEffect(() => {
    keys.current = keyState;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (TYPING_TAGS.has(target.tagName) || target.isContentEditable)) return;
      // A key pressed in a window laid over the page from outside it (the Privy login) is its own.
      if (target instanceof Element && target !== document.body && target.closest('.app') === null) return;
      const k = keys.current;
      if (k.verifyOpen) {
        // The dialog handles keys inside it; this catches Escape with focus left outside.
        if (event.code === 'Escape' && !event.repeat) {
          event.preventDefault();
          k.closeVerify();
        }
        return;
      }
      if (k.sheetOpen) {
        if (event.code === 'Escape' && !event.repeat && !k.betting) {
          event.preventDefault();
          k.closeSheet();
        }
        return;
      }
      // A focused button or link keeps its own Enter and Space.
      const onControl = target !== null && (target.tagName === 'BUTTON' || target.tagName === 'A');
      const isEnter = event.code === 'Enter' || event.code === 'NumpadEnter';
      if (onControl && (isEnter || event.code === 'Space')) return;
      const dir = KEY_DIR[event.code];
      const action =
        dir !== undefined
          ? () => k.onDir(dir)
          : event.code === 'Space' || event.code === 'KeyZ'
            ? k.onA
            : isEnter
              ? k.onStart
              : event.code === 'Escape'
                ? k.onBack
                : event.code === 'KeyR'
                  ? k.onSelect
                  : null;
      if (action === null) return;
      // A held key does not scroll the page, and does not repeat the action either.
      event.preventDefault();
      if (!event.repeat) action();
    };
    // Console and dock buttons give their focus back after a pointer click, so Space and Enter keep
    // meaning A and START instead of pressing the last button again. Keyboard presses keep focus.
    const onClick = (event: MouseEvent): void => {
      if (event.detail === 0) return;
      const button = (event.target as Element | null)?.closest?.('[data-console] button, [data-testid="dock"] button');
      if (button instanceof HTMLElement) button.blur();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick, true);
    };
  }, []);

  // ----- what the screen says
  let tag: string | null = null;
  let timer: ScreenTimer | null = null;
  let notice: ScreenNotice | null = null;
  const pathChests = (rec?.chests ?? []).filter((c) => c.kind === 'path');
  const gamePoints = (rec?.chests ?? []).reduce((sum, c) => sum + BigInt(c.points), 0n);
  if (inLobby) {
    tag = phase === 'betting' && state.betStep !== null ? stepTag(state.betStep) : `READY · ${n}×${n}`;
  } else if (phase === 'playing' && observations.length === 0) {
    tag = 'WAITING FOR CHAIN';
    notice = { text: 'The server is confirming your bet on chain...', waiting: true };
  } else if (phase === 'playing') {
    tag = `STEP ${String(step).padStart(2, '0')}${gamePoints > 0n ? ` · +${formatPoints(gamePoints)} PT` : ''}`;
    if (view !== null && view.status === 'active') {
      const left = clock.now === 0 ? null : view.idleDeadlineSec - clock.now;
      timer = {
        text: `IDLE ${left === null ? '—' : formatClock(left)}`,
        urgent: left !== null && left <= IDLE_URGENT_SEC,
        remainingSec: left,
        deadlineSec: view.idleDeadlineSec,
      };
    }
    const fresh = pathChests.find((c) => c.step === step);
    if (bump !== null && bump.step === step) notice = { text: bump.text };
    else if (fresh !== undefined) {
      notice = { text: `Treasure chest! +${formatPoints(fresh.points)} PT · no cash value`, chest: fresh };
    } else if (step === 0) {
      notice = { text: 'The exit is in the bottom-right corner. Use the D-pad or the arrow keys to move.' };
    }
  }

  // ----- what the dock shows
  const size = `${n}×${n}`;
  const walletConnected = wallet !== null;
  // The direct reclaim joins the dock that is already up: a game in play keeps its cash-out, and a
  // finished game keeps its result next to the player's own settle, which for a winner pays more
  // than the bet back. It takes the whole dock only when there is nothing else to show.
  const reclaim =
    game.reclaim === null ? null : { info: game.reclaim, now: clock.now, onReclaim: () => void game.reclaimBet() };
  const noBoardYet = view === null || observations.length === 0;
  let dock: DockModel;
  if (rec === null) {
    dock =
      phase === 'betting' && state.betStep !== null
        ? { kind: 'betting', step: state.betStep, text: stepText(state.betStep, wallet?.kind ?? null) }
        : {
            kind: 'ready',
            tiers: config.tiers.map((t, index) => ({ index, n: t.n, multiplierBps: t.multiplierBps })),
            tier,
            presets,
            amountText,
            amountWei,
            amountProblem,
            exitWei: amountWei === null ? null : exitPayoutWei(table, amountWei, tier),
            multiplier: formatMultiplier(config.tiers[tier].multiplierBps),
            balanceWei,
            shortWei,
            faucetUrl: config.network?.faucetUrl ?? null,
            seedText,
            startSide: dungeon?.side ?? null,
            onTier: setTier,
            onAmount: setAmountText,
            onSeed: setSeedText,
            onReroll: reroll,
            onStart: openSheet,
          };
  } else if (game.reclaim !== null && (phase === 'ended' ? result === null : noBoardYet)) {
    dock = {
      kind: 'reclaim',
      info: game.reclaim,
      now: clock.now,
      betWei,
      walletConnected,
      busy: state.busy !== null,
      onReclaim: () => void game.reclaimBet(),
    };
  } else if (phase === 'ended') {
    dock = {
      kind: 'ended',
      gameId: rec.gameId,
      result,
      betWei,
      confirmed,
      canSelfSettle: game.canSelfSettle,
      walletConnected,
      busy: state.busy !== null,
      choice: endKeysFree ? endChoice : null,
      reclaim,
      onSettleSelf: () => void game.settleSelf(),
      onNewGame: newGame,
      onVerify: () => openVerify(rec.gameId),
    };
  } else if (view === null || noBoardYet) {
    dock = { kind: 'waiting', betWei, size };
  } else if (confirm.open && active) {
    dock = {
      kind: 'confirm',
      refundWei: BigInt(view.refundableWei),
      choice: confirm.choice,
      busy: state.busy !== null,
      onTake: takeCashOut,
      onKeep: () => setConfirm({ open: false, choice: 0 }),
    };
  } else {
    const bet = BigInt(view.betWei);
    const nextStep = view.step + 1;
    const hasNext = nextStep < (table.tiers[view.tier]?.refundBps.length ?? 0);
    const nextWei = hasNext ? refundWei(table, bet, view.tier, nextStep) : null;
    const refundable = BigInt(view.refundableWei);
    dock = {
      kind: 'play',
      view,
      next: nextWei === null ? null : { wei: nextWei, dropWei: refundable > nextWei ? refundable - nextWei : 0n },
      size,
      gameLeftSec: clock.now === 0 ? null : view.gameDeadlineSec - clock.now,
      points:
        config.chest !== undefined && view.chests !== undefined
          ? { total: view.chests.reduce((sum, c) => sum + BigInt(c.points), 0n).toString(), count: view.chests.length }
          : null,
      busy: state.busy !== null,
      canCashOut: active,
      walletConnected,
      reclaim,
      onCashOut: () => {
        if (active && state.busy === null) setConfirm({ open: true, choice: 0 });
      },
    };
  }

  const refreshKey = `${phase}:${state.onchain?.status ?? ''}:${record?.gameId ?? ''}`;
  const sheetTier = config.tiers[tier];
  const chainName = config.network?.name ?? `Chain ${config.chainId}`;
  const contractUrl = explorerLink(network.explorerUrl, 'address', config.contract);

  return (
    <div className={sheetOpen ? 'app sheet-open' : 'app'} data-phase={phase}>
      <header className="masthead" inert={verifyOf !== null}>
        <div className="head-group">
          <Brand />
          <Bankroll chain={chain} contract={config.contract} refreshKey={refreshKey} />
        </div>
        <div className="head-group">
          {config.chest !== undefined && (
            <PointsBalance
              api={deps.api}
              address={wallet?.address ?? null}
              // A path chest adds points during play: every chest found asks again.
              refreshKey={`${refreshKey}:${record?.chests?.length ?? 0}`}
            />
          )}
          <WalletButton
            config={config}
            deps={deps}
            chain={chain}
            wallet={wallet}
            onWallet={setWallet}
            refreshKey={refreshKey}
          />
        </div>
      </header>

      <div className="banners" inert={modalOpen}>
        {config.testHooks && (
          <p className="banner banner-hooks" role="alert" data-testid="test-hooks-banner">
            <strong>Test hooks are on.</strong> A test helper can compute the maze seed from the game number, so the
            maze can be known in advance. This is not a fair game: do not bet money of real value.
          </p>
        )}
        {config.fixture && (
          <p className="banner" data-testid="fixture-banner">
            Running on the test table. Payouts and refunds are uncertified test values.
          </p>
        )}
        {state.serverUnreachable && (
          <p className="banner banner-down" role="alert" data-testid="server-unreachable">
            The game server cannot be reached. Still retrying.
          </p>
        )}
        {clock.rpcDown && (
          <p className="banner banner-down" role="alert" data-testid="rpc-unreachable">
            The chain RPC ({config.rpcUrl}) cannot be reached.
          </p>
        )}
        {phase === 'playing' && settledOnChain && (
          <p className="banner" data-testid="settled-notice">
            This game is already settled on chain. The result shows once the server answers.
          </p>
        )}
        {state.error !== null && (
          <p className="banner banner-error" role="alert" data-testid="error-message">
            {state.error}
            <button type="button" className="quiet" onClick={game.dismissError}>
              Dismiss
            </button>
          </p>
        )}
      </div>

      {/* Behind an open dialog only the header (the wallet) stays reachable. */}
      <div className="layout" inert={modalOpen}>
        <div className="col-main">
          <Console
            n={n}
            gameId={rec?.gameId ?? null}
            observations={observations}
            facing={facing}
            legal={game.legal}
            moving={state.busy === 'move'}
            bumpTick={bump?.tick ?? 0}
            ended={ended}
            deadEndChest={phase === 'ended' && result?.chest ? result.chest.cell : null}
            found={rec?.chests ?? []}
            endFigures={
              phase === 'ended' && result !== null
                ? {
                    payoutWei: result.payoutWei,
                    betWei,
                    points: (result.chests ?? []).reduce((sum, c) => sum + BigInt(c.points), 0n),
                  }
                : null
            }
            dungeon={dungeon}
            showSeed={rec === null}
            tag={tag}
            timer={timer}
            notice={notice}
            onDir={onDir}
            onCell={(dir) => {
              if (!modalOpen && !confirm.open) tryMove(dir);
            }}
            onA={onA}
            onStart={onStart}
            onSelect={onSelect}
          />
          <div className="dfoot">
            <span>
              {rec !== null ? (
                <>
                  Commit{' '}
                  <span className="mono" data-testid="commitment" title={rec.commitment}>
                    {shortHex(rec.commitment, 8, 6)}
                  </span>
                </>
              ) : (
                'Provably fair'
              )}
            </span>
            <span
              className="chain-info"
              data-testid="chain-info"
              data-chain-id={config.chainId}
              title={`Contract ${config.contract}`}
            >
              {contractUrl === null ? (
                chainName
              ) : (
                <a href={contractUrl} target="_blank" rel="noreferrer">
                  {chainName}
                </a>
              )}
            </span>
            <a
              className="dlink"
              data-testid="fairness-link"
              href={`/?verify=${rec !== null ? rec.gameId : 'import'}`}
              onClick={(event) => {
                event.preventDefault();
                openVerify(rec !== null ? rec.gameId : 'import');
              }}
            >
              Verify fairness
            </a>
          </div>
        </div>
        <aside className="side col-left" aria-label="Recent games">
          <RecentGames api={deps.api} me={wallet?.address ?? null} now={clock.now} refreshKey={refreshKey} />
        </aside>
        <aside className="side col-right" aria-label="Leaderboard">
          <Leaderboard
            api={deps.api}
            me={wallet?.address ?? null}
            now={clock.now}
            refreshKey={refreshKey}
            flash={flash}
          />
        </aside>
      </div>

      <div inert={modalOpen}>
        <Dock model={dock} />
      </div>

      {sheetOpen && (
        <SignSheet
          size={`${sheetTier.n}×${sheetTier.n}`}
          multiplier={formatMultiplier(sheetTier.multiplierBps)}
          betWei={amountWei}
          exitWei={amountWei === null ? null : exitPayoutWei(table, amountWei, tier)}
          seedCode={dungeon?.code ?? null}
          startSide={dungeon?.side ?? null}
          seedText={seedText}
          onOwnSeed={applyOwnSeed}
          step={phase === 'betting' ? state.betStep : null}
          walletKind={wallet?.kind ?? null}
          blocked={blocked}
          commitment={phase === 'betting' && record ? record.commitment : null}
          error={state.error}
          rules={{
            idleSec: config.idleTimeoutSec,
            maxGameSec: config.maxGameSec,
            refundStartBps: sheetTier.refundBps[0],
            refundStep1Bps: sheetTier.refundBps[1] ?? sheetTier.refundBps[0],
          }}
          table={table}
          tier={tier}
          onSubmit={submitBet}
          onClose={() => setSheetOpen(false)}
        />
      )}

      {verifyOf !== null && (
        <VerifyModal gameId={verifyOf === 'import' ? null : verifyOf} deps={deps} onClose={closeVerify} />
      )}

      {config.testHooks && <TestBeacon api={deps.api} chainNowSec={clock.now} />}
    </div>
  );
}
