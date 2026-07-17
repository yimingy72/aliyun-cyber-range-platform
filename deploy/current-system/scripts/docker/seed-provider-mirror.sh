#!/usr/bin/env sh
set -eu

MIRROR_ROOT="${OPENTOFU_PROVIDER_MIRROR_ROOT:-/var/lib/cyber-range/provider-mirror}"
WORKSPACES_ROOT="${OPENTOFU_WORKSPACES_ROOT:-/var/lib/cyber-range/workspaces}"
PROVIDER_DIR="${MIRROR_ROOT}/registry.opentofu.org/aliyun/alicloud"
PROVIDER_ZIP_PATH="${PROVIDER_DIR}/terraform-provider-alicloud_1.282.0_linux_amd64.zip"
SEEDED_PROVIDER_ZIP="${SEEDED_PROVIDER_ZIP:-/opt/provider-seed/terraform-provider-alicloud_1.282.0_linux_amd64.zip}"

mkdir -p "${PROVIDER_DIR}" "${WORKSPACES_ROOT}"

if [ ! -f "${PROVIDER_ZIP_PATH}" ] && [ -f "${SEEDED_PROVIDER_ZIP}" ]; then
  TMP_PROVIDER_ZIP_PATH="${PROVIDER_DIR}/.terraform-provider-alicloud_1.282.0_linux_amd64.zip.$$"
  cp "${SEEDED_PROVIDER_ZIP}" "${TMP_PROVIDER_ZIP_PATH}"
  mv "${TMP_PROVIDER_ZIP_PATH}" "${PROVIDER_ZIP_PATH}"
fi

exec "$@"
