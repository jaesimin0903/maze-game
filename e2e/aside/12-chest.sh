#!/usr/bin/env bash
# 12 treasure chests, points only, chest rule 2 (docs/treasure-chest.md; AC-P7, AC-P10, AC-P11).
#
# Bets through the page on the middle size of the table, plans offline (the test seed hook gives
# the server seed from the game id) the shortest route that passes at least one path chest and
# ends in a dead end that holds a chest, and walks it with the arrow keys (the move buttons when
# key presses were not verified), one move at a time.
#
#   DOM    on every move into a path chest: chest-just-found with that chest's points and cell,
#          chest-pop with the points over the cell, the cell's chest-cell-<x>-<y> mark,
#          game-points with the game's running total and points-balance with the same total;
#          on every other move no chest-just-found. Before the last move no chest-found, no
#          chest-reveal, and only the entered path-chest cells marked. After it result-outcome =
#          loss with a payout of 0, chest-found with the planned reward and points, saying
#          "Chest found: +N points" and "No cash value", chest-reveal on the dead end, the dead-end cell
#          marked, game-chests listing every chest of the game and game-points-total and
#          points-balance showing their sum; in the verify dialog every check passes,
#          verify-chests lists every chest the planner computed (rule 2, path and dead-end
#          counts) and verify-chest-match is true
#   chain  the game settles as a loss of 0: GameSettled(outcome 2, payout 0) from the relayer,
#          the player's balance does not change after the bet, totalReserved back to 0, and the
#          contract's accounting holds. Points change nothing on chain.
#   HTTP   /api/config reports chest rule 2, both chest kinds and points without cash value; each
#          in-game answer lists exactly the chests of the cells entered so far and the ledger
#          holds each path chest from the move that found it; the terminal view carries the
#          dead-end chest; GET /api/points/<player> lists every award (game, kind, cell, bet,
#          reward, points, rule, step) and the total; the reveal route
#
# Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED.

set -u
# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

scenario_begin 12 chest "a route past path chests into a dead end with a treasure chest: each path chest shows and pays its points the moment its cell is entered, the bet is lost on chain as before, every chest and its points (no cash value) show on the page and in the ledger, and the verify dialog matches the chests to the seed"
require_input_path
stack_up
aside_start || blocked_scenario "the aside repl session did not start (see $ASIDE_LOG)"

HOW=click
cap pressKey && HOW=key

check http "/api/config: the chest rule is version 2" 2 "$(printf '%s' "$CONFIG_JSON" | jq -r '.chest.ruleVersion')"
check http "/api/config: dead-end chests 30%, 10-30% of the bet; path chests 10%, 2-5% of the bet" \
  "3000 1000 3000 1000 200 500" \
  "$(printf '%s' "$CONFIG_JSON" | jq -r '.chest | "\(.rateBps) \(.rewardMinBps) \(.rewardMaxBps) \(.pathRateBps) \(.pathRewardMinBps) \(.pathRewardMaxBps)"')"
check http "/api/config: points have no cash value" false "$(printf '%s' "$CONFIG_JSON" | jq -r '.chest.cashValue')"
http GET "/api/points/$PLAYER_ADDR"
check http "GET /api/points/<player> answers 200 without a token, with 0 points before any game" "200 0" "$HTTP_STATUS $(http_field .totalPoints)"

open_lobby A
connect_dev_wallet A
expect_attr "points-balance shows 0 points before any game" A points-balance data-points 0 10

# ----- the game, up to the dead end -----

