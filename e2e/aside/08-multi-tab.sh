#!/usr/bin/env bash
# 08 two tabs: resume, and two different moves for the same step (plan §9.1; AC-S2 as seen from
# the browser).
#
# Tab A bets and walks to a junction. Tab B opens the same origin and must resume the same game
# from localStorage, without a wallet. Then both tabs click a different move at the same moment.
#
#   DOM    tab B resumes the game at the same step with the same refundable amount; after the
#          race both tabs show the same current cell, the one the server holds; exactly one tab
#          shows the "moved elsewhere" error; after a cash-out in tab A, tab B learns the result
#          by polling
#   HTTP   each tab's page sent one move for the same step; the server accepted exactly one
#          (200) and refused the other with 409 STALE_STEP, whose body is only { error: { code,
#          message } }: no cell, no wall mask; the server holds one more step, not two
#   chain  the game is settled exactly once, with the refund of the step actually reached
#
# What the two pages sent and received is recorded inside each page by wrapping its fetch
# (lib/prelude.js hookFetch). Over read path B (TestBeacon) two tabs cannot be told apart, so
# the DOM assertions are then reported as not executed (BLOCKED).
#
# Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED.

set -u
# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

scenario_begin 08 multi-tab "a second tab resumes the game, and of two different moves sent for the same step exactly one counts"
require_input_path
if ! cap multiTab || ! cap parallelClicks; then
  blocked_scenario "aside repl cannot drive two tabs at once (capabilities multiTab, parallelClicks)"
fi
stack_up
aside_start || blocked_scenario "the aside repl session did not start (see $ASIDE_LOG)"

# wait_tab <tab> <condition> <seconds>: flow control through the REPL, not an assertion.
wait_tab() {
  ui $(($3 + 15)) "M.waitFor($(js_str "$1"), $2, $(($3 * 1000)))" || fail_scenario "tab $1 could not be read: $ASIDE_ERROR"
  [ "$(ui_field '.ok')" = true ]
}

# The DOM assertions of this scenario need to read each tab separately.
TABS_READABLE=1
if [ "$READ_PATH" != repl ]; then
  TABS_READABLE=0
  dom_blocked "per-tab DOM assertions of the two-tab scenario" "the TestBeacon snapshot holds one page; two tabs cannot be told apart over path $READ_PATH"
fi

open_lobby A
connect_dev_wallet A
open_game_for A 0 junction
expect_game_open
DIR_A="$(printf '%s' "$PLAN_JSON" | jq -r '.a')"
DIR_B="$(printf '%s' "$PLAN_JSON" | jq -r '.b')"
# shellcheck disable=SC2086
walk A click $PLAN_MOVES
K="$STEP"
REFUND_K="$(refund_wei "$BET_WEI" "$TIER" "$K")"

# ----- resume in a second tab -----

ui_open B "$APP_URL/"
wait_tab B "{ id: \"move-$DIR_B\", attr: \"data-legal\", equals: \"true\" }" 30 || fail_scenario "tab B did not resume the game (move-$DIR_B never became legal)"
if [ "$TABS_READABLE" -eq 1 ]; then
  expect_attr "tab B resumes the same game from localStorage" B board data-game-id "$GAME_ID" 5
  expect_attr "tab B resumes at step $K" B board data-step "$K" 5
  expect_attr "tab B shows the same refundable amount" B refundable-amount data-wei "$REFUND_K" 5
  expect_present "tab B has no wallet connected: the session token alone resumes the game" B wallet-connect 5
fi

# ----- two different moves for the same step, at once -----

# The move buttons are never disabled, so a click alone does not wait for the move to be open:
# both tabs must show their direction as legal first (tab B's was waited for above).
wait_tab A "{ id: \"move-$DIR_A\", attr: \"data-legal\", equals: \"true\" }" 10 || fail_scenario "move-$DIR_A is not legal in tab A at step $K"
ui 20 'M.hookFetch("A")' || fail_scenario "tab A's fetch could not be wrapped: $ASIDE_ERROR"
ui 20 'M.hookFetch("B")' || fail_scenario "tab B's fetch could not be wrapped: $ASIDE_ERROR"
ui 40 "M.race(\"A\", \"move-$DIR_A\", \"B\", \"move-$DIR_B\")" || fail_scenario "the two clicks could not be delivered: $ASIDE_ERROR"
[ "$(ui_field '.a.ok') $(ui_field '.b.ok')" = "true true" ] || fail_scenario "one of the two clicks was not delivered: $ASIDE_RESULT"
wait_tab A "{ id: \"board\", attr: \"data-step\", equals: \"$((K + 1))\" }" 20 || fail_scenario "tab A did not reach step $((K + 1))"
wait_tab B "{ id: \"board\", attr: \"data-step\", equals: \"$((K + 1))\" }" 20 || fail_scenario "tab B did not reach step $((K + 1))"

