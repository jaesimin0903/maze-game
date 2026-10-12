#!/usr/bin/env bash
# 09 exploratory agent (plan §9.1, advisory; AC-A7).
#
# The only scenario that uses `aside exec`: a model-driven browser agent is asked to look for a
# way to see hidden cells or to get money back for free, and afterwards the contract's
# invariants and the server's access rules must still hold. The plan defines no DOM assertion
# for it, and its verdict does not decide the suite's exit code.
#
# It runs ONLY on request (scripts/e2e-aside.sh --with-exec, or MAZE_E2E_EXEC=1), because
# `aside exec` is not deterministic, is billed to the model account configured in the user's
# Aside, and runs an agent inside the user's real browser profile. Without the request the
# scenario reports NOT-RUN (exit code 4) and starts nothing.
#
#   chain  the contract's balance equals funded + bets - payouts - reclaims + pending; it
#          reserves exactly the active games' maximum payouts; no settlement paid more than
#          its game's maximum; owner, server signer and table hash are the deployed ones
#   HTTP   the agent did open the page (the TestBeacon snapshot names this app); no game can be
#          read without its session token; the seed of every game still in progress is not
#          revealed; /api/config still serves the same table
#
# If the agent is cut off by the time limit, a tab it opened may stay open in the browser; the
# scenario cannot know that tab and says so.
#
# Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED, 4 NOT-RUN.

set -u
# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

scenario_begin 09 exploratory-agent "advisory: after a model-driven agent has tried to cheat, the contract's accounting and the server's access rules still hold"
SC_NO_DOM=1
if [ "${MAZE_E2E_EXEC:-0}" != 1 ]; then
  not_run_scenario "advisory and on request only: aside exec is model-driven and billed to the user's model account (scripts/e2e-aside.sh --with-exec)"
fi
if [ -z "$ASIDE_BIN" ] || [ ! -x "$ASIDE_BIN" ]; then blocked_scenario "aside is not installed"; fi

EXEC_TIMEOUT="${MAZE_E2E_EXEC_TIMEOUT:-420}"
stack_up
TABLE_HASH_BEFORE="$(printf '%s' "$CONFIG_JSON" | jq -r '.tableHash')"

PROMPT="You are testing a local demo game for cheating opportunities. Work ONLY in one new tab on $APP_URL/ and never open, read or change any other tab, site, account, mail, document or file. \
On that page: click the button with data-testid wallet-dev-option to connect the test wallet (do NOT click wallet-connect), keep the default size and bet, click btn-a (the A button, named START), which places the bet the screen names at once and shows the steps on the screen until the board appears, and play the maze with the move-N, move-E, move-S, move-W buttons (a move button whose data-legal is false is refused on the page; A does not move). To cash out, click btn-a (A, named CASH OUT during a game), then cashout-button (Take it). \
Then try to find a way to (1) learn the walls of cells you have not visited, or (2) get more money back than the page says you can cash out. You may inspect the page, its storage and the requests it makes to $APP_URL/api/. \
Stop after at most 25 actions. Close the tab you opened. Report in a few lines what you tried and whether anything worked."

log "running aside exec for at most $EXEC_TIMEOUT seconds (model-driven; output in $SC_DIR/exec.log)"
with_timeout "$EXEC_TIMEOUT" "$ASIDE_BIN" exec "$PROMPT" </dev/null 2>&1 | redact >"$SC_DIR/exec.log"
EXEC_CODE="${PIPESTATUS[0]}"
evidence execExitCode "$EXEC_CODE"
if [ "$EXEC_CODE" -ne 0 ]; then
  log "aside exec ended with code $EXEC_CODE (142 means the time limit); a tab it opened on $APP_URL may still be open"
fi

# ----- the agent was really there -----

http GET /api/test/ui-snapshot
check http "the agent opened the page (the TestBeacon posted a snapshot)" 200 "$HTTP_STATUS"
check_ok http "the snapshot comes from this app" "$APP_URL/..." "$(http_field .url)" \
  "$(case "$(http_field .url)" in "$APP_URL"/*) echo 0 ;; *) echo 1 ;; esac)"

# ----- invariants -----

expect_accounting
check_hex chain "the contract's owner is the deployed one" "$(jq -r '.owner' "$DEPLOYMENT_FILE")" "$(chain_call 'owner()(address)')"
check_hex chain "the contract's server signer is the deployed one" "$(jq -r '.serverSigner' "$DEPLOYMENT_FILE")" "$(chain_call 'serverSigner()(address)')"
check_hex chain "the contract's table hash is the deployed one" "$(jq -r '.tableHash' "$DEPLOYMENT_FILE")" "$(chain_call 'tableHash()(bytes32)')"

http GET /api/config
check http "/api/config still answers" 200 "$HTTP_STATUS"
check_hex http "/api/config still serves the same table" "$TABLE_HASH_BEFORE" "$(http_field .tableHash)"

GAMES=0
OPEN_READS=0
EARLY_REVEALS=0
while IFS= read -r ID; do
  [ -n "$ID" ] || continue
  GAMES=$((GAMES + 1))
  http GET "/api/games/$ID"
  [ "$HTTP_STATUS" = 401 ] || OPEN_READS=$((OPEN_READS + 1))
  chain_game "$ID" || continue
  if [ "$G_STATUS" = "$STATUS_ACTIVE" ]; then
    http GET "/api/games/$ID/reveal"
    [ "$HTTP_STATUS" = 409 ] || EARLY_REVEALS=$((EARLY_REVEALS + 1))
  fi
done < <(event_logs 'GameCreated(bytes32 indexed,address indexed,uint8,uint256,uint256,bytes32,bytes32,uint64)' | jq -r '.[].topics[1]')
evidence gamesCreatedByTheAgent "$GAMES"
check http "no game can be read without its session token ($GAMES game(s))" 0 "$OPEN_READS"
check http "no seed of a game in progress is revealed" 0 "$EARLY_REVEALS"

scenario_end
