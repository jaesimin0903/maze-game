#!/usr/bin/env bash
# 10 server down: reclaim from the command line (plan §9.1; AC-E2).
#
# Bets, makes one move, then the app process is killed. A third party (Anvil account #9) runs
# scripts/reclaim.sh: before the settle deadline it must be refused, after it the bet must go
# back to the player. Then the app is started again on the same chain and data directory and
# has to treat the game as reclaimed and reveal its seed.
#
# This scenario moves the chain clock (evm_increaseTime) on an Anvil of its own.
#
#   chain  scripts/reclaim.sh exits 1 with DeadlineNotReached before the deadline and the game
#          stays Active; after the time warp it exits 0; getGame is Reclaimed; GameReclaimed
#          (amount = bet) was sent by the third party; the player's balance grew by exactly the
#          bet; a second reclaim is refused (GameNotActive); the restarted server does not
#          settle the game
#   HTTP   the server cannot be reached while it is down; after the restart the reveal route
#          answers with reason reclaimed, the planned seed and the on-chain commitment, and a
#          move is refused with GAME_NOT_ACTIVE
#   DOM    the page that stayed open learns the reclaim from the chain alone: result-outcome =
#          reclaimed with the whole bet and no transaction of its own; after the restart the
#          verify dialog checks the revealed seed against the commitment and the cells seen
#
# Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED.

set -u
# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

scenario_begin 10 cli-reclaim "with the server dead, anyone reclaims the bet for the player with scripts/reclaim.sh after the settle deadline"
require_input_path
stack_up
aside_start || blocked_scenario "the aside repl session did not start (see $ASIDE_LOG)"

open_lobby A
connect_dev_wallet A
fill_bet A 0 "$BET_ETH" "$(client_seed 1)"
submit_bet A
expect_game_open
DEADLINE="$G_SETTLE_DEADLINE"
COMMITMENT="$G_COMMITMENT"
plan cashout:1 || fail_scenario "the solution of this maze is shorter than 2 moves"
# shellcheck disable=SC2086
walk A click $PLAN_MOVES
http_game
check http "the server reports the game active at step 1 before it is stopped" "active 1" "$(http_field .status) $(http_field .step)"

app_stop
http GET /api/health
check http "the server cannot be reached after the stop" 000 "$HTTP_STATUS"

# ----- before the deadline: refused -----

CLI_CODE=0
CLI_OUT="$(bash "$ROOT_DIR/scripts/reclaim.sh" "$GAME_ID" --port "$ANVIL_PORT" 2>&1)" || CLI_CODE=$?
check chain "scripts/reclaim.sh exits 1 before the settle deadline" 1 "$CLI_CODE"
check_ok chain "scripts/reclaim.sh names the refusal DeadlineNotReached" "DeadlineNotReached" "$CLI_OUT" \
  "$(printf '%s' "$CLI_OUT" | grep -q DeadlineNotReached; echo $?)"
chain_game "$GAME_ID"
check chain "the game is still Active after the refused reclaim" "$STATUS_ACTIVE" "$G_STATUS"

# ----- past the deadline: reclaimed by a third party -----

warp_past "$DEADLINE" || fail_scenario "the chain clock could not be moved"
BALANCE_BEFORE_RECLAIM="$(balance_of "$PLAYER_ADDR")"
CLI_CODE=0
CLI_OUT="$(bash "$ROOT_DIR/scripts/reclaim.sh" "$GAME_ID" --port "$ANVIL_PORT" 2>&1)" || CLI_CODE=$?
check chain "scripts/reclaim.sh exits 0 after the settle deadline" 0 "$CLI_CODE"
wait_status "$GAME_ID" "$STATUS_RECLAIMED" 20
check chain "getGame.status is Reclaimed" "$STATUS_RECLAIMED" "$G_STATUS"
reclaim_log "$GAME_ID"
check chain "exactly one GameReclaimed event" 1 "$R_COUNT"
check chain "GameReclaimed.amount is the whole bet" "$BET_WEI" "$R_AMOUNT"
check_hex chain "GameReclaimed.player is the player" "$PLAYER_ADDR" "$R_PLAYER"
check_hex chain "a third party (Anvil #9) sent the reclaim" "$THIRD_PARTY_ADDR" "$R_FROM"
check chain "the player's balance grew by exactly the bet" "$(big_add "$BALANCE_BEFORE_RECLAIM" "$BET_WEI")" "$(balance_of "$PLAYER_ADDR")"
check_ok chain "scripts/reclaim.sh printed the transaction it sent" "$R_TX" "$CLI_OUT" \
  "$(printf '%s' "$CLI_OUT" | grep -qi "$R_TX"; echo $?)"
evidence reclaimTx "$R_TX"

CLI_CODE=0
CLI_OUT="$(bash "$ROOT_DIR/scripts/reclaim.sh" "$GAME_ID" --port "$ANVIL_PORT" 2>&1)" || CLI_CODE=$?
check chain "a second reclaim is refused (exit 1)" 1 "$CLI_CODE"
check_ok chain "the second refusal is GameNotActive" "GameNotActive" "$CLI_OUT" \
  "$(printf '%s' "$CLI_OUT" | grep -q GameNotActive; echo $?)"

# ----- the page that stayed open reads the chain -----

expect_attr "the open page shows reclaimed, learnt from the chain alone" A result-outcome data-outcome reclaimed 30
expect_attr "result-payout shows the whole bet" A result-payout data-wei "$BET_WEI" 5
expect_attr "settle-tx names no transaction: someone else sent it" A settle-tx data-tx "" 5

# ----- the server comes back -----

app_start_again
http GET "/api/games/$GAME_ID/reveal"
check http "after the restart the reveal route answers 200 with reason reclaimed" "200 reclaimed" "$HTTP_STATUS $(http_field .reason)"
check_hex http "the revealed seed is the one the route was planned with" "$PREDICTED_SERVER_SEED" "$(http_field .serverSeed)"
check_hex http "the revealed commitment is the one on chain" "$COMMITMENT" "$(http_field .commitment)"
http POST "/api/games/$GAME_ID/move" "$TOKEN" '{"step":1,"dir":0}'
check http "the restarted server refuses a move on the reclaimed game" "409 GAME_NOT_ACTIVE" "$HTTP_STATUS $(http_field .error.code)"
# Give the restarted server's settlement worker time to act, if it wrongly would.
sleep 8
settlement "$GAME_ID"
check chain "the restarted server does not settle the reclaimed game" 0 "$S_COUNT"
chain_game "$GAME_ID"
check chain "the game is still Reclaimed" "$STATUS_RECLAIMED" "$G_STATUS"
check chain "totalReserved is back to 0" 0 "$(chain_call 'totalReserved()(uint256)')"
expect_accounting

open_verify A V
expect_attr "verify: the revealed seed hashes to the commitment" V verify-hash-match data-match true 30
expect_attr "verify: commitment and client seed match the chain" V verify-onchain-match data-match true 10
expect_attr "verify: every observed cell matches the recomputed maze" V verify-cells-match data-match true 10
if CELLS="$(dom_list V verify-cell-)"; then
  check dom "verify: one compared cell per observation (start and one move)" 2 "$(printf '%s' "$CELLS" | jq 'length')"
else
  dom_blocked "verify: per-cell comparison" "the DOM could not be read over path $READ_PATH"
fi

scenario_end
