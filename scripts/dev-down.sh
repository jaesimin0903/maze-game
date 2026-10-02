#!/usr/bin/env bash
# Stops the local stack started by scripts/dev-up.sh (plan §8.4 step 3.1).
#
#   pnpm dev:down
#
# Only the processes recorded in .data/dev-up-<next port>/{supervisor,next,anvil}.pid are
# signalled, and only after checking that each PID still is the process dev-up started: the
# supervisor must be the `dev-up.sh --supervise` command for this state directory, the app must be
# listening on the app port (or still be the `next start` command for it), Anvil must be the
# `anvil --port <port>` command. Nothing is ever stopped by name or pattern, so other dev
# servers on this machine are left alone.
#
# The supervisor goes first: it would start the app again the moment the app stops. On SIGTERM
# it stops the app itself; the app's own PID is then checked as well, in case the supervisor was
# already gone (a stack started with --no-supervisor has none).
#
# Environment: MAZE_ANVIL_PORT, MAZE_NEXT_PORT (the values dev-up was started with; default:
# the dev:up ports of scripts/ports.sh).
#
# Exit codes: 0 everything recorded is stopped (also when nothing was running), 1 a process did
# not stop.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/ports.sh
. "$SCRIPT_DIR/ports.sh"

ANVIL_PORT="${MAZE_ANVIL_PORT:-$MAZE_DEV_ANVIL_PORT}"
NEXT_PORT="${MAZE_NEXT_PORT:-$MAZE_DEV_NEXT_PORT}"
STATE_DIR="$ROOT_DIR/.data/dev-up-$NEXT_PORT"

say() { echo "dev:down: $*"; }

command_of() {
  ps -p "$1" -o command= 2>/dev/null || true
}

listens_on() {
  command -v lsof >/dev/null 2>&1 && lsof -nP -a -p "$1" -iTCP:"$2" -sTCP:LISTEN >/dev/null 2>&1
}

# stop <label> <pid file> <port> <pattern the command line must match>
stop() {
  local label="$1" file="$2" port="$3" pattern="$4" pid
  if [ ! -f "$file" ]; then
    say "$label: not running (no $(basename "$file"))"
    return 0
  fi
  pid="$(tr -cd '0-9' <"$file")"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    say "$label: pid ${pid:-?} is gone"
    rm -f "$file"
    return 0
  fi
  if ! listens_on "$pid" "$port" && ! command_of "$pid" | grep -Eq -- "$pattern"; then
    say "$label: pid $pid now belongs to another process; leaving it alone"
    rm -f "$file"
    return 0
  fi

  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    say "$label: pid $pid ignored SIGTERM, sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
    for _ in $(seq 1 25); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
  fi
  if kill -0 "$pid" 2>/dev/null; then
    say "$label: pid $pid did not stop"
    return 1
  fi
  rm -f "$file"
  say "$label: stopped pid $pid"
}

STATUS=0
stop "supervisor (port $NEXT_PORT)" "$STATE_DIR/supervisor.pid" "$NEXT_PORT" "dev-up\.sh --supervise .*/dev-up-$NEXT_PORT -- " || STATUS=1
# The app before the chain, so that it stops talking to the chain before the chain goes away.
stop "app (port $NEXT_PORT)" "$STATE_DIR/next.pid" "$NEXT_PORT" "next start .*--port $NEXT_PORT( |\$)" || STATUS=1
stop "anvil (port $ANVIL_PORT)" "$STATE_DIR/anvil.pid" "$ANVIL_PORT" "anvil --port $ANVIL_PORT( |\$)" || STATUS=1
exit "$STATUS"
