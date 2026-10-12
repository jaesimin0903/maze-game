#!/usr/bin/env bash
# Shared library of the aside scenarios (plan §9.1). Sourced by 00-capability-probe.sh and by
# every NN-*.sh scenario; it does nothing when sourced except define variables and functions.
#
# What a scenario gets from here:
#   - its own stack: a fresh Anvil (8550 + i), a fresh data directory, a fresh deployment and the
#     app on 3050 + i, started through scripts/dev-up.sh --allow-test-hooks with the hook flags
#     on the command line and a seed-hook secret that is random per run;
#   - one `aside repl` session that stays open for the whole scenario (tabs opened by a session
#     are closed by Aside when the session ends, so a scenario cannot be split over invocations);
#   - DOM reads through the path the capability probe found (A: the REPL reads the page;
#     B: the page's TestBeacon and GET /api/test/ui-snapshot);
#   - hard assertions on chain state (cast) and HTTP responses (curl);
#   - a PASS / FAIL / BLOCKED verdict, a result file and a PID-scoped teardown.
#
# Written for bash 3.2 (the bash of macOS): no associative arrays, no coproc, no mapfile.
#
# This suite drives the user's real Aside browser. It opens its own tabs on 127.0.0.1 only,
# closes them, and touches only localStorage keys that start with "maze:" on those origins.

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$E2E_DIR/../.." && pwd)"
# shellcheck source=scripts/ports.sh
. "$ROOT_DIR/scripts/ports.sh"

# Results that are kept: capabilities.json, results.json, report.md, scenarios/<NN>.json.
OUT_DIR="${MAZE_E2E_OUT_DIR:-$E2E_DIR/out}"
CAP_FILE="$OUT_DIR/capabilities.json"
# Working files of a run (logs, event logs of the servers): under the git-ignored .data/.
WORK_ROOT="${MAZE_E2E_WORK_DIR:-$ROOT_DIR/.data/e2e-aside}"
RUN_ID="${MAZE_E2E_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
# fixture: the test table. production: packages/shared/src/tuning.json with only the seed hook.
TABLE_MODE="${MAZE_E2E_TABLE:-fixture}"
# The secret of the test seed hook: the server derives every server seed from it, and
# plan-moves.ts rebuilds the maze with it. It is random and new for every run, so no value in
# the repository opens a stack. scripts/e2e-aside.sh draws one per run and hands it to every
# scenario; a scenario started on its own draws its own. Set MAZE_TEST_SEED_SECRET to repeat a
# run with the secret it logged (the scenario's run.log, under the git-ignored .data/).
# Both users read this one variable: stack_env (the server) and plan (the route planner).
SEED_SECRET="${MAZE_TEST_SEED_SECRET:-$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')}"
[ "${#SEED_SECRET}" -ge 16 ] || { echo "lib.sh: could not draw a seed secret (set MAZE_TEST_SEED_SECRET)" >&2; exit 2; }
FIXTURE_FILE="$ROOT_DIR/packages/shared/test/fixtures/tuning.fixture.json"
PRELUDE_FILE="$E2E_DIR/lib/prelude.js"
TSX="$ROOT_DIR/node_modules/.bin/tsx"

# Anvil's well-known accounts (plan §7.9): #1 signs and relays, #2 is the dev wallet's default
# player, #9 is the third party scripts/reclaim.sh sends from.
RELAYER_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
PLAYER_ADDR=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
THIRD_PARTY_ADDR=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720

# Contract status numbers (packages/shared/src/abi.ts ONCHAIN_STATUS).
STATUS_NONE=0
STATUS_ACTIVE=1
STATUS_SETTLED=2
STATUS_RECLAIMED=3

# The bet of every game, in ETH, from the table's minimum to its maximum in steps of 0.001.
BET_ETH="${MAZE_E2E_BET_ETH:-0.01}"

ASIDE_BIN="${ASIDE_BIN:-$(command -v aside 2>/dev/null || true)}"
if [ -z "$ASIDE_BIN" ] && [ -x "$HOME/.local/bin/aside" ]; then ASIDE_BIN="$HOME/.local/bin/aside"; fi

# State of the aside session and of the app, before anything was started.
ASIDE_WORK_DIR=""
ASIDE_PID=""
ASIDE_ALIVE=0
ASIDE_FIFO=""
# File of the target ids of the tabs the suite opened and has not closed yet (one per line).
ASIDE_TARGETS_FILE=""
APP_DOWN=0

# ----- small tools -----

# with_timeout <seconds> <command...>: macOS has no timeout(1).
with_timeout() {
  perl -e 'alarm shift; exec @ARGV' "$@"
}

# Removes colour codes and any e-mail address (the REPL banner prints the account's).
redact() {
  perl -pe 'BEGIN { $| = 1 } s/\e\[[0-9;]*[A-Za-z]//g; s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<account>/g'
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# A JSON string literal of the argument, safe to paste into a line of JavaScript.
js_str() { jq -n --arg v "$1" '$v'; }

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# floor(wei * bps / 10000), exact for any size.
mul_bps() { BC_LINE_LENGTH=0 bc <<<"$1 * $2 / 10000"; }
big_add() { BC_LINE_LENGTH=0 bc <<<"$1 + $2"; }
big_sub() { BC_LINE_LENGTH=0 bc <<<"$1 - $2"; }
big_mul() { BC_LINE_LENGTH=0 bc <<<"$1 * $2"; }

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

log() { printf '[%s %s] %s\n' "${SC_NUM:---}" "$(date +%H:%M:%S)" "$*"; }

# The fixed client seed of a scenario's n-th game: 32 bytes derived from the scenario number.
# No scenario uses a random seed (the server seed comes from the game id through the seed hook).
client_seed() {
  printf '0x%s' "$(printf 'maze-e2e-aside:%s:%s' "$SC_NUM" "${1:-1}" | shasum -a 256 | cut -c1-64)"
}

# ----- capabilities -----

# cap <name>: true when the probe verified the capability by a real action.
cap() {
  [ -f "$CAP_FILE" ] && [ "$(jq -r --arg n "$1" '.capabilities[$n].ok // false' "$CAP_FILE")" = "true" ]
}

# Sets INPUT_PATH and READ_PATH from the capability file (plan §9.1).
choose_paths() {
  INPUT_PATH=none
  READ_PATH=none
  if cap session && cap openTab && cap click && cap fill && cap evalInPage; then INPUT_PATH=repl; fi
  if cap readDom; then READ_PATH=repl; else READ_PATH=beacon; fi
  # MAZE_E2E_READ_PATH=beacon forces path B, to exercise it where path A also works.
  case "${MAZE_E2E_READ_PATH:-}" in
    repl | beacon) READ_PATH="$MAZE_E2E_READ_PATH" ;;
    "") ;;
    *) echo "lib.sh: MAZE_E2E_READ_PATH must be repl or beacon" >&2; exit 2 ;;
  esac
}

# ----- assertions -----
#
# Every assertion is one line of $SC_DIR/assertions.tsv: kind, status, label, expected, actual.
# kind is chain | http | dom. status is PASS | FAIL | BLOCKED (a DOM assertion that could not run).

record() {
  local kind="$1" status="$2" label="$3" expected="$4" actual="$5"
  printf '%s\t%s\t%s\t%s\t%s\n' "$kind" "$status" "$label" \
    "$(printf '%s' "$expected" | tr '\t\n' '  ')" "$(printf '%s' "$actual" | tr '\t\n' '  ')" >>"$SC_DIR/assertions.tsv"
  if [ "$status" = PASS ]; then
    log "  ok    [$kind] $label"
  else
    log "  $status [$kind] $label: expected \"$expected\", got \"$actual\""
  fi
}

# check <kind> <label> <expected> <actual>
check() {
  if [ "$3" = "$4" ]; then record "$1" PASS "$2" "$3" "$4"; else record "$1" FAIL "$2" "$3" "$4"; fi
}

# check_hex: equality of hex strings whatever their case (addresses, hashes).
check_hex() {
  if [ "$(lower "$3")" = "$(lower "$4")" ]; then record "$1" PASS "$2" "$3" "$4"; else record "$1" FAIL "$2" "$3" "$4"; fi
}

# check_le <kind> <label> <max> <actual>: actual is an integer not above max.
check_le() {
  if [[ "$4" =~ ^-?[0-9]+$ ]] && [ "$4" -le "$3" ]; then
    record "$1" PASS "$2" "<= $3" "$4"
  else
    record "$1" FAIL "$2" "<= $3" "$4"
  fi
}

# check_ok <kind> <label> <what was expected, in words> <actual> <0 when it held>
check_ok() {
  if [ "$5" -eq 0 ]; then record "$1" PASS "$2" "$3" "$4"; else record "$1" FAIL "$2" "$3" "$4"; fi
}

# A DOM assertion that could not be executed. The scenario cannot be PASS any more.
dom_blocked() {
  record dom BLOCKED "$1" "executed" "${2:-no DOM read path}"
}

# ----- scenario life cycle -----

# scenario_begin <number> <name> <what it proves>
scenario_begin() {
  SC_NUM="$1"
  SC_NAME="$2"
  SC_PROVES="$3"
  # A new directory per run, so a fresh Anvil never meets an old event log and nothing is deleted.
  SC_DIR="$WORK_ROOT/$RUN_ID/$SC_NUM"
  RESULT_FILE="$OUT_DIR/scenarios/$SC_NUM.json"
  SC_STARTED="$(now_utc)"
  SC_START_EPOCH="$(date +%s)"
  SC_FATAL=""
  SC_BLOCKED=""
  SC_NOT_RUN=""
  SC_DONE=0
  # Set to 1 only by scenario 09, for which the plan defines no DOM assertion.
  SC_NO_DOM=0
  SC_EVIDENCE="{}"
  STACK_UP=0
  ASIDE_PID=""
  ASIDE_ALIVE=0
  APP_DOWN=0
  ANVIL_PORT="$(maze_e2e_anvil_port "$SC_NUM")"
  NEXT_PORT="$(maze_e2e_next_port "$SC_NUM")"
  RPC="http://127.0.0.1:$ANVIL_PORT"
  APP_URL="http://127.0.0.1:$NEXT_PORT"
  STATE_DIR="$ROOT_DIR/.data/dev-up-$NEXT_PORT"
  # One build serves every scenario by default: the app reads its chain settings from
  # /api/config at run time (plan §9.1), and scenarios run one at a time.
  DIST_DIR="${MAZE_E2E_DIST_DIR:-$(maze_e2e_dist_dir "$SC_NUM")}"
  DATA_DIR="$SC_DIR/data"

  mkdir -p "$SC_DIR" "$OUT_DIR/scenarios"
  : >"$SC_DIR/assertions.tsv"
  rm -f "$RESULT_FILE"
  ASIDE_WORK_DIR="$SC_DIR"
  # At a fixed place, so that the next run of this scenario finds what a stopped run left open.
  ASIDE_TARGETS_FILE="$WORK_ROOT/open-tabs-$SC_NUM.txt"
  for tool in jq curl cast bc perl node shasum; do
    command -v "$tool" >/dev/null 2>&1 || { echo "lib.sh: $tool is not installed" >&2; exit 2; }
  done
  choose_paths
  # A run of this scenario that was stopped hard may have left its tab open.
  aside_close_leftovers
  trap scenario_finish EXIT
  trap 'SC_FATAL="${SC_FATAL:-interrupted}"; exit 130' INT TERM
  log "scenario $SC_NUM $SC_NAME: $SC_PROVES"
  log "table mode $TABLE_MODE, input path $INPUT_PATH, DOM read path $READ_PATH, anvil $ANVIL_PORT, app $NEXT_PORT"
  log "seed secret of this run (MAZE_TEST_SEED_SECRET repeats it): $SEED_SECRET"
}