# The middle size of the table, as scenario 02. A maze without a route past a path chest into a
# chest dead end before the exit is cashed out at step 0 and another game is started
# (open_game_for).
open_game_for A $((($(tier_count) - 1) / 2)) chest
expect_game_open
STEPS="$(printf '%s' "$PLAN_JSON" | jq -r '.steps')"
CHEST_X="$(printf '%s' "$PLAN_JSON" | jq -r '.chest.x')"
CHEST_Y="$(printf '%s' "$PLAN_JSON" | jq -r '.chest.y')"
CHEST_BPS="$(printf '%s' "$PLAN_JSON" | jq -r '.chest.rewardBps')"
ALL_CHESTS="$(printf '%s' "$PLAN_JSON" | jq -r '[.chests[].cell] | join(",")')"
CHEST_COUNT="$(printf '%s' "$PLAN_JSON" | jq -r '.chests | length')"
PATH_CHEST_COUNT="$(printf '%s' "$PLAN_JSON" | jq -r '[.chests[] | select(.kind == "path")] | length')"
PATH_COUNT="$(printf '%s' "$PLAN_JSON" | jq -r '.pathChests | length')"
# points = floor(bet × rewardBps / (10000 × 10^12))
points_of() { BC_LINE_LENGTH=0 bc <<<"$BET_WEI * $1 / 10000000000000000"; }
POINTS="$(points_of "$CHEST_BPS")"
evidence chest "($CHEST_X,$CHEST_Y) ${CHEST_BPS} bps"
evidence points "$POINTS"
evidence "path chests" "$(printf '%s' "$PLAN_JSON" | jq -r '[.pathChests[] | "step \(.step) (\(.x),\(.y)) \(.rewardBps) bps"] | join(", ")')"
evidence input "moves by $HOW"
check http "the planner's route ends the game as a loss (it replays the rules)" loss "$(printf '%s' "$PLAN_JSON" | jq -r '.outcome')"
check http "the planner used chest rule 2" 2 "$(printf '%s' "$PLAN_JSON" | jq -r '.chestRule')"
check http "the planner's route passes at least one path chest and ends in a dead-end chest" "yes dead-end" \
  "$([ "$PATH_COUNT" -ge 1 ] 2>/dev/null && echo yes || echo no) $(printf '%s' "$PLAN_JSON" | jq -r '.chest.kind')"

# shellcheck disable=SC2206
MOVES=($PLAN_MOVES)
LAST="${MOVES[$((${#MOVES[@]} - 1))]}"
BEFORE=("${MOVES[@]:0:$((${#MOVES[@]} - 1))}")
expect_attr "game-points shows 0 for the new game" A game-points data-points 0 10

# One move at a time: a path chest shows, and pays, the moment its cell is entered.
TOTAL=0
FOUND=0
FOUND_CELLS=""
for DIR in ${BEFORE[@]+"${BEFORE[@]}"}; do
  move A "$DIR" "$HOW"
  AT="$(printf '%s' "$PLAN_JSON" | jq -r --argjson s "$STEP" '.pathChests[] | select(.step == $s) | "\(.x) \(.y) \(.rewardBps)"')"
  if [ -n "$AT" ]; then
    read -r PX PY PBPS <<<"$AT"
    PPOINTS="$(points_of "$PBPS")"
    TOTAL="$(big_add "$TOTAL" "$PPOINTS")"
    FOUND=$((FOUND + 1))
    FOUND_CELLS="${FOUND_CELLS:+$FOUND_CELLS }$PX,$PY"
    expect_attr "step $STEP: chest-just-found shows the path chest's points" A chest-just-found data-points "$PPOINTS" 10
    expect_attr "step $STEP: chest-just-found names its cell" A chest-just-found data-x "$PX" 5
    expect_attr "step $STEP: chest-just-found names its cell (y)" A chest-just-found data-y "$PY" 5
    expect_attr "step $STEP: chest-just-found is a path chest" A chest-just-found data-kind path 5
    expect_attr "step $STEP: chest-pop shows the points on the board cell" A chest-pop data-points "$PPOINTS" 5
    expect_attr "step $STEP: the cell keeps its chest mark" A "chest-cell-$PX-$PY" data-points "$PPOINTS" 5
    expect_attr "step $STEP: game-points is the game's running total" A game-points data-points "$TOTAL" 5
    expect_attr "step $STEP: points-balance in the header follows" A points-balance data-points "$TOTAL" 20
    if JUST_TEXT="$(dom_text A chest-just-found)"; then
      check_ok dom "step $STEP: chest-just-found says Treasure chest! +N PT" "contains Treasure chest! +" "$JUST_TEXT" \
        "$(printf '%s' "$JUST_TEXT" | grep -q 'Treasure chest! +'; echo $?)"
    else
      dom_blocked "step $STEP: chest-just-found text" "the DOM could not be read over path $READ_PATH"
    fi
    http GET "/api/points/$PLAYER_ADDR"
    check http "step $STEP: the ledger holds the path chest from the move that found it" "$TOTAL $FOUND path $STEP" \
      "$(http_field .totalPoints) $(http_field .awardCount) $(http_field '.awards[0].kind') $(http_field '.awards[0].step')"
  else
    expect_absent "step $STEP: no chest-just-found after a move into a cell without a chest" A chest-just-found 0
    expect_attr "step $STEP: game-points is unchanged" A game-points data-points "$TOTAL" 5
  fi
  # Every in-game answer lists exactly the chests of the cells entered so far.
  http_game
  check http "step $STEP: the view lists the path chests found so far, and only those" "$FOUND_CELLS" \
    "$(http_field '[.chests[] | select(.kind == "path") | "\(.cell.x),\(.cell.y)"] | join(" ")')"
