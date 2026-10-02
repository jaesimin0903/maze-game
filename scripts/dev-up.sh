#!/usr/bin/env bash
# Starts the local stack (plan §8.4 step 3.1): a fresh Anvil, the MazeBet contract with the house
# funded, and the web app built and started against that deployment.
#
#   pnpm dev:up
#   MAZE_ALLOW_TEST_HOOKS=1 MAZE_TUNING_FIXTURE=packages/shared/test/fixtures/tuning.fixture.json \
#     pnpm dev:up --allow-test-hooks
#
# Options:
#   --allow-test-hooks   start although a test-hook flag is set in the environment (see below)
#   --no-supervisor      start the app directly; nothing restarts it when it exits
#
# What it does, in order:
#   1. starts `anvil --block-time 1` on the Anvil port;
#   2. deploys and funds the contract with scripts/deploy-local.ts, which writes
#      deployments/local-<port>.json;
#   3. builds the app into its own NEXT_DIST_DIR;
#   4. reads the deployment file and starts the app with those values as environment variables,
#      listening on the loopback interface only (the app may be running with test hooks). The app
#      runs under a supervisor (this script in `--supervise` mode) that starts it again whenever
#      it exits: after 1 s, then 2, 4, 8 and at most 10 s, back to 1 s once a run has lasted 30 s;
#   5. waits until GET /api/config answers.
# `pnpm dev:down` stops the processes this script started, by the PIDs recorded under
# .data/dev-up-<next port>/: supervisor.pid (the supervisor), next.pid (the app that is running
# now, rewritten at every restart) and anvil.pid. To stop only the app for good, stop the
# supervisor first.
#
# Why a supervisor: a game is cashed out and settled by the app. While the app is down nothing is,
# and a game that reaches its settle deadline unsettled is reclaimed in full. The app ends itself
# when it can no longer write its event log; the restarted app signs what is overdue.
#
# Test-hook flags (MAZE_ALLOW_TEST_HOOKS, MAZE_TEST_SEED_SECRET, MAZE_TUNING_FIXTURE) make the
# app derive every maze from public data. This script therefore REFUSES to start (exit 2) while
# any of them is set in its environment, unless --allow-test-hooks is given on its command line.
# There is no environment variable that grants this. With the switch the flags are handed to the
# app through its process environment, as before; this script writes them to no file. Without
# MAZE_TUNING_FIXTURE the production table is deployed, and the app refuses to start while that
# table is not calibrated (AC-S8).
#
# Environment (all optional):
#   MAZE_ANVIL_PORT, MAZE_NEXT_PORT   ports (default: the dev:up ports of scripts/ports.sh)
#   NEXT_DIST_DIR                     build directory under apps/web (default .next-dev-<next port>)
#   MAZE_SKIP_BUILD=1                 reuse the build already in NEXT_DIST_DIR
#   MAZE_DATA_DIR                     the server's event-log directory. By default a directory
#                                     under .data/ that is emptied on every start, because a
#                                     fresh Anvil needs a fresh event log.
#   MAZE_IDLE_TIMEOUT_SEC, MAZE_MAX_GAME_SEC, SERVER_SIGNER_PRIVATE_KEY, RELAYER_PRIVATE_KEY,
#   NEXT_PUBLIC_ENABLE_DEV_WALLET (default 1)   passed on to the app (plan §7.9)
#
# Exit codes: 0 the stack is up, 1 something failed (what this run started is stopped again),
# 2 usage or setup error (nothing was started).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ----- supervisor mode (internal): dev-up.sh --supervise <state dir> -- <command...> -----
#
# Runs <command> and starts it again whenever it exits, until this process gets SIGTERM or
# SIGINT; it then stops the command (SIGTERM, SIGKILL after 8 s) and exits. The PID of the
# running command is kept in <state dir>/next.pid, every exit is counted in <state dir>/restarts
# and described in <state dir>/supervisor.log.
if [ "${1:-}" = "--supervise" ]; then
  SUP_STATE_DIR="${2:?dev-up.sh --supervise needs a state directory}"
  shift 2
  [ "${1:-}" = "--" ] && shift
  [ "$#" -gt 0 ] || { echo "dev-up.sh --supervise needs a command" >&2; exit 2; }
  SUP_MAX_DELAY=10
  SUP_STABLE_SEC=30
  SUP_CHILD=""
  SUP_STOPPING=0
  SUP_DELAY=1
  SUP_EXITS=0
  sup_note() {
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$SUP_STATE_DIR/supervisor.log"
    echo "dev:up supervisor: $*"
  }
  sup_stop() {
    SUP_STOPPING=1
    if [ -n "$SUP_CHILD" ]; then kill -TERM "$SUP_CHILD" 2>/dev/null || true; fi
  }
  trap sup_stop TERM INT
  while [ "$SUP_STOPPING" -eq 0 ]; do
    "$@" &
    SUP_CHILD=$!
    echo "$SUP_CHILD" >"$SUP_STATE_DIR/next.pid"
    sup_note "started pid $SUP_CHILD"
    SUP_STARTED=$SECONDS
    SUP_CODE=0
    # `wait` also returns when a trapped signal arrives, so it is repeated while the command lives.
    while kill -0 "$SUP_CHILD" 2>/dev/null; do
      SUP_CODE=0
      wait "$SUP_CHILD" || SUP_CODE=$?
      if [ "$SUP_STOPPING" -eq 1 ]; then
        for _ in $(seq 1 40); do
          kill -0 "$SUP_CHILD" 2>/dev/null || break
          sleep 0.2
        done
        kill -KILL "$SUP_CHILD" 2>/dev/null || true
        break
      fi
    done
    [ "$SUP_STOPPING" -eq 1 ] && break
    SUP_UPTIME=$((SECONDS - SUP_STARTED))
    [ "$SUP_UPTIME" -ge "$SUP_STABLE_SEC" ] && SUP_DELAY=1
    SUP_EXITS=$((SUP_EXITS + 1))
    echo "$SUP_EXITS" >"$SUP_STATE_DIR/restarts"
    sup_note "pid $SUP_CHILD exited with status $SUP_CODE after ${SUP_UPTIME}s; starting it again in ${SUP_DELAY}s"
    SUP_CHILD=""
    sleep "$SUP_DELAY" &
    wait $! || true
    SUP_DELAY=$((SUP_DELAY * 2))
    [ "$SUP_DELAY" -gt "$SUP_MAX_DELAY" ] && SUP_DELAY=$SUP_MAX_DELAY
  done
  sup_note "stopped"
  exit 0
