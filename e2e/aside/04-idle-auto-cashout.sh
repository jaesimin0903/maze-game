#!/usr/bin/env bash
# 04 idle auto cash-out (plan §9.1; AC-W7, AC-E2).
#
# Runs the stack with MAZE_IDLE_TIMEOUT_SEC=6, makes two moves and then does nothing. The server
# ends the game by itself; the page has to find out by polling.
#
#   DOM    idle-countdown carries the idle deadline in chain seconds; without any input the
#          page shows result-outcome = auto-cashout, and the chain clock at that moment is at
#          most 5 seconds past the idle deadline (+3 seconds allowance for a time-sensitive
#          scenario, plan §8.2); the payout shown is the refund of step 2
#   chain  GameSettled(outcome 1, steps 2, payout = bet x refundBps[2] / 10000), sent by the
#          relayer, in a block not before the idle deadline; the balance grows by the payout
#   HTTP   /api/config reports the 6 second timeout; the server's idleDeadlineSec is the one
#          on screen; afterwards status cashed_out with auto = true
#
# Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED.

set -u
# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

IDLE_SEC=6
# Chain seconds the page may take to show the result (AC-W7), and the plan's allowance.
SHOW_WITHIN=5
ALLOWANCE=3
MOVES=2

scenario_begin 04 idle-auto-cashout "after $IDLE_SEC idle chain seconds the server cashes out and the page learns it by polling"
require_input_path
stack_up "MAZE_IDLE_TIMEOUT_SEC=$IDLE_SEC"
aside_start || blocked_scenario "the aside repl session did not start (see $ASIDE_LOG)"

check http "/api/config reports the shortened idle timeout" "$IDLE_SEC" "$(printf '%s' "$CONFIG_JSON" | jq -r '.idleTimeoutSec')"

open_lobby A
connect_dev_wallet A
fill_bet A 0 "$BET_ETH" "$(client_seed 1)"
submit_bet A
# No assertions between the bet and the last move: the idle clock is already running.
plan "cashout:$MOVES" || fail_scenario "the solution of this maze is shorter than $((MOVES + 1)) moves"
# shellcheck disable=SC2086
walk A click $PLAN_MOVES

# From here on the scenario only reads.
http_game
check http "the server reports the game active after $MOVES moves" "active $MOVES" "$(http_field .status) $(http_field .step)"
IDLE_DEADLINE="$(http_field .idleDeadlineSec)"
expect_attr "idle-countdown carries the server's idle deadline (chain seconds)" A idle-countdown data-deadline-sec "$IDLE_DEADLINE" 3
chain_game "$GAME_ID" || fail_scenario "getGame($GAME_ID) could not be read from the chain"
check chain "getGame.status is Active while the idle clock runs" "$STATUS_ACTIVE" "$G_STATUS"
check chain "getGame.bet is the amount typed into the page" "$BET_WEI" "$G_BET"

PAYOUT="$(refund_wei "$BET_WEI" "$TIER" "$MOVES")"
SHOWN_CODE=0
dom_wait A result-outcome - "" $((IDLE_SEC + 25)) || SHOWN_CODE=$?
SHOWN_AT="$(chain_now)"
if [ "$SHOWN_CODE" -eq 2 ]; then
  dom_blocked "the page shows the automatic cash-out by itself" "the DOM could not be read over path $READ_PATH"
else
  LATE=$((SHOWN_AT - IDLE_DEADLINE))
  evidence shownAfterDeadlineSec "$LATE"
  check_ok dom "the page shows a result without any input" "result-outcome present" "$DOM_ACTUAL" "$SHOWN_CODE"
  check_le dom "the result is on screen within $SHOW_WITHIN (+$ALLOWANCE) chain seconds of the idle deadline" $((SHOW_WITHIN + ALLOWANCE)) "$LATE"
  [ "$LATE" -le "$SHOW_WITHIN" ] || log "note: shown $LATE chain seconds after the deadline, inside the allowance but above $SHOW_WITHIN"
fi
expect_result A auto-cashout "$PAYOUT"
expect_settled 1 "$MOVES" "$PAYOUT" cashed_out true
check_ok chain "the settlement was mined at or after the idle deadline" ">= $IDLE_DEADLINE" "$S_BLOCK_TIME" \
  "$([ "${S_BLOCK_TIME:-0}" -ge "$IDLE_DEADLINE" ] 2>/dev/null; echo $?)"
expect_result_tx A

scenario_end