# evidence <key> <value>: something worth keeping in the result (game id, transaction hash).
evidence() {
  SC_EVIDENCE="$(printf '%s' "$SC_EVIDENCE" | jq -c --arg k "$1" --arg v "$2" '. + {($k): $v}')"
}

# fail_scenario <reason>: an essential step did not work; nothing after it can be trusted.
fail_scenario() {
  SC_FATAL="$1"
  log "FATAL: $1"
  exit 1
}

# blocked_scenario <reason>: the scenario cannot be driven at all (no input path).
blocked_scenario() {
  SC_BLOCKED="$1"
  log "BLOCKED: $1"
  exit 3
}

# not_run_scenario <reason>: only for the advisory scenario 09, which runs on request. It is
# reported as NOT-RUN (exit code 4), never as PASS, and the runner does not count it.
not_run_scenario() {
  SC_NOT_RUN="$1"
  log "NOT-RUN: $1"
  exit 4
}

# The capabilities a UI-driven scenario cannot do without.
require_input_path() {
  [ -f "$CAP_FILE" ] || blocked_scenario "no capability file; run e2e/aside/00-capability-probe.sh"
  if [ "$INPUT_PATH" != repl ]; then
    local missing="" name
    for name in session openTab click fill evalInPage; do cap "$name" || missing="$missing $name"; done
    blocked_scenario "aside repl cannot drive the page (missing:$missing); the aside exec path is not automated"
  fi
}

# Marks the end of the scenario body. A script that stops before this line is a FAIL.
scenario_end() {
  SC_DONE=1
  exit 0
}

count_rows() {
  awk -F'\t' -v kind="$1" -v status="$2" '$1 == kind && $2 == status { n += 1 } END { print n + 0 }' "$SC_DIR/assertions.tsv"
}

# EXIT trap: tear everything down, decide the verdict, write the result, set the exit code.
scenario_finish() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  aside_stop
  [ "$STACK_UP" -eq 1 ] && stack_down

  local failed blocked_dom dom_ok chain_ok http_ok result reason
  failed="$(awk -F'\t' '$2 == "FAIL" { n += 1 } END { print n + 0 }' "$SC_DIR/assertions.tsv")"
  blocked_dom="$(count_rows dom BLOCKED)"
  dom_ok="$(count_rows dom PASS)"
  chain_ok="$(count_rows chain PASS)"
  http_ok="$(count_rows http PASS)"

  if [ -n "$SC_NOT_RUN" ]; then
    result=NOT-RUN
    reason="$SC_NOT_RUN"
  elif [ -n "$SC_BLOCKED" ]; then
    result=BLOCKED
    reason="input: $SC_BLOCKED"
  elif [ -n "$SC_FATAL" ]; then
    result=FAIL
    reason="$SC_FATAL"
  elif [ "$failed" -gt 0 ]; then
    result=FAIL
    reason="$failed assertion(s) failed: $(awk -F'\t' '$2 == "FAIL" { print "[" $1 "] " $3 }' "$SC_DIR/assertions.tsv" | head -n 3 | paste -sd ';' -)"
  elif [ "$SC_DONE" -ne 1 ]; then
    result=FAIL
    reason="the script stopped before its last step (exit code $code)"
  elif [ "$chain_ok" -eq 0 ] || [ "$http_ok" -eq 0 ]; then
    result=FAIL
    reason="no on-chain or no HTTP assertion was executed (chain $chain_ok, http $http_ok)"
  elif [ "${SC_NO_DOM:-0}" -ne 1 ] && { [ "$blocked_dom" -gt 0 ] || [ "$dom_ok" -eq 0 ]; }; then
    result=BLOCKED
    reason="UI: $blocked_dom DOM assertion(s) could not be executed over read path $READ_PATH; chain $chain_ok and http $http_ok assertions passed"
  else
    result=PASS
    reason="chain $chain_ok, http $http_ok, dom $dom_ok assertions passed"
  fi

  jq -n \
    --arg scenario "$SC_NUM" --arg name "$SC_NAME" --arg proves "$SC_PROVES" --arg run "$RUN_ID" \
    --arg result "$result" --arg reason "$reason" \
    --arg table "$TABLE_MODE" --arg input "$INPUT_PATH" --arg read "$READ_PATH" --arg logs "${SC_DIR#"$ROOT_DIR"/}" \
    --arg started "$SC_STARTED" --arg finished "$(now_utc)" \
    --argjson seconds "$(($(date +%s) - SC_START_EPOCH))" \
    --argjson evidence "$SC_EVIDENCE" \
    --rawfile rows "$SC_DIR/assertions.tsv" \
    '{
      scenario: $scenario, name: $name, proves: $proves, runId: $run, result: $result, reason: $reason,
      tableMode: $table, inputPath: $input, readPath: $read, logs: $logs,
      startedAt: $started, finishedAt: $finished, seconds: $seconds,
      evidence: $evidence,
      assertions: ($rows | split("\n") | map(select(length > 0) | split("\t")
        | { kind: .[0], status: .[1], label: .[2], expected: .[3], actual: .[4] }))
    } | .counts = (reduce .assertions[] as $a ({}; .[$a.kind + "." + $a.status] += 1))' \
    >"$RESULT_FILE"

  echo "RESULT $SC_NUM $SC_NAME: $result ($reason)"
  case "$result" in
    PASS) exit 0 ;;
    BLOCKED) exit 3 ;;
    NOT-RUN) exit 4 ;;
    *) exit 1 ;;
  esac
}

# ----- the stack -----

# Environment of scripts/dev-up.sh for this scenario, one VAR=value per line. Hook flags travel
# on the command line only; nothing here is written to an .env file.
stack_env() {
  echo "MAZE_ANVIL_PORT=$ANVIL_PORT"
  echo "MAZE_NEXT_PORT=$NEXT_PORT"
  echo "NEXT_DIST_DIR=$DIST_DIR"
  echo "MAZE_DATA_DIR=$DATA_DIR"
  echo "MAZE_ALLOW_TEST_HOOKS=1"
  echo "MAZE_TEST_SEED_SECRET=$SEED_SECRET"
  if [ "$TABLE_MODE" = fixture ]; then echo "MAZE_TUNING_FIXTURE=$FIXTURE_FILE"; fi
  if [ -f "$ROOT_DIR/apps/web/$DIST_DIR/BUILD_ID" ] && [ "${MAZE_E2E_REBUILD:-0}" != 1 ]; then
    echo "MAZE_SKIP_BUILD=1"
  fi
}

# dev_up [VAR=value ...]: the one place that builds the command starting a scenario's stack.
# scripts/dev-up.sh starts with test hooks only when asked to with --allow-test-hooks; without
# the switch it refuses to start while a hook flag is set. The flags come from stack_env alone:
# env -u keeps a hook flag of the caller's shell from leaking in.
dev_up() {
  (cd "$ROOT_DIR" && env -u MAZE_ALLOW_TEST_HOOKS -u MAZE_TEST_SEED_SECRET -u MAZE_TUNING_FIXTURE -u MAZE_SKIP_BUILD \
    "${STACK_ENV[@]}" "$@" bash scripts/dev-up.sh --allow-test-hooks)
}

# stack_up [VAR=value ...]: starts Anvil, deploys, starts the app. Extra variables are passed on
# to dev-up.sh (MAZE_IDLE_TIMEOUT_SEC=6, NEXT_PUBLIC_ENABLE_DEV_WALLET=0, ...).
stack_up() {
  local line
  case "$TABLE_MODE" in
    fixture | production) ;;
    *) fail_scenario "MAZE_E2E_TABLE must be fixture or production, got \"$TABLE_MODE\"" ;;
  esac
  port_in_use "$ANVIL_PORT" && fail_scenario "port $ANVIL_PORT is in use; another stack of this scenario may be running"
  port_in_use "$NEXT_PORT" && fail_scenario "port $NEXT_PORT is in use; another stack of this scenario may be running"
  mkdir -p "$DATA_DIR"

  STACK_ENV=()
  while IFS= read -r line; do STACK_ENV+=("$line"); done < <(stack_env)
  STACK_EXTRA=("$@")
  STACK_UP=1
  log "starting the stack ($TABLE_MODE table)"
  if ! dev_up "$@" >"$SC_DIR/dev-up.log" 2>&1; then
    STACK_UP=0
    tail -n 15 "$SC_DIR/dev-up.log" | redact
    fail_scenario "the stack did not start (see $SC_DIR/dev-up.log)"
  fi

  DEPLOYMENT_FILE="$ROOT_DIR/$(maze_deployment_file "$ANVIL_PORT")"
  CONTRACT="$(jq -r '.mazeBetAddress' "$DEPLOYMENT_FILE")"
  http GET /api/config
  [ "$HTTP_STATUS" = 200 ] || fail_scenario "GET /api/config answered $HTTP_STATUS after the stack came up"
  CONFIG_JSON="$HTTP_BODY"
  printf '%s\n' "$CONFIG_JSON" >"$SC_DIR/config.json"
  log "stack up: contract $CONTRACT, chain $RPC, app $APP_URL"
}

