#!/usr/bin/env bash
# Starts the local stack (plan §8.4 step 3.1): a fresh Anvil, the MazeBet contract with the house
# funded, and the web app built and started against that deployment.
#
#   pnpm dev:up
#   MAZE_ALLOW_TEST_HOOKS=1 MAZE_TUNING_FIXTURE=packages/shared/test/fixtures/tuning.fixture.json pnpm dev:up
#
# What it does, in order:
#   1. starts `anvil --block-time 1` on the Anvil port;
#   2. deploys and funds the contract with scripts/deploy-local.ts, which writes
#      deployments/local-<port>.json;
#   3. builds the app into its own NEXT_DIST_DIR;
#   4. reads the deployment file and starts the app with those values as environment variables,
#      listening on the loopback interface only (the app may be running with test hooks);
#   5. waits until GET /api/config answers.
# `pnpm dev:down` stops the two processes this script started, by the PIDs recorded under
# .data/dev-up-<next port>/.
#
# Test-hook flags (MAZE_ALLOW_TEST_HOOKS, MAZE_TEST_SEED_SECRET, MAZE_TUNING_FIXTURE) are taken
# from the invoking command line only and are handed to the app through its process environment.
# This script writes them to no file. Without MAZE_TUNING_FIXTURE the production table is
# deployed, and the app refuses to start while that table is not calibrated (AC-S8).
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
RPC_URL_LOCAL="http://127.0.0.1:$ANVIL_PORT"
APP_URL="http://127.0.0.1:$NEXT_PORT"
# Where the caller stood: pnpm runs this script from the repository root and keeps the
# original directory in INIT_CWD.
CALLER_DIR="${INIT_CWD:-$PWD}"

say() { echo "dev:up: $*"; }
# die <message> [exit code]
die() { echo "dev:up: $1" >&2; exit "${2:-1}"; }

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

for file in "$ANVIL_PID_FILE" "$NEXT_PID_FILE"; do
  if [ -f "$file" ] && kill -0 "$(cat "$file")" 2>/dev/null; then
    die "already running (pid $(cat "$file"), $file). Run \"pnpm dev:down\" first." 2
  fi
done
port_in_use "$ANVIL_PORT" && die "port $ANVIL_PORT is in use by another process" 2
port_in_use "$NEXT_PORT" && die "port $NEXT_PORT is in use by another process" 2

mkdir -p "$STATE_DIR"
rm -f "$ANVIL_PID_FILE" "$NEXT_PID_FILE"

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

say "starting the app on port $NEXT_PORT"
if [ -n "$FIXTURE" ]; then export MAZE_TUNING_FIXTURE="$FIXTURE"; fi
cd "$WEB_DIR"
RPC_URL="$DEPLOYED_RPC_URL" \
  CHAIN_ID="$DEPLOYED_CHAIN_ID" \
  MAZEBET_ADDRESS="$DEPLOYED_ADDRESS" \
  SERVER_SIGNER_PRIVATE_KEY="${SERVER_SIGNER_PRIVATE_KEY:-$DEFAULT_SIGNER_KEY}" \
  RELAYER_PRIVATE_KEY="${RELAYER_PRIVATE_KEY:-${SERVER_SIGNER_PRIVATE_KEY:-$DEFAULT_SIGNER_KEY}}" \
  MAZE_DATA_DIR="$DATA_DIR" \
  NEXT_PUBLIC_ENABLE_DEV_WALLET="${NEXT_PUBLIC_ENABLE_DEV_WALLET-1}" \
  NEXT_DIST_DIR="$DIST_DIR" \
  nohup node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port "$NEXT_PORT" \
  >"$STATE_DIR/next.log" 2>&1 </dev/null &
NEXT_PID=$!
echo "$NEXT_PID" >"$NEXT_PID_FILE"
cd "$ROOT_DIR"

# ----- 5. wait until healthy -----

CONFIG=""
for _ in $(seq 1 120); do
  if ! kill -0 "$NEXT_PID" 2>/dev/null; then
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

UP=1
say "up"
echo "  app       http://localhost:$NEXT_PORT   (pid $NEXT_PID, log .data/dev-up-$NEXT_PORT/next.log)"
echo "  chain     $DEPLOYED_RPC_URL   (pid $ANVIL_PID, log .data/dev-up-$NEXT_PORT/anvil.log)"
echo "  contract  $DEPLOYED_ADDRESS   ($(maze_deployment_file "$ANVIL_PORT"))"
if [ "$ANVIL_PORT" = "$MAZE_DEV_ANVIL_PORT" ] && [ "$NEXT_PORT" = "$MAZE_DEV_NEXT_PORT" ]; then
  echo "  stop      pnpm dev:down"
else
  echo "  stop      MAZE_ANVIL_PORT=$ANVIL_PORT MAZE_NEXT_PORT=$NEXT_PORT pnpm dev:down"
fi
