# aside scenarios: run 20261002T051556Z-44028

- started 2026-10-02T05:15:56Z, finished 2026-10-02T05:19:26Z
- table: fixture
- input path: repl; DOM read path: repl (capabilities probed 2026-10-02T05:12:50Z)
- totals (scenario 09 is advisory and not counted): 10 PASS, 0 FAIL, 0 BLOCKED; exit code 0
- no scenario uses real random seeds: the server seed comes from the game id through the test seed hook, the client seed is fixed per scenario

| # | scenario | result | input | read | chain | HTTP | DOM | seconds | reason |
|---|---|---|---|---|---|---|---|---|---|
| 01 | exit | PASS | repl | repl | 26 | 21 | 59 | 29 | chain 26, http 21, dom 59 assertions passed |
| 02 | deadend | PASS | repl | repl | 19 | 10 | 13 | 17 | chain 19, http 10, dom 13 assertions passed |
| 03 | cashout | PASS | repl | repl | 23 | 14 | 20 | 19 | chain 23, http 14, dom 20 assertions passed |
| 04 | idle-auto-cashout | PASS | repl | repl | 16 | 9 | 8 | 19 | chain 16, http 9, dom 8 assertions passed |
| 06 | verify-mismatch | PASS | repl | repl | 22 | 12 | 23 | 26 | chain 22, http 12, dom 23 assertions passed |
| 07 | invalid-move | PASS | repl | repl | 22 | 29 | 9 | 20 | chain 22, http 29, dom 9 assertions passed |
| 08 | multi-tab | PASS | repl | repl | 19 | 17 | 15 | 22 | chain 19, http 17, dom 15 assertions passed |
| 09 | exploratory-agent (advisory) | NOT-RUN | repl | repl | 0 | 0 | 0 | 0 | advisory and on request only: aside exec is model-driven and billed to the user's model account (scripts/e2e-aside.sh --with-exec) |
| 11 | dev-wallet-gating | PASS | repl | repl | 2 | 4 | 8 | 10 | chain 2, http 4, dom 8 assertions passed |
| 10 | cli-reclaim | PASS | repl | repl | 26 | 9 | 8 | 27 | chain 26, http 9, dom 8 assertions passed |
| 05 | server-down-reclaim | PASS | repl | repl | 20 | 6 | 11 | 17 | chain 20, http 6, dom 11 assertions passed |

## 01 exit: PASS

What it proves: schedule and exit payout before the bet, then the solution to the exit, the payout on chain and the verify page

Reason: chain 26, http 21, dom 59 assertions passed

Evidence: gameId `0xc0244be6fa7970fda8786c2b1fd82b0c04b808caeb38e78eb91af30eff2ec19e`, settleTx `0x6763cc857c19578197dd8a728c4603ce80485220bb6ccbeb7dd8e56cb5b6f350`
Logs: `.data/e2e-aside/20261002T051556Z-44028/01`