done
check http "every planned path chest was found on the way" "$PATH_COUNT" "$FOUND"
PATH_TOTAL="$TOTAL"

# The dead end's chest stays unknown until the game is over.
http_game
check http "the server reports the game active one move before the dead end" "active $((STEPS - 1))" "$(http_field .status) $(http_field .step)"
check http "no in-game answer shows a dead-end chest or a terminal" "0 " \
  "$(http_field '[.chests[] | select(.kind == "dead-end")] | length') $(http_field '.terminal')"
expect_absent "chest-found is not on screen during the game" A chest-found 0
expect_absent "chest-reveal is not on the board during the game" A chest-reveal 0
if CELLS="$(dom_list A cell-)"; then
  check dom "only the entered path-chest cells are marked as chests during the game" "$PATH_COUNT" \
    "$(printf '%s' "$CELLS" | jq '[.[] | select(.attrs["data-chest"] != null and .attrs["data-chest-kind"] == "path")] | length')"
  check dom "no other board cell is marked as a chest during the game" 0 \
    "$(printf '%s' "$CELLS" | jq '[.[] | select(.attrs["data-chest"] != null and .attrs["data-chest-kind"] != "path")] | length')"
else
  dom_blocked "only the entered path-chest cells are marked as chests during the game" "the DOM could not be read over path $READ_PATH"
fi

# ----- the move into the dead end -----

move A "$LAST" "$HOW"
expect_result A loss 0
expect_attr "chest-found shows the planned points" A chest-found data-points "$POINTS" 20
expect_attr "chest-found shows the planned reward" A chest-found data-reward-bps "$CHEST_BPS" 5
expect_attr "chest-points shows the points" A chest-points data-points "$POINTS" 5
if FOUND_TEXT="$(dom_text A chest-found)"; then
  check_ok dom "chest-found says Chest found: +N points" "contains Chest found: +" "$FOUND_TEXT" \
    "$(printf '%s' "$FOUND_TEXT" | grep -q 'Chest found: +' && printf '%s' "$FOUND_TEXT" | grep -q 'points'; echo $?)"
  check_ok dom "chest-found says the points have no cash value" "contains No cash value" "$FOUND_TEXT" \
    "$(printf '%s' "$FOUND_TEXT" | grep -q 'No cash value'; echo $?)"
else
  dom_blocked "chest-found text" "the DOM could not be read over path $READ_PATH"
