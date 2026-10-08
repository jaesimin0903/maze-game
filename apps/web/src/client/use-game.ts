'use client';

// The game flow as one hook: bet, play, poll, end, and the two ways a player settles alone
// (submitting the server-signed settlement, reclaiming after the deadline).
//
// Wallet, server and contract calls, in order, for one game:
//   signMessage(ticketRequestMessage)    the wallet proves it asks for its own ticket
//   POST /api/games                      ticket (commitment fixed before the client seed is sent);
//                                        an unused ticket of this wallet comes back as it was
//   createGame(...) + receipt            the bet, with the client seed, on chain
//   POST /api/games/:id/start            first cell
//   POST /api/games/:id/move | cashout   play
//   GET  /api/games/:id                  every `pollMs`, and on every chain tick past a deadline;
//                                        after the end, until the chain shows which transaction
//                                        settled the game
// The server settles on chain itself. The player sends `settle` or `reclaim` only when it did not.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ONCHAIN_STATUS,
  ticketRequestMessage,
  type ChestFound,
  type ConfigResponse,
  type FoundChest,
  type Dir,
  type ErrorCode,
  type GameView,
  type Hex,
} from '@maze/shared';
import { ApiError, ServerUnreachableError, apiMessage } from './api';
import { legalMoves } from './board-view';
import type { ChainApi, OnchainGame } from './chain';
import type { ClientDeps } from './deps';
import { formatClock } from './format';
import { useInterval, type ChainClock } from './poll';
import {
  activeGameId,
  loadRecord,
  saveRecord,
  setActiveGameId,
  withView,
  type PlayRecord,
} from './record';
import { hashSessionToken, newSessionToken } from './seed';
import { describeTxError, isUserRejection, type WalletApi } from './wallet';

export type Phase = 'lobby' | 'betting' | 'playing' | 'ended';
export type BetStep = 'sign' | 'ticket' | 'tx' | 'confirm';
export type Busy = 'move' | 'cashout' | 'reclaim' | 'settle';
export type ResultOutcome = 'exit' | 'loss' | 'cashout' | 'auto-cashout' | 'reclaimed';

export interface GameState {
  phase: Phase;
  betStep: BetStep | null;
  record: PlayRecord | null;
  /** Latest accepted server view. `null` until the server has shown the first cell. */
  view: GameView | null;
  /** Latest `getGame` read. Read only once the game needs the chain's word (see `needsChain`). */
  onchain: OnchainGame | null;
  /** Hash of a `settle` the player sent. */
  selfSettleTx: Hex | null;
  /** The transaction that settled the game, once the chain has shown that it did. */
  settledTx: Hex | null;
  /** Chain second at which this page first saw the game ended. */
  endedAtSec: number | null;
  serverUnreachable: boolean;
  busy: Busy | null;
  error: string | null;
}

export interface GameResult {
  outcome: ResultOutcome;
  payoutWei: bigint;
  /** The transaction that settled or reclaimed the game on chain, once the chain has shown it. */
  txHash: Hex | null;
  /**
   * For a game that ended in a dead end the server applied a chest rule to: the chest found
   * there, or `null` when it held none. `undefined` for every other ending.
   */
  chest?: ChestFound | null;
  /**
   * Every chest found in this game, in the order found (path chests during play, and the
   * dead-end chest), as the server showed them. `undefined` for a game shown without chests.
   */
  chests?: FoundChest[];
}

export interface ReclaimInfo {
  /** `settleDeadline` of the game, chain seconds. */
  deadlineSec: number;
  /** Chain seconds until `reclaim` is accepted. */
  remainingSec: number;
  ready: boolean;
}

export interface GameController {
  state: GameState;
  result: GameResult | null;
  reclaim: ReclaimInfo | null;
  canSelfSettle: boolean;
  /** Directions the player may move in right now. */
  legal: Dir[];
  placeBet(p: { tier: number; betWei: bigint; clientSeed: Hex }): Promise<void>;
  move(dir: Dir): Promise<void>;
  cashOut(): Promise<void>;
  reclaimBet(): Promise<void>;
  settleSelf(): Promise<void>;
  newGame(): void;
  dismissError(): void;
}