# dev-up.sh runs the app under a supervisor that starts it again about a second after it exits
# (supervisor.pid: the supervising shell; next.pid: the current app, rewritten on every
# restart). Before the app is killed for good the supervisor has to go, or the app is back.
# The recorded PID is stopped only when it is this stack's supervisor: an ancestor of the
# recorded app process, or a process whose command line is `dev-up.sh --supervise` for this
# state directory (the same test scripts/dev-down.sh applies). A stack without a supervisor
# (app_start_again, dev-up.sh --no-supervisor) has nothing to stop here.
supervisor_stop() {
  local supervisor app parent _
  supervisor="$(tr -cd '0-9' <"$STATE_DIR/supervisor.pid" 2>/dev/null)"
  [ -n "$supervisor" ] && kill -0 "$supervisor" 2>/dev/null || return 0
  app="$(tr -cd '0-9' <"$STATE_DIR/next.pid" 2>/dev/null)"
  parent="$app"
  for _ in 1 2 3 4 5; do
    [ -n "$parent" ] && [ "$parent" -gt 1 ] || break
    parent="$(ps -o ppid= -p "$parent" 2>/dev/null | tr -cd '0-9')"
    [ "$parent" = "$supervisor" ] && break
  done
  if [ "$parent" != "$supervisor" ] &&
    ! ps -o command= -p "$supervisor" 2>/dev/null | grep -Eq "dev-up\.sh --supervise .*/dev-up-$NEXT_PORT -- "; then
    log "PID $supervisor in supervisor.pid is not this stack's supervisor; it was left alone"
    return 0
  fi
  kill -KILL "$supervisor" 2>/dev/null
  for _ in $(seq 1 50); do
    kill -0 "$supervisor" 2>/dev/null || break
    sleep 0.1
  done
  log "supervisor stopped (PID $supervisor)"
}

stack_down() {
  local pid
  # `next start` can take more than ten seconds to leave on SIGTERM while a browser still holds
  # connections to it; dev-down.sh then falls back to SIGKILL. This stack is disposable, so the
  # app is stopped at once here (same PID check as app_stop) and dev-down.sh does the rest.
  # The supervisor goes first, so that it does not start a new app in between.
  supervisor_stop
  pid="$(tr -cd '0-9' <"$STATE_DIR/next.pid" 2>/dev/null)"
  if [ -n "$pid" ] && lsof -nP -a -p "$pid" -iTCP:"$NEXT_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    kill -KILL "$pid" 2>/dev/null
  fi
  (cd "$ROOT_DIR" && MAZE_ANVIL_PORT="$ANVIL_PORT" MAZE_NEXT_PORT="$NEXT_PORT" bash scripts/dev-down.sh) \
    >>"$SC_DIR/dev-down.log" 2>&1 || log "dev-down reported a process that did not stop (see $SC_DIR/dev-down.log)"
  STACK_UP=0
}

# Stops the app for good, by the PID dev-up recorded, after checking that this PID is the
# process listening on this scenario's port. The supervisor is stopped first: these scenarios
# are a server that is gone and stays gone, not a crash the supervisor recovers from. The chain
# keeps running (scenarios 05 and 10).
app_stop() {
  local file="$STATE_DIR/next.pid" pid
  pid="$(tr -cd '0-9' <"$file" 2>/dev/null)"
  [ -n "$pid" ] || fail_scenario "no recorded PID of the app in $file"
  if ! lsof -nP -a -p "$pid" -iTCP:"$NEXT_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    fail_scenario "PID $pid is not the process listening on port $NEXT_PORT; nothing was stopped"
  fi
  supervisor_stop
  # SIGKILL: the scenario is a server that is gone, not one that shuts down politely while it
  # still answers the page's open connections.
  kill -KILL "$pid" 2>/dev/null
  local _
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -0 "$pid" 2>/dev/null && fail_scenario "the app (PID $pid) did not stop"
  # A supervisor that is still alive brings the app back after about a second.
  sleep 2
  port_in_use "$NEXT_PORT" && fail_scenario "the app is listening on port $NEXT_PORT again: a supervisor restarted it"
  APP_DOWN=1
  log "app stopped (PID $pid) and not restarted; the chain keeps running"
}

# Starts the app again on the same chain, deployment and data directory, the way dev-up.sh
# starts it, and records its PID where dev-down.sh looks for it.
app_start_again() {
  local signer=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d pid _ line
  local hooks=()
  for line in "${STACK_ENV[@]}" ${STACK_EXTRA[@]+"${STACK_EXTRA[@]}"}; do
    case "$line" in
      MAZE_ALLOW_TEST_HOOKS=* | MAZE_TEST_SEED_SECRET=* | MAZE_TUNING_FIXTURE=* | MAZE_IDLE_TIMEOUT_SEC=* | MAZE_MAX_GAME_SEC=* | NEXT_PUBLIC_ENABLE_DEV_WALLET=*) hooks+=("$line") ;;
    esac
  done
  (
    cd "$ROOT_DIR/apps/web" || exit 1
    env -u MAZE_TUNING_FIXTURE \
      RPC_URL="$(jq -r '.rpcUrl' "$DEPLOYMENT_FILE")" \
      CHAIN_ID="$(jq -r '.chainId' "$DEPLOYMENT_FILE")" \
      MAZEBET_ADDRESS="$CONTRACT" \
      SERVER_SIGNER_PRIVATE_KEY="$signer" \
      RELAYER_PRIVATE_KEY="$signer" \
      MAZE_DATA_DIR="$DATA_DIR" \
      NEXT_PUBLIC_ENABLE_DEV_WALLET=1 \
      NEXT_DIST_DIR="$DIST_DIR" \
      "${hooks[@]}" \
      nohup node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port "$NEXT_PORT" \
      >>"$STATE_DIR/next.log" 2>&1 </dev/null 9>&- &
    echo $! >"$STATE_DIR/next.pid"
  )
  pid="$(tr -cd '0-9' <"$STATE_DIR/next.pid")"
  for _ in $(seq 1 120); do
    kill -0 "$pid" 2>/dev/null || fail_scenario "the app exited while starting again (see $STATE_DIR/next.log)"
    if curl -sf -m 5 "$APP_URL/api/config" >/dev/null 2>&1; then
      APP_DOWN=0
      log "app started again (PID $pid) on the same chain and data directory"
      return 0
    fi
    sleep 0.5
  done
  fail_scenario "the app did not answer within 60 seconds after starting again"
}

# ----- HTTP -----

# http <METHOD> <path> [bearer token] [json body]: sets HTTP_STATUS ("000" when the server
# cannot be reached) and HTTP_BODY.
http() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}" file="$SC_DIR/http-body.tmp"
  local args=(-s -m 10 -o "$file" -w '%{http_code}' -X "$method" -H 'accept: application/json')
  [ -n "$token" ] && args+=(-H "authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' --data "$body")
  : >"$file"
  HTTP_STATUS="$(curl "${args[@]}" "$APP_URL$path" 2>/dev/null)"
  [ -n "$HTTP_STATUS" ] || HTTP_STATUS=000
  HTTP_BODY="$(cat "$file")"
}

# A field of the last JSON body; empty when the body is not JSON or the field is absent.
http_field() { printf '%s' "$HTTP_BODY" | jq -r "$1 | if . == null then empty else . end" 2>/dev/null; }

# ----- chain (cast) -----

# cast prints large numbers as "20000 [2e4]"; the first word is the value.
chain_call() { cast call "$CONTRACT" "$@" --rpc-url "$RPC" 2>/dev/null | awk '{ print $1 }'; }

chain_now() { cast block latest --field timestamp --rpc-url "$RPC" 2>/dev/null | awk '{ print $1 }'; }

balance_of() { cast balance "$1" --rpc-url "$RPC" 2>/dev/null | awk '{ print $1 }'; }

