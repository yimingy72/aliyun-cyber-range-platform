#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

API_BASE_URL=${API_BASE_URL:-http://127.0.0.1:${API_PORT:-3001}}
MCP_URL=${MCP_URL:-http://127.0.0.1:${MCP_PORT:-8787}/mcp}
OIDC_TOKEN_ENDPOINT=${OIDC_TOKEN_ENDPOINT:-http://127.0.0.1:${KEYCLOAK_PORT:-8080}/realms/${KEYCLOAK_REALM:-cyber-range}/protocol/openid-connect/token}
ADMIN_USERNAME_VALUE=${MCP_SMOKE_USERNAME:-mcp-smoke-sa}
ADMIN_PASSWORD_VALUE=${MCP_SMOKE_PASSWORD:-${ADMIN_PASSWORD:-change-me}}
MCP_SMOKE_OIDC_CLIENT_ID_VALUE=${MCP_SMOKE_OIDC_CLIENT_ID:-mcp-smoke-sa}
MCP_SMOKE_OIDC_CLIENT_SECRET_VALUE=${MCP_SMOKE_OIDC_CLIENT_SECRET:-mcp-smoke-secret}
COMPOSE_BAKE_VALUE=${COMPOSE_BAKE:-false}
SERVICES=(postgres api mcp)
SKIP_UP=${MCP_SMOKE_SKIP_UP:-0}

json_first_id() {
  sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sed -n '1p'
}

ensure_smoke_prerequisites() {
  echo '==> ensure smoke oidc service-account mapping'

  docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh config credentials \
    --server http://localhost:8080 \
    --realm master \
    --user "${KEYCLOAK_ADMIN_USERNAME:-admin}" \
    --password "${KEYCLOAK_ADMIN_PASSWORD:-change-me}" >/dev/null

  local client_id user_id
  client_id=$(docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh get clients -r "${KEYCLOAK_REALM:-cyber-range}" -q clientId="$MCP_SMOKE_OIDC_CLIENT_ID_VALUE" | json_first_id)
  [ -n "$client_id" ]
  user_id=$(docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh get clients/"$client_id"/service-account-user -r "${KEYCLOAK_REALM:-cyber-range}" | json_first_id)
  [ -n "$user_id" ]

  docker compose exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-cyber_range}" <<SQL >/dev/null
insert into "PlatformUser" ("id","username","passwordHash","role","status","oidcIssuer","oidcSubject","createdAt","updatedAt")
values ('$ADMIN_USERNAME_VALUE','$ADMIN_USERNAME_VALUE','smoke-unused','admin','active','http://localhost:${KEYCLOAK_PORT:-8080}/realms/${KEYCLOAK_REALM:-cyber-range}','$user_id',now(),now())
on conflict ("id") do update set
  "username"=excluded."username",
  "role"=excluded."role",
  "status"=excluded."status",
  "oidcIssuer"=excluded."oidcIssuer",
  "oidcSubject"=excluded."oidcSubject",
  "updatedAt"=now();
SQL
}

wait_for_http() {
  local url=$1
  local label=$2

  for _ in $(seq 1 120); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "$label did not become ready: $url" >&2
  return 1
}

if [ "$SKIP_UP" != "1" ]; then
  echo '==> compose up'
  COMPOSE_BAKE=$COMPOSE_BAKE_VALUE docker compose up -d --build "${SERVICES[@]}"
else
  echo '==> compose up skipped'
fi

echo '==> waiting for api and mcp'
wait_for_http "$API_BASE_URL/health" 'api'
wait_for_http "${MCP_URL%/mcp}/healthz" 'mcp'

ensure_smoke_prerequisites

echo '==> get oidc access token'
TOKEN=$(
  curl -fsS "$OIDC_TOKEN_ENDPOINT" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=client_credentials' \
    --data-urlencode "client_id=$MCP_SMOKE_OIDC_CLIENT_ID_VALUE" \
    --data-urlencode "client_secret=$MCP_SMOKE_OIDC_CLIENT_SECRET_VALUE" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s); if(!x.access_token){process.exit(1)}; process.stdout.write(x.access_token)})"
)

echo '==> mcp smoke:http'
MCP_URL="$MCP_URL" MCP_BEARER_TOKEN="$TOKEN" pnpm --filter @aliyun-cyber-range/mcp smoke:http