fi
# shellcheck source=scripts/ports.sh
. "$SCRIPT_DIR/ports.sh"

# Anvil default account #1 (public, well-known test key): server signer and relayer.
DEFAULT_SIGNER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

ANVIL_PORT="${MAZE_ANVIL_PORT:-$MAZE_DEV_ANVIL_PORT}"
NEXT_PORT="${MAZE_NEXT_PORT:-$MAZE_DEV_NEXT_PORT}"
DIST_DIR="${NEXT_DIST_DIR:-.next-dev-$NEXT_PORT}"
WEB_DIR="$ROOT_DIR/apps/web"
STATE_DIR="$ROOT_DIR/.data/dev-up-$NEXT_PORT"
ANVIL_PID_FILE="$STATE_DIR/anvil.pid"
NEXT_PID_FILE="$STATE_DIR/next.pid"
SUPERVISOR_PID_FILE="$STATE_DIR/supervisor.pid"
RPC_URL_LOCAL="http://127.0.0.1:$ANVIL_PORT"
APP_URL="http://127.0.0.1:$NEXT_PORT"
# Where the caller stood: pnpm runs this script from the repository root and keeps the
# original directory in INIT_CWD.
CALLER_DIR="${INIT_CWD:-$PWD}"

say() { echo "dev:up: $*"; }
# die <message> [exit code]
die() { echo "dev:up: $1" >&2; exit "${2:-1}"; }

ALLOW_TEST_HOOKS=0
SUPERVISE=1
for arg in "$@"; do
  case "$arg" in
    --allow-test-hooks) ALLOW_TEST_HOOKS=1 ;;
    --no-supervisor) SUPERVISE=0 ;;
    --) ;;
    *) die "unknown argument \"$arg\" (options: --allow-test-hooks, --no-supervisor)" 2 ;;
  esac
done

# Before anything is started: a hook flag left in the caller's environment must not turn the
# stack into one whose mazes can be computed from public data.
HOOK_FLAGS=""
for name in MAZE_ALLOW_TEST_HOOKS MAZE_TEST_SEED_SECRET MAZE_TUNING_FIXTURE; do
  if [ -n "${!name:-}" ]; then HOOK_FLAGS="$HOOK_FLAGS $name"; fi
done
if [ -n "$HOOK_FLAGS" ]; then
  if [ "$ALLOW_TEST_HOOKS" -ne 1 ]; then
    die "refusing to start: test-hook flag(s) set in the environment:$HOOK_FLAGS. With test hooks the mazes of this stack can be computed from public data. Unset them, or pass --allow-test-hooks if this stack is for automated tests only." 2
  fi
  echo "dev:up: WARNING: TEST HOOKS ARE ON ($(echo $HOOK_FLAGS | tr ' ' ',')). Mazes of this stack can be computed from public data. For automated tests only." >&2
fi

for port in "$ANVIL_PORT" "$NEXT_PORT"; do
  [[ "$port" =~ ^[0-9]+$ ]] || die "ports must be numbers, got \"$port\"" 2
done
for tool in anvil node pnpm curl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed" 2
done

