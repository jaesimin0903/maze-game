#!/usr/bin/env bash
# Port allocation for local runs (plan §8.2). Source this file instead of hard-coding ports:
#   . "$(dirname "${BASH_SOURCE[0]}")/ports.sh"
#
# | use                   | Anvil    | Next     |
# | pnpm dev:up           | 8545     | 3000     |
# | WS-C integration test | 8546     | -        |
# | WS-G audit test       | 8547     | 3047     |
# | WS-F scenario i       | 8550 + i | 3050 + i |

MAZE_DEV_ANVIL_PORT=8545
MAZE_DEV_NEXT_PORT=3000

MAZE_INT_ANVIL_PORT=8546

MAZE_AUDIT_ANVIL_PORT=8547
MAZE_AUDIT_NEXT_PORT=3047

MAZE_E2E_ANVIL_PORT_BASE=8550
MAZE_E2E_NEXT_PORT_BASE=3050

# Scenario numbers may be zero-padded ("08"), so force base 10.
maze_e2e_anvil_port() {
  echo $((MAZE_E2E_ANVIL_PORT_BASE + 10#$1))
}

maze_e2e_next_port() {
  echo $((MAZE_E2E_NEXT_PORT_BASE + 10#$1))
}

# NEXT_DIST_DIR for scenario i, so that builds never share ".next".
maze_e2e_dist_dir() {
  echo ".next-f-$((10#$1))"
}

# Deployment record written by scripts/deploy-local.ts for the Anvil on the given port.
maze_deployment_file() {
  echo "deployments/local-$1.json"
}
