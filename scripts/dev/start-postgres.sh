#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$ROOT_DIR"

docker compose up -d postgres

CONTAINER_ID="$(docker compose ps -q postgres)"

if [ -z "$CONTAINER_ID" ]; then
  echo "postgres container not found after docker compose up" >&2
  exit 1
fi

for _ in $(seq 1 30); do
  HEALTH_STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER_ID")"

  if [ "$HEALTH_STATUS" = "healthy" ] || [ "$HEALTH_STATUS" = "running" ]; then
    echo "postgres is ready"
    exit 0
  fi

  sleep 1
done

echo "postgres did not become ready in time" >&2
exit 1
