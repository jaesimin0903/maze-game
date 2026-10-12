'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ONCHAIN_STATUS,
  exitPayoutWei,
  markStartSide,
  type ConfigResponse,
  type Dir,
  type Hex,
} from '@maze/shared';
import { ApiError, ServerUnreachableError, apiMessage } from './api';
import {
  TYPICAL_BET_GAS,
  betBlocked,
  betShortfall,
  betTicks,
  initialBet,
  maxAffordable,
  normalizeBet,
  stepPreset,
  stepTag,
  stepText,
  type PlaceStep,
} from './bet-form';
import { assertConfig, tableFromConfig, tierName } from './config';
import { defaultDeps, type ClientDeps } from './deps';
import { formatClock, formatPoints, shortHex } from './format';
import { NetworkContext, explorerLink, networkView, useNetwork } from './network';
import { useChainClock } from './poll';
import { dungeonOf } from './dungeon';
import { blockedReason, facingOf, startFacing, type Blocked } from './screen-model';
import { isHex32, randomStartSeed } from './seed';
import { useGame } from './use-game';
import type { WalletApi } from './wallet';
import { Console, type ConsoleAction, type ScreenNotice, type ScreenTimer } from './components/Console';
import { DexPanel } from './components/DexPanel';
import { GameDetails, type DetailsGame } from './components/GameDetails';
import { HpRow, ScreenMenu, panelMode, type PanelModel } from './components/Panel';
import { PointsBalance } from './components/PointsBalance';
import { Bankroll, Leaderboard, RecentGames } from './components/SidePanels';
import { TestBeacon } from './components/TestBeacon';
import { TxLog } from './components/TxLog';
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

/** A press of A this soon after the cash-out question opened is the same press, not an answer. */
const CONFIRM_GUARD_MS = 300;

/**
 * A press of A this soon after the lobby comes up (a new game, a failed bet, an abandoned game, a
 * wallet connected, a dialog closed) is the press that led there coming twice, not a decision: in
 * the lobby A bets at once. `ClientDeps.timing.startGuardMs` overrides it.
 */
const START_GUARD_MS = 300;

/** How long the balance read before a bet may take (`ClientDeps.timing.balanceCheckMs` overrides it). */
const BALANCE_CHECK_MS = 5000;

/** Where the lobby keeps the difficulty and the bet chosen last, so that a reload shows them. */
const LOBBY_KEY = 'maze:lobby';

