#!/usr/bin/env bash
# 06 verify screen: a tampered record is caught (plan §9.1; AC-M5, AC-W5, AC-M4).
#
# Plays a short game (two moves, cash-out), takes the play record the page saved in
# localStorage, changes one wall bit of one observation and pastes it into the import page
# (/verify).
#
#   DOM    the untouched game verifies clean; with one wall bit of observation 1 flipped,
#          exactly that cell (and that row) is marked data-match = false, every other cell
#          stays true, and the commitment check still passes; with one digit of the server
#          seed changed instead, verify-hash-match turns false; the untouched record, imported,
#          verifies clean again
#   HTTP   importing records changes nothing on the server: the game read and the reveal
#          answer are byte for byte what they were before
#   chain  the game is Settled, once, before and after
#
# Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED.

set -u
# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

scenario_begin 06 verify-mismatch "one changed wall bit in an imported play record is flagged on exactly that cell"
require_input_path
stack_up
aside_start || blocked_scenario "the aside repl session did not start (see $ASIDE_LOG)"

MOVES=2
open_lobby A
connect_dev_wallet A
fill_bet A 0 "$BET_ETH" "$(client_seed 1)"
submit_bet A
expect_game_open
plan "cashout:$MOVES" || fail_scenario "the solution of this maze is shorter than $((MOVES + 1)) moves"
# shellcheck disable=SC2086
walk A click $PLAN_MOVES
PAYOUT="$(refund_wei "$BET_WEI" "$TIER" "$MOVES")"
ui_click A cashout-button 10 || fail_scenario "cashout-button is not clickable"
expect_result A cashout "$PAYOUT"
expect_settled 1 "$MOVES" "$PAYOUT" cashed_out false

http_game
GAME_BEFORE="$(printf '%s' "$HTTP_BODY" | jq -cS 'del(.chainNowSec)')"
http GET "/api/games/$GAME_ID/reveal"
REVEAL_BEFORE="$(printf '%s' "$HTTP_BODY" | jq -cS '.')"

# ----- the record this browser kept -----

open_verify A V
expect_verify_ok V $((MOVES + 1))
# The record is the one the game page saved in localStorage (plan §7.6), which is what the
# verify page just checked.
RECORD="$(ui_storage_get V "maze:record:$GAME_ID")" || fail_scenario "the play record could not be read: $ASIDE_ERROR"
printf '%s' "$RECORD" | jq -e '.observations | length == 3' >/dev/null 2>&1 ||
  fail_scenario "the saved play record does not hold three observations"
TAMPERED_CELL="$(printf '%s' "$RECORD" | jq -r '.observations[1].cell')"
TAMPERED_ID="verify-cell-$((TAMPERED_CELL % N))-$((TAMPERED_CELL / N))"
# Flip the east-wall bit (2) of what the server showed after the first move.
TAMPERED="$(printf '%s' "$RECORD" | jq -c '.observations[1].open |= (if ((. / 2 | floor) % 2) == 1 then . - 2 else . + 2 end)')"
# Change the last hex digit of the revealed server seed.
BAD_SEED="$(printf '%s' "$RECORD" | jq -c '.terminal.serverSeed |= (.[0:65] + (if .[65:66] == "0" then "1" else "0" end))')"
ui 30 'M.close("V")' || fail_scenario "closing the verify tab failed: $ASIDE_ERROR"

# import_record <json>: pastes a record into the import page and submits it.
import_record() {
  ui_fill I verify-import "$1" || fail_scenario "verify-import could not be filled"
  ui_click I verify-import-submit 10 || fail_scenario "verify-import-submit is not clickable"
}

# ----- the import page -----

ui_open I "$APP_URL/verify"
expect_present "the import page starts without a record" I verify-empty 20

import_record "$TAMPERED"
expect_attr "the imported record is shown as this game" I verify-game data-game-id "$GAME_ID" 10
expect_attr "one flipped wall bit: the cell check fails" I verify-cells-match data-match false 10
expect_attr "one flipped wall bit: the commitment check still passes" I verify-hash-match data-match true 10
if CELLS="$(dom_list I verify-cell-)"; then
  check dom "exactly the tampered cell is marked as a mismatch" "$TAMPERED_ID" \
    "$(printf '%s' "$CELLS" | jq -r '[.[] | select(.attrs["data-match"] == "false") | .id] | join(",")')"
  check dom "the other compared cells still match" $MOVES \
    "$(printf '%s' "$CELLS" | jq '[.[] | select(.attrs["data-match"] == "true")] | length')"
else
  dom_blocked "exactly the tampered cell is marked as a mismatch" "the DOM could not be read over path $READ_PATH"
fi
expect_attr "the tampered observation's row is a mismatch" I verify-row-1 data-match false 5
expect_attr "the row before it still matches" I verify-row-0 data-match true 5
expect_attr "the row after it still matches" I verify-row-2 data-match true 5

import_record "$BAD_SEED"
expect_attr "a changed server seed fails the commitment check" I verify-hash-match data-match false 10

import_record "$RECORD"
expect_attr "the untouched record, imported, passes the commitment check" I verify-hash-match data-match true 10
expect_attr "the untouched record, imported, matches on every cell" I verify-cells-match data-match true 10

# ----- nothing changed on the server or on chain -----

http_game
check http "the server's game read is unchanged by the imports" "$GAME_BEFORE" "$(printf '%s' "$HTTP_BODY" | jq -cS 'del(.chainNowSec)')"
http GET "/api/games/$GAME_ID/reveal"
check http "the reveal answer is unchanged by the imports" "$REVEAL_BEFORE" "$(printf '%s' "$HTTP_BODY" | jq -cS '.')"
chain_game "$GAME_ID"
check chain "the game is still Settled" "$STATUS_SETTLED" "$G_STATUS"
settlement "$GAME_ID"
check chain "the game is still settled exactly once" 1 "$S_COUNT"
check chain "the settled payout is unchanged" "$PAYOUT" "$S_PAYOUT"

scenario_end
