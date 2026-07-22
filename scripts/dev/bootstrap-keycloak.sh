#!/bin/sh
set -eu

SERVER_URL=${KEYCLOAK_ADMIN_BASE_URL:-http://keycloak:8080}
REALM=${KEYCLOAK_REALM:-cyber-range}
KEYCLOAK_ADMIN_USERNAME=${KEYCLOAK_ADMIN_USERNAME:-admin}
KEYCLOAK_ADMIN_PASSWORD=${KEYCLOAK_ADMIN_PASSWORD:-change-me}
PLATFORM_ADMIN_USERNAME=${PLATFORM_ADMIN_USERNAME:-${ADMIN_USERNAME:-${KEYCLOAK_ADMIN_USERNAME}}}
PLATFORM_ADMIN_PASSWORD=${PLATFORM_ADMIN_PASSWORD:-${ADMIN_PASSWORD:-${KEYCLOAK_ADMIN_PASSWORD}}}
WEB_PUBLIC_URL=${WEB_PUBLIC_URL:-http://localhost:3000}
WEB_PUBLIC_URL=${WEB_PUBLIC_URL%/}
KEYCLOAK_ADMIN_CLIENT_ID=${KEYCLOAK_ADMIN_CLIENT_ID:-platform-admin}
KEYCLOAK_ADMIN_CLIENT_SECRET=${KEYCLOAK_ADMIN_CLIENT_SECRET:-platform-admin-dev-only}
MCP_OIDC_CLIENT_ID=${MCP_OIDC_CLIENT_ID:-mcp-gateway}
MCP_OIDC_CLIENT_SECRET=${MCP_OIDC_CLIENT_SECRET:-mcp-gateway-dev-only}
MCP_SMOKE_CLIENT_ID=${MCP_SMOKE_CLIENT_ID:-smoke-conf}
MCP_SMOKE_CLIENT_SECRET=${MCP_SMOKE_CLIENT_SECRET:-smoke-secret}
MCP_SMOKE_OIDC_CLIENT_ID=${MCP_SMOKE_OIDC_CLIENT_ID:-mcp-smoke-sa}
MCP_SMOKE_OIDC_CLIENT_SECRET=${MCP_SMOKE_OIDC_CLIENT_SECRET:-mcp-smoke-secret}

json_first_id() {
  sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sed -n '1p'
}

find_exact_user_id() {
  username=$1
  /opt/keycloak/bin/kcadm.sh get users -r "$REALM" -q exact=true -q username="$username" | json_first_id
}

until /opt/keycloak/bin/kcadm.sh config credentials \
  --server "$SERVER_URL" \
  --realm master \
  --user "$KEYCLOAK_ADMIN_USERNAME" \
  --password "$KEYCLOAK_ADMIN_PASSWORD" >/dev/null 2>&1; do
  sleep 2
done

/opt/keycloak/bin/kcadm.sh update "realms/$REALM" \
  -s sslRequired=NONE \
  -s loginTheme=cyber-range \
  -s registrationAllowed=false \
  -s accessTokenLifespan=604800 \
  -s ssoSessionIdleTimeout=604800 \
  -s ssoSessionMaxLifespan=604800

ADMIN_REALM_USER_ID=$(find_exact_user_id "$PLATFORM_ADMIN_USERNAME")

if [ -z "$ADMIN_REALM_USER_ID" ]; then
  ADMIN_REALM_USER_ID=$(
    /opt/keycloak/bin/kcadm.sh create users -r "$REALM" \
      -s username="$PLATFORM_ADMIN_USERNAME" \
      -s enabled=true \
      -s emailVerified=true \
      -s firstName=Platform \
      -s lastName=Admin \
      -s email="${PLATFORM_ADMIN_USERNAME}@example.local" \
      -i
  )
fi

/opt/keycloak/bin/kcadm.sh update "users/$ADMIN_REALM_USER_ID" -r "$REALM" \
  -s enabled=true \
  -s emailVerified=true \
  -s firstName=Platform \
  -s lastName=Admin \
  -s email="${PLATFORM_ADMIN_USERNAME}@example.local" \
  -s 'requiredActions=[]' >/dev/null

/opt/keycloak/bin/kcadm.sh set-password -r "$REALM" --userid "$ADMIN_REALM_USER_ID" --new-password "$PLATFORM_ADMIN_PASSWORD" >/dev/null
/opt/keycloak/bin/kcadm.sh add-roles -r "$REALM" --uid "$ADMIN_REALM_USER_ID" --rolename admin >/dev/null 2>&1 || true

/opt/keycloak/bin/kcadm.sh add-roles \
  -r "$REALM" \
  --uusername service-account-platform-admin \
  --cclientid realm-management \
  --rolename manage-users \
  --rolename query-users \
  --rolename view-users \
  --rolename view-realm

PLATFORM_WEB_CLIENT_ID=$(/opt/keycloak/bin/kcadm.sh get clients -r "$REALM" -q clientId=platform-web | json_first_id)
PLATFORM_ADMIN_CLIENT_ID=$(/opt/keycloak/bin/kcadm.sh get clients -r "$REALM" -q clientId="$KEYCLOAK_ADMIN_CLIENT_ID" | json_first_id)
SMOKE_CLIENT_ID=$(/opt/keycloak/bin/kcadm.sh get clients -r "$REALM" -q clientId="$MCP_SMOKE_CLIENT_ID" | json_first_id)
MCP_SMOKE_SERVICE_CLIENT_ID=$(/opt/keycloak/bin/kcadm.sh get clients -r "$REALM" -q clientId="$MCP_SMOKE_OIDC_CLIENT_ID" | json_first_id)
MCP_GATEWAY_CLIENT_ID=$(/opt/keycloak/bin/kcadm.sh get clients -r "$REALM" -q clientId="$MCP_OIDC_CLIENT_ID" | json_first_id)
PLATFORM_API_CLIENT_ID=$(/opt/keycloak/bin/kcadm.sh get clients -r "$REALM" -q clientId=platform-api | json_first_id)

set_client_secret() {
  client_id=$1
  client_secret=$2

  [ -n "$client_id" ] || return
  /opt/keycloak/bin/kcadm.sh update "clients/$client_id" -r "$REALM" -s "secret=$client_secret" >/dev/null
}

set_client_secret "$PLATFORM_ADMIN_CLIENT_ID" "$KEYCLOAK_ADMIN_CLIENT_SECRET"
set_client_secret "$MCP_GATEWAY_CLIENT_ID" "$MCP_OIDC_CLIENT_SECRET"
set_client_secret "$SMOKE_CLIENT_ID" "$MCP_SMOKE_CLIENT_SECRET"
set_client_secret "$MCP_SMOKE_SERVICE_CLIENT_ID" "$MCP_SMOKE_OIDC_CLIENT_SECRET"

ensure_audience_mapper() {
  client_id=$1
  mapper_name=$2
  audience=$3
  mapper_id=$(/opt/keycloak/bin/kcadm.sh get "clients/$client_id/protocol-mappers/models" -r "$REALM" | sed -n "/\"name\"[[:space:]]*:[[:space:]]*\"$mapper_name\"/{x;p;d;}; h" | json_first_id)

  [ -n "$mapper_id" ] || /opt/keycloak/bin/kcadm.sh create "clients/$client_id/protocol-mappers/models" -r "$REALM" \
    -s name="$mapper_name" \
    -s protocol=openid-connect \
    -s protocolMapper=oidc-audience-mapper \
    -s consentRequired=false \
    -s "config.\"included.client.audience\"=$audience" \
    -s 'config."id.token.claim"=false' \
    -s 'config."access.token.claim"=true' \
    -s 'config."lightweight.claim"=false' >/dev/null
}

ensure_subject_mapper() {
  client_id=$1
  mapper_id=$(/opt/keycloak/bin/kcadm.sh get "clients/$client_id/protocol-mappers/models" -r "$REALM" | sed -n '/"name"[[:space:]]*:[[:space:]]*"sub-direct"/{x;p;d;}; h' | json_first_id)

  [ -n "$mapper_id" ] || /opt/keycloak/bin/kcadm.sh create "clients/$client_id/protocol-mappers/models" -r "$REALM" \
    -s name=sub-direct \
    -s protocol=openid-connect \
    -s protocolMapper=oidc-usermodel-property-mapper \
    -s consentRequired=false \
    -s 'config."user.attribute"=id' \
    -s 'config."claim.name"=sub' \
    -s 'config."jsonType.label"=String' \
    -s 'config."id.token.claim"=true' \
    -s 'config."access.token.claim"=true' \
    -s 'config."userinfo.token.claim"=true' \
    -s 'config."introspection.token.claim"=true' >/dev/null
}

ensure_preferred_username_mapper() {
  client_id=$1
  mapper_id=$(/opt/keycloak/bin/kcadm.sh get "clients/$client_id/protocol-mappers/models" -r "$REALM" | sed -n '/"name"[[:space:]]*:[[:space:]]*"preferred-username-direct"/{x;p;d;}; h' | json_first_id)

  [ -n "$mapper_id" ] || /opt/keycloak/bin/kcadm.sh create "clients/$client_id/protocol-mappers/models" -r "$REALM" \
    -s name=preferred-username-direct \
    -s protocol=openid-connect \
    -s protocolMapper=oidc-usermodel-property-mapper \
    -s consentRequired=false \
    -s 'config."user.attribute"=username' \
    -s 'config."claim.name"=preferred_username' \
    -s 'config."jsonType.label"=String' \
    -s 'config."id.token.claim"=true' \
    -s 'config."access.token.claim"=true' \
    -s 'config."userinfo.token.claim"=true' \
    -s 'config."introspection.token.claim"=true' >/dev/null
}

ensure_realm_roles_mapper() {
  client_id=$1
  mapper_id=$(/opt/keycloak/bin/kcadm.sh get "clients/$client_id/protocol-mappers/models" -r "$REALM" | sed -n '/"name"[[:space:]]*:[[:space:]]*"realm-roles-direct"/{x;p;d;}; h' | json_first_id)

  [ -n "$mapper_id" ] || /opt/keycloak/bin/kcadm.sh create "clients/$client_id/protocol-mappers/models" -r "$REALM" \
    -s name=realm-roles-direct \
    -s protocol=openid-connect \
    -s protocolMapper=oidc-usermodel-realm-role-mapper \
    -s consentRequired=false \
    -s 'config."claim.name"=realm_access.roles' \
    -s 'config."jsonType.label"=String' \
    -s 'config."multivalued"=true' \
    -s 'config."id.token.claim"=true' \
    -s 'config."access.token.claim"=true' \
    -s 'config."userinfo.token.claim"=true' >/dev/null
}

 /opt/keycloak/bin/kcadm.sh update "clients/$PLATFORM_WEB_CLIENT_ID" -r "$REALM" \
  -s "redirectUris=[\"${WEB_PUBLIC_URL}/*\"]" \
  -s "webOrigins=[\"${WEB_PUBLIC_URL}\"]" >/dev/null
ensure_subject_mapper "$PLATFORM_WEB_CLIENT_ID"
ensure_preferred_username_mapper "$PLATFORM_WEB_CLIENT_ID"
ensure_realm_roles_mapper "$PLATFORM_WEB_CLIENT_ID"
ensure_audience_mapper "$PLATFORM_WEB_CLIENT_ID" aud-mcp-gateway-direct mcp-gateway
ensure_audience_mapper "$PLATFORM_WEB_CLIENT_ID" aud-platform-api-direct platform-api

if [ -n "$SMOKE_CLIENT_ID" ]; then
  ensure_subject_mapper "$SMOKE_CLIENT_ID"
  ensure_preferred_username_mapper "$SMOKE_CLIENT_ID"
  ensure_realm_roles_mapper "$SMOKE_CLIENT_ID"
  ensure_audience_mapper "$SMOKE_CLIENT_ID" aud-mcp-gateway-direct mcp-gateway
  ensure_audience_mapper "$SMOKE_CLIENT_ID" aud-platform-api-direct platform-api
fi

ensure_subject_mapper "$PLATFORM_API_CLIENT_ID"

REALM_MANAGEMENT_CLIENT_ID=$(/opt/keycloak/bin/kcadm.sh get clients -r "$REALM" -q clientId=realm-management | json_first_id)

/opt/keycloak/bin/kcadm.sh update "clients/$PLATFORM_API_CLIENT_ID/management/permissions" -r "$REALM" -s enabled=true >/dev/null

/opt/keycloak/bin/kcadm.sh create "clients/$REALM_MANAGEMENT_CLIENT_ID/authz/resource-server/policy/client" -r "$REALM" \
  -s name=allow-mcp-gateway-token-exchange \
  -s logic=POSITIVE \
  -s decisionStrategy=UNANIMOUS \
  -s "clients=[\"$MCP_GATEWAY_CLIENT_ID\"]" >/dev/null 2>&1 || true

TOKEN_EXCHANGE_PERMISSION_ID=$(
  /opt/keycloak/bin/kcadm.sh get "clients/$PLATFORM_API_CLIENT_ID/management/permissions" -r "$REALM" | \
    sed -n 's/.*"token-exchange"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
)

[ -n "$TOKEN_EXCHANGE_PERMISSION_ID" ] && \
  /opt/keycloak/bin/kcadm.sh update "clients/$REALM_MANAGEMENT_CLIENT_ID/authz/resource-server/permission/scope/$TOKEN_EXCHANGE_PERMISSION_ID" -r "$REALM" \
    -s 'policies=["allow-mcp-gateway-token-exchange"]' >/dev/null