- PASS [http] /api/config: devWallet is on
- PASS [http] /api/config: testHooks is on
- PASS [http] /api/config: fixture matches the table mode (fixture)
- PASS [http] /api/config: the contract is the one deployed for this scenario
- PASS [http] /api/config: the chain is this scenario's Anvil
- PASS [dom] chain-info shows chain 31337 (from /api/config, not from the build)
- PASS [dom] fixture-banner is shown with the test table
- PASS [dom] wallet-dev-option is offered while devWallet is on
- PASS [dom] wallet-address is Anvil account #2
- PASS [dom] the connected wallet is the dev wallet
- PASS [chain] no game exists on chain while the schedule is read
- PASS [dom] refund-schedule is drawn for size 1
- PASS [dom] refund-schedule is drawn for the typed amount (20000000000000000 wei)
- PASS [dom] size 1: every schedule row shows step, refundBps and bet x refundBps (7 x 7 rows)
- PASS [dom] size 1: schedule-exit-payout is bet x multiplier
- PASS [dom] size 1: tier-payout-1 is bet x multiplier
- PASS [chain] size 1: the contract quotes the same exit payout
- PASS [chain] size 1: the contract's size and multiplier are the table's
- PASS [dom] refund-schedule is drawn for size 0
- PASS [dom] refund-schedule is drawn for the typed amount (10000000000000000 wei)
- PASS [dom] size 0: every schedule row shows step, refundBps and bet x refundBps (5 x 5 rows)
- PASS [dom] size 0: schedule-exit-payout is bet x multiplier
- PASS [dom] size 0: tier-payout-0 is bet x multiplier
- PASS [chain] size 0: the contract quotes the same exit payout
- PASS [chain] size 0: the contract's size and multiplier are the table's
- PASS [dom] schedule-row-0 is the refund right after the bet
- PASS [dom] schedule-row-1 is the refund after the first move
- PASS [chain] getGame.status is Active after the bet
- PASS [chain] getGame.player is the dev wallet (Anvil #2)
- PASS [chain] getGame.bet is the amount typed into the page
- PASS [chain] getGame.clientSeed is the seed typed into the page
- PASS [chain] getGame.maxPayout is bet x multiplier
- PASS [chain] totalReserved holds the game's maximum payout
- PASS [http] GET /api/games/:id answers 200 to the session token
- PASS [http] the server reports the game active at step 0
- PASS [http] refundableWei at step 0 is bet x refundBps[0]
- PASS [dom] the board has n x n cells
- PASS [dom] exactly one cell is current after 0 move(s)
- PASS [dom] one cell is visited per move made (0)
- PASS [dom] no hidden cell carries wall data
- PASS [dom] every cell the player has been to shows its walls
- PASS [dom] the start cell is marked
- PASS [dom] the exit cell is marked
- PASS [dom] refundable-amount after 0 move(s) is bet x refundBps[0]
- PASS [chain] the contract's refundBps(0, 0) is the table's
- PASS [http] the server's refundableWei after 0 move(s)
- PASS [dom] exit-payout shows bet x multiplier
- PASS [dom] the cash-out button is on screen
- PASS [dom] the board has n x n cells
- PASS [dom] exactly one cell is current after 1 move(s)
- PASS [dom] one cell is visited per move made (1)
- PASS [dom] no hidden cell carries wall data
- PASS [dom] every cell the player has been to shows its walls
- PASS [dom] the start cell is marked
- PASS [dom] the exit cell is marked
- PASS [dom] refundable-amount after 1 move(s) is bet x refundBps[1]
- PASS [chain] the contract's refundBps(0, 1) is the table's
- PASS [http] the server's refundableWei after 1 move(s)
- PASS [dom] result-outcome shows exit
- PASS [dom] result-payout shows the amount paid
- PASS [dom] result-net shows payout minus bet
- PASS [dom] the board has n x n cells
- PASS [dom] exactly one cell is current after 8 move(s)
- PASS [dom] one cell is visited per move made (8)
- PASS [dom] no hidden cell carries wall data
- PASS [dom] every cell the player has been to shows its walls
- PASS [dom] the start cell is marked
- PASS [dom] the exit cell is marked
- PASS [chain] getGame.status is Settled
- PASS [chain] the game was settled exactly once (GameSettled events)
- PASS [chain] GameSettled.outcome
- PASS [chain] GameSettled.steps
- PASS [chain] GameSettled.payout
- PASS [chain] the relayer (Anvil #1) submitted the settlement
- PASS [chain] the player's balance changed by exactly the payout
- PASS [chain] totalReserved is back to 0
- PASS [chain] the settled server seed is the one the route was planned with
- PASS [http] the server reports the game as won
- PASS [http] the server reports auto = false
- PASS [http] terminal.payoutWei is the settled payout
- PASS [http] terminal.settleTxHash is the settlement transaction
- PASS [http] GET /api/games/:id/reveal answers 200 with reason settled
- PASS [http] the revealed server seed is the settled one
- PASS [http] the revealed commitment is the one on chain
- PASS [chain] accounting: contract balance = funded + bets - payouts - reclaims + pending (1 game(s))
- PASS [chain] accounting: totalReserved is the sum of the active games' reserves
- PASS [chain] accounting: the balance covers totalReserved + totalPending
- PASS [chain] accounting: no settlement paid more than its game's maximum payout
- PASS [dom] settle-tx is marked confirmed by the chain
- PASS [dom] settle-tx names the settlement transaction
- PASS [http] GET /api/test/ui-snapshot answers 200 while test hooks are on
- PASS [http] the snapshot carries the result the page shows
- PASS [http] the snapshot carries the payout the page shows
- PASS [http] the snapshot's seq keeps rising (heartbeat)
- PASS [dom] verify-link points at /verify/<gameId>
- PASS [dom] verify: the revealed seed hashes to the commitment
- PASS [dom] verify: commitment and client seed match the chain
- PASS [dom] verify: every observed cell matches the recomputed maze
- PASS [dom] verify: the recorded moves end in the settled outcome
- PASS [dom] verify: the payout is what the table prescribes
- PASS [dom] verify: one compared cell per observation
- PASS [dom] verify: no compared cell is a mismatch
- PASS [dom] verify-game names this game
- PASS [dom] verify-maze draws the whole n x n maze
- PASS [dom] verify-solution shows the solution, as long as the route walked
- PASS [dom] verify-server-seed is the settled seed

## 02 deadend: PASS

What it proves: a route into a dead end loses the whole bet: the page says so and the chain pays nothing

Reason: chain 19, http 10, dom 13 assertions passed

Evidence: gameId `0xc7edc4c4da78acd0ea778eae40f60ebfd496a00098b6152c624cedbb54134358`, input `moves by key`, settleTx `0xb963ef40f09d7f597d327d1d9169bb02667d4aded2fb0a01f4381fc4da41b190`
Logs: `.data/e2e-aside/20261002T051556Z-44028/02`

- PASS [chain] getGame.status is Active after the bet
- PASS [chain] getGame.player is the dev wallet (Anvil #2)
- PASS [chain] getGame.bet is the amount typed into the page
- PASS [chain] getGame.clientSeed is the seed typed into the page
- PASS [chain] getGame.maxPayout is bet x multiplier
- PASS [chain] totalReserved holds the game's maximum payout
- PASS [http] GET /api/games/:id answers 200 to the session token
- PASS [http] the server reports the game active at step 0
- PASS [http] refundableWei at step 0 is bet x refundBps[0]
- PASS [dom] result-outcome shows loss
- PASS [dom] result-payout shows the amount paid
- PASS [dom] result-net shows payout minus bet
- PASS [chain] getGame.status is Settled
- PASS [chain] the game was settled exactly once (GameSettled events)
- PASS [chain] GameSettled.outcome
- PASS [chain] GameSettled.steps
- PASS [chain] GameSettled.payout
- PASS [chain] the relayer (Anvil #1) submitted the settlement
- PASS [chain] the player's balance changed by exactly the payout
- PASS [chain] totalReserved is back to 0
- PASS [chain] the settled server seed is the one the route was planned with
- PASS [http] the server reports the game as lost
- PASS [http] the server reports auto = false
- PASS [http] terminal.payoutWei is the settled payout
- PASS [http] terminal.settleTxHash is the settlement transaction
- PASS [http] GET /api/games/:id/reveal answers 200 with reason settled
- PASS [http] the revealed server seed is the settled one
- PASS [http] the revealed commitment is the one on chain
- PASS [chain] accounting: contract balance = funded + bets - payouts - reclaims + pending (1 game(s))
- PASS [chain] accounting: totalReserved is the sum of the active games' reserves
- PASS [chain] accounting: the balance covers totalReserved + totalPending
- PASS [chain] accounting: no settlement paid more than its game's maximum payout
- PASS [dom] settle-tx is marked confirmed by the chain
- PASS [dom] settle-tx names the settlement transaction
- PASS [dom] verify-link points at /verify/<gameId>
- PASS [dom] verify: the revealed seed hashes to the commitment
- PASS [dom] verify: commitment and client seed match the chain
- PASS [dom] verify: every observed cell matches the recomputed maze
- PASS [dom] verify: the recorded moves end in the settled outcome
- PASS [dom] verify: the payout is what the table prescribes
- PASS [dom] verify: one compared cell per observation
- PASS [dom] verify: no compared cell is a mismatch

## 03 cashout: PASS

What it proves: three moves, then cash-out: the refund follows the table at every step and is paid on chain

Reason: chain 23, http 14, dom 20 assertions passed

Evidence: gameId `0xa549a9e2e814c4e3582030a3f71c90b96c75307073435a50d97ec4d8b79cf8f1`, settleTx `0xf5ba5ed55eef7742945adb8855d09a8e05b349156e4d5cb10a3a676e31c1f450`
Logs: `.data/e2e-aside/20261002T051556Z-44028/03`

- PASS [chain] getGame.status is Active after the bet
- PASS [chain] getGame.player is the dev wallet (Anvil #2)
- PASS [chain] getGame.bet is the amount typed into the page
- PASS [chain] getGame.clientSeed is the seed typed into the page
- PASS [chain] getGame.maxPayout is bet x multiplier
- PASS [chain] totalReserved holds the game's maximum payout
- PASS [http] GET /api/games/:id answers 200 to the session token
- PASS [http] the server reports the game active at step 0
- PASS [http] refundableWei at step 0 is bet x refundBps[0]
- PASS [dom] refundable-amount after 0 move(s) is bet x refundBps[0]
- PASS [chain] the contract's refundBps(0, 0) is the table's
- PASS [http] the server's refundableWei after 0 move(s)
- PASS [dom] exit-payout shows bet x multiplier during play
- PASS [dom] the cash-out button is on screen during play
- PASS [dom] refundable-amount after 1 move(s) is bet x refundBps[1]
- PASS [chain] the contract's refundBps(0, 1) is the table's
- PASS [http] the server's refundableWei after 1 move(s)
- PASS [dom] refundable-amount after 2 move(s) is bet x refundBps[2]
- PASS [chain] the contract's refundBps(0, 2) is the table's
- PASS [http] the server's refundableWei after 2 move(s)
- PASS [dom] refundable-amount after 3 move(s) is bet x refundBps[3]
- PASS [chain] the contract's refundBps(0, 3) is the table's
- PASS [http] the server's refundableWei after 3 move(s)
- PASS [dom] exit-payout is unchanged after 3 moves
- PASS [dom] result-outcome shows cashout
- PASS [dom] result-payout shows the amount paid
- PASS [dom] result-net shows payout minus bet
- PASS [chain] getGame.status is Settled
- PASS [chain] the game was settled exactly once (GameSettled events)
- PASS [chain] GameSettled.outcome
- PASS [chain] GameSettled.steps
- PASS [chain] GameSettled.payout
- PASS [chain] the relayer (Anvil #1) submitted the settlement
- PASS [chain] the player's balance changed by exactly the payout
- PASS [chain] totalReserved is back to 0
- PASS [chain] the settled server seed is the one the route was planned with
- PASS [http] the server reports the game as cashed_out
- PASS [http] the server reports auto = false
- PASS [http] terminal.payoutWei is the settled payout
- PASS [http] terminal.settleTxHash is the settlement transaction
- PASS [http] GET /api/games/:id/reveal answers 200 with reason settled
- PASS [http] the revealed server seed is the settled one
- PASS [http] the revealed commitment is the one on chain
- PASS [chain] accounting: contract balance = funded + bets - payouts - reclaims + pending (1 game(s))
- PASS [chain] accounting: totalReserved is the sum of the active games' reserves
- PASS [chain] accounting: the balance covers totalReserved + totalPending
- PASS [chain] accounting: no settlement paid more than its game's maximum payout
- PASS [dom] settle-tx is marked confirmed by the chain
- PASS [dom] settle-tx names the settlement transaction
- PASS [dom] verify-link points at /verify/<gameId>
- PASS [dom] verify: the revealed seed hashes to the commitment
- PASS [dom] verify: commitment and client seed match the chain
- PASS [dom] verify: every observed cell matches the recomputed maze
- PASS [dom] verify: the recorded moves end in the settled outcome
- PASS [dom] verify: the payout is what the table prescribes
- PASS [dom] verify: one compared cell per observation
- PASS [dom] verify: no compared cell is a mismatch

## 04 idle-auto-cashout: PASS

What it proves: after 6 idle chain seconds the server cashes out and the page learns it by polling

Reason: chain 16, http 9, dom 8 assertions passed

Evidence: gameId `0x97358922f1e81abfc5906aa3fc89c1895444d4c32f899906b9bb639c4709fff2`, shownAfterDeadlineSec `0`, settleTx `0x5bfc1b43a4df777bb868b5649a1052d6dc33c831f6c43e75b602438dace7692e`
Logs: `.data/e2e-aside/20261002T051556Z-44028/04`

- PASS [http] /api/config reports the shortened idle timeout
- PASS [http] the server reports the game active after 2 moves
- PASS [dom] idle-countdown carries the server's idle deadline (chain seconds)
- PASS [chain] getGame.status is Active while the idle clock runs
- PASS [chain] getGame.bet is the amount typed into the page
- PASS [dom] the page shows a result without any input
- PASS [dom] the result is on screen within 5 (+3) chain seconds of the idle deadline
- PASS [dom] result-outcome shows auto-cashout
- PASS [dom] result-payout shows the amount paid
- PASS [dom] result-net shows payout minus bet
- PASS [chain] getGame.status is Settled
- PASS [chain] the game was settled exactly once (GameSettled events)
- PASS [chain] GameSettled.outcome
- PASS [chain] GameSettled.steps
- PASS [chain] GameSettled.payout
- PASS [chain] the relayer (Anvil #1) submitted the settlement
- PASS [chain] the player's balance changed by exactly the payout
- PASS [chain] totalReserved is back to 0
- PASS [chain] the settled server seed is the one the route was planned with
- PASS [http] the server reports the game as cashed_out
- PASS [http] the server reports auto = true
- PASS [http] terminal.payoutWei is the settled payout
- PASS [http] terminal.settleTxHash is the settlement transaction
- PASS [http] GET /api/games/:id/reveal answers 200 with reason settled
- PASS [http] the revealed server seed is the settled one
- PASS [http] the revealed commitment is the one on chain
- PASS [chain] accounting: contract balance = funded + bets - payouts - reclaims + pending (1 game(s))
- PASS [chain] accounting: totalReserved is the sum of the active games' reserves
- PASS [chain] accounting: the balance covers totalReserved + totalPending
- PASS [chain] accounting: no settlement paid more than its game's maximum payout
- PASS [chain] the settlement was mined at or after the idle deadline
- PASS [dom] settle-tx is marked confirmed by the chain
- PASS [dom] settle-tx names the settlement transaction

## 06 verify-mismatch: PASS

What it proves: one changed wall bit in an imported play record is flagged on exactly that cell

Reason: chain 22, http 12, dom 23 assertions passed

Evidence: gameId `0xc642ffc6070d7ffaa03f5908d6fea4587962a01569d741684f085fd74a5478f4`, settleTx `0x96713361e455b5ae07a0d123bf703eca33821af2524eeda8114071bf56562cd5`
Logs: `.data/e2e-aside/20261002T051556Z-44028/06`

- PASS [chain] getGame.status is Active after the bet
- PASS [chain] getGame.player is the dev wallet (Anvil #2)
- PASS [chain] getGame.bet is the amount typed into the page
- PASS [chain] getGame.clientSeed is the seed typed into the page
- PASS [chain] getGame.maxPayout is bet x multiplier
- PASS [chain] totalReserved holds the game's maximum payout
- PASS [http] GET /api/games/:id answers 200 to the session token
- PASS [http] the server reports the game active at step 0
- PASS [http] refundableWei at step 0 is bet x refundBps[0]
- PASS [dom] result-outcome shows cashout
- PASS [dom] result-payout shows the amount paid
- PASS [dom] result-net shows payout minus bet
- PASS [chain] getGame.status is Settled
- PASS [chain] the game was settled exactly once (GameSettled events)
- PASS [chain] GameSettled.outcome
- PASS [chain] GameSettled.steps
- PASS [chain] GameSettled.payout
- PASS [chain] the relayer (Anvil #1) submitted the settlement
- PASS [chain] the player's balance changed by exactly the payout
- PASS [chain] totalReserved is back to 0
- PASS [chain] the settled server seed is the one the route was planned with
- PASS [http] the server reports the game as cashed_out
- PASS [http] the server reports auto = false
- PASS [http] terminal.payoutWei is the settled payout
- PASS [http] terminal.settleTxHash is the settlement transaction
- PASS [http] GET /api/games/:id/reveal answers 200 with reason settled
- PASS [http] the revealed server seed is the settled one
- PASS [http] the revealed commitment is the one on chain
- PASS [chain] accounting: contract balance = funded + bets - payouts - reclaims + pending (1 game(s))
- PASS [chain] accounting: totalReserved is the sum of the active games' reserves
- PASS [chain] accounting: the balance covers totalReserved + totalPending
- PASS [chain] accounting: no settlement paid more than its game's maximum payout
- PASS [dom] verify-link points at /verify/<gameId>
- PASS [dom] verify: the revealed seed hashes to the commitment
- PASS [dom] verify: commitment and client seed match the chain
- PASS [dom] verify: every observed cell matches the recomputed maze
- PASS [dom] verify: the recorded moves end in the settled outcome
- PASS [dom] verify: the payout is what the table prescribes
- PASS [dom] verify: one compared cell per observation
- PASS [dom] verify: no compared cell is a mismatch
- PASS [dom] the import page starts without a record
- PASS [dom] the imported record is shown as this game
- PASS [dom] one flipped wall bit: the cell check fails
- PASS [dom] one flipped wall bit: the commitment check still passes
- PASS [dom] exactly the tampered cell is marked as a mismatch
- PASS [dom] the other compared cells still match
- PASS [dom] the tampered observation's row is a mismatch
- PASS [dom] the row before it still matches
- PASS [dom] the row after it still matches
- PASS [dom] a changed server seed fails the commitment check
- PASS [dom] the untouched record, imported, passes the commitment check
- PASS [dom] the untouched record, imported, matches on every cell
- PASS [http] the server's game read is unchanged by the imports
- PASS [http] the reveal answer is unchanged by the imports
- PASS [chain] the game is still Settled
- PASS [chain] the game is still settled exactly once
- PASS [chain] the settled payout is unchanged

## 07 invalid-move: PASS

What it proves: moves through a wall, off the grid, onto a visited cell or with a stale step are refused and change nothing

Reason: chain 22, http 29, dom 9 assertions passed

Evidence: gameId `0x156f20fd2fd558a6fa3cf41f8cc7f1425972c6c8fb6541e96c1511920e1bc577`, settleTx `0x569d60ed9d688eddc01a7111abc38bdac971f3b18af385f16a32e32d358fb3e4`
Logs: `.data/e2e-aside/20261002T051556Z-44028/07`

- PASS [chain] getGame.status is Active after the bet
- PASS [chain] getGame.player is the dev wallet (Anvil #2)
- PASS [chain] getGame.bet is the amount typed into the page
- PASS [chain] getGame.clientSeed is the seed typed into the page
- PASS [chain] getGame.maxPayout is bet x multiplier
- PASS [chain] totalReserved holds the game's maximum payout
- PASS [http] GET /api/games/:id answers 200 to the session token
- PASS [http] the server reports the game active at step 0
- PASS [http] refundableWei at step 0 is bet x refundBps[0]
- PASS [http] a move off the grid at step 0: 409 INVALID_MOVE_BOUNDS
- PASS [http] a move off the grid at step 0: the body is only { error: { code, message } }
- PASS [dom] refundable-amount before the refused moves
- PASS [dom] the page does not offer the wall direction (move-E is not legal)
- PASS [http] a move through a wall: 409 INVALID_MOVE_WALL
- PASS [http] a move through a wall: the body is only { error: { code, message } }
- PASS [http] a move back onto a visited cell: 409 INVALID_MOVE_VISITED
- PASS [http] a move back onto a visited cell: the body is only { error: { code, message } }
- PASS [http] a move with a stale step: 409 STALE_STEP
- PASS [http] a move with a stale step: the body is only { error: { code, message } }
- PASS [http] a move with a direction that does not exist: 400 BAD_REQUEST
- PASS [http] a move with a direction that does not exist: the body is only { error: { code, message } }
- PASS [http] a move with an extra field: 400 BAD_REQUEST
- PASS [http] a move with an extra field: the body is only { error: { code, message } }
- PASS [http] a move without a session token: 401 UNAUTHORIZED
- PASS [http] a move without a session token: the body is only { error: { code, message } }
- PASS [http] a move with a wrong session token: 401 UNAUTHORIZED
- PASS [http] a move with a wrong session token: the body is only { error: { code, message } }
- PASS [http] the seed of a game in progress is not revealed
- PASS [http] the game cannot be read without the session token
- PASS [http] the server's game read is unchanged by the refused moves
- PASS [chain] the game is still Active
- PASS [chain] nothing was settled
- PASS [chain] totalReserved still holds the game's maximum payout
- PASS [dom] the board is still at step 1
- PASS [dom] refundable-amount is unchanged
- PASS [dom] the current cell is unchanged
- PASS [dom] the page shows no error: it sent none of these moves
- PASS [dom] result-outcome shows cashout
- PASS [dom] result-payout shows the amount paid
- PASS [dom] result-net shows payout minus bet
- PASS [chain] getGame.status is Settled
- PASS [chain] the game was settled exactly once (GameSettled events)
- PASS [chain] GameSettled.outcome
- PASS [chain] GameSettled.steps
- PASS [chain] GameSettled.payout
- PASS [chain] the relayer (Anvil #1) submitted the settlement
- PASS [chain] the player's balance changed by exactly the payout
- PASS [chain] totalReserved is back to 0
- PASS [chain] the settled server seed is the one the route was planned with
- PASS [http] the server reports the game as cashed_out
- PASS [http] the server reports auto = false
- PASS [http] terminal.payoutWei is the settled payout
- PASS [http] terminal.settleTxHash is the settlement transaction
- PASS [http] GET /api/games/:id/reveal answers 200 with reason settled
- PASS [http] the revealed server seed is the settled one
- PASS [http] the revealed commitment is the one on chain
- PASS [chain] accounting: contract balance = funded + bets - payouts - reclaims + pending (1 game(s))
- PASS [chain] accounting: totalReserved is the sum of the active games' reserves
- PASS [chain] accounting: the balance covers totalReserved + totalPending
- PASS [chain] accounting: no settlement paid more than its game's maximum payout

## 08 multi-tab: PASS

What it proves: a second tab resumes the game, and of two different moves sent for the same step exactly one counts

Reason: chain 19, http 17, dom 15 assertions passed

Evidence: gameId `0x2c9fdb25e88cb4dd2006081a3970b81fd5fb9ec6b78d5ad80e8479d94acf1fba`, acceptedTab `A`, settleTx `0xc6782145c9316730108233f39b0be33e148b0cbb477b4e387d768702be261a14`
Logs: `.data/e2e-aside/20261002T051556Z-44028/08`

- PASS [chain] getGame.status is Active after the bet
- PASS [chain] getGame.player is the dev wallet (Anvil #2)
- PASS [chain] getGame.bet is the amount typed into the page
- PASS [chain] getGame.clientSeed is the seed typed into the page
- PASS [chain] getGame.maxPayout is bet x multiplier
- PASS [chain] totalReserved holds the game's maximum payout
- PASS [http] GET /api/games/:id answers 200 to the session token
- PASS [http] the server reports the game active at step 0
- PASS [http] refundableWei at step 0 is bet x refundBps[0]
- PASS [dom] tab B resumes the same game from localStorage
- PASS [dom] tab B resumes at step 3
- PASS [dom] tab B shows the same refundable amount
- PASS [dom] tab B has no wallet connected: the session token alone resumes the game
- PASS [http] each tab's page sent one move, both for step 3
- PASS [http] the two moves were different directions
- PASS [http] the server accepted exactly one of them (200)
- PASS [http] the server refused exactly one of them with 409 STALE_STEP
- PASS [http] the refusal carries no game state: its body is only { error: { code, message } }
- PASS [http] the server holds one more step, not two
- PASS [http] the server's path has one cell per step
- PASS [dom] tab A shows the server's current cell
- PASS [dom] tab B shows the server's current cell
- PASS [dom] the tab whose move was refused (tab B) says so
- PASS [dom] the tab whose move was accepted (tab A) shows no error
- PASS [dom] tab A shows the refund of step 4
- PASS [dom] tab B shows the refund of step 4
- PASS [dom] result-outcome shows cashout
- PASS [dom] result-payout shows the amount paid
- PASS [dom] result-net shows payout minus bet
- PASS [dom] tab B learns the cash-out by polling
- PASS [dom] tab B shows the same payout
- PASS [chain] getGame.status is Settled
- PASS [chain] the game was settled exactly once (GameSettled events)
- PASS [chain] GameSettled.outcome
- PASS [chain] GameSettled.steps
- PASS [chain] GameSettled.payout
- PASS [chain] the relayer (Anvil #1) submitted the settlement
- PASS [chain] the player's balance changed by exactly the payout
- PASS [chain] totalReserved is back to 0
- PASS [chain] the settled server seed is the one the route was planned with
- PASS [http] the server reports the game as cashed_out
- PASS [http] the server reports auto = false
- PASS [http] terminal.payoutWei is the settled payout
- PASS [http] terminal.settleTxHash is the settlement transaction
- PASS [http] GET /api/games/:id/reveal answers 200 with reason settled
- PASS [http] the revealed server seed is the settled one
- PASS [http] the revealed commitment is the one on chain
- PASS [chain] accounting: contract balance = funded + bets - payouts - reclaims + pending (1 game(s))
- PASS [chain] accounting: totalReserved is the sum of the active games' reserves
- PASS [chain] accounting: the balance covers totalReserved + totalPending
- PASS [chain] accounting: no settlement paid more than its game's maximum payout

## 09 exploratory-agent: NOT-RUN

What it proves: advisory: after a model-driven agent has tried to cheat, the contract's accounting and the server's access rules still hold

Reason: advisory and on request only: aside exec is model-driven and billed to the user's model account (scripts/e2e-aside.sh --with-exec)

Logs: `.data/e2e-aside/20261002T051556Z-44028/09`


## 11 dev-wallet-gating: PASS

What it proves: the dev wallet is offered only when /api/config says devWallet, with the same build

Reason: chain 2, http 4, dom 8 assertions passed

Logs: `.data/e2e-aside/20261002T051556Z-44028/11`

- PASS [http] /api/config: devWallet is false when NEXT_PUBLIC_ENABLE_DEV_WALLET=0
- PASS [http] /api/config: the chain is 31337
- PASS [chain] the chain id is 31337
- PASS [dom] the lobby is up: wallet-connect is offered
- PASS [dom] the page knows the chain from /api/config
- PASS [dom] wallet-dev-option is not in the DOM while devWallet is false
- PASS [dom] wallet-dev-account is not in the DOM while devWallet is false
- PASS [dom] bet-submit is disabled without a wallet
- PASS [chain] no game was created while no wallet could be connected
- PASS [http] /api/config: devWallet is true after the restart with NEXT_PUBLIC_ENABLE_DEV_WALLET=1
- PASS [http] /api/config: the contract is unchanged
- PASS [dom] after a reload wallet-dev-option is in the DOM
- PASS [dom] the dev wallet connects Anvil account #2
- PASS [dom] the connected wallet is the dev wallet

## 10 cli-reclaim: PASS

What it proves: with the server dead, anyone reclaims the bet for the player with scripts/reclaim.sh after the settle deadline

Reason: chain 26, http 9, dom 8 assertions passed

Evidence: gameId `0x09ffe92df206036bd1d87d6aa640f1f7a89e2722ce2235d9b2e7f41b783bcf5b`, reclaimTx `0x4ff9a1cb40bb2c5f3b5f5a45ee7758e0eaa099ad1016f8a79ba61ce227f9515b`
Logs: `.data/e2e-aside/20261002T051556Z-44028/10`

- PASS [chain] getGame.status is Active after the bet
- PASS [chain] getGame.player is the dev wallet (Anvil #2)
- PASS [chain] getGame.bet is the amount typed into the page
- PASS [chain] getGame.clientSeed is the seed typed into the page
- PASS [chain] getGame.maxPayout is bet x multiplier
- PASS [chain] totalReserved holds the game's maximum payout
- PASS [http] GET /api/games/:id answers 200 to the session token
- PASS [http] the server reports the game active at step 0
- PASS [http] refundableWei at step 0 is bet x refundBps[0]
- PASS [http] the server reports the game active at step 1 before it is stopped
- PASS [http] the server cannot be reached after the stop
- PASS [chain] scripts/reclaim.sh exits 1 before the settle deadline
- PASS [chain] scripts/reclaim.sh names the refusal DeadlineNotReached
- PASS [chain] the game is still Active after the refused reclaim
- PASS [chain] scripts/reclaim.sh exits 0 after the settle deadline
- PASS [chain] getGame.status is Reclaimed
- PASS [chain] exactly one GameReclaimed event
- PASS [chain] GameReclaimed.amount is the whole bet
- PASS [chain] GameReclaimed.player is the player
- PASS [chain] a third party (Anvil #9) sent the reclaim
- PASS [chain] the player's balance grew by exactly the bet
- PASS [chain] scripts/reclaim.sh printed the transaction it sent
- PASS [chain] a second reclaim is refused (exit 1)
- PASS [chain] the second refusal is GameNotActive
- PASS [dom] the open page shows reclaimed, learnt from the chain alone
- PASS [dom] result-payout shows the whole bet
- PASS [dom] settle-tx names no transaction: someone else sent it
- PASS [http] after the restart the reveal route answers 200 with reason reclaimed
- PASS [http] the revealed seed is the one the route was planned with
- PASS [http] the revealed commitment is the one on chain
- PASS [http] the restarted server refuses a move on the reclaimed game
- PASS [chain] the restarted server does not settle the reclaimed game
- PASS [chain] the game is still Reclaimed
- PASS [chain] totalReserved is back to 0
- PASS [chain] accounting: contract balance = funded + bets - payouts - reclaims + pending (1 game(s))
- PASS [chain] accounting: totalReserved is the sum of the active games' reserves
- PASS [chain] accounting: the balance covers totalReserved + totalPending
- PASS [chain] accounting: no settlement paid more than its game's maximum payout
- PASS [dom] verify-link points at /verify/<gameId>
- PASS [dom] verify: the revealed seed hashes to the commitment
- PASS [dom] verify: commitment and client seed match the chain
- PASS [dom] verify: every observed cell matches the recomputed maze
- PASS [dom] verify: one compared cell per observation (start and one move)

## 05 server-down-reclaim: PASS

What it proves: with the server dead, the page that was open reclaims the bet itself after the settle deadline

Reason: chain 20, http 6, dom 11 assertions passed

Evidence: gameId `0x640070413309362d5a463dd164d4cb265973be152a09b98717d328f1adac5998`, reclaimTx `0x6420389cc048e24b3058d3f975f27fbef1d3962b4bd334f22f3939f0d954db5a`
Logs: `.data/e2e-aside/20261002T051556Z-44028/05`

- PASS [chain] getGame.status is Active after the bet
- PASS [chain] getGame.player is the dev wallet (Anvil #2)
- PASS [chain] getGame.bet is the amount typed into the page
- PASS [chain] getGame.clientSeed is the seed typed into the page
- PASS [chain] getGame.maxPayout is bet x multiplier
- PASS [chain] totalReserved holds the game's maximum payout
- PASS [http] GET /api/games/:id answers 200 to the session token
- PASS [http] the server reports the game active at step 0
- PASS [http] refundableWei at step 0 is bet x refundBps[0]
- PASS [http] the server reports the game active at step 1 before it is stopped
- PASS [http] the server's settleDeadlineSec is the contract's settleDeadline
- PASS [http] the server cannot be reached after the stop
- PASS [dom] the open page shows server-unreachable
- PASS [dom] the open page shows the reclaim countdown
- PASS [dom] reclaim-countdown is not ready before the deadline
- PASS [dom] reclaim-countdown carries the contract's settle deadline
- PASS [dom] the countdown's clock is the block timestamp (at most 3 seconds behind the chain)
- PASS [dom] the remaining seconds are deadline + 1 - block time
- PASS [dom] reclaim-button is disabled before the deadline
- PASS [chain] the contract refuses reclaim before the settle deadline
- PASS [chain] the chain clock is past the settle deadline
- PASS [dom] reclaim-countdown becomes ready once block time passes the deadline
- PASS [dom] result-outcome shows reclaimed
- PASS [dom] result-payout shows the whole bet
- PASS [chain] getGame.status is Reclaimed
- PASS [chain] exactly one GameReclaimed event
- PASS [chain] GameReclaimed.amount is the whole bet
- PASS [chain] GameReclaimed.player is the player
- PASS [chain] the page's dev wallet sent the reclaim
- PASS [chain] the player's balance grew by the bet minus the transaction fee
- PASS [chain] the game was never settled
- PASS [chain] totalReserved is back to 0
- PASS [chain] accounting: contract balance = funded + bets - payouts - reclaims + pending (1 game(s))
- PASS [chain] accounting: totalReserved is the sum of the active games' reserves
- PASS [chain] accounting: the balance covers totalReserved + totalPending
- PASS [chain] accounting: no settlement paid more than its game's maximum payout
- PASS [dom] settle-tx names the reclaim transaction

