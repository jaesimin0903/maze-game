#!/usr/bin/env bash
# 03 cash-out (plan §9.1; AC-W3, AC-W4, AC-E1, AC-R3, AC-T8).
#
# Bets through the page, walks three moves of the solution, cashes out, and follows the money.
#
#   DOM    after every move refundable-amount is bet x refundBps[k]; exit-payout and the
#          cash-out button are on screen the whole time; result-outcome = cashout with the
#          refund of step 3; the settlement transaction is named; the verify page passes
#   chain  getGame Active then Settled; GameSettled(outcome 1, steps 3, payout = bet x
#          refundBps[3] / 10000) sent by the relayer; the player's balance grows by exactly
#          that; totalReserved returns to 0; the contract's refundBps equal the table's
#   HTTP   the server's refundableWei at every step; status cashed_out, auto false, the payout
#          and the settlement hash; the reveal route returns the settled seed and commitment
#
# Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED.

set -u
# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

scenario_begin 03 cashout "three moves, then cash-out: the refund follows the table at every step and is paid on chain"
require_input_path
stack_up
aside_start || blocked_scenario "the aside repl session did not start (see $ASIDE_LOG)"

MOVES=3
open_lobby A
connect_dev_wallet A
fill_bet A 0 "$BET_ETH" "$(client_seed 1)"
submit_bet A
expect_game_open
plan "cashout:$MOVES" || fail_scenario "the solution of this maze is shorter than $((MOVES + 1)) moves"

expect_refundable A 0
expect_attr "exit-payout shows bet x multiplier during play" A exit-payout data-wei "$(exit_wei "$BET_WEI" "$TIER")" 5
expect_present "the cash-out button is on screen during play" A cashout-button 5
# shellcheck disable=SC2086
for DIR in $PLAN_MOVES; do
  move A "$DIR"
  expect_refundable A "$STEP"
done
expect_attr "exit-payout is unchanged after $MOVES moves" A exit-payout data-wei "$(exit_wei "$BET_WEI" "$TIER")" 5

PAYOUT="$(refund_wei "$BET_WEI" "$TIER" "$MOVES")"
ui_click A cashout-button 10 || fail_scenario "cashout-button is not clickable"
expect_result A cashout "$PAYOUT"
expect_settled 1 "$MOVES" "$PAYOUT" cashed_out false
expect_result_tx A

open_verify A V
expect_verify_ok V $((MOVES + 1))

scenario_end