# An absolute form of a path given by the caller. The app runs in apps/web, so a relative path
# would not mean there what it meant on the command line.
absolute() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s' "$CALLER_DIR/$1" ;;
  esac
}

FIXTURE=""
if [ -n "${MAZE_TUNING_FIXTURE:-}" ]; then
  FIXTURE="$(absolute "$MAZE_TUNING_FIXTURE")"
  # A path relative to the repository root is accepted from any directory.
  [ -f "$FIXTURE" ] || FIXTURE="$ROOT_DIR/$MAZE_TUNING_FIXTURE"
  [ -f "$FIXTURE" ] || die "MAZE_TUNING_FIXTURE=$MAZE_TUNING_FIXTURE is not a file" 2
fi

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

for file in "$ANVIL_PID_FILE" "$NEXT_PID_FILE" "$SUPERVISOR_PID_FILE"; do
  if [ -f "$file" ] && kill -0 "$(cat "$file")" 2>/dev/null; then
    die "already running (pid $(cat "$file"), $file). Run \"pnpm dev:down\" first." 2
  fi
done
port_in_use "$ANVIL_PORT" && die "port $ANVIL_PORT is in use by another process" 2
port_in_use "$NEXT_PORT" && die "port $NEXT_PORT is in use by another process" 2

mkdir -p "$STATE_DIR"
rm -f "$ANVIL_PID_FILE" "$NEXT_PID_FILE" "$SUPERVISOR_PID_FILE" "$STATE_DIR/restarts" "$STATE_DIR/supervisor.log"

if [ -n "${MAZE_DATA_DIR:-}" ]; then
  DATA_DIR="$(absolute "$MAZE_DATA_DIR")"
else
  # The server refuses an event log written against another chain instance.
  DATA_DIR="$STATE_DIR/data"
  rm -rf "$DATA_DIR"
fi
mkdir -p "$DATA_DIR"

UP=0
cleanup() {
  if [ "$UP" -ne 1 ]; then
    MAZE_ANVIL_PORT="$ANVIL_PORT" MAZE_NEXT_PORT="$NEXT_PORT" bash "$SCRIPT_DIR/dev-down.sh" >&2 || true
  fi
}
trap cleanup EXIT

# ----- 1. Anvil -----

say "starting anvil --block-time 1 on port $ANVIL_PORT"
nohup anvil --port "$ANVIL_PORT" --block-time 1 >"$STATE_DIR/anvil.log" 2>&1 </dev/null &
ANVIL_PID=$!
echo "$ANVIL_PID" >"$ANVIL_PID_FILE"

chain_id() {
  curl -s -m 2 -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL_LOCAL" 2>/dev/null |
    sed -nE 's/.*"result"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]+)".*/\1/p'
}

READY=""
for _ in $(seq 1 100); do
  kill -0 "$ANVIL_PID" 2>/dev/null || { tail -n 20 "$STATE_DIR/anvil.log" >&2; die "anvil exited"; }
  READY="$(chain_id || true)"
  [ -n "$READY" ] && break
  sleep 0.2
done
[ -n "$READY" ] || die "anvil did not answer on $RPC_URL_LOCAL"

# ----- 2. deploy and fund -----

DEPLOY_ARGS=(--port "$ANVIL_PORT")
if [ -n "$FIXTURE" ]; then
  say "deploying MazeBet with the test table $FIXTURE and funding the house"
  DEPLOY_ARGS+=(--table "$FIXTURE")
else
  say "deploying MazeBet with the production table and funding the house"
fi
(cd "$ROOT_DIR" && node_modules/.bin/tsx scripts/deploy-local.ts "${DEPLOY_ARGS[@]}") >"$STATE_DIR/deploy.log" ||
  { cat "$STATE_DIR/deploy.log" >&2; die "the deployment failed"; }

DEPLOYMENT_FILE="$ROOT_DIR/$(maze_deployment_file "$ANVIL_PORT")"
[ -f "$DEPLOYMENT_FILE" ] || die "$DEPLOYMENT_FILE was not written"
deployment() {
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (value === undefined) process.exit(1);
    process.stdout.write(String(value));
  ' "$DEPLOYMENT_FILE" "$1" || die "$DEPLOYMENT_FILE has no \"$1\""
}
DEPLOYED_RPC_URL="$(deployment rpcUrl)"
DEPLOYED_CHAIN_ID="$(deployment chainId)"
DEPLOYED_ADDRESS="$(deployment mazeBetAddress)"

# ----- 3. build -----

if [ "${MAZE_SKIP_BUILD:-}" = "1" ] && [ -f "$WEB_DIR/$DIST_DIR/BUILD_ID" ]; then
  say "reusing the build in apps/web/$DIST_DIR"
