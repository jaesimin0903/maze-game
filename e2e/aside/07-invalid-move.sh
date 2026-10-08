#!/usr/bin/env bash
# 07 invalid moves are refused (plan §9.1; AC-S1 as seen from outside).
#
# Bets through the page, then sends moves the page itself would never send, straight to the
# API with the game's own session token: off the grid, through a wall, back onto a visited
# cell, with a stale step, with a malformed body, without a token, with a wrong token.
#
#   HTTP   each refusal has its error code and status, and its body is only
#          { error: { code, message } }: no cell, no wall mask, no path; the seed of a game in
#          progress is not revealed (409 NOT_REVEALABLE); the game read is unchanged
#   DOM    the board, the current cell and refundable-amount do not change; the wall direction
#          is not offered by the page (its move button says data-legal="false")
#   chain  the game stays Active and unsettled; afterwards a normal cash-out through the page
#          still settles it with the refund of that step
#
# Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED.

set -u
# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

scenario_begin 07 invalid-move "moves through a wall, off the grid, onto a visited cell or with a stale step are refused and change nothing"
require_input_path
stack_up
aside_start || blocked_scenario "the aside repl session did not start (see $ASIDE_LOG)"

# refusal <label> <expected "status CODE"> <token> <json body>: one refused move.
refusal() {
  http POST "/api/games/$GAME_ID/move" "$3" "$4"
  check http "$1: $2" "$2" "$HTTP_STATUS $(http_field .error.code)"
  check http "$1: the body is only { error: { code, message } }" '["error"] ["code","message"]' \
    "$(printf '%s' "$HTTP_BODY" | jq -c 'keys' 2>/dev/null) $(printf '%s' "$HTTP_BODY" | jq -c '.error | keys' 2>/dev/null)"
}

open_lobby A
connect_dev_wallet A
open_game_for A 0 invalid
expect_game_open
WALL="$(printf '%s' "$PLAN_JSON" | jq -r '.wall')"
VISITED="$(printf '%s' "$PLAN_JSON" | jq -r '.visited')"

# The start is the top-left corner: north leaves the grid.
refusal "a move off the grid at step 0" "409 INVALID_MOVE_BOUNDS" "$TOKEN" '{"step":0,"dir":0}'

# shellcheck disable=SC2086
walk A click $PLAN_MOVES
K="$STEP"
REFUND="$(refund_wei "$BET_WEI" "$TIER" "$K")"
http_game
GAME_BEFORE="$(printf '%s' "$HTTP_BODY" | jq -cS 'del(.chainNowSec)')"
CELL_BEFORE="$(current_cell A || true)"
expect_attr "refundable-amount before the refused moves" A refundable-amount data-wei "$REFUND" 5
expect_attr "the page does not offer the wall direction (move-$WALL is not legal)" A "move-$WALL" data-legal false 5

refusal "a move through a wall" "409 INVALID_MOVE_WALL" "$TOKEN" "{\"step\":$K,\"dir\":$(dir_num "$WALL")}"
refusal "a move back onto a visited cell" "409 INVALID_MOVE_VISITED" "$TOKEN" "{\"step\":$K,\"dir\":$(dir_num "$VISITED")}"
refusal "a move with a stale step" "409 STALE_STEP" "$TOKEN" "{\"step\":$((K - 1)),\"dir\":$(dir_num "$WALL")}"
refusal "a move with a direction that does not exist" "400 BAD_REQUEST" "$TOKEN" "{\"step\":$K,\"dir\":7}"
refusal "a move with an extra field" "400 BAD_REQUEST" "$TOKEN" "{\"step\":$K,\"dir\":1,\"cell\":24}"
refusal "a move without a session token" "401 UNAUTHORIZED" "" "{\"step\":$K,\"dir\":$(dir_num "$WALL")}"
refusal "a move with a wrong session token" "401 UNAUTHORIZED" "not-the-token" "{\"step\":$K,\"dir\":$(dir_num "$WALL")}"

http GET "/api/games/$GAME_ID/reveal"
check http "the seed of a game in progress is not revealed" "409 NOT_REVEALABLE" "$HTTP_STATUS $(http_field .error.code)"
http GET "/api/games/$GAME_ID"
check http "the game cannot be read without the session token" "401 UNAUTHORIZED" "$HTTP_STATUS $(http_field .error.code)"

http_game
check http "the server's game read is unchanged by the refused moves" "$GAME_BEFORE" "$(printf '%s' "$HTTP_BODY" | jq -cS 'del(.chainNowSec)')"
chain_game "$GAME_ID"
check chain "the game is still Active" "$STATUS_ACTIVE" "$G_STATUS"
settlement "$GAME_ID"
check chain "nothing was settled" 0 "$S_COUNT"
check chain "totalReserved still holds the game's maximum payout" "$G_MAX_PAYOUT" "$(chain_call 'totalReserved()(uint256)')"

# One poll period of the page (3 seconds), so that anything the server changed would show.
sleep 4
expect_attr "the board is still at step $K" A board data-step "$K" 5
expect_attr "refundable-amount is unchanged" A refundable-amount data-wei "$REFUND" 5
if CELL_AFTER="$(current_cell A)"; then
  check dom "the current cell is unchanged" "$CELL_BEFORE" "$CELL_AFTER"
else
  dom_blocked "the current cell is unchanged" "the DOM could not be read over path $READ_PATH"
fi
expect_absent "the page shows no error: it sent none of these moves" A error-message 2

# The game is still playable: a normal cash-out settles it.
cash_out A || fail_scenario "the cash-out (cashout-open, then cashout-button) is not clickable after the refused moves"
expect_result A cashout "$REFUND"
expect_settled 1 "$K" "$REFUND" cashed_out false

scenario_end
