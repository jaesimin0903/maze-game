// Game rules, payouts, deadlines and ticket policy, exercised through the real route handlers.

import {
  EIP712_TYPES,
  exitPayoutWei,
  mazeBetDomain,
  refundWei,
  type Dir,
  type ErrorResponse,
  type GameView,
  type Hex,
  type TicketResponse,
} from '@maze/shared';
import { verifyTypedData } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  BET,
  CONTRACT,
  deadEndRoute,
  exitRoute,
  makeEnv,
  newToken,
  ONCHAIN,
  openGame,
  outDir,
  PLAYERS,
  requestTicket,
  SIGNER_ADDRESS,
  wallDir,
  type OpenedGame,
  type TestEnv,
} from './helpers';

let env: TestEnv;

beforeEach(async () => {
  env = await makeEnv();
});

afterEach(async () => {
  await env.close();
});

function expectError(reply: { status: number; body: unknown }, status: number, code: string): void {
  expect(reply.status).toBe(status);
  expect(reply.body).toEqual({ error: { code, message: expect.any(String) } });
}

/** Plays `dirs` in order and returns the last view. */
async function walk(game: OpenedGame, dirs: readonly Dir[], fromStep = 0): Promise<GameView> {
  let view: GameView | null = null;
  for (let i = 0; i < dirs.length; i++) {
    const reply = await api.move<GameView>(game.gameId, game.token, {
      step: fromStep + i,
      dir: dirs[i],
    });
    expect(reply.status).toBe(200);
    view = reply.body;
  }
  if (view === null) throw new Error('walk needs at least one move');
  return view;
}

describe('before the game is on chain', () => {
  it('AC-M3: no cell is shown until the server itself has read GameCreated', async () => {
    const { ticket, token } = await requestTicket();
    expectError(await api.start(ticket.gameId, token), 409, 'NOT_ON_CHAIN');
    expectError(await api.move(ticket.gameId, token, { step: 0, dir: 1 }), 409, 'NOT_ON_CHAIN');
    expectError(await api.cashout(ticket.gameId, token, { step: 0 }), 409, 'NOT_ON_CHAIN');
    expectError(await api.game(ticket.gameId, token), 409, 'NOT_ON_CHAIN');

    env.chain.createGame({ ...ticket, betWei: BET, clientSeed: `0x${'11'.repeat(32)}` });
    // No worker pass: `start` reads the chain itself.
    const reply = await api.start<GameView>(ticket.gameId, token);
    expect(reply.status).toBe(200);
    expect(reply.body.step).toBe(0);
    expect(reply.body.cell).toEqual({ x: 0, y: 0 });
  });

  it('answers TICKET_EXPIRED once the ticket can no longer create a game', async () => {
    const { ticket, token } = await requestTicket();
    env.advance(env.table.timing.ticketExpirySec + 1);
    expectError(await api.start(ticket.gameId, token), 410, 'TICKET_EXPIRED');
    expectError(await api.game(ticket.gameId, token), 410, 'TICKET_EXPIRED');
  });

  it('the ticket commits to the seed and carries a valid server signature', async () => {
    const { ticket } = await requestTicket({ tier: 1 });
    expect(ticket.expirySec).toBe(env.chain.time + env.table.timing.ticketExpirySec);
    const valid = await verifyTypedData({
      address: SIGNER_ADDRESS,
      domain: mazeBetDomain(31337, CONTRACT),
      types: EIP712_TYPES,
      primaryType: 'Ticket',
      message: {
        gameId: ticket.gameId,
        player: ticket.player,
        tier: ticket.tier,
        commitment: ticket.commitment,
        expiry: BigInt(ticket.expirySec),
      },
      signature: ticket.signature,
    });
    expect(valid).toBe(true);
    expect(Object.keys(ticket).sort()).toEqual(
      ['commitment', 'expirySec', 'gameId', 'player', 'signature', 'tier'].sort(),
    );
  });
});

