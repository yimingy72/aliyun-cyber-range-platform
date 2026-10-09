#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID="${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
CI_IMAGE="${CI_IMAGE:-cyber-range-ci:$RUN_ID}"
CI_NETWORK="cyber-range-ci-$RUN_ID"
CI_DB="cyber-range-ci-postgres-$RUN_ID"
CI_PACKED_DB="cyber-range-ci-packed-postgres-$RUN_ID"
CI_TAG_DB="cyber-range-ci-image-tags-postgres-$RUN_ID"
CI_TENCENT_IMAGE="cyber-range-tencentcloud-iac:$RUN_ID"
CI_PROVIDER_MIRROR_ARGS=()
if [ -n "${OPENTOFU_PROVIDER_MIRROR_HOST_PATH:-}" ]; then
  CI_PROVIDER_MIRROR_HOST="$(cd "${OPENTOFU_PROVIDER_MIRROR_HOST_PATH}" && pwd)"
  CI_PROVIDER_MIRROR_ARGS=(-v "${CI_PROVIDER_MIRROR_HOST}:/app/.local/provider-mirror:ro")
fi
if [ -n "${TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH:-}" ]; then
  CI_TENCENT_MIRROR_HOST="$(cd "${TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH}" && pwd)"
  CI_TENCENT_MIRROR_ARGS=(-v "${CI_TENCENT_MIRROR_HOST}:/app/.local/tencentcloud-provider/mirror:ro")
else
  CI_TENCENT_MIRROR_HOST="$REPO_ROOT/.local/tencentcloud-provider/mirror"
  mkdir -p "$CI_TENCENT_MIRROR_HOST"
  CI_TENCENT_MIRROR_ARGS=(-v "${CI_TENCENT_MIRROR_HOST}:/app/.local/tencentcloud-provider/mirror")
fi
CONTEXT_DIR="$(mktemp -d)"
CONTEXT_IMAGE="cyber-range-ci-context:$RUN_ID"

