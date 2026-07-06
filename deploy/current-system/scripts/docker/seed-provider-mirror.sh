#!/usr/bin/env sh
set -eu

MIRROR_ROOT="${OPENTOFU_PROVIDER_MIRROR_ROOT:-/var/lib/cyber-range/provider-mirror}"
WORKSPACES_ROOT="${OPENTOFU_WORKSPACES_ROOT:-/var/lib/cyber-range/workspaces}"
PROVIDER_DIR="${MIRROR_ROOT}/registry.opentofu.org/aliyun/alicloud"
PROVIDER_ZIP_PATH="${PROVIDER_DIR}/terraform-provider-alicloud_1.282.0_linux_amd64.zip"
SEEDED_BINARY="/opt/provider-seed/terraform-provider-alicloud_v1.282.0"

mkdir -p "${PROVIDER_DIR}" "${WORKSPACES_ROOT}"

if [ ! -f "${PROVIDER_ZIP_PATH}" ] && [ -f "${SEEDED_BINARY}" ]; then
  TMP_DIR="$(mktemp -d)"
  cp "${SEEDED_BINARY}" "${TMP_DIR}/terraform-provider-alicloud_v1.282.0"
  (
    cd "${TMP_DIR}"
    zip -q "${PROVIDER_ZIP_PATH}" terraform-provider-alicloud_v1.282.0
  )
  rm -rf "${TMP_DIR}"
fi

exec "$@"