else
  say "building the app into apps/web/$DIST_DIR"
  (cd "$ROOT_DIR" && NEXT_DIST_DIR="$DIST_DIR" pnpm --filter @maze/web build) >"$STATE_DIR/build.log" 2>&1 ||
    { tail -n 40 "$STATE_DIR/build.log" >&2; die "the build failed"; }
fi

# ----- 4. the app -----

if [ -n "$FIXTURE" ]; then export MAZE_TUNING_FIXTURE="$FIXTURE"; fi
# The app's environment. Exported in a subshell, so nothing leaks into what runs after it.
(
  export RPC_URL="$DEPLOYED_RPC_URL"
  export CHAIN_ID="$DEPLOYED_CHAIN_ID"
  export MAZEBET_ADDRESS="$DEPLOYED_ADDRESS"
  export SERVER_SIGNER_PRIVATE_KEY="${SERVER_SIGNER_PRIVATE_KEY:-$DEFAULT_SIGNER_KEY}"
  export RELAYER_PRIVATE_KEY="${RELAYER_PRIVATE_KEY:-$SERVER_SIGNER_PRIVATE_KEY}"
  export MAZE_DATA_DIR="$DATA_DIR"
  export NEXT_PUBLIC_ENABLE_DEV_WALLET="${NEXT_PUBLIC_ENABLE_DEV_WALLET-1}"
  export NEXT_DIST_DIR="$DIST_DIR"
  cd "$WEB_DIR"
  if [ "$SUPERVISE" -eq 1 ]; then
    nohup bash "$SCRIPT_DIR/dev-up.sh" --supervise "$STATE_DIR" -- \
      node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port "$NEXT_PORT" \
      >"$STATE_DIR/next.log" 2>&1 </dev/null &
    echo $! >"$SUPERVISOR_PID_FILE"
  else
    nohup node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port "$NEXT_PORT" \
      >"$STATE_DIR/next.log" 2>&1 </dev/null &
    echo $! >"$NEXT_PID_FILE"
  fi
)
if [ "$SUPERVISE" -eq 1 ]; then
  say "starting the app on port $NEXT_PORT under a restarting supervisor"
else
  say "starting the app on port $NEXT_PORT (no supervisor: nothing restarts it)"
fi

# ----- 5. wait until healthy -----

# True while the first start of the app is still running: with a supervisor, it and its app are
# alive and the app has not exited once; without one, the app is alive.
app_starting() {
  if [ "$SUPERVISE" -eq 1 ]; then
    kill -0 "$(cat "$SUPERVISOR_PID_FILE")" 2>/dev/null && [ ! -f "$STATE_DIR/restarts" ]
  else
    kill -0 "$(cat "$NEXT_PID_FILE")" 2>/dev/null
  fi
}

CONFIG=""
for _ in $(seq 1 120); do
  if ! app_starting; then
    tail -n 20 "$STATE_DIR/next.log" >&2
    die "the app exited during start (see the boot-failed line above)"
  fi
  CONFIG="$(curl -sf -m 5 "$APP_URL/api/config" 2>/dev/null || true)"
  [ -n "$CONFIG" ] && break
  sleep 0.5
done
if [ -z "$CONFIG" ]; then
  tail -n 20 "$STATE_DIR/next.log" >&2
  die "the app did not answer GET /api/config within 60 seconds"
fi
printf '%s' "$CONFIG" | grep -qi "\"contract\":\"$DEPLOYED_ADDRESS\"" ||
  die "GET /api/config does not report the deployed contract $DEPLOYED_ADDRESS"
NEXT_PID="$(cat "$NEXT_PID_FILE")"

UP=1
say "up"
echo "  app       http://localhost:$NEXT_PORT   (pid $NEXT_PID, log .data/dev-up-$NEXT_PORT/next.log)"
if [ "$SUPERVISE" -eq 1 ]; then
  echo "  restarts  supervisor pid $(cat "$SUPERVISOR_PID_FILE") starts the app again when it exits (log .data/dev-up-$NEXT_PORT/supervisor.log)"
fi
if [ -n "$HOOK_FLAGS" ]; then
  echo "  WARNING   test hooks are ON: mazes can be computed from public data. For automated tests only."
fi
echo "  chain     $DEPLOYED_RPC_URL   (pid $ANVIL_PID, log .data/dev-up-$NEXT_PORT/anvil.log)"
echo "  contract  $DEPLOYED_ADDRESS   ($(maze_deployment_file "$ANVIL_PORT"))"
if [ "$ANVIL_PORT" = "$MAZE_DEV_ANVIL_PORT" ] && [ "$NEXT_PORT" = "$MAZE_DEV_NEXT_PORT" ]; then
  echo "  stop      pnpm dev:down"
else
  echo "  stop      MAZE_ANVIL_PORT=$ANVIL_PORT MAZE_NEXT_PORT=$NEXT_PORT pnpm dev:down"
fi
