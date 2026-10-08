#!/bin/sh
# Entry point of the container image (Dockerfile): starts the game server (Next's standalone
# `server.js`) on $PORT (default 3000).
#
# Like `pnpm start:web`, it refuses to start while a test-hook flag is set in the environment:
# with them, every maze can be computed from public data.
#
# MAZE_DATA_DIR must be a persistent volume, and only one server may use it. An exclusive `flock`
# on `container.lock` in it is held for as long as the server runs (the server inherits the
# descriptor), so a second container on the same volume stops here. The event log's own lock
# (`events.lock`) holds the pid of the process that had the log open, and the server exits without
# removing it; pids start over in every container, so that pid may now belong to a live process
# and would refuse the start. While `container.lock` is held no other server can have the log
# open, so a stale `events.lock` is removed then, and only then.

set -eu

if [ -n "${MAZE_ALLOW_TEST_HOOKS:-}${MAZE_TEST_SEED_SECRET:-}${MAZE_TUNING_FIXTURE:-}" ]; then
  echo 'container-start: refusing to start, a test-hook flag is set in the environment' >&2
  exit 1
fi
: "${MAZE_DATA_DIR:?container-start: MAZE_DATA_DIR is not set}"

mkdir -p "$MAZE_DATA_DIR"
exec 9>>"$MAZE_DATA_DIR/container.lock"
if ! flock -n 9; then
  echo "container-start: refusing to start, another server holds $MAZE_DATA_DIR/container.lock" >&2
  exit 1
fi
rm -f "$MAZE_DATA_DIR/events.lock"

cd /app/apps/web
# Docker sets HOSTNAME to the container id; the standalone server binds to HOSTNAME.
export HOSTNAME=0.0.0.0
export PORT="${PORT:-3000}"
exec node server.js
