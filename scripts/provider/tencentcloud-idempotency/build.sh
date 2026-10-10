#!/bin/sh
set -eu
RECIPE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$RECIPE/../../.." && pwd)
OUTPUT=${TENCENTCLOUD_PROVIDER_BUILD_OUTPUT:-$REPO/.local/tencentcloud-idempotency}
CACHE=${TENCENTCLOUD_PROVIDER_BUILD_CACHE:-$OUTPUT/cache}
mkdir -p "$OUTPUT" "$CACHE"
OUTPUT=$(CDPATH= cd -- "$OUTPUT" && pwd)
CACHE=$(CDPATH= cd -- "$CACHE" && pwd)
docker build --platform linux/amd64 -t range-tencentcloud-idempotency-builder:1 "$RECIPE"
docker run --rm --platform linux/amd64 --cpus=2 --memory=5g -v "$RECIPE:/recipe:ro" -v "$CACHE:/cache" -v "$OUTPUT:/out" range-tencentcloud-idempotency-builder:1