# chain_game <gameId>: sets G_PLAYER G_TIER G_STATUS G_CREATED_AT G_SETTLE_DEADLINE G_BET
# G_MAX_PAYOUT G_RESERVED G_COMMITMENT G_CLIENT_SEED from getGame.
chain_game() {
  local fields
  fields="$(chain_call 'getGame(bytes32)(address,uint8,uint8,uint64,uint64,uint128,uint128,uint128,bytes32,bytes32)' "$1" | paste -sd ' ' -)"
  # shellcheck disable=SC2086
  set -- $fields
  [ $# -eq 10 ] || return 1
  G_PLAYER="$1" G_TIER="$2" G_STATUS="$3" G_CREATED_AT="$4" G_SETTLE_DEADLINE="$5"
  G_BET="$6" G_MAX_PAYOUT="$7" G_RESERVED="$8" G_COMMITMENT="$9" G_CLIENT_SEED="${10}"
}

# wait_status <gameId> <status> <seconds>: waits until getGame reports the status.
wait_status() {
  local _
  for _ in $(seq 1 $(($3 * 5))); do
    chain_game "$1" && [ "$G_STATUS" = "$2" ] && return 0
    sleep 0.2
  done
  return 1
}

# The n-th 32-byte word (0-based) of ABI-encoded data, as 0x-prefixed hex.
data_word() { printf '0x%s' "$(printf '%s' "${1#0x}" | cut -c$(($2 * 64 + 1))-$((($2 + 1) * 64)))"; }

# settlement <gameId>: reads the GameSettled logs of the game. Sets S_COUNT and, from the first
# log, S_TX S_OUTCOME S_STEPS S_PAYOUT S_SERVER_SEED S_FROM S_BLOCK_TIME.
settlement() {
  local logs data block
  logs="$(cast logs --from-block 0 --to-block latest --address "$CONTRACT" --rpc-url "$RPC" --json \
    'GameSettled(bytes32 indexed,address indexed,uint8,uint16,uint256,bytes32)' "$1" 2>/dev/null)"
  S_COUNT="$(printf '%s' "$logs" | jq 'length' 2>/dev/null)"
  [ -n "$S_COUNT" ] || S_COUNT=0
  S_TX="" S_OUTCOME="" S_STEPS="" S_PAYOUT="" S_SERVER_SEED="" S_FROM="" S_BLOCK_TIME=""
  [ "$S_COUNT" -gt 0 ] || return 1
  S_TX="$(printf '%s' "$logs" | jq -r '.[0].transactionHash')"
  data="$(printf '%s' "$logs" | jq -r '.[0].data')"
  block="$(printf '%s' "$logs" | jq -r '.[0].blockNumber')"
  S_OUTCOME="$(cast to-dec "$(data_word "$data" 0)")"
  S_STEPS="$(cast to-dec "$(data_word "$data" 1)")"
  S_PAYOUT="$(cast to-dec "$(data_word "$data" 2)")"
  S_SERVER_SEED="$(data_word "$data" 3)"
  S_FROM="$(cast tx "$S_TX" from --rpc-url "$RPC" 2>/dev/null)"
  S_BLOCK_TIME="$(cast block "$block" --field timestamp --rpc-url "$RPC" 2>/dev/null | awk '{ print $1 }')"
}

# reclaim_log <gameId>: reads the GameReclaimed logs. Sets R_COUNT R_TX R_AMOUNT R_FROM R_PLAYER.
reclaim_log() {
  local logs
  logs="$(cast logs --from-block 0 --to-block latest --address "$CONTRACT" --rpc-url "$RPC" --json \
    'GameReclaimed(bytes32 indexed,address indexed,uint256)' "$1" 2>/dev/null)"
  R_COUNT="$(printf '%s' "$logs" | jq 'length' 2>/dev/null)"
  [ -n "$R_COUNT" ] || R_COUNT=0
  R_TX="" R_AMOUNT="" R_FROM="" R_PLAYER=""
  [ "$R_COUNT" -gt 0 ] || return 1
  R_TX="$(printf '%s' "$logs" | jq -r '.[0].transactionHash')"
  R_AMOUNT="$(cast to-dec "$(printf '%s' "$logs" | jq -r '.[0].data')")"
  R_PLAYER="0x$(printf '%s' "$logs" | jq -r '.[0].topics[2]' | cut -c27-66)"
  R_FROM="$(cast tx "$R_TX" from --rpc-url "$RPC" 2>/dev/null)"
}

# event_logs <event signature>: every log of that event from this scenario's contract, as JSON.
event_logs() {
  cast logs --from-block 0 --to-block latest --address "$CONTRACT" --rpc-url "$RPC" --json "$1" 2>/dev/null
}

# sum_words <logs json> <word index>: the sum of one 32-byte data word over the logs.
sum_words() {
  local total=0 data
  while IFS= read -r data; do
    [ -n "$data" ] || continue
    total="$(big_add "$total" "$(cast to-dec "$(data_word "$data" "$2")")")"
  done < <(printf '%s' "$1" | jq -r '.[].data')
  echo "$total"
}

# expect_accounting: the contract holds exactly what its events say it should (plan §9.1,
# scenario 09's invariants; checked by every scenario that moves money):
#   balance       = funded + every bet - every payout - every reclaim + totalPending
#   totalReserved = the sum of getGame(id).reserved over the games that are still active
#   balance       >= totalReserved + totalPending (the contract's own stated invariant)
#   no settlement paid more than its game's maximum payout
expect_accounting() {
  local created settled reclaimed funded bets payouts reclaims pending expected reserved=0 id over=0 max payout
  created="$(event_logs 'GameCreated(bytes32 indexed,address indexed,uint8,uint256,uint256,bytes32,bytes32,uint64)')"
  settled="$(event_logs 'GameSettled(bytes32 indexed,address indexed,uint8,uint16,uint256,bytes32)')"
  reclaimed="$(event_logs 'GameReclaimed(bytes32 indexed,address indexed,uint256)')"
  funded="$(jq -r '.fundedWei' "$DEPLOYMENT_FILE")"
  bets="$(sum_words "$created" 1)"
  payouts="$(sum_words "$settled" 2)"
  reclaims="$(sum_words "$reclaimed" 0)"
  pending="$(chain_call 'totalPending()(uint256)')"
  expected="$(big_add "$(big_sub "$(big_sub "$(big_add "$funded" "$bets")" "$payouts")" "$reclaims")" "$pending")"
  check chain "accounting: contract balance = funded + bets - payouts - reclaims + pending ($(printf '%s' "$created" | jq 'length') game(s))" \
    "$expected" "$(balance_of "$CONTRACT")"
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    chain_game "$id" || continue
    # getGame(id).reserved is fixed at creation; totalReserved counts it while the game is active.
    if [ "$G_STATUS" = "$STATUS_ACTIVE" ]; then reserved="$(big_add "$reserved" "$G_RESERVED")"; fi
    max="$G_MAX_PAYOUT"
    payout="$(printf '%s' "$settled" | jq -r --arg id "$id" '[.[] | select(.topics[1] == $id) | .data][0] // empty')"
    if [ -n "$payout" ] && [ "$(BC_LINE_LENGTH=0 bc <<<"$(cast to-dec "$(data_word "$payout" 2)") > $max")" = 1 ]; then over=$((over + 1)); fi
  done < <(printf '%s' "$created" | jq -r '.[].topics[1]')
  check chain "accounting: totalReserved is the sum of the active games' reserves" "$reserved" "$(chain_call 'totalReserved()(uint256)')"
  check_ok chain "accounting: the balance covers totalReserved + totalPending" ">= $(big_add "$reserved" "$pending")" "$(balance_of "$CONTRACT")" \
    "$([ "$(BC_LINE_LENGTH=0 bc <<<"$(balance_of "$CONTRACT") >= $reserved + $pending")" = 1 ]; echo $?)"
  check chain "accounting: no settlement paid more than its game's maximum payout" 0 "$over"
}

# reclaim_refusal <gameId> <caller>: what the contract would answer to reclaim(gameId) right now,
# without sending anything: accepted, DeadlineNotReached, GameNotActive, or the raw error.
reclaim_refusal() {
  local out not_reached not_active
  if out="$(cast call "$CONTRACT" 'reclaim(bytes32)' "$1" --from "$2" --rpc-url "$RPC" 2>&1)"; then
    echo accepted
    return 0
  fi
  not_reached="$(cast sig 'DeadlineNotReached()')"
  not_active="$(cast sig 'GameNotActive()')"
  if printf '%s' "$out" | grep -qiE "DeadlineNotReached|${not_reached#0x}"; then echo DeadlineNotReached
  elif printf '%s' "$out" | grep -qiE "GameNotActive|${not_active#0x}"; then echo GameNotActive
  else printf 'other: %s\n' "$(printf '%s' "$out" | head -n 1)"; fi
}

# The fee a transaction cost its sender, in wei.
tx_fee() {
  local used price
  used="$(cast receipt "$1" gasUsed --rpc-url "$RPC" 2>/dev/null | awk '{ print $1 }')"
  price="$(cast receipt "$1" effectiveGasPrice --rpc-url "$RPC" 2>/dev/null | awk '{ print $1 }')"
  big_mul "$used" "$price"
}

# Moves the chain clock past a chain second: the next block's timestamp is above <second>.
warp_past() {
  local now delta
  now="$(chain_now)"
  delta=$(($1 - now + 2))
  [ "$delta" -gt 0 ] || delta=1
  cast rpc evm_increaseTime "$delta" --rpc-url "$RPC" >/dev/null 2>&1 || return 1
  cast rpc evm_mine --rpc-url "$RPC" >/dev/null 2>&1 || return 1
  log "chain clock moved forward by $delta seconds (now $(chain_now), target above $1)"
}

# ----- the table, as the server reports it -----

# How many sizes the table offers. The scenarios take sizes, multipliers and refunds from
# /api/config, never from a list of their own, so they follow whichever table is deployed.
tier_count() { printf '%s' "$CONFIG_JSON" | jq -r '.tiers | length'; }
tier_n() { printf '%s' "$CONFIG_JSON" | jq -r --argjson t "$1" '.tiers[$t].n'; }
tier_multiplier_bps() { printf '%s' "$CONFIG_JSON" | jq -r --argjson t "$1" '.tiers[$t].multiplierBps'; }
tier_refund_bps() { printf '%s' "$CONFIG_JSON" | jq -r --argjson t "$1" --argjson k "$2" '.tiers[$t].refundBps[$k]'; }
# What the table refunds after k moves, and what the exit pays, for a bet in wei.
refund_wei() { mul_bps "$1" "$(tier_refund_bps "$2" "$3")"; }
exit_wei() { mul_bps "$1" "$(tier_multiplier_bps "$2")"; }

# ----- the aside session -----
#
# One `aside repl` process reads statements from a FIFO for the whole scenario. Each statement
# is one line; the REPL answers it with its output and a status line "[ok | 12ms]" or
# "[error | 12ms]". The exit code of `aside repl` is 0 even when the code threw, so only the
# status line tells.

aside_alive() { [ "$ASIDE_ALIVE" -eq 1 ] && [ -n "$ASIDE_PID" ] && kill -0 "$ASIDE_PID" 2>/dev/null; }

# aside_start: opens the session and loads lib/prelude.js into it. Returns 1 when no session
# could be opened; $ASIDE_LOG then holds what aside printed.
aside_start() {
  local dir="${ASIDE_WORK_DIR:-$WORK_ROOT}" _ encoded
  mkdir -p "$dir"
  ASIDE_FIFO="$dir/aside-$$.in"
  ASIDE_LOG="$dir/aside.log"
  ASIDE_PID_FILE="$dir/aside.pid"
  [ -n "$ASIDE_BIN" ] && [ -x "$ASIDE_BIN" ] || { echo "aside is not installed" >"$ASIDE_LOG"; return 1; }
  [ -p "$ASIDE_FIFO" ] || mkfifo "$ASIDE_FIFO" || return 1
  : >"$ASIDE_LOG"
  : >"$ASIDE_PID_FILE"
  {
    "$ASIDE_BIN" repl <"$ASIDE_FIFO" 2>&1 &
    echo $! >"$ASIDE_PID_FILE"
    wait
  } | redact >>"$ASIDE_LOG" &
  # Opening the write end lets the REPL's read end open; fd 9 keeps the session alive.
  exec 9>"$ASIDE_FIFO"
  for _ in $(seq 1 300); do
    grep -q "type 'help'" "$ASIDE_LOG" 2>/dev/null && break
    sleep 0.1
  done
  ASIDE_PID="$(tr -cd '0-9' <"$ASIDE_PID_FILE")"
  if ! grep -q "type 'help'" "$ASIDE_LOG" 2>/dev/null || [ -z "$ASIDE_PID" ]; then
    exec 9>&-
    return 1
  fi
  ASIDE_ALIVE=1
  ASIDE_SESSION_DIR="$(sed -n 's/^sessionDir: //p' "$ASIDE_LOG" | head -n 1)"
  encoded="$(base64 <"$PRELUDE_FILE" | tr -d '\n')"
  aside_js 30 "(0, eval)(Buffer.from('$encoded', 'base64').toString('utf8')); M.out(typeof M.click)" || return 1
  [ "$ASIDE_RESULT" = '"function"' ]
}

# aside_js <timeout seconds> <one line of JavaScript>
# Returns 0 on "[ok", 1 when the code threw, 2 on timeout, 3 when the session is gone.
# Sets ASIDE_OUT (everything printed), ASIDE_RESULT (the JSON of the last M.out) and ASIDE_ERROR.
aside_js() {
  local timeout="$1" js="$2" start ticks=0 status=""
  ASIDE_OUT="" ASIDE_RESULT="" ASIDE_ERROR=""
  aside_alive || { ASIDE_ERROR="the aside session is not running"; return 3; }
  case "$js" in *$'\n'*) ASIDE_ERROR="a statement must be one line"; return 1 ;; esac
  start="$(wc -l <"$ASIDE_LOG" | tr -d ' ')"
  printf '%s\n' "$js" >&9
  while :; do
    ASIDE_OUT="$(tail -n +"$((start + 1))" "$ASIDE_LOG" | sed -e 's/^repl > //')"
    status="$(printf '%s\n' "$ASIDE_OUT" | grep -m 1 -E '^\[(ok|error) \| [0-9]+ms\]$')"
    [ -n "$status" ] && break
    if ! kill -0 "$ASIDE_PID" 2>/dev/null; then
      ASIDE_ALIVE=0
      ASIDE_ERROR="the aside session ended"
      return 3
    fi
    ticks=$((ticks + 1))
    if [ "$ticks" -ge $((timeout * 20)) ]; then
      ASIDE_ERROR="no answer within $timeout seconds"
      return 2
    fi
    sleep 0.05
  done
  ASIDE_RESULT="$(printf '%s\n' "$ASIDE_OUT" | sed -n 's/^@@R //p' | tail -n 1)"
  case "$status" in
    "[ok"*) return 0 ;;
  esac
  ASIDE_ERROR="$(printf '%s\n' "$ASIDE_OUT" | grep -v -E '^\[(ok|error) \|' | grep -v '^@@R ' | head -n 3 | paste -sd ' ' -)"
  return 1
}

# Ends the session: removes this suite's localStorage keys from the tabs it opened, closes those
# tabs, quits the REPL, and stops the process by PID only if it is still there afterwards.
#
# What the probe found about tabs: Aside closes a session's tabs when the session quits with
# "exit", and only then. When the session's input just ends, or its process is stopped, the tab
# stays open in the user's browser, and no other session may close it (closeTab and page.close
# only detach a tab that was attached, and chrome.tabs.remove is refused in the REPL). What is
# left is window.close() run inside the page, which a browser honours only for a tab that has
# never navigated. So: the suite always closes its tabs from the session that opened them, a
# scenario never navigates a tab (it opens a new tab for a new URL), and
# aside_close_leftovers is the fallback.
aside_stop() {
  local _ closed=0
  if aside_alive; then
    if aside_js 20 'for (const name of M.names()) { try { await M.storage(name, "clear"); } catch (error) {} } M.out(await M.closeAll())' &&
      [ "$(ui_field '.errors | length')" = 0 ]; then
      closed=1
    else
      log "closing the tabs failed: ${ASIDE_ERROR:-$ASIDE_RESULT}"
    fi
    printf 'exit\n' >&9 2>/dev/null
  fi
  exec 9>&- 2>/dev/null
  if [ -n "$ASIDE_PID" ]; then
    for _ in $(seq 1 50); do
      kill -0 "$ASIDE_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$ASIDE_PID" 2>/dev/null; then
      log "the aside session (PID $ASIDE_PID) did not quit; stopping it"
      kill -TERM "$ASIDE_PID" 2>/dev/null
      closed=0
    fi
  fi
  ASIDE_ALIVE=0
  ASIDE_PID=""
  [ -n "${ASIDE_FIFO:-}" ] && [ -p "$ASIDE_FIFO" ] && rm -f "$ASIDE_FIFO"
  if [ "$closed" -eq 1 ]; then
    [ -n "$ASIDE_TARGETS_FILE" ] && : >"$ASIDE_TARGETS_FILE"
  else
    aside_close_leftovers
  fi
  return 0
}

# close_leftover_tab <target id>: closes a tab this suite opened and a dead session left behind.
# Prints closed, gone (it was not open any more), left-open (the browser refused; the tab is
# parked on about:blank) or not-ours (the tab no longer shows a page of this suite; untouched).
# The tab list is used only to ask whether this one target id is still open.
close_leftover_tab() {
  local js
  case "$1" in "" | *[!0-9A-Fa-f]*) echo gone; return 0 ;; esac
  js="const id = '$1'; const open = async () => (await listBrowserTabs()).some((t) => t.targetId === id); let state = 'gone'; if (await open()) { const p = await attachBrowserTab(id); const url = String(await p.url()); if (/^http:\\/\\/127\\.0\\.0\\.1:30[56][0-9]\\//.test(url)) { await p.evaluate(() => { setTimeout(() => window.close(), 0); return true; }); await sleep(1500); state = (await open()) ? 'left-open' : 'closed'; if (state === 'left-open') { try { await p.goto('about:blank', { waitUntil: 'load', timeout: 5000 }); } catch (error) {} } } else { state = 'not-ours'; } } console.log('@@R ' + state);"
  with_timeout 90 "$ASIDE_BIN" repl "$js" </dev/null 2>&1 | redact | sed -n 's/^@@R //p' | tail -n 1
}

