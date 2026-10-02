#!/usr/bin/env bash
# 02 dead-end loss (plan §9.1; AC-R4, AC-W4, AC-E1).
#
# Bets through the page and walks, with the arrow keys, the shortest route into a dead end.
#
#   DOM    result-outcome = loss with a payout of 0 and a net of minus the bet; the settlement
#          transaction is named; the verify page passes for the lost game too
#   chain  GameSettled(outcome 2, payout 0) from the relayer; the player's balance does not
#          change after the bet; totalReserved returns to 0
#   HTTP   the server reports status lost, payout 0, the settlement hash; the reveal route
#
# The moves go through the keyboard (page.keyboard.press) when the probe verified key presses,
# through the move buttons otherwise.
#
# Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED.

set -u
# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

scenario_begin 02 deadend "a route into a dead end loses the whole bet: the page says so and the chain pays nothing"
require_input_path
stack_up
aside_start || blocked_scenario "the aside repl session did not start (see $ASIDE_LOG)"

HOW=click
cap pressKey && HOW=key

open_lobby A
connect_dev_wallet A
open_game_for A 0 deadend
expect_game_open
STEPS="$(printf '%s' "$PLAN_JSON" | jq -r '.steps')"
evidence input "moves by $HOW"

# shellcheck disable=SC2086
walk A "$HOW" $PLAN_MOVES

expect_result A loss 0
expect_settled 2 "$STEPS" 0 lost false
expect_result_tx A

open_verify A V
expect_verify_ok V $((STEPS + 1))

scenario_end