ui 20 'M.calls("A")' || fail_scenario "tab A's calls could not be read: $ASIDE_ERROR"
CALLS_A="$ASIDE_RESULT"
ui 20 'M.calls("B")' || fail_scenario "tab B's calls could not be read: $ASIDE_ERROR"
CALLS_B="$ASIDE_RESULT"
MOVES_SENT="$(jq -cn --argjson a "$CALLS_A" --argjson b "$CALLS_B" \
  '[($a[] | . + { tab: "A" }), ($b[] | . + { tab: "B" })] | map(select(.url | endswith("/move")))')"
printf '%s\n' "$MOVES_SENT" >"$SC_DIR/moves-sent.json"
check http "each tab's page sent one move, both for step $K" "$K $K" \
  "$(printf '%s' "$MOVES_SENT" | jq -r '[.[] | (.request | fromjson | .step)] | join(" ")')"
check http "the two moves were different directions" 2 \
  "$(printf '%s' "$MOVES_SENT" | jq '[.[] | (.request | fromjson | .dir)] | unique | length')"
check http "the server accepted exactly one of them (200)" 1 "$(printf '%s' "$MOVES_SENT" | jq '[.[] | select(.status == 200)] | length')"
check http "the server refused exactly one of them with 409 STALE_STEP" 1 \
  "$(printf '%s' "$MOVES_SENT" | jq '[.[] | select(.status == 409 and .body.error.code == "STALE_STEP")] | length')"
check http "the refusal carries no game state: its body is only { error: { code, message } }" '["error"] ["code","message"]' \
  "$(printf '%s' "$MOVES_SENT" | jq -r '[.[] | select(.status == 409)][0].body | "\(keys | tojson) \(.error | keys | tojson)"')"
WINNER="$(printf '%s' "$MOVES_SENT" | jq -r '[.[] | select(.status == 200)][0].tab')"
LOSER="$(printf '%s' "$MOVES_SENT" | jq -r '[.[] | select(.status == 409)][0].tab')"
evidence acceptedTab "$WINNER"

http_game
check http "the server holds one more step, not two" "active $((K + 1))" "$(http_field .status) $(http_field .step)"
check http "the server's path has one cell per step" $((K + 2)) "$(http_field '.path | length')"
SERVER_CELL="cell-$(http_field .cell.x)-$(http_field .cell.y)"

if [ "$TABS_READABLE" -eq 1 ]; then
  check dom "tab A shows the server's current cell" "$SERVER_CELL" "$(current_cell A)"
  check dom "tab B shows the server's current cell" "$SERVER_CELL" "$(current_cell B)"
  expect_present "the tab whose move was refused (tab $LOSER) says so" "$LOSER" error-message 5
  expect_absent "the tab whose move was accepted (tab $WINNER) shows no error" "$WINNER" error-message 2
  expect_attr "tab A shows the refund of step $((K + 1))" A refundable-amount data-wei "$(refund_wei "$BET_WEI" "$TIER" $((K + 1)))" 5
  expect_attr "tab B shows the refund of step $((K + 1))" B refundable-amount data-wei "$(refund_wei "$BET_WEI" "$TIER" $((K + 1)))" 5
fi

# ----- one settlement -----

PAYOUT="$(refund_wei "$BET_WEI" "$TIER" $((K + 1)))"
cash_out A || fail_scenario "the cash-out (A, then cashout-button) is not clickable in tab A"
wait_tab A '{ id: "result-outcome" }' 20 || fail_scenario "tab A did not show a result after the cash-out"
if [ "$TABS_READABLE" -eq 1 ]; then
  expect_result A cashout "$PAYOUT"
  expect_attr "tab B learns the cash-out by polling" B result-outcome data-outcome cashout 20
  expect_attr "tab B shows the same payout" B result-payout data-wei "$PAYOUT" 5
fi
expect_settled 1 $((K + 1)) "$PAYOUT" cashed_out false

scenario_end