# Closes the tabs recorded as opened and not closed (by this run, or by an earlier run of the
# scenario that was stopped hard). This is the only place the suite attaches to a tab, and only
# to a tab whose target id it recorded when it opened it.
aside_close_leftovers() {
  local target state
  [ -n "$ASIDE_TARGETS_FILE" ] && [ -s "$ASIDE_TARGETS_FILE" ] || return 0
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    state="$(close_leftover_tab "$target")"
    case "$state" in
      closed) log "closed a tab the suite had left open (target $target)" ;;
      left-open) log "WARNING: a tab of this suite could not be closed (target $target). It now shows about:blank; close it by hand." ;;
      *) ;;
    esac
  done <"$ASIDE_TARGETS_FILE"
  : >"$ASIDE_TARGETS_FILE"
}

# ----- driving the page (input path: repl) -----

# ui <timeout seconds> <expression>: evaluates `M.out(await <expression>)`.
ui() { aside_js "$1" "M.out(await $2)"; }

# A field of the last result; empty when absent.
ui_field() { printf '%s' "$ASIDE_RESULT" | jq -r "$1 | if . == null then empty else . end" 2>/dev/null; }

ui_open() {
  ui 60 "M.open($(js_str "$1"), $(js_str "$2"))" || fail_scenario "opening a tab on $2 failed: $ASIDE_ERROR"
  ui_field '.targetId' >>"$ASIDE_TARGETS_FILE"
  log "tab $1 opened on $2"
}

# ui_click <tab> <testid> [timeout seconds]: waits until the element is there and enabled, then
# clicks it. Returns 1 when it never became clickable.
ui_click() {
  local wait="${3:-10}"
  ui $((wait + 15)) "M.click($(js_str "$1"), $(js_str "$2"), $((wait * 1000)))" || return 1
  [ "$(ui_field '.ok')" = true ]
}

# ui_fill <tab> <testid> <value>: sets a field; the page sees a native input event.
ui_fill() {
  ui 30 "M.fill($(js_str "$1"), $(js_str "$2"), $(js_str "$3"))" || return 1
  [ "$(ui_field '.ok')" = true ]
}

ui_press() { ui 20 "M.press($(js_str "$1"), $(js_str "$2"))"; }

# ui_set_value <tab> <testid> <value>: sets a field from a script, with an input event (for the
# hidden client seed, which Playwright's fill refuses).
ui_set_value() {
  ui 20 "M.setValue($(js_str "$1"), $(js_str "$2"), $(js_str "$3"))" || return 1
  [ "$(ui_field '.ok')" = true ]
}

# ui_attr <tab> <testid> <attribute>: the attribute as the page has it now, read over the REPL
# (flow control, not an assertion). Empty when the element or the attribute is absent.
ui_attr() {
  ui 20 "M.read($(js_str "$1"), [$(js_str "$2")])" || return 1
  printf '%s' "$ASIDE_RESULT" | jq -r --arg id "$2" --arg a "$3" '.[$id].attrs[$a] // empty'
}

ui_storage_get() {
  ui 20 "M.storage($(js_str "$1"), \"get\", $(js_str "$2"))" || return 1
  printf '%s' "$ASIDE_RESULT" | jq -r '. // empty'
}

# ----- reading the page (read path A: repl, read path B: TestBeacon snapshot) -----

# dom_item <tab> <testid>: the element as JSON { text, attrs }, or "null" when it is not in the
# DOM. Returns 1 when the DOM could not be read at all.
dom_item() {
  case "$READ_PATH" in
    repl)
      ui 20 "M.read($(js_str "$1"), [$(js_str "$2")])" || return 1
      printf '%s' "$ASIDE_RESULT" | jq -c --arg id "$2" '.[$id]'
      ;;
    beacon)
      [ "$APP_DOWN" -eq 0 ] || return 1
      http GET /api/test/ui-snapshot
      [ "$HTTP_STATUS" = 200 ] || return 1
      printf '%s' "$HTTP_BODY" | jq -c --arg id "$2" '.items[$id] // null'
      ;;
    *) return 1 ;;
  esac
}

# dom_attr <tab> <testid> <attribute>: the attribute's value; empty when the element or the
# attribute is absent.
dom_attr() {
  local item
  item="$(dom_item "$1" "$2")" || return 1
  printf '%s' "$item" | jq -r --arg a "$3" 'if . == null then empty else (.attrs[$a] // empty) end'
}

dom_text() {
  local item
  item="$(dom_item "$1" "$2")" || return 1
  printf '%s' "$item" | jq -r 'if . == null then empty else .text end'
}