const INITIAL: GameState = {
  phase: 'lobby',
  betStep: null,
  record: null,
  view: null,
  onchain: null,
  selfSettleTx: null,
  settledTx: null,
  endedAtSec: null,
  serverUnreachable: false,
  busy: null,
  error: null,
};

/** The relayer normally settles within a block or two; offer the player's own `settle` after this. */
const SELF_SETTLE_AFTER_SEC = 10;
/** Consecutive `getGame` reads saying "no such game" before a game the server never showed is dropped. */
const ABANDON_AFTER_NONE_READS = 5;
/** Failed reads tolerated at the fast retry period, and NOT_ON_CHAIN answers kept from the player. */
const QUIET_SYNC_FAILURES = 20;
/** Polls after the chain shows a game finished, while the page still looks for its settle transaction. */
const FINAL_POLLS = 10;

/** `start` errors that mean "ask again later" rather than "read the game instead". */
const START_RETRY_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'NOT_ON_CHAIN',
  'NOT_FOUND',
  'TICKET_EXPIRED',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'NOT_CALIBRATED',
  'TABLE_MISMATCH',
  'CHAIN_UNAVAILABLE',
]);

/** The state a page starts in: the game this browser was playing, when it left one unfinished. */
function resumedState(): GameState {
  const gameId = activeGameId();
  const record = gameId === null ? null : loadRecord(gameId);
  if (!record) return INITIAL;
  const ended = record.reclaimed !== undefined || record.terminal !== undefined;
  return { ...INITIAL, phase: ended ? 'ended' : 'playing', record, endedAtSec: ended ? 0 : null };
}

function isFinal(s: GameState): boolean {
  if (s.record?.reclaimed) return true;
  const status = s.onchain?.status;
  return status === ONCHAIN_STATUS.Settled || status === ONCHAIN_STATUS.Reclaimed;
}

export function resultOf(s: GameState): GameResult | null {
  const record = s.record;
  if (!record) return null;
  if (record.reclaimed) {
    return {
      outcome: 'reclaimed',
      payoutWei: BigInt(record.reclaimed.amountWei),
      txHash: record.reclaimed.txHash,
      ...(record.chests === undefined ? {} : { chests: record.chests }),
    };
  }
  const t = record.terminal;
  if (!t) return null;
  const outcome: ResultOutcome =
    t.outcome === 0 ? 'exit' : t.outcome === 2 ? 'loss' : record.auto ? 'auto-cashout' : 'cashout';
  // The server reports a settlement transaction as soon as it is sent; one that was sent is not
  // shown until the chain says it settled the game (`settledTx`).
  const result: GameResult = { outcome, payoutWei: BigInt(t.payoutWei), txHash: s.settledTx };
  // The terminal names the dead-end chest only for an ending in a dead end.
  if (t.chestRule !== undefined && t.chest !== undefined) result.chest = t.chest;
  if (record.chests !== undefined) result.chests = record.chests;
  return result;
}

/**
 * The direct-reclaim panel's data, or `null` when it should not show. It shows for a game the
 * chain has not finished when the server cannot be reached or the settle deadline has passed.
 */
export function reclaimInfo(s: GameState, now: number): ReclaimInfo | null {
  const record = s.record;
  if (!record || record.reclaimed || (s.phase !== 'playing' && s.phase !== 'ended')) return null;
  if (s.onchain && s.onchain.status !== ONCHAIN_STATUS.Active) return null;
  const deadlineSec = s.onchain?.settleDeadline ?? s.view?.settleDeadlineSec;
  if (deadlineSec === undefined) return null;
  // The contract requires `block.timestamp > settleDeadline`.
  const ready = now > deadlineSec;
  if (!s.serverUnreachable && !ready) return null;
  return { deadlineSec, remainingSec: Math.max(0, deadlineSec + 1 - now), ready };
}