function readLobby(): { tier?: unknown; betWei?: unknown } | null {
  try {
    const raw = window.localStorage.getItem(LOBBY_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

/** Smooth scrolling, unless the player asked for reduced motion. */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function Game({ config, deps }: { config: ConfigResponse; deps: ClientDeps }) {
  const chain = useMemo(() => deps.chain(config), [deps, config]);
  const table = useMemo(() => tableFromConfig(config), [config]);
  const clock = useChainClock(chain, deps.timing.clockMs, config.chainNowSec);
  const network = useNetwork();

  const [wallet, setWallet] = useState<WalletApi | null>(null);
  const game = useGame({ config, deps, chain, wallet, clock });
  const { state, result } = game;
  const { phase, record, view } = state;

  // The wallet's balance for the console, and the fee bid for the bet's fee: read on connect, again
  // after every phase change (a bet or a payout moves the balance), when A is pressed while the
  // wallet is short, and every 15 seconds while the lobby shows them.
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

  // The gas price, for the bet's typical fee on the lobby screen: read in the lobby every 15
  // seconds, wallet or not.
  const [gasPriceWei, setGasPriceWei] = useState<bigint | null>(null);
  useEffect(() => {
    if (phase !== 'lobby') return;
    let live = true;
    const read = (): void => {
      chain
        .gasPrice()
        .then((wei) => live && setGasPriceWei(wei))
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [chain, phase]);

  // What the bet transaction cost in fees, from its receipt, for the end screen and the game's
  // details. A game restored without its transaction, or a receipt that cannot be read, shows no
  // fee rather than a guess; a read that failed during play is tried again at the end.
  const createTx: Hex | null = phase === 'playing' || phase === 'ended' ? (record?.createTxHash ?? null) : null;
  const [betFee, setBetFee] = useState<{ hash: Hex; wei: bigint } | null>(null);
  const betFeeWei = betFee !== null && betFee.hash === createTx ? betFee.wei : null;
  useEffect(() => {
    if (createTx === null || betFeeWei !== null) return;
    let live = true;
    chain
      .txFee(createTx)
      .then((wei) => live && wei !== null && setBetFee({ hash: createTx, wei }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [chain, createTx, betFeeWei, phase]);

  // ----- the bet being set up: a difficulty and an amount on the side panel, and the client seed
  const ticks = useMemo(() => betTicks(BigInt(config.minBetWei), BigInt(config.maxBetWei)), [config]);
  const minWei = ticks[0].wei;
  const maxWei = ticks[ticks.length - 1].wei;
  /** A tier index the table has; anything else (a corrupt record, a changed table) is not one. */
  const tierOk = (t: number | undefined): t is number =>
    t !== undefined && Number.isInteger(t) && t >= 0 && t < config.tiers.length;
  // The lobby starts from the difficulty and bet chosen last on this browser, when they still fit.
  const [tier, setTier] = useState(() => {
    const stored = readLobby()?.tier;
    return typeof stored === 'number' && tierOk(stored) ? stored : 0;
  });
  const [amountWei, setAmountWei] = useState(() => {
    const stored = readLobby()?.betWei;
    return typeof stored === 'string' && /^\d{1,30}$/.test(stored) ? normalizeBet(ticks, BigInt(stored)) : initialBet(ticks);
  });
  const savedLobby = useRef<string | null>(null);
  useEffect(() => {
    const next = JSON.stringify({ tier, betWei: amountWei.toString() });
    // The first run only notes what the page started with: nothing has been chosen yet.
    if (savedLobby.current === null || savedLobby.current === next) {
      savedLobby.current = next;
      return;
    }
    savedLobby.current = next;
    try {
      window.localStorage.setItem(LOBBY_KEY, next);
    } catch {
      // Storage is off: the choice lasts as long as the page.
    }
  }, [tier, amountWei]);
  const [seedText, setSeedText] = useState<string>(() => randomStartSeed());
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** The game the fairness dialog checks, `'import'` for a pasted record, or `null` when closed. */
  const [verifyOf, setVerifyOf] = useState<string | null>(null);
  const modalOpen = detailsOpen || verifyOf !== null;
  const seedOk = isHex32(seedText.trim());
  // A wallet that cannot pay the bet and its fee is not asked to sign for it, and A does not start.
  const shortWei =
    balanceWei !== null && maxFeeWei !== null ? betShortfall(balanceWei, amountWei, maxFeeWei) : null;
  const blocked = betBlocked({
    walletConnected: wallet !== null,
    betWei: amountWei,
    minWei,
    maxWei,
    seedOk,
    shortWei,
    symbol: network.symbol,
  });

  // ----- play controls
  // The cash-out question: `choice` 0 is "Take it", 1 is "Keep going", which it opens on.
  const [confirm, setConfirm] = useState<{ open: boolean; choice: 0 | 1 }>({ open: false, choice: 1 });
  const confirmAt = useRef(0);
  const [endChoice, setEndChoice] = useState<0 | 1>(0);
  /** Changes on every A pressed while the wallet is short: the NEED bubble pulses. */
  const [pulse, setPulse] = useState(0);
  const [bump, setBump] = useState<{ tick: number; text: string; step: number } | null>(null);
  const [flash, setFlash] = useState(0);
  /** When the lobby last came up for A (see `START_GUARD_MS`). */
  const lobbyAt = useRef(0);
  /**
   * A was pressed and the balance is being read before the bet: A and the lobby keys wait, set at
   * once on the press, and the screen shows the first step.
   */
  const placing = useRef(false);
  const [checking, setChecking] = useState(false);
  /**
   * Why the last A in the lobby did not bet, shown under the screen while the wallet, the
   * difficulty, the bet, the seed and whether the wallet is short are what they were then.
   */
  const [hint, setHint] = useState<{ text: string; key: string } | null>(null);
  /** The bet A would place now: the wallet, the difficulty, the amount and the seed. */
  const betKey = `${wallet?.address ?? ''}:${tier}:${amountWei}:${seedText.trim()}`;
  const lobbyKey = `${phase}:${betKey}:${shortWei === null ? 'paid' : 'short'}`;
  /** The latest of both, for a balance read that returns after the render it started in. */
  const lobbyNow = useRef({ betKey, lobbyKey });
  useLayoutEffect(() => {
    lobbyNow.current = { betKey, lobbyKey };
  });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The guard starts over whenever the lobby comes up for A: on load, after a new game, a failed
  // bet or an abandoned game, when a wallet connects, and when a dialog closes.
  const lobbyUp = phase === 'lobby' && !modalOpen;
  useEffect(() => {
    if (lobbyUp) lobbyAt.current = performance.now();
  }, [lobbyUp, wallet?.address]);

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
  // The side panel and the LEDs show the difficulty being set up, or the game's own once there is
  // one: the server's view first, then the stored record, either only when the table has it.
  const shownTier = rec === null ? tier : tierOk(view?.tier) ? view.tier : tierOk(rec.tier) ? rec.tier : tier;
  const settledOnChain = state.onchain?.status === ONCHAIN_STATUS.Settled;
  const confirmed = settledOnChain || state.onchain?.status === ONCHAIN_STATUS.Reclaimed;
  const ended = phase === 'ended' ? (result?.outcome ?? null) : null;
  // A key press may leave a finished game only once the chain shows it settled or reclaimed, so a
  // stray tap after the last step cannot hide a settle or reclaim the game may still need. The
  // New game button itself always works.
  const endKeysFree = phase === 'ended' && result !== null && (confirmed || result.outcome === 'reclaimed');

  // A cash-out question closes when play stops.
  useEffect(() => {
    if (!active) setConfirm((c) => (c.open ? { open: false, choice: 1 } : c));
  }, [active]);
  // When play starts, bring the console into view: the side panel under it on a phone may have
  // scrolled its screen away, and a short window may hide its D-pad. A console taller than the
  // window keeps its D-pad in view.
  useEffect(() => {
    if (!active) return;
    const box = document.querySelector('[data-console]')?.getBoundingClientRect();
    if (!box || box.height === 0) return;
    const below = box.bottom - window.innerHeight + 8;
    let move = 0;
    if (box.top < 0 && box.height + 16 <= window.innerHeight) move = box.top - 8;
    else if (below > 0) move = Math.min(below, Math.max(0, box.top));
    if (move !== 0) window.scrollBy?.({ top: move, behavior: scrollBehavior() });
  }, [active]);

  /** The client seed in the side panel's field: a value set by script without an input event counts. */
  const domSeed = (): string =>
    ((document.getElementById('client-seed') as HTMLInputElement | null)?.value ?? seedText).trim();

  /**
   * A in the lobby: the bet the screen names. Without a wallet the screen says to log in and the
   * header's login comes into view; a bet that cannot be placed says why. Otherwise the screen
   * shows the first step at once while the balance is read again, and the bet is placed as it was
   * when A was pressed: a change of wallet, difficulty, bet or seed meanwhile cancels it.
   */
  const submitBet = (): void => {
    if (phase !== 'lobby' || placing.current) return;
    if (wallet === null) {
      setHint({ text: 'Log in to bet', key: lobbyKey });
      window.scrollTo?.({ top: 0, behavior: scrollBehavior() });
      return;
    }
    const seed = domSeed();
    const why = betBlocked({
      walletConnected: true,
      betWei: amountWei,
      minWei,
      maxWei,
      seedOk: isHex32(seed),
      shortWei,
      symbol: network.symbol,
    });
    if (why !== null || !isHex32(seed) || !tierOk(tier)) {
      setHint({ text: why ?? 'Choose a difficulty', key: lobbyKey });
      return;
    }
    setHint(null);
    if (seed !== seedText.trim()) setSeedText(seed);
    const bet = { tier, betWei: amountWei, clientSeed: seed };
    const address = wallet.address;
    const pressed = `${address}:${tier}:${amountWei}:${seed}`;
    // The seed just taken from the field is the bet's, before the render that shows it.
    lobbyNow.current = { ...lobbyNow.current, betKey: pressed };
    placing.current = true;
    setChecking(true);
    // The balance on screen may be 15 seconds old: read it again before the signature, so a wallet
    // that cannot pay the bet and its fee is stopped here. A chain that cannot be read, or not in
    // time, leaves it to the wallet.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.timing.balanceCheckMs ?? BALANCE_CHECK_MS);
    });
    // Started inside a promise, so that even a read that throws at once ends in the race below,
    // which lets go of `placing` on every path.
    const read = Promise.resolve()
      .then(() => Promise.all([chain.balanceOf(address), chain.maxFeePerGas()]))
      .then(
        ([wei, maxFee]) => {
          if (alive.current) {
            setBalance({ address, wei });
            setMaxFeeWei(maxFee);
          }
          return betShortfall(wei, bet.betWei, maxFee);
        },
        () => null,
      );
    void Promise.race([read, slow]).then((short) => {
      clearTimeout(timer);
      placing.current = false;
      if (!alive.current) return;
      setChecking(false);
      const now = lobbyNow.current;
      if (now.betKey !== pressed) {
        setHint({ text: 'The bet changed before it was placed. Nothing was sent: press A to bet', key: now.lobbyKey });
        return;
      }
      if (short !== null) {
        // The slider turns red from the balance just read; the screen says why A did not bet.
        const text = betBlocked({
          walletConnected: true,
          betWei: bet.betWei,
          minWei,
          maxWei,
          seedOk: true,
          shortWei: short,
          symbol: network.symbol,
        });
        setHint(text === null ? null : { text, key: `lobby:${pressed}:short` });
        return;
      }
      // A bet refused at once can bring the lobby back before any render shows that it left: the
      // guard also starts over when the attempt ends.
      void game.placeBet(bet).finally(() => {
        lobbyAt.current = performance.now();
      });
    });
  };

  /** Opens the game's details; before a bet, the lobby's choice with the seed the field holds. */
  const openDetails = (): void => {
    if (phase === 'lobby') {
      const seed = domSeed();
      if (seed !== seedText.trim() && isHex32(seed)) setSeedText(seed);
    }
    setDetailsOpen(true);
  };

  const newGame = (): void => {
    // The side panel keeps the finished game's difficulty and bet, a reloaded page included, as
    // the slider holds them: on its 0.001 grid and within the table's limits.
    if (rec !== null && tierOk(shownTier)) setTier(shownTier);
    if (betWei !== null) setAmountWei(normalizeBet(ticks, betWei));
    game.newGame();
    setConfirm({ open: false, choice: 1 });
    setEndChoice(0);
    setBump(null);
    setSeedText(randomStartSeed());
  };

  /** A new client seed before the bet: a new look, and maybe the other start side. */
  const reroll = (): void => {
    if (phase === 'lobby' && !modalOpen && !placing.current) setSeedText(randomStartSeed());
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

  /** The player's own seed from the details: kept but for its last four bytes, the start-side mark. */
  const applyOwnSeed = (text: string): void => {
    const seed = text.trim();
    if (phase === 'lobby' && !placing.current && isHex32(seed)) setSeedText(markStartSide(seed, dungeon?.side ?? 'E'));
  };

  const takeCashOut = (): void => {
    setConfirm({ open: false, choice: 1 });
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
      if (phase !== 'lobby' || placing.current) return;
      if (dir === 0 || dir === 2) {
        setTier((t) => Math.max(0, Math.min(config.tiers.length - 1, t + (dir === 2 ? 1 : -1))));
      } else {
        const next = stepPreset(ticks, amountWei, dir === 1 ? 1 : -1);
        if (next) setAmountWei(next.wei);
      }
      return;
    }
    if (phase === 'ended') {
      // New game on the left, Verify on the right.
      if (dir === 1 || dir === 3) setEndChoice(dir === 1 ? 1 : 0);
      return;
    }
    if (confirm.open) {
      // "Keep going" on the left, "Take it" on the right: only the D-pad (or a tap) gets to it.
      if (dir === 1 || dir === 3) setConfirm({ open: true, choice: dir === 1 ? 0 : 1 });
      return;
    }
    tryMove(dir);
  };

  const goVerify = (): void => {
    if (rec) openVerify(rec.gameId);
  };

  /**
   * A bets (what the screen names), cashes out (asks, then takes the highlighted answer) and, once a
   * game is over, opens the highlighted choice. It never moves: the D-pad does.
   */
  const onA = (): void => {
    if (modalOpen) return;
    if (inLobby) {
      const guardMs = deps.timing.startGuardMs ?? START_GUARD_MS;
      if (phase !== 'lobby' || placing.current || performance.now() - lobbyAt.current < guardMs) return;
      // An error on the screen is read first: the press that clears it does not bet as well.
      if (state.error !== null) return game.dismissError();
      // A wallet short of the bet and its fee is told so on the slider; A waits for the coins, and
      // looks again at once, so that coins just fetched from a faucet count.
      if (shortWei === null) submitBet();
      else {
        setBalanceTick((t) => t + 1);
        setPulse((n) => n + 1);
      }
      return;
    }
    if (phase === 'ended') {
      if (endKeysFree) return endChoice === 0 ? newGame() : goVerify();
      return;
    }
    if (!active) return;
    if (confirm.open) {
      // A pressed again right after asking is the same press, not an answer.
      if (performance.now() - confirmAt.current < CONFIRM_GUARD_MS) return;
      return confirm.choice === 0 ? takeCashOut() : setConfirm({ open: false, choice: 1 });
    }
    if (state.busy === null) {
      // The question opens on "Keep going": A, A asks and puts it away again.
      confirmAt.current = performance.now();
      setConfirm({ open: true, choice: 1 });
    }
  };

  /** Escape backs out of the cash-out question; it never starts or leaves a game. */
  const onBack = (): void => {
    if (confirm.open) setConfirm({ open: false, choice: 1 });
  };

  /** Brings the leaderboard into view (under the console on a narrow screen) and flashes it. */
  const showRank = (): void => {
    document
      .querySelector('[data-testid="side-leaderboard"]')
      ?.scrollIntoView?.({ behavior: scrollBehavior(), block: 'nearest' });
    setFlash((f) => f + 1);
  };

  // Keyboard: arrows/WASD are the D-pad, Enter, Space and Z are A, Escape is back, R shows the
  // leaderboard. The handlers are swapped in before paint, so a key pressed right after a render
  // uses the new ones.
  const keyState = {
    onDir,
    onA,
    onBack,
    showRank,
    detailsOpen,
    closeDetails: () => setDetailsOpen(false),
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
      const isEnter = event.code === 'Enter' || event.code === 'NumpadEnter';
      // A field keeps its keys, the bet slider included: Enter there is not A, which would bet.
      if (target && (TYPING_TAGS.has(target.tagName) || target.isContentEditable)) return;
      // A key pressed in a window laid over the page from outside it (the Privy login) is its own.
      if (target instanceof Element && target !== document.body && target.closest('.app') === null) return;
      const k = keys.current;
      if (k.verifyOpen || k.detailsOpen) {
        // A dialog handles keys inside it; this catches Escape with focus left outside.
        if (event.code === 'Escape' && !event.repeat) {
          event.preventDefault();
          if (k.verifyOpen) k.closeVerify();
          else k.closeDetails();
        }
        return;
      }
      // A focused button or link keeps its own Enter and Space.
      const onControl = target !== null && (target.tagName === 'BUTTON' || target.tagName === 'A');
      if (onControl && (isEnter || event.code === 'Space')) return;
      const dir = KEY_DIR[event.code];
      const action =
        dir !== undefined
          ? () => k.onDir(dir)
          : isEnter || event.code === 'Space' || event.code === 'KeyZ'
            ? k.onA
            : event.code === 'Escape'
              ? k.onBack
              : event.code === 'KeyR'
                ? k.showRank
                : null;
      if (action === null) return;
      // A held key does not scroll the page, and does not repeat the action either.
      event.preventDefault();
      if (!event.repeat) action();
    };
    // The device's buttons give their focus back after a pointer click, so Space and Enter keep
    // meaning A instead of pressing the last button again. Keyboard presses keep focus.
    const onClick = (event: MouseEvent): void => {
      if (event.detail === 0) return;
      const button = (event.target as Element | null)?.closest?.('[data-device] button');
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
    const placeStep: PlaceStep | null = phase === 'betting' ? state.betStep : checking ? 'check' : null;
    tag = placeStep !== null ? stepTag(placeStep) : `READY ${tierName(tier, config.tiers.length)}`;
    // What the bet waits for while it is placed; else why the last bet failed, or why A did not bet.
    if (placeStep !== null) notice = { text: stepText(placeStep, wallet?.kind ?? null), step: placeStep };
    else if (state.error !== null) notice = { text: state.error, error: true };
    else if (hint !== null && hint.key === lobbyKey) notice = { text: hint.text };
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

  // ----- what the console shows around the screen
  const size = `${n}×${n}`;
  const walletConnected = wallet !== null;
  // The direct reclaim joins what is already up: a game in play keeps its meter, and a finished
  // game keeps its result next to the player's own settle, which for a winner pays more than the
  // bet back. It takes the whole panel only when there is nothing else to show.
  const reclaim =
    game.reclaim === null ? null : { info: game.reclaim, now: clock.now, onReclaim: () => void game.reclaimBet() };
  const noBoardYet = view === null || observations.length === 0;
  let panel: PanelModel;
  if (rec === null && (phase === 'betting' || checking)) {
    panel = {
      kind: 'betting',
      betWei: amountWei,
      step: phase === 'betting' ? (state.betStep ?? 'sign') : 'check',
      chainName: config.network?.name ?? 'chain',
    };
  } else if (rec === null) {
    panel = {
      kind: 'ready',
      betWei: amountWei,
      feeWei: gasPriceWei === null ? null : TYPICAL_BET_GAS * gasPriceWei,
      // In a few words: the full reason is said under the screen when A is pressed.
      blocked:
        state.error !== null
          ? 'PRESS A TO DISMISS THE ERROR'
          : blocked === null
            ? null
            : wallet === null
              ? 'LOG IN TO BET'
              : !seedOk
                ? 'INVALID CLIENT SEED'
                : shortWei !== null
                  ? `NOT ENOUGH ${network.symbol}`
                  : blocked.toUpperCase(),
    };
  } else if (game.reclaim !== null && (phase === 'ended' ? result === null : noBoardYet)) {
    panel = {
      kind: 'reclaim',
      info: game.reclaim,
      now: clock.now,
      betWei,
      walletConnected,
      busy: state.busy !== null,
      onReclaim: () => void game.reclaimBet(),
    };
  } else if (phase === 'ended') {
    panel = {
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
    panel = { kind: 'waiting', betWei };
  } else {
    panel = {
      kind: 'play',
      view,
      table,
      size,
      gameLeftSec: clock.now === 0 ? null : view.gameDeadlineSec - clock.now,
      points:
        config.chest !== undefined && view.chests !== undefined
          ? { total: view.chests.reduce((sum, c) => sum + BigInt(c.points), 0n).toString(), count: view.chests.length }
          : null,
      walletConnected,
      busy: state.busy !== null,
      reclaim,
      confirm:
        confirm.open && active
          ? { choice: confirm.choice, onTake: takeCashOut, onKeep: () => setConfirm({ open: false, choice: 1 }) }
          : null,
    };
  }
  // The side panel shows the bet being set up, or the game's own once there is one.
  const shownBetWei = rec === null ? amountWei : (betWei ?? amountWei);
  const tierNames = config.tiers.map((_, index) => tierName(index, config.tiers.length));
  const ready = panel.kind === 'ready';
  const affordWei =
    ready && balanceWei !== null && maxFeeWei !== null ? (maxAffordable(balanceWei, maxFeeWei) ?? 0n) : null;
  // What locks the side panel: a bet being placed, then the game, then its end.
  const lock =
    panel.kind === 'ready'
      ? null
      : panel.kind === 'betting'
        ? state.betStep === 'sign'
          ? 'SIGNING'
          : 'PLACING BET'
        : panel.kind === 'waiting'
          ? 'PLACING BET'
          : phase === 'ended'
            ? 'GAME OVER'
            : 'IN GAME';
  // A finished game that the keys may not leave yet is still settling: A waits, and says so.
  const action: ConsoleAction = inLobby
    ? 'start'
    : phase === 'ended'
      ? !endKeysFree
        ? 'settling'
        : endChoice === 1
          ? 'verify'
          : 'new-game'
      : 'cashout';

  const refreshKey = `${phase}:${state.onchain?.status ?? ''}:${record?.gameId ?? ''}`;
  // The game the details dialog shows, from its ticket on; before that, the lobby's choice.
  const detailsGame: DetailsGame | null =
    record === null || phase === 'lobby'
      ? null
      : {
          gameId: record.gameId,
          tier: tierOk(view?.tier) ? view.tier : tierOk(record.tier) ? record.tier : tier,
          betWei,
          clientSeed: record.clientSeed,
          commitment: record.commitment,
          serverSeed: record.terminal?.serverSeed ?? null,
          betTx: record.createTxHash ?? null,
          betConfirmed: phase === 'playing' || phase === 'ended',
          betFeeWei,
          settleTx: state.settledTx,
          settle: state.settledTx !== null || settledOnChain ? 'settled' : record.terminal ? 'settling' : 'none',
          reclaimed: record.reclaimed
            ? { txHash: record.reclaimed.txHash, amountWei: BigInt(record.reclaimed.amountWei) }
            : null,
          ended: phase === 'ended',
        };
  const chainName = config.network?.name ?? `Chain ${config.chainId}`;
  const contractUrl = explorerLink(network.explorerUrl, 'address', config.contract);

  return (
    <div className="app" data-phase={phase}>
      <header className="masthead" inert={modalOpen}>
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

      {/* Nothing behind an open dialog is reachable. */}
      <div className="layout" inert={modalOpen}>
        <div className="col-main">
          <div className="device" data-device="">
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
                      feeWei: betFeeWei,
                      points: (result.chests ?? []).reduce((sum, c) => sum + BigInt(c.points), 0n),
                    }
                  : null
              }
              dungeon={dungeon}
              showSeed={rec === null}
              tag={tag}
              timer={timer}
              notice={notice}
              mode={panelMode(panel)}
              hp={<HpRow model={panel} />}
              menu={<ScreenMenu model={panel} />}
              difficulty={{ names: tierNames, index: shownTier }}
              balanceWei={balanceWei}
              action={action}
              onDir={onDir}
              onCell={(dir) => {
                if (!modalOpen && !confirm.open) tryMove(dir);
              }}
              onA={onA}
            />
            <div className="hinge" aria-hidden="true" />
            <DexPanel
              tiers={config.tiers.map((t, index) => ({
                index,
                n: t.n,
                multiplierBps: t.multiplierBps,
                name: tierNames[index],
              }))}
              tier={shownTier}
              ticks={ticks}
              betWei={shownBetWei}
              exitWei={exitPayoutWei(table, shownBetWei, shownTier)}
              affordWei={affordWei}
              shortWei={ready ? shortWei : null}
              faucetUrl={config.network?.faucetUrl ?? null}
              seedText={seedText}
              startSide={dungeon?.side ?? null}
              lock={lock}
              pulse={pulse}
              onTier={setTier}
              onBet={setAmountWei}
              onSeed={setSeedText}
              onReroll={reroll}
              onRank={showRank}
            />
          </div>
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
        <aside className="side col-left" aria-label="Transactions and recent games">
          <TxLog
            record={phase === 'lobby' ? null : record}
            phase={phase}
            betStep={state.betStep}
            result={result}
            settled={confirmed}
            onOpen={openDetails}
          />
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

      {detailsOpen && (
        <GameDetails
          config={config}
          table={table}
          game={detailsGame}
          lobby={{ tier, betWei: amountWei, seedText }}
          onOwnSeed={phase === 'lobby' && !checking ? applyOwnSeed : null}
          onVerify={(gameId) => {
            setDetailsOpen(false);
            openVerify(gameId);
          }}
          onClose={() => setDetailsOpen(false)}
        />
      )}

      {verifyOf !== null && (
        <VerifyModal gameId={verifyOf === 'import' ? null : verifyOf} deps={deps} onClose={closeVerify} />
      )}

      {config.testHooks && <TestBeacon api={deps.api} chainNowSec={clock.now} />}
    </div>
  );
}