# dom_list <tab> <testid prefix>: every element whose testid starts with the prefix, as a JSON
# array of { id, text, attrs }.
dom_list() {
  case "$READ_PATH" in
    repl)
      ui 20 "M.list($(js_str "$1"), $(js_str "$2"))" || return 1
      printf '%s' "$ASIDE_RESULT"
      ;;
    beacon)
      [ "$APP_DOWN" -eq 0 ] || return 1
      http GET /api/test/ui-snapshot
      [ "$HTTP_STATUS" = 200 ] || return 1
      printf '%s' "$HTTP_BODY" | jq -c --arg p "$2" '[.items | to_entries[] | select(.key | startswith($p)) | { id: .key, text: .value.text, attrs: .value.attrs }]'
      ;;
    *) return 1 ;;
  esac
}

# dom_wait <tab> <testid> <attribute> <value> <seconds>: waits until the attribute has the value.
# With attribute "-" it waits for the element to be present; with value "-absent-" for it to go.
# Sets DOM_ACTUAL to what was last seen. Returns 0 when it held, 1 when not, 2 when unreadable.
dom_wait() {
  local tab="$1" id="$2" attr="$3" value="$4" seconds="${5:-10}" cond item _
  DOM_ACTUAL=""
  case "$READ_PATH" in
    repl)
      if [ "$value" = "-absent-" ]; then cond="{ id: $(js_str "$id"), present: false }"
      elif [ "$attr" = "-" ]; then cond="{ id: $(js_str "$id") }"
      else cond="{ id: $(js_str "$id"), attr: $(js_str "$attr"), equals: $(js_str "$value") }"; fi
      ui $((seconds + 15)) "M.waitFor($(js_str "$tab"), $cond, $((seconds * 1000)))" || return 2
      item="$(printf '%s' "$ASIDE_RESULT" | jq -c '.item')"
      DOM_ACTUAL="$(dom_describe "$item" "$attr")"
      [ "$(ui_field '.ok')" = true ]
      ;;
    beacon)
      for _ in $(seq 1 $((seconds * 4 + 1))); do
        item="$(dom_item "$tab" "$id")" || return 2
        DOM_ACTUAL="$(dom_describe "$item" "$attr")"
        if [ "$value" = "-absent-" ]; then [ "$item" = null ] && return 0
        elif [ "$attr" = "-" ]; then [ "$item" != null ] && return 0
        elif [ "$item" != null ] && [ "$(printf '%s' "$item" | jq -r --arg a "$attr" '.attrs[$a] // empty')" = "$value" ]; then return 0; fi
        sleep 0.25
      done
      return 1
      ;;
    *) return 2 ;;
  esac
}

# What an element showed, for an assertion's "actual" column.
dom_describe() {
  if [ "$1" = null ] || [ -z "$1" ]; then printf 'not in the DOM'
  elif [ "$2" = "-" ]; then printf 'present'
  else printf '%s' "$1" | jq -r --arg a "$2" '.attrs[$a] // "(no such attribute)"'; fi
}

# ----- DOM assertions -----

# expect_attr <label> <tab> <testid> <attribute> <expected> [seconds to wait]
expect_attr() {
  local code=0
  dom_wait "$2" "$3" "$4" "$5" "${6:-0}" || code=$?
  if [ "$code" -eq 2 ]; then dom_blocked "$1" "the DOM could not be read over path $READ_PATH"
  else check_ok dom "$1" "$5" "$DOM_ACTUAL" "$code"; fi
  return "$code"
}

# expect_attr_hex: like expect_attr, for a value whose letter case does not matter (an address).
expect_attr_hex() {
  local actual
  dom_wait "$2" "$3" "-" "" "${6:-0}" >/dev/null
  if ! actual="$(dom_attr "$2" "$3" "$4")"; then dom_blocked "$1" "the DOM could not be read over path $READ_PATH"; return 2; fi
  check_hex dom "$1" "$5" "$actual"
}

# expect_present <label> <tab> <testid> [seconds]
expect_present() {
  local code=0
  dom_wait "$2" "$3" "-" "" "${4:-0}" || code=$?
  if [ "$code" -eq 2 ]; then dom_blocked "$1" "the DOM could not be read over path $READ_PATH"
  else check_ok dom "$1" "present" "$DOM_ACTUAL" "$code"; fi
  return "$code"
}

# expect_absent <label> <tab> <testid> [seconds]
expect_absent() {
  local code=0
  dom_wait "$2" "$3" "-" "-absent-" "${4:-0}" || code=$?
  if [ "$code" -eq 2 ]; then dom_blocked "$1" "the DOM could not be read over path $READ_PATH"
  else check_ok dom "$1" "not in the DOM" "$DOM_ACTUAL" "$code"; fi
  return "$code"
}

# ----- the game, through the page -----

# open_lobby <tab>: opens the app in a new tab, removes records an earlier run may have left in
# this origin's localStorage (the page would resume that game), and waits for the lobby (the
# console's A button, btn-a, named START: data-action start).
open_lobby() {
  local left
  ui_open "$1" "$APP_URL/"
  ui 20 "M.storage($(js_str "$1"), \"clear\")" || fail_scenario "the page's localStorage could not be reached: $ASIDE_ERROR"
  left="$ASIDE_RESULT"
  if [ "$left" != 0 ]; then
    log "removed $left maze:* localStorage key(s) left by an earlier run; reloading"
    ui 30 "M.reload($(js_str "$1"))" || fail_scenario "reload failed: $ASIDE_ERROR"
  fi
  wait_lobby "$1" || fail_scenario "the lobby did not render within 30 seconds"
}

# wait_lobby <tab>: waits until A starts a bet (btn-a with data-action start). Returns 1 when it
# does not within 30 seconds.
wait_lobby() {
  ui 40 "M.waitFor($(js_str "$1"), { id: \"btn-a\", attr: \"data-action\", equals: \"start\" }, 30000)" ||
    fail_scenario "the lobby could not be read: $ASIDE_ERROR"
  [ "$(ui_field '.ok')" = true ]
}

# coin_label <amount in ETH>: the label of the slider's tick for that amount, as the page writes
# it in the tick button's test id (bet-preset-<label>): 0.01 -> .01, 0.10 -> .1, 1 -> 1.
coin_label() {
  local v="$1"
  case "$v" in *.*) v="$(printf '%s' "$v" | sed -E 's/0+$//; s/\.$//')" ;; esac
  case "$v" in 0.*) v="${v#0}" ;; esac
  printf '%s' "$v"
}

# connect_dev_wallet <tab>: clicks wallet-dev-option (never wallet-connect, which would talk to
# whatever wallet extension the user's browser has) and waits for the player's address.
connect_dev_wallet() {
  ui_click "$1" wallet-dev-option 10 || fail_scenario "wallet-dev-option is not clickable; is devWallet on?"
  ui 20 "M.waitFor($(js_str "$1"), { id: \"wallet-address\" }, 10000)" || fail_scenario "wallet read failed: $ASIDE_ERROR"
  [ "$(ui_field '.ok')" = true ] || fail_scenario "the dev wallet did not connect"
  WALLET_SHOWN="$(ui_field '.item.text')"
}

# slider_position <bet wei>: where that bet sits on the bet slider, 0 to 1000, by the page's
# mapping: the ticks (the table's minimum, 0.01 and 0.05 between the limits, the table's maximum)
# evenly spaced, straight lines between them.
slider_position() {
  local lo hi
  lo="$(printf '%s' "$CONFIG_JSON" | jq -r .minBetWei)"
  hi="$(printf '%s' "$CONFIG_JSON" | jq -r .maxBetWei)"
  awk -v v="$1" -v lo="$lo" -v hi="$hi" 'BEGIN {
    n = 0; t[n++] = lo + 0
    if (1e16 > lo && 1e16 < hi) t[n++] = 1e16
    if (5e16 > lo && 5e16 < hi) t[n++] = 5e16
    t[n++] = hi + 0
    if (v <= t[0]) { print 0; exit }
    if (v >= t[n - 1]) { print 1000; exit }
    for (i = 0; i < n - 1; i++) if (v >= t[i] && v <= t[i + 1]) break
    printf "%d\n", int(((i + (v - t[i]) / (t[i + 1] - t[i])) / (n - 1)) * 1000 + 0.5)
  }'
}

