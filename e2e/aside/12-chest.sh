#!/usr/bin/env bash
# 12 treasure chest, points only (docs/treasure-chest.md; AC-P7).
#
# Bets through the page on the middle size of the table, plans offline (the test seed hook gives
# the server seed from the game id) the shortest route into a dead end that holds a chest, and
# walks it with the arrow keys (the move buttons when key presses were not verified).
#
#   DOM    before the last move nothing tells of a chest (no chest-found, no chest-reveal, no
#          cell marked) and points-balance shows 0; after it result-outcome = loss with a payout
#          of 0, chest-found with the planned reward and points, saying "보물상자 발견" and
#          "현금 가치 없음", chest-reveal on the dead end, the dead-end cell marked, and
#          points-balance showing the points; on the verify page every check passes,
#          verify-chests lists every chest the planner computed and verify-chest-match is true
#   chain  the game settles as a loss of 0: GameSettled(outcome 2, payout 0) from the relayer,
#          the player's balance does not change after the bet, totalReserved back to 0, and the
#          contract's accounting holds. Points change nothing on chain.
#   HTTP   /api/config reports chest rule 1 and points without cash value; no answer during the
#          game mentions a chest and the ledger stays empty until the end; the terminal view
#          carries the chest; GET /api/points/<player> lists the award (game, cell, bet, reward,
#          points, rule) and the total; the reveal route
#
# Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED.

set -u
# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

scenario_begin 12 chest "a route into a dead end with a treasure chest: the bet is lost on chain as before, the chest and its points (no cash value) show on the page and in the ledger, and the verify page matches the chest to the seed"
require_input_path
stack_up
aside_start || blocked_scenario "the aside repl session did not start (see $ASIDE_LOG)"

HOW=click
cap pressKey && HOW=key

check http "/api/config: the chest rule is version 1" 1 "$(printf '%s' "$CONFIG_JSON" | jq -r '.chest.ruleVersion')"
check http "/api/config: points have no cash value" false "$(printf '%s' "$CONFIG_JSON" | jq -r '.chest.cashValue')"
http GET "/api/points/$PLAYER_ADDR"
check http "GET /api/points/<player> answers 200 without a token, with 0 points before any game" "200 0" "$HTTP_STATUS $(http_field .totalPoints)"

open_lobby A
connect_dev_wallet A
expect_attr "points-balance shows 0 points before any game" A points-balance data-points 0 10

# ----- the game, up to the dead end -----

# The middle size of the table, as scenario 02. A maze whose chests all lie beyond the exit is
# cashed out at step 0 and another game is started (open_game_for).
open_game_for A $((($(tier_count) - 1) / 2)) chest
expect_game_open
STEPS="$(printf '%s' "$PLAN_JSON" | jq -r '.steps')"
CHEST_X="$(printf '%s' "$PLAN_JSON" | jq -r '.chest.x')"
CHEST_Y="$(printf '%s' "$PLAN_JSON" | jq -r '.chest.y')"
CHEST_BPS="$(printf '%s' "$PLAN_JSON" | jq -r '.chest.rewardBps')"
ALL_CHESTS="$(printf '%s' "$PLAN_JSON" | jq -r '[.chests[].cell] | join(",")')"
CHEST_COUNT="$(printf '%s' "$PLAN_JSON" | jq -r '.chests | length')"
# points = floor(bet × rewardBps / (10000 × 10^12))
POINTS="$(BC_LINE_LENGTH=0 bc <<<"$BET_WEI * $CHEST_BPS / 10000000000000000")"
evidence chest "($CHEST_X,$CHEST_Y) ${CHEST_BPS} bps"
evidence points "$POINTS"
evidence input "moves by $HOW"
check http "the planner's route ends the game as a loss (it replays the rules)" loss "$(printf '%s' "$PLAN_JSON" | jq -r '.outcome')"
check http "the planner used chest rule 1" 1 "$(printf '%s' "$PLAN_JSON" | jq -r '.chestRule')"

# shellcheck disable=SC2206
MOVES=($PLAN_MOVES)
LAST="${MOVES[$((${#MOVES[@]} - 1))]}"
BEFORE=("${MOVES[@]:0:$((${#MOVES[@]} - 1))}")
walk A "$HOW" ${BEFORE[@]+"${BEFORE[@]}"}