describe('the three endings', () => {
  it('AC-R2: reaching the exit wins bet × multiplier', async () => {
    const game = await openGame(env);
    const route = exitRoute(game.maze);
    const view = await walk(game, route);

    expect(view.status).toBe('won');
    expect(view.auto).toBe(false);
    expect(view.step).toBe(route.length);
    expect(view.cell).toEqual({ x: game.n - 1, y: game.n - 1 });
    expect(view.terminal).toMatchObject({
      outcome: 0,
      steps: route.length,
      payoutWei: exitPayoutWei(env.table, BET, 0).toString(),
      clientSeed: game.clientSeed,
    });
  });

  it('AC-R4: arriving in a dead end loses everything', async () => {
    const game = await openGame(env, { deadEnd: true });
    const route = deadEndRoute(game.maze);
    const view = await walk(game, route);

    expect(view.status).toBe('lost');
    expect(view.terminal).toMatchObject({ outcome: 2, steps: route.length, payoutWei: '0' });
  });

  it('AC-R3: cash-out after k moves pays refund(k), k = 0 included', async () => {
    for (const k of [0, 1, 3]) {
      const game = await openGame(env, { player: PLAYERS[k] });
      const route = exitRoute(game.maze).slice(0, k);
      if (k > 0) {
        const view = await walk(game, route);
        expect(view.refundableWei).toBe(refundWei(env.table, BET, 0, k).toString());
      }
      const reply = await api.cashout<GameView>(game.gameId, game.token, { step: k });
      expect(reply.status).toBe(200);
      expect(reply.body.status).toBe('cashed_out');
      expect(reply.body.auto).toBe(false);
      expect(reply.body.terminal).toMatchObject({
        outcome: 1,
        steps: k,
        payoutWei: refundWei(env.table, BET, 0, k).toString(),
      });
    }
    expect(refundWei(env.table, BET, 0, 0)).toBe((BET * 9500n) / 10_000n);
  });

  it('AC-S3: the settlement is signed over the recorded steps and the table amount', async () => {
    const game = await openGame(env);
    await walk(game, exitRoute(game.maze).slice(0, 2));
    const reply = await api.cashout<GameView>(game.gameId, game.token, { step: 2 });
    const terminal = reply.body.terminal!;
    const valid = await verifyTypedData({
      address: SIGNER_ADDRESS,
      domain: mazeBetDomain(31337, CONTRACT),
      types: EIP712_TYPES,
      primaryType: 'Settlement',
      message: {
        gameId: game.gameId,
        player: game.player,
        outcome: 1,
        steps: 2,
        payout: refundWei(env.table, BET, 0, 2),
        serverSeed: terminal.serverSeed,
      },
      signature: terminal.signature,
    });
    expect(valid).toBe(true);
    // 65 bytes, as the contract requires.
    expect(terminal.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('an ended game refuses every further action', async () => {
    const game = await openGame(env);
    await api.cashout(game.gameId, game.token, { step: 0 });
    expectError(await api.move(game.gameId, game.token, { step: 0, dir: 1 }), 409, 'GAME_NOT_ACTIVE');
    expectError(await api.cashout(game.gameId, game.token, { step: 0 }), 409, 'GAME_NOT_ACTIVE');
    expectError(await api.start(game.gameId, game.token), 409, 'GAME_NOT_ACTIVE');
    expect(env.signs.settlement).toBe(1);
  });

  it('the settle transaction hash appears in the read once the settlement is mined', async () => {
    const game = await openGame(env);
    await api.cashout(game.gameId, game.token, { step: 0 });
    await env.container.relayer.drain();
    expect(env.chain.sent).toHaveLength(1);

    env.advance(1);
    await env.tick();
    const reply = await api.game<GameView>(game.gameId, game.token);
    expect(reply.body.terminal!.settleTxHash).toBe(env.chain.sent[0].hash);
    expect(env.chain.games.get(game.gameId)!.status).toBe(ONCHAIN.Settled);
  });
});

describe('AC-R5: invalid requests change nothing', () => {
  it('wall, visited and out-of-bounds moves are refused', async () => {
    const game = await openGame(env);
    const first = exitRoute(game.maze)[0];
    const before = await api.game<GameView>(game.gameId, game.token);

    expectError(
      await api.move(game.gameId, game.token, { step: 0, dir: wallDir(game.maze, 0) }),
      409,
      'INVALID_MOVE_WALL',
    );
    expectError(
      await api.move(game.gameId, game.token, { step: 0, dir: outDir(game.maze, 0) }),
      409,
      'INVALID_MOVE_BOUNDS',
    );
    expect((await api.game(game.gameId, game.token)).text).toBe(before.text);

    await walk(game, [first]);
    const back = ((first + 2) % 4) as Dir;
    const afterOne = await api.game<GameView>(game.gameId, game.token);
    expectError(
      await api.move(game.gameId, game.token, { step: 1, dir: back }),
      409,
      'INVALID_MOVE_VISITED',
    );
    expect((await api.game(game.gameId, game.token)).text).toBe(afterOne.text);
    expect(afterOne.body.step).toBe(1);
  });

  it('a stale or future step is refused', async () => {
    const game = await openGame(env);
    const route = exitRoute(game.maze);
    await walk(game, [route[0]]);
    expectError(await api.move(game.gameId, game.token, { step: 0, dir: route[1] }), 409, 'STALE_STEP');
    expectError(await api.move(game.gameId, game.token, { step: 2, dir: route[1] }), 409, 'STALE_STEP');
    expectError(await api.cashout(game.gameId, game.token, { step: 0 }), 409, 'STALE_STEP');
    // A second `start` after a move is refused the same way every time.
    expectError(await api.start(game.gameId, game.token), 409, 'STALE_STEP');
    expectError(await api.start(game.gameId, game.token), 409, 'STALE_STEP');
    expect((await api.game<GameView>(game.gameId, game.token)).body.step).toBe(1);
  });

  it('malformed bodies and ids are BAD_REQUEST', async () => {
    const game = await openGame(env);
    for (const body of [
      {},
      { step: 0 },
      { step: 0, dir: 4 },
      { step: 0, dir: '1' },
      { step: -1, dir: 1 },
      { step: 0.5, dir: 1 },
      { step: 0, dir: 1, extra: true },
      [0, 1],
    ]) {
      expectError(await api.move(game.gameId, game.token, body), 400, 'BAD_REQUEST');
    }
    expectError(await api.cashout(game.gameId, game.token, { step: '0' }), 400, 'BAD_REQUEST');
    expectError(await api.cashout(game.gameId, game.token, {}), 400, 'BAD_REQUEST');
    expectError(await api.start(game.gameId, game.token, { any: 1 }), 400, 'BAD_REQUEST');
    expectError(await api.game('0x1234', game.token), 400, 'BAD_REQUEST');
    expectError(await api.ticketRaw('{not json'), 400, 'BAD_REQUEST');
    expectError(await api.ticketRaw(`{"pad":"${'x'.repeat(5000)}"}`), 400, 'BAD_REQUEST');
    expect((await api.game<GameView>(game.gameId, game.token)).body.step).toBe(0);
  });

  it("X25: another session's token, a missing token and an unknown game are refused", async () => {
    const game = await openGame(env);
    const other = await openGame(env, { player: PLAYERS[1] });
    expectError(await api.start(game.gameId, other.token), 401, 'UNAUTHORIZED');
    expectError(await api.move(game.gameId, other.token, { step: 0, dir: 1 }), 401, 'UNAUTHORIZED');
    expectError(await api.cashout(game.gameId, null, { step: 0 }), 401, 'UNAUTHORIZED');
    expectError(await api.game(game.gameId, 'nope'), 401, 'UNAUTHORIZED');
    expectError(await api.game(`0x${'ab'.repeat(32)}`, game.token), 404, 'NOT_FOUND');
    expect(env.container.service.get(game.gameId)!.ended).toBeNull();
  });
});

describe('deadlines on the chain clock', () => {
  it('AC-S4: an idle game is cashed out at its current step, /start or not', async () => {
    const idle = env.table.timing.idleTimeoutSec;
    const never = await openGame(env, { player: PLAYERS[0] });
    const walked = await openGame(env, { player: PLAYERS[1] });
    await api.start(walked.gameId, walked.token);
    env.advance(10);
    await walk(walked, exitRoute(walked.maze).slice(0, 2));

    env.advance(idle - 11);
    await env.tick();
    expect(env.container.service.get(never.gameId)!.ended).toBeNull();

    // The game nobody started is due first: its clock began at the creation block.
    env.advance(1);
    await env.tick();
    const first = await api.game<GameView>(never.gameId, never.token);
    expect(first.body).toMatchObject({ status: 'cashed_out', auto: true, step: 0 });
    expect(first.body.terminal!.payoutWei).toBe(refundWei(env.table, BET, 0, 0).toString());
    expect(env.container.service.get(walked.gameId)!.ended).toBeNull();

    env.advance(10);
    await env.tick();
    const second = await api.game<GameView>(walked.gameId, walked.token);
    expect(second.body).toMatchObject({ status: 'cashed_out', auto: true, step: 2 });
    expect(second.body.terminal!.payoutWei).toBe(refundWei(env.table, BET, 0, 2).toString());
  });

  it('a late /start does not restart the idle timer', async () => {
    const idle = env.table.timing.idleTimeoutSec;
    const game = await openGame(env);
    env.advance(idle - 1);
    const reply = await api.start<GameView>(game.gameId, game.token);
    expect(reply.status).toBe(200);
    expect(reply.body.idleDeadlineSec).toBe(env.chain.time + 1);

    env.advance(1);
    expectError(await api.start(game.gameId, game.token), 409, 'DEADLINE_PASSED');
    await env.tick();
    expect((await api.game<GameView>(game.gameId, game.token)).body).toMatchObject({
      status: 'cashed_out',
      auto: true,
      step: 0,
    });
  });

  it('a move or cash-out after a deadline is refused even before the worker ran', async () => {
    const game = await openGame(env);
    const route = exitRoute(game.maze);
    await walk(game, [route[0]]);
    env.advance(env.table.timing.idleTimeoutSec);

    expectError(await api.move(game.gameId, game.token, { step: 1, dir: route[1] }), 409, 'DEADLINE_PASSED');
    expectError(await api.cashout(game.gameId, game.token, { step: 1 }), 409, 'DEADLINE_PASSED');
    expect(env.signs.settlement).toBe(0);

    await env.tick();
    expect(env.signs.settlement).toBe(1);
    expect(env.container.service.get(game.gameId)!.ended).toMatchObject({ outcome: 1, steps: 1, auto: true, cause: 'idle' });
  });

  it('the game is force-settled at the maximum game time however often the player moves', async () => {
    await env.close();
    env = await makeEnv({ config: { idleTimeoutSec: 50, maxGameSec: 100 } });
    const game = await openGame(env, { tier: 2 });
    const route = exitRoute(game.maze);
    env.advance(40);
    await walk(game, [route[0]]);
    env.advance(40);
    const view = await walk(game, [route[1]], 1);
    expect(view.gameDeadlineSec).toBe(env.chain.time + 20);
    expect(view.idleDeadlineSec).toBe(env.chain.time + 50);

    env.advance(20);
    expectError(await api.move(game.gameId, game.token, { step: 2, dir: route[2] }), 409, 'DEADLINE_PASSED');
    await env.tick();
    expect(env.container.service.get(game.gameId)!.ended).toMatchObject({
      outcome: 1,
      steps: 2,
      auto: true,
      cause: 'max-game',
      payoutWei: refundWei(env.table, BET, 2, 2),
    });
  });
});

describe('a game the server could not end in time', () => {
  it('is never signed after the settle deadline: only reclaim is left', async () => {
    const game = await openGame(env);
    const route = exitRoute(game.maze);
    await walk(game, [route[0]]);
    const deadline = env.chain.games.get(game.gameId)!.settleDeadlineSec;

    // No worker pass happened for the whole settle window (the server was not running).
    env.advance(deadline + 1 - env.chain.time);
    await env.tick();
    await env.tick();
    expect(env.signs.settlement).toBe(0);
    expect(env.chain.sent).toHaveLength(0);
    expect(env.logs.filter((line) => line.event === 'settle-window-missed')).toHaveLength(1);
    expectError(await api.move(game.gameId, game.token, { step: 1, dir: route[1] }), 409, 'DEADLINE_PASSED');
    expectError(await api.cashout(game.gameId, game.token, { step: 1 }), 409, 'DEADLINE_PASSED');

    env.chain.reclaim(game.gameId);
    await env.tick();
    expect(env.container.service.get(game.gameId)).toMatchObject({ final: 'reclaimed', ended: null });
    expectError(await api.cashout(game.gameId, game.token, { step: 1 }), 409, 'GAME_NOT_ACTIVE');
    expect(env.signs.settlement).toBe(0);
    // The address is free again.
    expect((await api.ticket({ player: PLAYERS[0], tier: 0, sessionTokenHash: newToken().sessionTokenHash })).status).toBe(201);
  });
});

describe('ticket policy', () => {
  it('X3: one address gets at most 10 tickets per 60 chain seconds', async () => {
    for (let i = 0; i < 10; i++) await requestTicket();
    const body = { player: PLAYERS[0], tier: 0, sessionTokenHash: newToken().sessionTokenHash };
    expectError(await api.ticket(body), 429, 'RATE_LIMITED');
    // Another address is not affected.
    expect((await api.ticket({ ...body, player: PLAYERS[1] })).status).toBe(201);

    env.advance(60);
    expect((await api.ticket(body)).status).toBe(201);
  });

  it('X3 / X4: tickets reveal only hashes of fresh random seeds', async () => {
    const seeds = new Set<Hex>();
    const commitments = new Set<Hex>();
    for (let i = 0; i < 10; i++) {
      const { ticket } = await requestTicket();
      seeds.add(env.container.service.get(ticket.gameId)!.serverSeed);
      commitments.add(ticket.commitment);
      expect(JSON.stringify(ticket)).not.toContain(
        env.container.service.get(ticket.gameId)!.serverSeed.slice(2),
      );
    }
    expect(seeds.size).toBe(10);
    expect(commitments.size).toBe(10);
  });

  it('ALREADY_ACTIVE while the address has a game that is active on chain', async () => {
    const game = await openGame(env);
    const body = { player: PLAYERS[0], tier: 0, sessionTokenHash: newToken().sessionTokenHash };
    expectError(await api.ticket(body), 409, 'ALREADY_ACTIVE');
    // The check is not case-sensitive in the address.
    expectError(await api.ticket({ ...body, player: PLAYERS[0].toLowerCase() }), 409, 'ALREADY_ACTIVE');

    await api.cashout(game.gameId, game.token, { step: 0 });
    await env.container.relayer.drain();
    // Ended on the server, still Active on chain until the settlement is mined.
    expectError(await api.ticket(body), 409, 'ALREADY_ACTIVE');
    env.advance(1);
    await env.tick();
    expect((await api.ticket<TicketResponse>(body)).status).toBe(201);
  });

  it('rejects malformed ticket requests', async () => {
    const hash = newToken().sessionTokenHash;
    for (const body of [
      { player: 'nope', tier: 0, sessionTokenHash: hash },
      { player: PLAYERS[0], tier: 3, sessionTokenHash: hash },
      { player: PLAYERS[0], tier: -1, sessionTokenHash: hash },
      { player: PLAYERS[0], tier: 0, sessionTokenHash: '0x12' },
      { player: PLAYERS[0], tier: 0 },
      { player: PLAYERS[0], tier: 0, sessionTokenHash: hash, bet: '1' },
    ]) {
      const reply = await api.ticket<ErrorResponse>(body);
      expectError(reply, 400, 'BAD_REQUEST');
    }
    expect(env.signs.ticket).toBe(0);
  });
});