cleanup() {
  docker rm -f "$CI_DB" >/dev/null 2>&1 || true
  docker rm -f "$CI_PACKED_DB" >/dev/null 2>&1 || true
  docker rm -f "$CI_TAG_DB" >/dev/null 2>&1 || true
  docker network rm "$CI_NETWORK" >/dev/null 2>&1 || true
  docker image rm "$CONTEXT_IMAGE" >/dev/null 2>&1 || true
  docker image rm "$CI_TENCENT_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$CONTEXT_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$REPO_ROOT"
cp .dockerignore "$CONTEXT_DIR/.dockerignore"
mkdir -p "$CONTEXT_DIR/deploy/current-system"
touch "$CONTEXT_DIR/.env" "$CONTEXT_DIR/.env.local" "$CONTEXT_DIR/.env.example" \
  "$CONTEXT_DIR/deploy/current-system/.env" "$CONTEXT_DIR/deploy/current-system/.env.production" \
  "$CONTEXT_DIR/deploy/current-system/.env.example" "$CONTEXT_DIR/deploy/current-system/.env.local.example"
docker build --network none -t "$CONTEXT_IMAGE" -f - "$CONTEXT_DIR" <<'DOCKERFILE'
FROM node:22-alpine
COPY . /context
RUN test ! -e /context/.env && test ! -e /context/.env.local \
  && test ! -e /context/deploy/current-system/.env && test ! -e /context/deploy/current-system/.env.production \
  && test -e /context/.env.example && test -e /context/deploy/current-system/.env.example \
  && test -e /context/deploy/current-system/.env.local.example
DOCKERFILE
if [ -n "${CI_BASE_IMAGE:-}" ]; then
  # Local final verification can reuse a prepared dependency runtime without fetching packages again.
  docker build -t "$CI_IMAGE" -f - . <<DOCKERFILE
FROM ${OPENTOFU_IMAGE:-ghcr.io/opentofu/opentofu:1.13.1-minimal} AS tofu
FROM ${CI_BASE_IMAGE}
COPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu
WORKDIR /app
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm --filter @aliyun-cyber-range/database prisma:generate
DOCKERFILE
else
  docker build --build-arg "OPENTOFU_IMAGE=${OPENTOFU_IMAGE:-ghcr.io/opentofu/opentofu:1.13.1-minimal}" \
    --build-arg "PNPM_REGISTRY=${PNPM_REGISTRY:-https://registry.npmjs.org}" \
    -f scripts/ci/Dockerfile -t "$CI_IMAGE" .
fi
for compose_file in docker-compose.yml deploy/current-system/docker-compose.yml deploy/current-system/docker-compose.images.yml; do
  docker compose --env-file /dev/null -f "$compose_file" config --quiet
done

# Download/verify the pinned public archive in Docker, then test Tencent IaC without cloud network access.
docker run --rm --user "$(id -u):$(id -g)" "${CI_TENCENT_MIRROR_ARGS[@]}" \
  -e TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH=/app/.local/tencentcloud-provider/mirror \
  -e TENCENTCLOUD_PROVIDER_VERSION -e TENCENTCLOUD_PROVIDER_SHA256 -e TENCENTCLOUD_PROVIDER_DOWNLOAD_URL \
  "$CI_IMAGE" sh scripts/dev/download-tencentcloud-provider.sh
TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH="$CI_TENCENT_MIRROR_HOST" \
  TENCENTCLOUD_IAC_IMAGE="$CI_TENCENT_IMAGE" TENCENTCLOUD_RUN_ID="$RUN_ID" \
  sh scripts/dev/validate-tencentcloud-opentofu.sh

if [ "${#CI_PROVIDER_MIRROR_ARGS[@]}" = 0 ]; then
  # Build the pinned source patch in Docker before isolated tests use its read-only mirror.
  ALICLOUD_PROVIDER_BUILD_OUTPUT="$REPO_ROOT/.local/provider-fast-wait" sh scripts/provider/alicloud-fast-wait/build.sh
  CI_PROVIDER_MIRROR_ARGS=(-v "$REPO_ROOT/.local/provider-fast-wait/mirror:/app/.local/provider-mirror:ro")
fi

# Exercise the runtime's pinned checksum and unpacking path with the real custom archive.
docker run --rm --network none "${CI_PROVIDER_MIRROR_ARGS[@]}" \
  -e OPENTOFU_PROVIDER_MIRROR_ROOT=/app/.local/provider-mirror \
  -e OPENTOFU_WORKSPACES_ROOT=/tmp/provider-seed-check \
  "$CI_IMAGE" sh scripts/docker/seed-provider-mirror.sh tofu version -json

docker network create --internal "$CI_NETWORK" >/dev/null
docker run -d --name "$CI_DB" --network "$CI_NETWORK" --network-alias postgres \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_DB=cyber_range -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  --health-cmd 'pg_isready -h 127.0.0.1 -U postgres -d cyber_range' --health-interval 1s --health-retries 30 \
  postgres:16-alpine >/dev/null
docker run -d --name "$CI_PACKED_DB" --network "$CI_NETWORK" --network-alias packed-image-test-postgres \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_DB=packed_image_test -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  --health-cmd 'pg_isready -h 127.0.0.1 -U postgres -d packed_image_test' --health-interval 1s --health-retries 30 \
  postgres:16-alpine >/dev/null
docker run -d --name "$CI_TAG_DB" --network "$CI_NETWORK" --network-alias image-tags-test-postgres \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_DB=image_tags_test -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  --health-cmd 'pg_isready -h 127.0.0.1 -U postgres -d image_tags_test' --health-interval 1s --health-retries 30 \
  postgres:16-alpine >/dev/null
for task_db in "$CI_DB" "$CI_PACKED_DB" "$CI_TAG_DB"; do
  for attempt in $(seq 1 40); do
    if [ "$(docker inspect --format '{{.State.Health.Status}}' "$task_db")" = healthy ]; then
      break
    fi
    if [ "$attempt" = 40 ]; then
      docker logs "$task_db"
      exit 1
    fi
    sleep 1
  done
done

docker exec "$CI_DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE cyber_range_settings_test' >/dev/null
docker exec "$CI_DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE billing_test' >/dev/null
docker exec "$CI_DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE native_batch_test' >/dev/null
docker exec "$CI_DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE user_auth_test' >/dev/null
docker exec "$CI_DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE cyber_range_workspace_test' >/dev/null
docker exec "$CI_DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE cyber_range_workspace_migration_test' >/dev/null

docker run --rm --network "$CI_NETWORK" \
  "${CI_PROVIDER_MIRROR_ARGS[@]}" \
  -e DATABASE_URL='postgresql://postgres:postgres@postgres:5432/cyber_range?schema=public' \
  -e SETTINGS_SWITCH_TEST_DATABASE_URL='postgresql://postgres:postgres@postgres:5432/cyber_range_settings_test?schema=public' \
  -e BILLING_TEST_DATABASE_URL='postgresql://postgres:postgres@postgres:5432/billing_test?schema=public' \
  -e NATIVE_BATCH_TEST_DATABASE_URL='postgresql://postgres:postgres@postgres:5432/native_batch_test?schema=public' \
  -e USER_AUTH_TEST_DATABASE_URL='postgresql://postgres:postgres@postgres:5432/user_auth_test?schema=public' \
  -e WORKSPACE_TEST_DATABASE_URL='postgresql://postgres:postgres@postgres:5432/cyber_range_workspace_test?schema=public' \
  -e CLOUD_WORKSPACE_MIGRATION_TEST_DATABASE_URL='postgresql://postgres:postgres@postgres:5432/cyber_range_workspace_migration_test?schema=public' \
  -e PACKED_IMAGE_TEST_DATABASE_URL='postgresql://postgres:postgres@packed-image-test-postgres:5432/packed_image_test?schema=public' \
  -e IMAGE_TAG_TEST_DATABASE_URL='postgresql://postgres:postgres@image-tags-test-postgres:5432/image_tags_test?schema=public' \
  -e SINGLE_TOFU_OFFLINE_VALIDATION=1 -e SINGLE_TOFU_PROVIDER_MIRROR_PATH=/app/.local/provider-mirror \
  -e NODE_ENV=test -e ADMIN_USERNAME=admin -e ADMIN_TOKEN=dev-admin-token \
  -e OIDC_ISSUER=https://test-issuer.example/realms/cyber-range \
  -e OIDC_JWKS_URL=https://test-issuer.example/realms/cyber-range/certs \
  -e OIDC_TOKEN_ENDPOINT=https://test-issuer.example/realms/cyber-range/token \
  -e RANGE_PROVISIONER_MODE=dry-run -e ALICLOUD_ACCESS_KEY= -e ALICLOUD_SECRET_KEY= \
  "$CI_IMAGE" sh -ec '
    pnpm --filter @aliyun-cyber-range/database prisma:migrate:deploy
    DATABASE_URL="$SETTINGS_SWITCH_TEST_DATABASE_URL" pnpm --filter @aliyun-cyber-range/database prisma:migrate:deploy
    DATABASE_URL="$BILLING_TEST_DATABASE_URL" pnpm --filter @aliyun-cyber-range/database prisma:migrate:deploy
    DATABASE_URL="$NATIVE_BATCH_TEST_DATABASE_URL" pnpm --filter @aliyun-cyber-range/database prisma:migrate:deploy
    DATABASE_URL="$USER_AUTH_TEST_DATABASE_URL" pnpm --filter @aliyun-cyber-range/database prisma:migrate:deploy
    DATABASE_URL="$WORKSPACE_TEST_DATABASE_URL" pnpm --filter @aliyun-cyber-range/database prisma:migrate:deploy
    DATABASE_URL="$PACKED_IMAGE_TEST_DATABASE_URL" pnpm --filter @aliyun-cyber-range/database prisma:migrate:deploy
    DATABASE_URL="$IMAGE_TAG_TEST_DATABASE_URL" pnpm --filter @aliyun-cyber-range/database prisma:migrate:deploy
    pnpm test
    NODE_ENV=production pnpm build
    ALICLOUD_PROVIDER_ZIP_PATH=/app/.local/provider-mirror/registry.opentofu.org/aliyun/alicloud/terraform-provider-alicloud_1.282.0-range.1_linux_amd64.zip pnpm iac:validate
    pnpm --filter @aliyun-cyber-range/database smoke:workspace-migration
  '
