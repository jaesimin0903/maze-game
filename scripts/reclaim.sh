#!/usr/bin/env bash
# Reclaims the bet of a game the server never settled (plan §9.1, scenario 10).
#
# This is the recovery path when the game server is down: it talks to the chain only.
# Anyone may call `reclaim`; the money always goes to the game's player. The contract accepts
# it only after the game's settle deadline.
#
#   scripts/reclaim.sh <gameId> [--rpc-url URL | --port PORT] [--address MAZEBET] [--private-key KEY]
#
# Defaults: the dev Anvil port from scripts/ports.sh, the contract address from
# deployments/local-<port>.json, and Anvil account #9 as the (third-party) sender.
# Environment: RPC_URL, MAZEBET_ADDRESS, RECLAIM_PRIVATE_KEY.
#
# Exit codes: 0 reclaimed, 1 the contract refused (the reason is printed), 2 usage or setup error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/ports.sh
. "$SCRIPT_DIR/ports.sh"

# Anvil default account #9. A public, well-known test key.
DEFAULT_KEY=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6

usage() {
  echo "usage: scripts/reclaim.sh <gameId> [--rpc-url URL | --port PORT] [--address MAZEBET] [--private-key KEY]" >&2
  exit 2
}

GAME_ID=""
RPC="${RPC_URL:-}"
PORT=""
ADDRESS="${MAZEBET_ADDRESS:-}"
KEY="${RECLAIM_PRIVATE_KEY:-$DEFAULT_KEY}"

while [ $# -gt 0 ]; do
  case "$1" in
    --rpc-url) [ $# -ge 2 ] || usage; RPC="$2"; shift 2 ;;
    --port) [ $# -ge 2 ] || usage; PORT="$2"; shift 2 ;;
    --address) [ $# -ge 2 ] || usage; ADDRESS="$2"; shift 2 ;;
    --private-key) [ $# -ge 2 ] || usage; KEY="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "reclaim.sh: unknown option $1" >&2; usage ;;
    *) [ -z "$GAME_ID" ] || usage; GAME_ID="$1"; shift ;;
  esac
done

if ! [[ "$GAME_ID" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "reclaim.sh: <gameId> must be 32 bytes of 0x-prefixed hex" >&2
  usage
fi
command -v cast >/dev/null 2>&1 || { echo "reclaim.sh: cast (Foundry) is not installed" >&2; exit 2; }

if [ -z "$RPC" ]; then
  RPC="http://127.0.0.1:${PORT:-$MAZE_DEV_ANVIL_PORT}"
fi
if [ -z "$PORT" ]; then
  PORT="$(printf '%s' "$RPC" | sed -nE 's#^[a-z]+://[^/:]+:([0-9]+).*$#\1#p')"
fi

if [ -z "$ADDRESS" ]; then
  DEPLOYMENT="$ROOT_DIR/$(maze_deployment_file "${PORT:-$MAZE_DEV_ANVIL_PORT}")"
  if [ ! -f "$DEPLOYMENT" ]; then
    echo "reclaim.sh: $DEPLOYMENT not found; pass --address or set MAZEBET_ADDRESS" >&2
    exit 2
  fi
  ADDRESS="$(sed -nE 's/.*"mazeBetAddress"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]{40})".*/\1/p' "$DEPLOYMENT" | head -n 1)"
fi
if ! [[ "$ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "reclaim.sh: no contract address" >&2
  exit 2
fi

SENDER="$(cast wallet address --private-key "$KEY")"
NOT_REACHED="$(cast sig 'DeadlineNotReached()')"
NOT_ACTIVE="$(cast sig 'GameNotActive()')"

# Names the contract's refusal when the output of a failed cast command carries its selector.
explain() {
  local output="$1"
  if printf '%s' "$output" | grep -qiE "DeadlineNotReached|${NOT_REACHED#0x}"; then
    echo "reclaim.sh: DeadlineNotReached: the settle deadline of $GAME_ID has not passed yet" >&2
  elif printf '%s' "$output" | grep -qiE "GameNotActive|${NOT_ACTIVE#0x}"; then
    echo "reclaim.sh: GameNotActive: $GAME_ID is not an active game (never created, settled, or already reclaimed)" >&2
  else
    echo "reclaim.sh: reclaim failed" >&2
    printf '%s\n' "$output" >&2
  fi
}

# Dry run first, so that a refusal costs no gas and is reported by name.
if ! OUTPUT="$(cast call "$ADDRESS" 'reclaim(bytes32)' "$GAME_ID" --from "$SENDER" --rpc-url "$RPC" 2>&1)"; then
  explain "$OUTPUT"
  exit 1
fi

if ! OUTPUT="$(cast send "$ADDRESS" 'reclaim(bytes32)' "$GAME_ID" --private-key "$KEY" --rpc-url "$RPC" --json 2>&1)"; then
  explain "$OUTPUT"
  exit 1
fi

STATUS="$(printf '%s' "$OUTPUT" | sed -nE 's/.*"status"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]+)".*/\1/p' | head -n 1)"
TX_HASH="$(printf '%s' "$OUTPUT" | sed -nE 's/.*"transactionHash"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]{64})".*/\1/p' | head -n 1)"
if [ "$STATUS" != "0x1" ]; then
  echo "reclaim.sh: the reclaim transaction ${TX_HASH:-} reverted" >&2
  exit 1
fi

echo "reclaimed $GAME_ID tx $TX_HASH"
