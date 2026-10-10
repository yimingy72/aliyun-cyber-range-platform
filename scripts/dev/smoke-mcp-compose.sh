#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

MCP_BEARER_TOKEN=${MCP_BEARER_TOKEN:-}
if [[ -z "${MCP_BEARER_TOKEN//[[:space:]]/}" ]]; then
  echo 'MCP_BEARER_TOKEN is required; use an existing enabled platform user OIDC token.' >&2
  exit 1
fi

# The gateway already runs in this container; never start services or bootstrap identities.
export MCP_URL=http://127.0.0.1:8787/mcp
export MCP_SMOKE_TOOL="${MCP_SMOKE_TOOL:-range_template_list}"
MCP_SMOKE_ARGS=${MCP_SMOKE_ARGS:-}
if [[ -z "$MCP_SMOKE_ARGS" ]]; then MCP_SMOKE_ARGS='{"view":"platform"}'; fi
export MCP_SMOKE_ARGS

docker compose exec -T \
  -e MCP_URL -e MCP_BEARER_TOKEN -e MCP_SMOKE_TOOL -e MCP_SMOKE_ARGS \
  mcp pnpm --filter @aliyun-cyber-range/mcp smoke:http
