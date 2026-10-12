#!/usr/bin/env bash
# 01 exit win (plan §9.1; AC-W1, AC-W2, AC-W3, AC-W4, AC-W5, AC-W6, AC-R1, AC-R2, AC-E1, AC-M4,
# AC-T8, and the positive half of AC-A4).
#
# Connects the dev wallet, reads the escape payout and the refund schedule BEFORE betting (for
# every size of the table, with two different amounts: 0.02 set on the slider between its ticks,
# and BET_ETH), bets on the smallest size with A (which bets at once what the lobby screen names),
# walks the solution to the exit, and opens the verify dialog.
#
#   DOM    the dev wallet option is offered and connects Anvil #2; before any bet the side
#          panel's difficulty keys carry the table's sizes and multipliers, the slider holds the
#          bet set, and escape-payout equals bet x multiplier for the chosen size and bet,
#          following a change of size and bet; in the game's details that the transaction log
#          opens before a bet, every schedule row and the exit payout equal the table for that
#          size and amount (closed again with their close button); their rules state the refund
#          right after the bet and after the first step, and the idle and maximum-time rules; the
#          lobby screen names the bet A places (bet-prompt); the board appears with the start and
#          the exit marked and no wall data on unvisited cells; result-outcome = exit with bet x
#          multiplier; the settlement transaction is named; the verify dialog shows the hash
#          match, every observed cell matching, and the solution
#   chain  nothing is on chain before the bet; the contract quotes the same exit payout and
#          holds the same sizes and multipliers; getGame Active then Settled; GameSettled
#          (outcome 0, steps = solution length, payout = bet x multiplier) from the relayer;
#          the player's balance grows by exactly the payout; totalReserved returns to 0
#   HTTP   /api/config reports devWallet, testHooks and the table mode; the server's view of
#          the game at start and at the end; the reveal route; and the TestBeacon snapshot
#          (GET /api/test/ui-snapshot) carries what the page shows and keeps counting
#
# Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED.

set -u
# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

scenario_begin 01 exit "escape payout and refund schedule before the bet, then the solution to the exit, the payout on chain and the verify dialog"
require_input_path
stack_up
aside_start || blocked_scenario "the aside repl session did not start (see $ASIDE_LOG)"

FIXTURE_EXPECTED=false
[ "$TABLE_MODE" = fixture ] && FIXTURE_EXPECTED=true
check http "/api/config: devWallet is on" true "$(printf '%s' "$CONFIG_JSON" | jq -r '.devWallet')"
check http "/api/config: testHooks is on" true "$(printf '%s' "$CONFIG_JSON" | jq -r '.testHooks')"
check http "/api/config: fixture matches the table mode ($TABLE_MODE)" "$FIXTURE_EXPECTED" "$(printf '%s' "$CONFIG_JSON" | jq -r '.fixture')"
check_hex http "/api/config: the contract is the one deployed for this scenario" "$CONTRACT" "$(printf '%s' "$CONFIG_JSON" | jq -r '.contract')"
check http "/api/config: the chain is this scenario's Anvil" "$RPC" "$(printf '%s' "$CONFIG_JSON" | jq -r '.rpcUrl')"

# ----- before the bet -----

open_lobby A
expect_attr "chain-info shows chain 31337 (from /api/config, not from the build)" A chain-info data-chain-id 31337 5
if [ "$FIXTURE_EXPECTED" = true ]; then
  expect_present "fixture-banner is shown with the test table" A fixture-banner 5
else
  expect_absent "fixture-banner is not shown with the production table" A fixture-banner 5
fi
expect_present "wallet-dev-option is offered while devWallet is on" A wallet-dev-option 5
connect_dev_wallet A
check_hex dom "wallet-address is Anvil account #2" "$PLAYER_ADDR" "$WALLET_SHOWN"
expect_attr "the connected wallet is the dev wallet" A wallet-address data-kind dev 5

LOGS_BEFORE="$(cast logs --from-block 0 --to-block latest --address "$CONTRACT" --rpc-url "$RPC" --json \
  'GameCreated(bytes32 indexed,address indexed,uint8,uint256,uint256,bytes32,bytes32,uint64)' 2>/dev/null | jq 'length')"
check chain "no game exists on chain while the payouts are read" 0 "$LOGS_BEFORE"

# Every other size of the table and another amount first, set on the slider between two ticks, to
# see that the escape payout and the schedule follow the side panel for each size the table
# offers. The details cover the device, so they are closed again before the next size is chosen.
OTHER=$(($(tier_count) - 1))
while [ "$OTHER" -ge 1 ]; do
  choose_bet A "$OTHER" 0.02
  expect_escape_payout A "$OTHER" "$BET_WEI"
  open_details A || fail_scenario "the game's details did not open from the transaction log (tx-log-open)"
  expect_schedule A "$OTHER" "$BET_WEI"
  close_details A || fail_scenario "the game's details did not close (details-close)"
  OTHER=$((OTHER - 1))
