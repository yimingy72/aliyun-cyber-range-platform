#!/usr/bin/env sh
set -eu

MIRROR_ROOT="${OPENTOFU_PROVIDER_MIRROR_ROOT:-/var/lib/cyber-range/provider-mirror}"
WORKSPACES_ROOT="${OPENTOFU_WORKSPACES_ROOT:-/var/lib/cyber-range/workspaces}"
PROVIDER_DIR="${MIRROR_ROOT}/registry.opentofu.org/aliyun/alicloud"
ALICLOUD_PROVIDER_VERSION="${ALICLOUD_PROVIDER_VERSION:-1.282.0}"
ALICLOUD_PROVIDER_SHA256="${ALICLOUD_PROVIDER_SHA256:-75cd138f29602271d79b4900f83bd5def4f2c16ebe19fdd97bd0439b74901807}"
PROVIDER_ZIP_PATH="${PROVIDER_DIR}/terraform-provider-alicloud_${ALICLOUD_PROVIDER_VERSION}_linux_amd64.zip"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "Missing SHA-256 utility: install sha256sum or shasum." >&2
    exit 1
  fi
}

mkdir -p "${WORKSPACES_ROOT}"

if [ ! -f "${PROVIDER_ZIP_PATH}" ]; then
  echo "Missing Alibaba Cloud provider cache: ${PROVIDER_ZIP_PATH}" >&2
  echo "Run 'pnpm provider:download' on the host before starting Docker Compose." >&2
  exit 1
fi

ACTUAL_SHA256=$(sha256_file "${PROVIDER_ZIP_PATH}")
if [ "${ACTUAL_SHA256}" != "${ALICLOUD_PROVIDER_SHA256}" ]; then
  echo "Alibaba Cloud provider cache checksum mismatch: expected ${ALICLOUD_PROVIDER_SHA256}, got ${ACTUAL_SHA256}." >&2
  exit 1
fi

exec "$@"