# choose_bet <tab> <tier> <amount in ETH>: presses the difficulty key (tier-<tier>) and sets the bet
# on the side panel's slider, with the bet sheet closed: an amount on a tick (0.001, 0.01, 0.05 or
# 0.1 on the tables in use) by the tick label's button (bet-preset-<label>), any other amount by
# writing its position (slider_position) into the slider with an input event. Only a pointer
# snaps to a tick, so any amount on the 0.001 grid lands as it is. Checks that the slider holds
# the bet (bet-slider data-wei). Sets TIER and BET_WEI.
choose_bet() {
  local tick
  tick="bet-preset-$(coin_label "$3")"
  ui_click "$1" "tier-$2" 10 || fail_scenario "tier-$2 is not clickable"
  [ "$(ui_attr "$1" "tier-$2" data-selected)" = true ] || fail_scenario "tier-$2 was not selected"
  TIER="$2"
  BET_WEI="$(cast to-wei "$3" ether)"
  ui 20 "M.read($(js_str "$1"), [$(js_str "$tick")])" || fail_scenario "the bet slider could not be read: $ASIDE_ERROR"
  if [ "$(ui_field ".[\"$tick\"] != null")" = true ]; then
    ui_click "$1" "$tick" 10 || fail_scenario "$tick is not clickable"
  else
    ui_set_value "$1" bet-slider "$(slider_position "$BET_WEI")" ||
      fail_scenario "bet-slider could not be set to $3 ETH (position $(slider_position "$BET_WEI")): $ASIDE_RESULT"
  fi
  expect_attr "the bet slider holds the bet ($3 ETH)" "$1" bet-slider data-wei "$BET_WEI" 5
}

# fill_bet <tab> <tier> <amount in ETH> <client seed>: chooses the difficulty and the bet on the
# side panel, sets the client seed (client-seed-input, a hidden field of the side panel, set by
# script with an input event) and presses A (btn-a, named START in the lobby), which opens the bet
# sheet. The open sheet makes the device inert and covers it, so everything on the side panel is
# set first. Sets TIER, BET_WEI and CLIENT_SEED.
fill_bet() {
  choose_bet "$1" "$2" "$3"
  ui_set_value "$1" client-seed-input "$4" || fail_scenario "client-seed-input could not be set: $ASIDE_RESULT"
  ui_click "$1" btn-a 10 || fail_scenario "btn-a (A, START) is not clickable"
  ui 20 "M.waitFor($(js_str "$1"), { id: \"sheet-full-seed\", text: $(js_str "$4") }, 10000)" ||
    fail_scenario "the bet sheet could not be read: $ASIDE_ERROR"
  [ "$(ui_field '.ok')" = true ] || fail_scenario "the bet sheet does not show the client seed $4 ($(ui_field '.item.text'))"
  CLIENT_SEED="$4"
}

# submit_bet <tab>: after fill_bet, clicks bet-submit in the bet sheet and waits until the server
# has shown the first cell (the sheet closes by itself). Sets GAME_ID, N, TOKEN and
# BALANCE_AFTER_BET (the player's balance once the bet is mined).
submit_bet() {
  ui_click "$1" bet-submit 10 || fail_scenario "bet-submit is not clickable (is the bet sheet open, the form valid and the wallet connected?)"
  ui 60 "M.waitFor($(js_str "$1"), { id: \"refundable-amount\" }, 45000)" || fail_scenario "waiting for the board failed: $ASIDE_ERROR"
  if [ "$(ui_field '.ok')" != true ]; then
    ui 20 "M.read($(js_str "$1"), [\"error-message\", \"bet-status\", \"sheet-error\"])"
    fail_scenario "the board did not appear within 45 seconds of the bet (page says: $ASIDE_RESULT)"
  fi
  ui 20 "M.read($(js_str "$1"), [\"board\"])" || fail_scenario "the board could not be read: $ASIDE_ERROR"
  GAME_ID="$(ui_field '.board.attrs["data-game-id"]')"
  N="$(ui_field '.board.attrs["data-n"]')"
  [[ "$GAME_ID" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail_scenario "board[data-game-id] is not a game id: \"$GAME_ID\""
  TOKEN="$(ui_storage_get "$1" "maze:record:$GAME_ID" | jq -r '.token // empty')"
  [ -n "$TOKEN" ] || fail_scenario "the play record of $GAME_ID has no session token in localStorage"
  BALANCE_AFTER_BET="$(balance_of "$PLAYER_ADDR")"
  STEP=0
  evidence gameId "$GAME_ID"
  log "game $GAME_ID started (n = $N, bet $BET_WEI wei)"
}

# open_game_for <tab> <tier> <goal>: bets and plans a route for the goal. A maze that cannot
# serve the goal (no dead end before the exit, no junction, ...) is cashed out at step 0 and the
# next game is tried with the scenario's next client seed, up to four games.
open_game_for() {
  local tab="$1" tier="$2" goal="$3" attempt
  for attempt in 1 2 3 4; do
    fill_bet "$tab" "$tier" "$BET_ETH" "$(client_seed "$attempt")"
    submit_bet "$tab"
    if plan "$goal"; then
      GAMES_PLAYED="$attempt"
      return 0
    fi
    log "the maze of game $attempt cannot serve \"$goal\"; cashing out at step 0 and betting again"
    cash_out "$tab" || fail_scenario "the cash-out (A, then cashout-button) is not clickable while abandoning game $attempt"
    wait_status "$GAME_ID" "$STATUS_SETTLED" 40 || fail_scenario "the abandoned game $GAME_ID was not settled"
    ui_click "$tab" new-game 20 || fail_scenario "new-game is not clickable after abandoning game $attempt"
    wait_lobby "$tab" || fail_scenario "the lobby did not come back after new-game"
  done
  fail_scenario "none of 4 mazes could serve the goal \"$goal\""
}

# cash_out <tab>: asks to cash out (A, btn-a, named CASH OUT during a game) and takes it
# (cashout-button, "Take it", on the screen). Returns 1 when A never offered the cash-out or
# either button never became clickable.
cash_out() {
  ui 20 "M.waitFor($(js_str "$1"), { id: \"btn-a\", attr: \"data-action\", equals: \"cashout\" }, 10000)" || return 1
  [ "$(ui_field '.ok')" = true ] || return 1
  ui_click "$1" btn-a 10 || return 1
  ui_click "$1" cashout-button 10
}

dir_num() {
  case "$1" in
    N) echo 0 ;;
    E) echo 1 ;;
    S) echo 2 ;;
    W) echo 3 ;;
  esac
}

# current_cell <tab>: the testid of the board cell marked current ("cell-<x>-<y>").
current_cell() {
  local cells
  cells="$(dom_list "$1" cell-)" || return 1
  printf '%s' "$cells" | jq -r '[.[] | select(.attrs["data-state"] == "current") | .id] | join(",")'
}

# expect_fog <tab> <moves made>: what the board may show after that many moves (AC-W2): one
# current cell, one visited cell per move, the start and the exit marked, and no wall data on
# any cell the player has not been to.
expect_fog() {
  local cells last=$((N - 1))
  if ! cells="$(dom_list "$1" cell-)"; then
    dom_blocked "the fog board after $2 move(s)" "the DOM could not be read over path $READ_PATH"
    return
  fi
  check dom "the board has n x n cells" $((N * N)) "$(printf '%s' "$cells" | jq 'length')"
  check dom "exactly one cell is current after $2 move(s)" 1 "$(printf '%s' "$cells" | jq '[.[] | select(.attrs["data-state"] == "current")] | length')"
  check dom "one cell is visited per move made ($2)" "$2" "$(printf '%s' "$cells" | jq '[.[] | select(.attrs["data-state"] == "visited")] | length')"
  check dom "no hidden cell carries wall data" 0 "$(printf '%s' "$cells" | jq '[.[] | select(.attrs["data-state"] == "hidden" and .attrs["data-open"] != "")] | length')"
  check dom "every cell the player has been to shows its walls" 0 "$(printf '%s' "$cells" | jq '[.[] | select(.attrs["data-state"] != "hidden" and .attrs["data-open"] == "")] | length')"
  check dom "the start cell is marked" "cell-0-0" "$(printf '%s' "$cells" | jq -r '[.[] | select(.attrs["data-start"] == "true") | .id] | join(",")')"
  check dom "the exit cell is marked" "cell-$last-$last" "$(printf '%s' "$cells" | jq -r '[.[] | select(.attrs["data-exit"] == "true") | .id] | join(",")')"
}

# expect_escape_payout <tab> <tier> <bet wei>: before any bet, the side panel shows the chosen
# difficulty selected, its key carries the table's size and multiplier, and escape-payout (what an
# escape would pay, on the LCD) is bet x multiplier for the chosen bet (AC-W6, AC-R1, AC-T8).
expect_escape_payout() {
  local payout
  payout="$(exit_wei "$3" "$2")"
  expect_attr "size $2 is the selected difficulty on the side panel" "$1" "tier-$2" data-selected true 5
  expect_attr "size $2: its chip shows the table's size" "$1" "tier-$2" data-n "$(tier_n "$2")" 5
  expect_attr "size $2: its chip carries the table's multiplier" "$1" "tier-$2" data-multiplier-bps "$(tier_multiplier_bps "$2")" 5
  expect_attr "size $2: escape-payout for the chosen bet ($3 wei) is bet x multiplier" "$1" escape-payout data-wei "$payout" 5
  check chain "size $2: the contract quotes the same exit payout" "$payout" "$(chain_call 'quoteExitPayout(uint8,uint256)(uint256)' "$2" "$3")"
  check chain "size $2: the contract's size and multiplier are the table's" "$(tier_n "$2") $(tier_multiplier_bps "$2")" \
    "$(chain_call 'tiers(uint8)(uint8,uint32)' "$2" | paste -sd ' ' -)"
}

# expect_schedule <tab> <tier> <bet wei>: with the bet sheet open, its refund schedule (a
# collapsed details block, read from the DOM) is drawn for the chosen size and amount: one row
# per step with refundBps and bet x refundBps, and the exit payout with the multiplier (AC-W6,
# AC-R1, AC-T8).
expect_schedule() {
  local rows expected="" actual k bps payout
  payout="$(exit_wei "$3" "$2")"
  expect_attr "the bet sheet's refund-schedule is drawn for size $2" "$1" refund-schedule data-tier "$2" 5
  expect_attr "the bet sheet's refund-schedule is drawn for the chosen bet ($3 wei)" "$1" refund-schedule data-bet-wei "$3" 5
  if rows="$(dom_list "$1" schedule-row-)"; then
    while read -r k bps; do
      expected="$expected$k:$bps:$(mul_bps "$3" "$bps") "
    done < <(printf '%s' "$CONFIG_JSON" | jq -r --argjson t "$2" '.tiers[$t].refundBps | to_entries[] | "\(.key) \(.value)"')
    actual="$(printf '%s' "$rows" | jq -r '.[] | "\(.attrs["data-step"]):\(.attrs["data-bps"]):\(.attrs["data-wei"])"' | tr '\n' ' ')"
    check dom "size $2: every schedule row shows step, refundBps and bet x refundBps ($(tier_n "$2") x $(tier_n "$2") rows)" "$expected" "$actual"
  else
    dom_blocked "size $2: the schedule rows" "the DOM could not be read over path $READ_PATH"
  fi
  expect_attr "size $2: schedule-exit-payout is bet x multiplier" "$1" schedule-exit-payout data-wei "$payout" 5
  expect_attr "size $2: schedule-exit-payout names the table's multiplier" "$1" schedule-exit-payout data-multiplier-bps "$(tier_multiplier_bps "$2")" 5
}

# close_sheet <tab>: closes the bet sheet with Escape (its close buttons carry no test id).
# Returns 1 when key presses were not verified by the probe or the sheet stays open.
close_sheet() {
  cap pressKey || return 1
  ui_press "$1" Escape || return 1
  ui 25 "M.waitFor($(js_str "$1"), { id: \"sign-sheet\", present: false }, 10000)" || return 1
  [ "$(ui_field '.ok')" = true ]
}

# plan <goal>: plans a route offline from the game id (plan-moves.ts). Sets PLAN_JSON and
# PLAN_MOVES (direction letters separated by spaces). Returns 3 when this maze cannot serve the goal.
plan() {
  local code=0
  PLAN_JSON="$("$TSX" "$E2E_DIR/plan-moves.ts" --secret "$SEED_SECRET" --game-id "$GAME_ID" \
    --client-seed "$CLIENT_SEED" --n "$N" --goal "$1" 2>"$SC_DIR/plan.err")" || code=$?
  if [ "$code" -ne 0 ] && [ "$code" -ne 3 ]; then
    fail_scenario "plan-moves.ts failed: $(head -n 3 "$SC_DIR/plan.err" | paste -sd ' ' -)"
  fi
  [ "$code" -eq 0 ] || return 3
  PLAN_MOVES="$(printf '%s' "$PLAN_JSON" | jq -r '.moves | join(" ")')"
  PREDICTED_SERVER_SEED="$(printf '%s' "$PLAN_JSON" | jq -r '.serverSeed')"
  log "planned $1: ${PLAN_MOVES:-(no moves)}"
}

