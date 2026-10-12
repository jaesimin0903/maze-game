#!/usr/bin/env bash
# 03 cash-out (plan §9.1; AC-W3, AC-W4, AC-E1, AC-R3, AC-T8).
#
# Bets through the page on the largest size of the table, walks three moves of the solution,
# cashes out, and follows the money.
#
#   DOM    after every move refundable-amount and the HP meter are bet x refundBps[k];
#          exit-payout and the cash-out button (A named CASH OUT, then "Take it") are on screen
#          the whole time;
#          result-outcome = cashout with the refund of step 3; the settlement transaction is
#          named; the verify dialog passes
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
# The largest size of the table: its board, refund table and multiplier are the ones that differ
# most from one table to the next.
fill_bet A $(($(tier_count) - 1)) "$BET_ETH" "$(client_seed 1)"
submit_bet A
expect_game_open
plan "cashout:$MOVES" || fail_scenario "the solution of this maze is shorter than $((MOVES + 1)) moves"

expect_refundable A 0
expect_attr "exit-payout shows bet x multiplier during play" A exit-payout data-wei "$(exit_wei "$BET_WEI" "$TIER")" 5
expect_attr "A is the cash-out button (CASH OUT) during play" A btn-a data-action cashout 5
# shellcheck disable=SC2086
for DIR in $PLAN_MOVES; do
  move A "$DIR"
  expect_refundable A "$STEP"
done
expect_attr "exit-payout is unchanged after $MOVES moves" A exit-payout data-wei "$(exit_wei "$BET_WEI" "$TIER")" 5

PAYOUT="$(refund_wei "$BET_WEI" "$TIER" "$MOVES")"
cash_out A || fail_scenario "the cash-out (A, then cashout-button) is not clickable"
expect_result A cashout "$PAYOUT"
expect_settled 1 "$MOVES" "$PAYOUT" cashed_out false
expect_result_tx A

open_verify A V
expect_verify_ok V $((MOVES + 1))

scenario_end