fi
expect_attr "chest-reveal stands on the dead end (x)" A chest-reveal data-x "$CHEST_X" 5
expect_attr "chest-reveal stands on the dead end (y)" A chest-reveal data-y "$CHEST_Y" 5
expect_attr "the dead-end cell is marked as the chest" A "cell-$CHEST_X-$CHEST_Y" data-chest true 5
TOTAL="$(big_add "$PATH_TOTAL" "$POINTS")"
expect_attr "game-chests lists every chest of the game" A game-chests data-count "$((PATH_COUNT + 1))" 5
expect_attr "game-chests: the last one is the dead end's" A "game-chest-$PATH_COUNT" data-kind dead-end 5
expect_attr "game-chests: the first one is the first path chest" A game-chest-0 data-kind path 5
expect_attr "game-points-total is the sum of the game's chests" A game-points-total data-points "$TOTAL" 5
expect_attr "points-balance in the header shows the new balance" A points-balance data-points "$TOTAL" 20

# On chain the game is the loss it always was: payout 0, balance unchanged, accounting intact.
expect_settled 2 "$STEPS" 0 lost false
expect_result_tx A

http_game
check http "terminal.chestRule is 2" 2 "$(http_field .terminal.chestRule)"
check http "terminal.chest is at the dead end" "$CHEST_X $CHEST_Y" "$(http_field .terminal.chest.cell.x) $(http_field .terminal.chest.cell.y)"
check http "terminal.chest carries the planned reward and points" "$CHEST_BPS $POINTS" "$(http_field .terminal.chest.rewardBps) $(http_field .terminal.chest.points)"
check http "the final view lists every chest of the game, the dead end's last" "$((PATH_COUNT + 1)) dead-end" \
  "$(http_field '.chests | length') $(http_field '.chests[-1].kind')"

http GET "/api/points/$PLAYER_ADDR"
check http "GET /api/points/<player> answers 200" 200 "$HTTP_STATUS"
check_hex http "the ledger account is the player's address" "$PLAYER_ADDR" "$(http_field .address)"
check http "the ledger total is the points of every chest of the game" "$TOTAL" "$(http_field .totalPoints)"
check http "the ledger holds one award per chest" "$((PATH_COUNT + 1))" "$(http_field .awardCount)"
check_hex http "the newest award names this game" "$GAME_ID" "$(http_field '.awards[0].gameId')"
check http "the newest award is the dead end's: kind, cell, bet, reward, points, rule and step" \
  "dead-end $CHEST_X $CHEST_Y $BET_WEI $CHEST_BPS $POINTS 2 $STEPS" \
  "$(http_field '.awards[0].kind') $(http_field '.awards[0].cell.x') $(http_field '.awards[0].cell.y') $(http_field '.awards[0].betWei') $(http_field '.awards[0].rewardBps') $(http_field '.awards[0].points') $(http_field '.awards[0].chestRule') $(http_field '.awards[0].step')"
check http "the other awards are this game's path chests" "$PATH_COUNT" \
  "$(http_field '[.awards[1:][] | select(.kind == "path")] | length')"
check http "the ledger says points have no cash value" false "$(http_field .cashValue)"
check chain "the award's chain time is not after the settlement block" 0 \
  "$([ "$(http_field '.awards[0].atSec')" -le "$S_BLOCK_TIME" ] 2>/dev/null; echo $?)"

# ----- the verify dialog -----

open_verify A V
expect_verify_ok V $((STEPS + 1))
expect_attr "verify: the awarded chest matches the seed" V verify-chest-match data-match true 10
expect_attr "verify: every chest of the maze is listed (the planner's cells)" V verify-chests data-cells "$ALL_CHESTS" 10
expect_attr "verify: the number of chests is the planner's" V verify-chests data-count "$CHEST_COUNT" 5
expect_attr "verify: the chests were computed with rule 2" V verify-chests data-rule 2 5
expect_attr "verify: the number of path chests is the planner's" V verify-chests data-path-count "$PATH_CHEST_COUNT" 5

scenario_end