key_of() {
  case "$1" in
    N) echo ArrowUp ;;
    E) echo ArrowRight ;;
    S) echo ArrowDown ;;
    W) echo ArrowLeft ;;
  esac
}

# move <tab> <direction letter> [click|key]: makes one move and waits until the board shows the
# next step. STEP counts the moves made so far. The D-pad buttons are never disabled; their
# data-legal says whether the move is open now (a press that is not is refused on the page), so
# the move waits for data-legal="true" first.
move() {
  local next=$((STEP + 1))
  ui 20 "M.waitFor($(js_str "$1"), { id: \"move-$2\", attr: \"data-legal\", equals: \"true\" }, 10000)" || fail_scenario "move-$2 could not be read: $ASIDE_ERROR"
  [ "$(ui_field '.ok')" = true ] || fail_scenario "move-$2 is not a legal move at step $STEP (data-legal is not true)"
  if [ "${3:-click}" = key ]; then
    ui_press "$1" "$(key_of "$2")" || fail_scenario "pressing $(key_of "$2") failed: $ASIDE_ERROR"
  else
    ui_click "$1" "move-$2" 10 || fail_scenario "move-$2 is not clickable at step $STEP ($ASIDE_RESULT)"
  fi
  ui 30 "M.waitFor($(js_str "$1"), { id: \"board\", attr: \"data-step\", equals: \"$next\" }, 15000)" || fail_scenario "the board could not be read after move $next: $ASIDE_ERROR"
  [ "$(ui_field '.ok')" = true ] || fail_scenario "the board did not reach step $next after move-$2"
  STEP="$next"
}

# walk <tab> <click|key> <direction letters...>
walk() {
  local tab="$1" how="$2" dir
  shift 2
  for dir in "$@"; do move "$tab" "$dir" "$how"; done
}

# Reads the game from the server with the session token. Sets HTTP_STATUS and HTTP_BODY.
http_game() { http GET "/api/games/$GAME_ID" "$TOKEN"; }

# ----- assertions every game scenario makes -----

# After submit_bet: the bet is on chain as typed, and the server serves the game to the token.
expect_game_open() {
  chain_game "$GAME_ID" || fail_scenario "getGame($GAME_ID) could not be read from the chain"
  check chain "getGame.status is Active after the bet" "$STATUS_ACTIVE" "$G_STATUS"
  check_hex chain "getGame.player is the dev wallet (Anvil #2)" "$PLAYER_ADDR" "$G_PLAYER"
  check chain "getGame.bet is the amount typed into the page" "$BET_WEI" "$G_BET"
  check_hex chain "getGame.clientSeed is the seed typed into the page" "$CLIENT_SEED" "$G_CLIENT_SEED"
  check chain "getGame.maxPayout is bet x multiplier" "$(exit_wei "$BET_WEI" "$TIER")" "$G_MAX_PAYOUT"
  check chain "totalReserved holds the game's maximum payout" "$G_MAX_PAYOUT" "$(chain_call 'totalReserved()(uint256)')"
  http_game
  check http "GET /api/games/:id answers 200 to the session token" 200 "$HTTP_STATUS"
  check http "the server reports the game active at step 0" "active 0" "$(http_field .status) $(http_field .step)"
  check http "refundableWei at step 0 is bet x refundBps[0]" "$(refund_wei "$BET_WEI" "$TIER" 0)" "$(http_field .refundableWei)"
}

# expect_refundable <tab> <k>: after k moves the page (refundable-amount and the HP meter,
# hp-bar), the server and the contract's table agree on what a cash-out would pay (AC-W3, AC-T8).
expect_refundable() {
  local expected
  expected="$(refund_wei "$BET_WEI" "$TIER" "$2")"
  expect_attr "refundable-amount after $2 move(s) is bet x refundBps[$2]" "$1" refundable-amount data-wei "$expected" 5
  expect_attr "the HP meter after $2 move(s) shows refundBps[$2] of the bet" "$1" hp-bar data-bps "$(tier_refund_bps "$TIER" "$2")" 5
  expect_attr "the HP meter after $2 move(s) shows bet x refundBps[$2]" "$1" hp-bar data-wei "$expected" 5
  check chain "the contract's refundBps($TIER, $2) is the table's" "$(tier_refund_bps "$TIER" "$2")" "$(chain_call 'refundBps(uint8,uint16)(uint16)' "$TIER" "$2")"
  http_game
  check http "the server's refundableWei after $2 move(s)" "$expected" "$(http_field .refundableWei)"
}

# expect_settled <outcome 0|1|2> <steps> <payout wei> <server status> <auto true|false>
# The settlement on chain and what the server says about it. Sets S_* (see settlement).
expect_settled() {
  local _
  wait_status "$GAME_ID" "$STATUS_SETTLED" 40
  check chain "getGame.status is Settled" "$STATUS_SETTLED" "$G_STATUS"
  settlement "$GAME_ID"
  check chain "the game was settled exactly once (GameSettled events)" 1 "$S_COUNT"
  check chain "GameSettled.outcome" "$1" "$S_OUTCOME"
  check chain "GameSettled.steps" "$2" "$S_STEPS"
  check chain "GameSettled.payout" "$3" "$S_PAYOUT"
  check_hex chain "the relayer (Anvil #1) submitted the settlement" "$RELAYER_ADDR" "$S_FROM"
  check chain "the player's balance changed by exactly the payout" "$(big_add "$BALANCE_AFTER_BET" "$3")" "$(balance_of "$PLAYER_ADDR")"
  check chain "totalReserved is back to 0" 0 "$(chain_call 'totalReserved()(uint256)')"
  check_hex chain "the settled server seed is the one the route was planned with" "$PREDICTED_SERVER_SEED" "$S_SERVER_SEED"
  evidence settleTx "$S_TX"

  # The server learns the mined transaction from its chain watcher a moment later.
  for _ in $(seq 1 60); do
    http_game
    [ -n "$(http_field .terminal.settleTxHash)" ] && break
    sleep 0.25
  done
  check http "the server reports the game as $4" "$4" "$(http_field .status)"
  check http "the server reports auto = $5" "$5" "$(http_field .auto)"
  check http "terminal.payoutWei is the settled payout" "$3" "$(http_field .terminal.payoutWei)"
  check_hex http "terminal.settleTxHash is the settlement transaction" "$S_TX" "$(http_field .terminal.settleTxHash)"
  http GET "/api/games/$GAME_ID/reveal"
  check http "GET /api/games/:id/reveal answers 200 with reason settled" "200 settled" "$HTTP_STATUS $(http_field .reason)"
  check_hex http "the revealed server seed is the settled one" "$S_SERVER_SEED" "$(http_field .serverSeed)"
  check_hex http "the revealed commitment is the one on chain" "$G_COMMITMENT" "$(http_field .commitment)"
  expect_accounting
}

# expect_result <tab> <data-outcome> <payout wei>: the result panel (AC-W4).
expect_result() {
  expect_attr "result-outcome shows $2" "$1" result-outcome data-outcome "$2" 20
  expect_attr "result-payout shows the amount paid" "$1" result-payout data-wei "$3" 5
  expect_attr "result-net shows payout minus bet" "$1" result-net data-wei "$(big_sub "$3" "$BET_WEI")" 5
}

# expect_result_tx <tab>: once the settlement is mined, the panel names its transaction.
expect_result_tx() {
  expect_attr "settle-tx is marked confirmed by the chain" "$1" settle-tx data-confirmed true 30
  expect_attr "settle-tx names the settlement transaction" "$1" settle-tx data-tx "$(lower "$S_TX")" 30
}

# open_verify <game tab> <new tab>: the fairness check is a dialog over the game. Clicks the
# result panel's verify-link (href /?verify=<gameId>), which opens the dialog for this game in
# place, closes it again (verify-close), then closes the game tab and opens a new tab on
# /?verify=<gameId>, where the page opens the dialog on load (the old /verify/<gameId> redirects
# there). A tab is never navigated: a tab with history could not be closed if its session died
# (see aside_stop).
open_verify() {
  local href
  if href="$(dom_attr "$1" verify-link href)"; then
    check dom "verify-link points at /?verify=<gameId>" "/?verify=$GAME_ID" "$href"
  else
    dom_blocked "verify-link points at /?verify=<gameId>" "the DOM could not be read over path $READ_PATH"
  fi
  ui_click "$1" verify-link 10 || fail_scenario "verify-link is not clickable"
  expect_attr "verify-link opens the verify dialog for this game" "$1" verify-game data-game-id "$GAME_ID" 20
  ui_click "$1" verify-close 10 || fail_scenario "verify-close is not clickable"
  expect_absent "verify-close closes the dialog" "$1" verify-modal 10
  ui 30 "M.close($(js_str "$1"))" || fail_scenario "closing tab $1 failed: $ASIDE_ERROR"
  ui_open "$2" "$APP_URL/?verify=$GAME_ID"
  expect_present "/?verify=<gameId> opens the verify dialog on load" "$2" verify-modal 30
}

# expect_verify_ok <tab> <observations>: in the verify dialog, the verdicts a fair game must get.
expect_verify_ok() {
  local cells bad
  expect_attr "verify: the revealed seed hashes to the commitment" "$1" verify-hash-match data-match true 30
  expect_attr "verify: commitment and client seed match the chain" "$1" verify-onchain-match data-match true 10
  expect_attr "verify: every observed cell matches the recomputed maze" "$1" verify-cells-match data-match true 10
  expect_attr "verify: the recorded moves end in the settled outcome" "$1" verify-outcome-ok data-match true 10
  expect_attr "verify: the payout is what the table prescribes" "$1" verify-payout-ok data-match true 10
  if cells="$(dom_list "$1" verify-cell-)"; then
    check dom "verify: one compared cell per observation" "$2" "$(printf '%s' "$cells" | jq 'length')"
    bad="$(printf '%s' "$cells" | jq -r '[.[] | select(.attrs["data-match"] != "true") | .id] | join(",")')"
    check dom "verify: no compared cell is a mismatch" "" "$bad"
  else
    dom_blocked "verify: per-cell comparison" "the DOM could not be read over path $READ_PATH"
  fi
}
