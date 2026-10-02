#!/usr/bin/env bash
# 05 server down: direct reclaim from the page that was already open (plan §9.1; AC-E2).
#
# Bets, makes one move, then the app process is killed. The page stays open: it must notice,
# show a countdown that runs on block time, and, once the chain clock has been moved past the
# game's settle deadline, send `reclaim` itself with the dev wallet.
#
# This scenario moves the chain clock (evm_increaseTime), so the runner runs it last and it has
# an Anvil of its own. The UI and the game server are one process: a page reloaded after the
# server died cannot be used. The general recovery path is the CLI (scenario 10).
#
#   DOM    server-unreachable appears; reclaim-countdown carries the on-chain settle deadline
#          and a chain "now" taken from block timestamps, and is not ready; reclaim-button is
#          disabled before the deadline and enabled after the time warp; after the click
#          result-outcome = reclaimed with the whole bet and the reclaim transaction
#   chain  the contract refuses reclaim before the deadline (DeadlineNotReached); afterwards
#          getGame is Reclaimed, GameReclaimed(amount = bet) was sent by the player's wallet,
#          the player's balance grew by bet minus the transaction fee, nothing was settled
#   HTTP   the game was active at step 1 before the stop, with the same settle deadline as on
#          chain; after the stop the server cannot be reached
#
# Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED.

set -u
# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

scenario_begin 05 server-down-reclaim "with the server dead, the page that was open reclaims the bet itself after the settle deadline"
require_input_path
stack_up
aside_start || blocked_scenario "the aside repl session did not start (see $ASIDE_LOG)"

open_lobby A
connect_dev_wallet A
fill_bet A 0 "$BET_ETH" "$(client_seed 1)"
submit_bet A
expect_game_open
DEADLINE="$G_SETTLE_DEADLINE"
plan cashout:1 || fail_scenario "the solution of this maze is shorter than 2 moves"
# shellcheck disable=SC2086
walk A click $PLAN_MOVES
http_game
check http "the server reports the game active at step 1 before it is stopped" "active 1" "$(http_field .status) $(http_field .step)"
check http "the server's settleDeadlineSec is the contract's settleDeadline" "$DEADLINE" "$(http_field .settleDeadlineSec)"

# ----- the server dies -----

app_stop
http GET /api/health
check http "the server cannot be reached after the stop" 000 "$HTTP_STATUS"

expect_present "the open page shows server-unreachable" A server-unreachable 20
expect_present "the open page shows the reclaim countdown" A reclaim-countdown 20
expect_attr "reclaim-countdown is not ready before the deadline" A reclaim-countdown data-ready false 5
expect_attr "reclaim-countdown carries the contract's settle deadline" A reclaim-countdown data-deadline-sec "$DEADLINE" 5
if COUNTDOWN="$(dom_item A reclaim-countdown)" && [ "$COUNTDOWN" != null ]; then
  PAGE_NOW="$(printf '%s' "$COUNTDOWN" | jq -r '.attrs["data-chain-now-sec"]')"
  REMAINING="$(printf '%s' "$COUNTDOWN" | jq -r '.attrs["data-remaining-sec"]')"
  DRIFT=$(($(chain_now) - PAGE_NOW))
  check_le dom "the countdown's clock is the block timestamp (at most 3 seconds behind the chain)" 3 "${DRIFT#-}"
  check dom "the remaining seconds are deadline + 1 - block time" $((DEADLINE + 1 - PAGE_NOW)) "$REMAINING"
else
  dom_blocked "the countdown runs on block time" "the DOM could not be read over path $READ_PATH"
fi
if BUTTON="$(dom_item A reclaim-button)" && [ "$BUTTON" != null ]; then
  check dom "reclaim-button is disabled before the deadline" true "$(printf '%s' "$BUTTON" | jq -r '.attrs | has("disabled")')"
else
  dom_blocked "reclaim-button is disabled before the deadline" "the DOM could not be read over path $READ_PATH"
fi
check chain "the contract refuses reclaim before the settle deadline" DeadlineNotReached "$(reclaim_refusal "$GAME_ID" "$PLAYER_ADDR")"

# ----- past the deadline -----

warp_past "$DEADLINE" || fail_scenario "the chain clock could not be moved"
check_ok chain "the chain clock is past the settle deadline" "> $DEADLINE" "$(chain_now)" "$([ "$(chain_now)" -gt "$DEADLINE" ]; echo $?)"
expect_attr "reclaim-countdown becomes ready once block time passes the deadline" A reclaim-countdown data-ready true 20

BALANCE_BEFORE_RECLAIM="$(balance_of "$PLAYER_ADDR")"
ui_click A reclaim-button 20 || fail_scenario "reclaim-button did not become clickable after the deadline"
expect_attr "result-outcome shows reclaimed" A result-outcome data-outcome reclaimed 30
expect_attr "result-payout shows the whole bet" A result-payout data-wei "$BET_WEI" 5

wait_status "$GAME_ID" "$STATUS_RECLAIMED" 30
check chain "getGame.status is Reclaimed" "$STATUS_RECLAIMED" "$G_STATUS"
reclaim_log "$GAME_ID"
check chain "exactly one GameReclaimed event" 1 "$R_COUNT"
check chain "GameReclaimed.amount is the whole bet" "$BET_WEI" "$R_AMOUNT"
check_hex chain "GameReclaimed.player is the player" "$PLAYER_ADDR" "$R_PLAYER"
check_hex chain "the page's dev wallet sent the reclaim" "$PLAYER_ADDR" "$R_FROM"
check chain "the player's balance grew by the bet minus the transaction fee" \
  "$(big_sub "$(big_add "$BALANCE_BEFORE_RECLAIM" "$BET_WEI")" "$(tx_fee "$R_TX")")" "$(balance_of "$PLAYER_ADDR")"
settlement "$GAME_ID"
check chain "the game was never settled" 0 "$S_COUNT"
check chain "totalReserved is back to 0" 0 "$(chain_call 'totalReserved()(uint256)')"
expect_accounting
evidence reclaimTx "$R_TX"
expect_attr "settle-tx names the reclaim transaction" A settle-tx data-tx "$(lower "$R_TX")" 10

scenario_end