# Nothing about the chest before the game is over.
http_game
check http "the server reports the game active one move before the dead end" "active $((STEPS - 1))" "$(http_field .status) $(http_field .step)"
check http "no in-game answer mentions a chest or points" "" "$(printf '%s' "$HTTP_BODY" | grep -oiE 'chest|points' | head -n 1)"
http GET "/api/points/$PLAYER_ADDR"
check http "the ledger is still empty while the game is in progress" 0 "$(http_field .totalPoints)"
expect_absent "chest-found is not on screen during the game" A chest-found 0
expect_absent "chest-reveal is not on the board during the game" A chest-reveal 0
if CELLS="$(dom_list A cell-)"; then
  check dom "no board cell is marked as a chest during the game" 0 "$(printf '%s' "$CELLS" | jq '[.[] | select(.attrs["data-chest"] != null)] | length')"
else
  dom_blocked "no board cell is marked as a chest during the game" "the DOM could not be read over path $READ_PATH"
fi

# ----- the move into the dead end -----

move A "$LAST" "$HOW"
expect_result A loss 0
expect_attr "chest-found shows the planned points" A chest-found data-points "$POINTS" 20
expect_attr "chest-found shows the planned reward" A chest-found data-reward-bps "$CHEST_BPS" 5
expect_attr "chest-points shows the points" A chest-points data-points "$POINTS" 5
if FOUND_TEXT="$(dom_text A chest-found)"; then
  check_ok dom "chest-found says 보물상자 발견: +N 포인트" "contains 보물상자 발견: +" "$FOUND_TEXT" \
    "$(printf '%s' "$FOUND_TEXT" | grep -q '보물상자 발견: +' && printf '%s' "$FOUND_TEXT" | grep -q '포인트'; echo $?)"
  check_ok dom "chest-found says the points have no cash value" "contains 현금 가치 없음" "$FOUND_TEXT" \
    "$(printf '%s' "$FOUND_TEXT" | grep -q '현금 가치 없음'; echo $?)"
else
  dom_blocked "chest-found text" "the DOM could not be read over path $READ_PATH"
fi
expect_attr "chest-reveal stands on the dead end (x)" A chest-reveal data-x "$CHEST_X" 5
expect_attr "chest-reveal stands on the dead end (y)" A chest-reveal data-y "$CHEST_Y" 5
expect_attr "the dead-end cell is marked as the chest" A "cell-$CHEST_X-$CHEST_Y" data-chest true 5
expect_attr "points-balance in the header shows the new balance" A points-balance data-points "$POINTS" 20

# On chain the game is the loss it always was: payout 0, balance unchanged, accounting intact.
expect_settled 2 "$STEPS" 0 lost false
expect_result_tx A

http_game
check http "terminal.chestRule is 1" 1 "$(http_field .terminal.chestRule)"
check http "terminal.chest is at the dead end" "$CHEST_X $CHEST_Y" "$(http_field .terminal.chest.cell.x) $(http_field .terminal.chest.cell.y)"
check http "terminal.chest carries the planned reward and points" "$CHEST_BPS $POINTS" "$(http_field .terminal.chest.rewardBps) $(http_field .terminal.chest.points)"

http GET "/api/points/$PLAYER_ADDR"
check http "GET /api/points/<player> answers 200" 200 "$HTTP_STATUS"
check_hex http "the ledger account is the player's address" "$PLAYER_ADDR" "$(http_field .address)"
check http "the ledger total is the chest's points" "$POINTS" "$(http_field .totalPoints)"
check http "the ledger holds one award" 1 "$(http_field .awardCount)"
check_hex http "the award names this game" "$GAME_ID" "$(http_field '.awards[0].gameId')"
check http "the award names the cell, the bet, the reward, the points and the rule" \
  "$CHEST_X $CHEST_Y $BET_WEI $CHEST_BPS $POINTS 1" \
  "$(http_field '.awards[0].cell.x') $(http_field '.awards[0].cell.y') $(http_field '.awards[0].betWei') $(http_field '.awards[0].rewardBps') $(http_field '.awards[0].points') $(http_field '.awards[0].chestRule')"
check http "the ledger says points have no cash value" false "$(http_field .cashValue)"
check chain "the award's chain time is not after the settlement block" 0 \
  "$([ "$(http_field '.awards[0].atSec')" -le "$S_BLOCK_TIME" ] 2>/dev/null; echo $?)"

# ----- the verify page -----

open_verify A V
expect_verify_ok V $((STEPS + 1))
expect_attr "verify: the awarded chest matches the seed" V verify-chest-match data-match true 10
expect_attr "verify: every chest of the maze is listed (the planner's cells)" V verify-chests data-cells "$ALL_CHESTS" 10
expect_attr "verify: the number of chests is the planner's" V verify-chests data-count "$CHEST_COUNT" 5
expect_attr "verify: the chests were computed with rule 1" V verify-chests data-rule 1 5

scenario_end