export function useGame(p: {
  config: ConfigResponse;
  deps: ClientDeps;
  chain: ChainApi;
  wallet: WalletApi | null;
  clock: ChainClock;
}): GameController {
  const { config, deps, chain, wallet } = p;
  const { api } = deps;
  const { now, observe, ticks } = p.clock;

  // `store` is the synchronous source of truth for the async flows; `state` mirrors it for render.
  const [state, setState] = useState<GameState>(resumedState);
  const store = useRef<GameState>(state);
  const update = useCallback((patch: Partial<GameState>): void => {
    store.current = { ...store.current, ...patch };
    setState(store.current);
  }, []);

  const syncing = useRef(false);
  const readingChain = useRef(false);
  const checkingSettle = useRef(false);
  const failedSyncs = useRef(0);
  const noneReads = useRef(0);
  const pollTicks = useRef(0);
  const [finalPolls, setFinalPolls] = useState<{ gameId: Hex | null; count: number }>({ gameId: null, count: 0 });
  /** The chain second of the latest render, for flows that outlive the render they started in. */
  const chainNow = useRef(now);
  useEffect(() => {
    chainNow.current = now;
  });

  const fail = useCallback(
    (error: unknown): void => {
      if (error instanceof ServerUnreachableError) update({ serverUnreachable: true });
      else if (error instanceof ApiError) {
        update({ serverUnreachable: false, error: apiMessage(error) });
      } else update({ error: describeTxError(error) });
    },
    [update],
  );

  const applyView = useCallback(
    (view: GameView, dir?: Dir): void => {
      const s = store.current;
      if (!s.record || s.record.reclaimed || view.gameId !== s.record.gameId) return;
      observe(view.chainNowSec);
      const ended = view.status !== 'active';
      if (s.view) {
        // An ended game does not come back, and an older answer may arrive after a newer one.
        if (s.view.status !== 'active' && !ended) return;
        if (!ended && view.step < s.view.step) return;
      }
      const record = withView(s.record, view, dir);
      saveRecord(record);
      update({
        record,
        view,
        serverUnreachable: false,
        phase: ended ? 'ended' : 'playing',
        endedAtSec: ended ? (s.endedAtSec ?? view.chainNowSec) : null,
      });
    },
    [observe, update],
  );

  /** Asks the server for the game: `start` until the first cell is known, the resume read after. */
  const sync = useCallback(async (): Promise<void> => {
    const { record } = store.current;
    if (!record || record.reclaimed || syncing.current) return;
    syncing.current = true;
    try {
      let view: GameView;
      if (record.observations.length === 0 && !record.terminal) {
        try {
          view = await api.start(record.gameId, record.token);
        } catch (error) {
          if (!(error instanceof ApiError) || START_RETRY_CODES.has(error.code)) throw error;
          view = await api.game(record.gameId, record.token);
        }
      } else {
        view = await api.game(record.gameId, record.token);
      }
      failedSyncs.current = 0;
      applyView(view);
    } catch (error) {
      failedSyncs.current += 1;
      const stillIndexing =
        error instanceof ApiError &&
        error.code === 'NOT_ON_CHAIN' &&
        failedSyncs.current <= QUIET_SYNC_FAILURES;
      if (stillIndexing) update({ serverUnreachable: false });
      else fail(error);
    } finally {
      syncing.current = false;
    }
  }, [api, applyView, fail, update]);

  // A resumed game asks the server where it stands; a pointer without a readable record is dropped.
  useEffect(() => {
    if (store.current.record !== null) void sync();
    else if (store.current.phase === 'lobby' && activeGameId() !== null) setActiveGameId(null);
  }, [sync]);

  /** Takes in a `getGame` read of the current game. */
  const absorbChain = useCallback(
    (gameId: Hex, onchain: OnchainGame): void => {
      const latest = store.current;
      if (latest.record?.gameId !== gameId || latest.record.reclaimed) return;
      if (onchain.status === ONCHAIN_STATUS.None) {
        noneReads.current += 1;
        if (latest.view === null && noneReads.current >= ABANDON_AFTER_NONE_READS) {
          setActiveGameId(null);
          update({
            ...INITIAL,
            error: 'This game is not on the chain. The bet was never recorded, or the chain was reset',
          });
        }
        return;
      }
      noneReads.current = 0;
      if (onchain.status === ONCHAIN_STATUS.Reclaimed) {
        // Someone else sent the reclaim; the bet went back to the player all the same.
        const reclaimed = { txHash: null, amountWei: onchain.bet.toString() };
        const record: PlayRecord = { ...latest.record, reclaimed };
        saveRecord(record);
        update({ record, onchain, phase: 'ended' });
        return;
      }
      // A finished game stays the active one until the player starts a new game, so a reload
      // (or a wallet reconnect) shows its result again.
      update({ onchain });
    },
    [update],
  );

  const placeBet = useCallback(
    async (bet: { tier: number; betWei: bigint; clientSeed: Hex }): Promise<void> => {
      if (!wallet || store.current.phase !== 'lobby') return;
      const { tier, betWei, clientSeed } = bet;
      update({ ...INITIAL, phase: 'betting', betStep: 'sign' });

      let hash: Hex;
      let record: PlayRecord;
      try {
        const token = newSessionToken();
        const sessionTokenHash = hashSessionToken(token);
        const signature = await wallet.signMessage(
          ticketRequestMessage({
            chainId: config.chainId,
            mazeBetAddress: config.contract,
            player: wallet.address,
            tier,
            sessionTokenHash,
          }),
        );
        update({ betStep: 'ticket' });
        const ticket = await api.createTicket({
          player: wallet.address,
          tier,
          sessionTokenHash,
          signature,
        });
        if (ticket.player.toLowerCase() !== wallet.address.toLowerCase()) {
          throw new Error('The server sent a ticket for another wallet');
        }
        if (ticket.tier !== tier) {
          // The server handed back this wallet's unused ticket, which fixed another size. Its
          // commitment is for that size, so it is not spent on a bet the player did not choose.
          const size = (index: number): string => {
            const n = config.tiers[index]?.n;
            return n === undefined ? `size ${index}` : `${n}×${n}`;
          };
          throw new Error(
            `This wallet still holds an unused ${size(ticket.tier)} ticket, so it cannot get a ${size(tier)} ticket yet. ` +
              `No bet transaction was sent. Bet on ${size(ticket.tier)}, or bet on ${size(tier)} again once that ticket` +
              ` expires (in about ${formatClock(ticket.expirySec - chainNow.current)})`,
          );
        }
        record = {
          gameId: ticket.gameId,
          tier,
          n: config.tiers[tier].n,
          commitment: ticket.commitment,
          clientSeed,
          token,
          observations: [],
          moves: [],
          betWei: betWei.toString(),
          player: wallet.address,
        };
        // Saved before the transaction: the token is the only way back into the game.
        saveRecord(record);
        update({ betStep: 'tx', record });
        hash = await wallet.createGame({ ticket, clientSeed, betWei });
      } catch (error) {
        // Back to the lobby whatever failed: nothing was sent to the chain, and a ticket already
        // issued is handed out again when the same wallet asks for one.
        const failedAt = store.current.betStep;
        update({ ...INITIAL });
        if (isUserRejection(error)) {
          update({
            error:
              failedAt === 'sign'
                ? 'The ticket request signature was rejected in the wallet. No bet was started. Bet again to start over'
                : 'The bet transaction was rejected in the wallet. No money left the wallet. Bet again to pick up where you left off',
          });
        } else if (error instanceof ApiError && error.code === 'UNAUTHORIZED') {
          update({
            error:
              'The server could not verify the wallet signature on the ticket request. Check the wallet account and network, then bet again',
          });
        } else fail(error);
        return;
      }

      record = { ...record, createTxHash: hash };
      saveRecord(record);
      setActiveGameId(record.gameId);
      update({ betStep: 'confirm', record });

      let mined: 'success' | 'reverted' | 'unknown';
      try {
        mined = await chain.waitForTx(hash);
      } catch {
        // The receipt could not be read. The chain watcher below decides whether the bet landed.
        mined = 'unknown';
      }
      if (mined === 'reverted') {
        setActiveGameId(null);
        update({ ...INITIAL, error: 'The bet transaction was reverted. No money left the wallet' });
        return;
      }
      failedSyncs.current = 0;
      noneReads.current = 0;
      update({ phase: 'playing', betStep: null });
      await sync();
    },
    [api, chain, config, fail, sync, update, wallet],
  );

  const act = useCallback(
    async (kind: 'move' | 'cashout', dir?: Dir): Promise<void> => {
      const s = store.current;
      if (s.phase !== 'playing' || !s.record || !s.view || s.view.status !== 'active' || s.busy) {
        return;
      }
      const { gameId, token, n, observations } = s.record;
      if (dir !== undefined && !legalMoves(n, observations).includes(dir)) return;
      update({ busy: kind, error: null });
      try {
        const step = s.view.step;
        const view =
          dir === undefined
            ? await api.cashout(gameId, token, { step })
            : await api.move(gameId, token, { step, dir });
        applyView(view, dir);
      } catch (error) {
        fail(error);
        // The server refused: its state is not what this page thought. Read it again.
        if (error instanceof ApiError) await sync();
      } finally {
        update({ busy: null });
      }
    },
    [api, applyView, fail, sync, update],
  );

  const move = useCallback((dir: Dir) => act('move', dir), [act]);
  const cashOut = useCallback(() => act('cashout'), [act]);

  const reclaimBet = useCallback(async (): Promise<void> => {
    const s = store.current;
    if (!wallet || !s.record || s.record.reclaimed || s.busy) return;
    const { gameId } = s.record;
    update({ busy: 'reclaim', error: null });
    try {
      const hash = await wallet.reclaim(gameId);
      if ((await chain.waitForTx(hash)) !== 'success') {
        throw new Error('The reclaim transaction was reverted');
      }
      const onchain = await chain.game(gameId);
      const current = store.current.record;
      if (!current || current.gameId !== gameId) return;
      const amountWei = onchain.bet > 0n ? onchain.bet.toString() : (current.betWei ?? '0');
      const record: PlayRecord = { ...current, reclaimed: { txHash: hash, amountWei } };
      saveRecord(record);
      update({ record, onchain, phase: 'ended' });
    } catch (error) {
      update({ error: describeTxError(error) });
    } finally {
      update({ busy: null });
    }
  }, [chain, update, wallet]);

  const settleSelf = useCallback(async (): Promise<void> => {
    const s = store.current;
    const terminal = s.record?.terminal;
    if (!wallet || !s.record || !terminal || s.busy) return;
    const { gameId } = s.record;
    update({ busy: 'settle', error: null });
    try {
      const hash = await wallet.settle({ gameId, terminal });
      if ((await chain.waitForTx(hash)) !== 'success') {
        throw new Error('The settlement transaction was reverted');
      }
      update({ selfSettleTx: hash });
      absorbChain(gameId, await chain.game(gameId));
    } catch (error) {
      update({ error: describeTxError(error) });
    } finally {
      update({ busy: null });
    }
  }, [absorbChain, chain, update, wallet]);

  const newGame = useCallback((): void => {
    setActiveGameId(null);
    update({ ...INITIAL });
  }, [update]);

  const dismissError = useCallback((): void => update({ error: null }), [update]);

  // Poll the server: quickly until it has seen the bet, every `pollMs` during play, and after the
  // end until the chain has shown which transaction settled the game. The hash the server reports
  // changes when a transaction it sent is dropped and sent again, so one answer is not enough.
  const { phase, record, view } = state;
  const awaitingStart = phase === 'playing' && view === null;
  // Once the chain shows the game finished, a few more polls may still name the transaction that
  // settled it; then the page stops asking. (A page reloaded after the player's own settle does
  // not know that transaction, and the server may never report one.)
  const finalOnChain = isFinal(state);
  const finalCount = finalPolls.gameId === record?.gameId ? finalPolls.count : 0;
  const awaitingSettlement =
    phase === 'ended' &&
    !record?.reclaimed &&
    state.settledTx === null &&
    !(finalOnChain && finalCount >= FINAL_POLLS);
  const pollMs = awaitingStart
    ? deps.timing.startRetryMs
    : phase === 'playing' || awaitingSettlement
      ? deps.timing.pollMs
      : null;
  const slowEvery = Math.max(1, Math.round(deps.timing.pollMs / deps.timing.startRetryMs));
  useInterval(() => {
    pollTicks.current += 1;
    // A server that keeps refusing is asked at the normal period, not the fast one.
    const backedOff = awaitingStart && failedSyncs.current > QUIET_SYNC_FAILURES;
    if (backedOff && pollTicks.current % slowEvery !== 0) return;
    const gameId = record?.gameId ?? null;
    if (finalOnChain && gameId !== null) {
      setFinalPolls((p) => ({ gameId, count: (p.gameId === gameId ? p.count : 0) + 1 }));
    }
    void sync();
  }, pollMs);

  // Once the chain clock reaches the idle or game deadline, ask on every clock read until the
  // server has ended the game (plan §7.3, AC-W7).
  useEffect(() => {
    const s = store.current;
    if (s.phase !== 'playing' || !s.view || s.view.status !== 'active') return;
    if (now >= Math.min(s.view.idleDeadlineSec, s.view.gameDeadlineSec)) void sync();
  }, [now, ticks, sync]);

  // Read the game from the chain whenever the server's word is missing or no longer enough:
  // after the end, while the server is unreachable or has not shown the game, and past the
  // settle deadline.
  useEffect(() => {
    const s = store.current;
    const current = s.record;
    if (!current || (s.phase !== 'playing' && s.phase !== 'ended') || isFinal(s)) return;
    const needsChain =
      s.phase === 'ended' ||
      s.serverUnreachable ||
      s.view === null ||
      now > s.view.settleDeadlineSec;
    if (!needsChain || readingChain.current) return;
    readingChain.current = true;
    chain
      .game(current.gameId)
      .then((onchain) => absorbChain(current.gameId, onchain))
      .catch(() => {
        // The chain clock reports an unreachable RPC; the next tick reads again.
      })
      .finally(() => {
        readingChain.current = false;
      });
  }, [absorbChain, chain, now, ticks, state.phase, state.serverUnreachable, state.view]);

  // Once the chain reports the game settled, ask it whether a transaction this page knows of is
  // the one that did it: the player's own, or the one the server last reported. A hash that is
  // not (dropped, reverted, overtaken by another copy) is asked about again after the next poll.
  useEffect(() => {
    const s = store.current;
    const current = s.record;
    if (s.phase !== 'ended' || !current?.terminal || current.reclaimed || s.settledTx !== null) return;
    if (s.onchain?.status !== ONCHAIN_STATUS.Settled || checkingSettle.current) return;
    const { gameId } = current;
    const candidates = [s.selfSettleTx, current.terminal.settleTxHash].filter(
      (hash): hash is Hex => hash !== null,
    );
    if (candidates.length === 0) return;
    checkingSettle.current = true;
    Promise.all(candidates.map((hash) => chain.settledBy(hash, gameId)))
      .then((settled) => {
        const hash = candidates[settled.indexOf(true)];
        if (hash !== undefined && store.current.record?.gameId === gameId) update({ settledTx: hash });
      })
      .catch(() => {
        // The chain clock reports an unreachable RPC; the next tick asks again.
      })
      .finally(() => {
        checkingSettle.current = false;
      });
  }, [chain, now, ticks, update, state.onchain, state.record, state.selfSettleTx, state.settledTx]);

  const active = phase === 'playing' && view?.status === 'active' && record !== null;
  const legal = active && state.busy === null ? legalMoves(record.n, record.observations) : [];

  // The player holds the signed settlement, so while the chain still shows the game Active and
  // the settle deadline has not passed, the player's own `settle` is on offer. A hash the server
  // reported counts for nothing here: it names a transaction that was sent, and one that is
  // dropped or stuck never settles the game. The chain's status is the only thing that ends this.
  // It is offered without a wallet too (a reloaded page has none yet); sending needs one.
  const onchain = state.onchain;
  const canSelfSettle =
    phase === 'ended' &&
    !record?.reclaimed &&
    record?.terminal != null &&
    onchain?.status === ONCHAIN_STATUS.Active &&
    now <= onchain.settleDeadline &&
    (state.serverUnreachable ||
      (state.endedAtSec !== null && now - state.endedAtSec >= SELF_SETTLE_AFTER_SEC));

  return {
    state,
    result: resultOf(state),
    reclaim: reclaimInfo(state, now),
    canSelfSettle,
    legal,
    placeBet,
    move,
    cashOut,
    reclaimBet,
    settleSelf,
    newGame,
    dismissError,
  };
}