done
choose_bet A 0 "$BET_ETH"
expect_escape_payout A 0 "$BET_WEI"

# The details before the bet: the schedule of the size and amount the bet is placed with, and the
# rules naming the refund right after the bet and after the first step, and the idle and
# maximum-time rules, as the table and /api/config give them.
fill_bet A 0 "$BET_ETH" "$(client_seed 1)"
open_details A || fail_scenario "the game's details did not open from the transaction log (tx-log-open)"
expect_attr "the details show the lobby's choice before the bet" A game-details data-mode preview 5
expect_schedule A 0 "$BET_WEI"
expect_attr "schedule-row-0 is the refund right after the bet" A schedule-row-0 data-wei "$(refund_wei "$BET_WEI" 0 0)" 5
expect_attr "schedule-row-1 is the refund after the first move" A schedule-row-1 data-wei "$(refund_wei "$BET_WEI" 0 1)" 5
# percent <bps>: as the page prints it, 9500 -> 95.00%
percent() { printf '%d.%02d%%' $(($1 / 100)) $(($1 % 100)); }
RULES_WANT="$(percent "$(tier_refund_bps 0 0)") $(percent "$(tier_refund_bps 0 1)") $(printf '%s' "$CONFIG_JSON" | jq -r '.idleTimeoutSec')s $(printf '%s' "$CONFIG_JSON" | jq -r '.maxGameSec')s"
expect_present "the details state the rules (bet-rules)" A bet-rules 5
if RULES_TEXT="$(dom_text A bet-rules)"; then
  RULES_SEEN=""
  for RULE in $RULES_WANT; do
    case "$RULES_TEXT" in *"$RULE"*) RULES_SEEN="${RULES_SEEN:+$RULES_SEEN }$RULE" ;; esac
  done
  check dom "bet-rules names refundBps[0], refundBps[1], the idle timeout and the maximum game time" "$RULES_WANT" "$RULES_SEEN"
else
  dom_blocked "bet-rules names the refunds and the time rules" "the DOM could not be read over path $READ_PATH"
fi
close_details A || fail_scenario "the game's details did not close (details-close)"

# ----- the game -----

submit_bet A
expect_game_open
plan exit || fail_scenario "the maze has no solution"
STEPS="$(printf '%s' "$PLAN_JSON" | jq -r '.steps')"
PAYOUT="$(exit_wei "$BET_WEI" "$TIER")"

expect_fog A 0
expect_refundable A 0
expect_attr "exit-payout shows bet x multiplier" A exit-payout data-wei "$PAYOUT" 5
expect_attr "A is the cash-out button (CASH OUT) during play" A btn-a data-action cashout 5

FIRST=1
# shellcheck disable=SC2086
for DIR in $PLAN_MOVES; do
  move A "$DIR"
  if [ "$FIRST" -eq 1 ]; then
    FIRST=0
    expect_fog A 1
    expect_refundable A 1
  fi
done

expect_result A exit "$PAYOUT"
expect_fog A "$STEPS"
expect_settled 0 "$STEPS" "$PAYOUT" won false
expect_result_tx A

# ----- the test-only read path (B) reports the same page -----

http GET /api/test/ui-snapshot
SEQ_BEFORE="$(http_field .seq)"
check http "GET /api/test/ui-snapshot answers 200 while test hooks are on" 200 "$HTTP_STATUS"
check http "the snapshot carries the result the page shows" exit "$(http_field '.items["result-outcome"].attrs["data-outcome"]')"
check http "the snapshot carries the payout the page shows" "$PAYOUT" "$(http_field '.items["result-payout"].attrs["data-wei"]')"
sleep 2.5
http GET /api/test/ui-snapshot
SEQ_AFTER="$(http_field .seq)"
check_ok http "the snapshot's seq keeps rising (heartbeat)" "above $SEQ_BEFORE" "$SEQ_AFTER" \
  "$([ "${SEQ_AFTER:-0}" -gt "${SEQ_BEFORE:-0}" ] 2>/dev/null; echo $?)"

# ----- the verify dialog -----

open_verify A V
expect_verify_ok V $((STEPS + 1))
expect_attr "verify-game names this game" V verify-game data-game-id "$GAME_ID" 5
expect_attr "verify-maze draws the whole n x n maze" V verify-maze data-n "$N" 5
expect_attr "verify-solution shows the solution, as long as the route walked" V verify-solution data-length "$STEPS" 5
if SEED_SHOWN="$(dom_text V verify-server-seed)"; then
  check_hex dom "verify-server-seed is the settled seed" "$S_SERVER_SEED" "$SEED_SHOWN"
else
  dom_blocked "verify-server-seed is the settled seed" "the DOM could not be read over path $READ_PATH"
fi

scenario_end
