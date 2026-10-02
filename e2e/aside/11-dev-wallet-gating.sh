#!/usr/bin/env bash
# 11 dev-wallet gating (AC-A4, AC-T8).
#
# The dev wallet must be offered only when the server's config says so, and the page must learn
# that from GET /api/config at run time, not from the build. So the same build is started twice
# on the same chain: first with NEXT_PUBLIC_ENABLE_DEV_WALLET=0, then with 1.
#
#   HTTP   /api/config reports devWallet false, then true after the restart; chain id 31337 and
#          the same contract both times
#   DOM    with devWallet false the lobby renders (wallet-connect is there, the page is fully
#          up) but wallet-dev-option and wallet-dev-account are not in the DOM and bet-submit
#          is disabled; after the restart and a reload the option is there and connects
#          Anvil #2
#   chain  the chain is 31337; no game was created while no wallet could be connected
#
# The scenario never clicks wallet-connect: that button talks to whatever wallet extension the
# user's browser has installed.
#
# Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED.

set -u
# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

scenario_begin 11 dev-wallet-gating "the dev wallet is offered only when /api/config says devWallet, with the same build"
require_input_path
stack_up NEXT_PUBLIC_ENABLE_DEV_WALLET=0
aside_start || blocked_scenario "the aside repl session did not start (see $ASIDE_LOG)"

# ----- devWallet off -----

check http "/api/config: devWallet is false when NEXT_PUBLIC_ENABLE_DEV_WALLET=0" false "$(printf '%s' "$CONFIG_JSON" | jq -r '.devWallet')"
check http "/api/config: the chain is 31337" 31337 "$(printf '%s' "$CONFIG_JSON" | jq -r '.chainId')"
check chain "the chain id is 31337" 31337 "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)"

open_lobby A
expect_present "the lobby is up: wallet-connect is offered" A wallet-connect 10
expect_attr "the page knows the chain from /api/config" A chain-info data-chain-id 31337 5
expect_absent "wallet-dev-option is not in the DOM while devWallet is false" A wallet-dev-option 3
expect_absent "wallet-dev-account is not in the DOM while devWallet is false" A wallet-dev-account 1
if SUBMIT="$(dom_item A bet-submit)" && [ "$SUBMIT" != null ]; then
  check dom "bet-submit is disabled without a wallet" true "$(printf '%s' "$SUBMIT" | jq -r '.attrs | has("disabled")')"
else
  dom_blocked "bet-submit is disabled without a wallet" "the DOM could not be read over path $READ_PATH"
fi
check chain "no game was created while no wallet could be connected" 0 \
  "$(event_logs 'GameCreated(bytes32 indexed,address indexed,uint8,uint256,uint256,bytes32,bytes32,uint64)' | jq 'length')"

# ----- the same build, devWallet on -----

app_stop
STACK_EXTRA=(NEXT_PUBLIC_ENABLE_DEV_WALLET=1)
app_start_again
http GET /api/config
check http "/api/config: devWallet is true after the restart with NEXT_PUBLIC_ENABLE_DEV_WALLET=1" true "$(http_field .devWallet)"
check_hex http "/api/config: the contract is unchanged" "$CONTRACT" "$(http_field .contract)"

ui 30 'M.reload("A")' || fail_scenario "reload failed: $ASIDE_ERROR"
expect_present "after a reload wallet-dev-option is in the DOM" A wallet-dev-option 30
connect_dev_wallet A
check_hex dom "the dev wallet connects Anvil account #2" "$PLAYER_ADDR" "$WALLET_SHOWN"
expect_attr "the connected wallet is the dev wallet" A wallet-address data-kind dev 5

scenario_end
