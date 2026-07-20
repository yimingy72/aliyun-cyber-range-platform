#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../.." && pwd)

ALICLOUD_PROVIDER_VERSION="${ALICLOUD_PROVIDER_VERSION:-1.282.0}"
ALICLOUD_PROVIDER_SHA256="${ALICLOUD_PROVIDER_SHA256:-75cd138f29602271d79b4900f83bd5def4f2c16ebe19fdd97bd0439b74901807}"
ALICLOUD_PROVIDER_DOWNLOAD_URL="${ALICLOUD_PROVIDER_DOWNLOAD_URL:-https://github.com/aliyun/terraform-provider-alicloud/releases/download/v${ALICLOUD_PROVIDER_VERSION}/terraform-provider-alicloud_${ALICLOUD_PROVIDER_VERSION}_linux_amd64.zip}"
MIRROR_ROOT="${OPENTOFU_PROVIDER_MIRROR_HOST_PATH:-${REPO_ROOT}/.local/provider-mirror}"
PROVIDER_DIR="${MIRROR_ROOT}/registry.opentofu.org/aliyun/alicloud"
PROVIDER_FILENAME="terraform-provider-alicloud_${ALICLOUD_PROVIDER_VERSION}_linux_amd64.zip"
PROVIDER_ZIP_PATH="${PROVIDER_DIR}/${PROVIDER_FILENAME}"

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

if [ -f "${PROVIDER_ZIP_PATH}" ] && [ "$(sha256_file "${PROVIDER_ZIP_PATH}")" = "${ALICLOUD_PROVIDER_SHA256}" ]; then
  echo "Alibaba Cloud provider cache is ready: ${PROVIDER_ZIP_PATH}"
  exit 0
fi

mkdir -p "${PROVIDER_DIR}"
TMP_PROVIDER_ZIP_PATH="${PROVIDER_ZIP_PATH}.download"
trap 'rm -f "${TMP_PROVIDER_ZIP_PATH}"' HUP INT TERM

echo "Downloading Alibaba Cloud provider ${ALICLOUD_PROVIDER_VERSION} to host cache..."
curl --continue-at - --fail --silent --show-error --location --connect-timeout 15 --retry 5 --retry-delay 2 \
  "${ALICLOUD_PROVIDER_DOWNLOAD_URL}" \
  -o "${TMP_PROVIDER_ZIP_PATH}"

ACTUAL_SHA256=$(sha256_file "${TMP_PROVIDER_ZIP_PATH}")
if [ "${ACTUAL_SHA256}" != "${ALICLOUD_PROVIDER_SHA256}" ]; then
  echo "Alibaba Cloud provider checksum mismatch: expected ${ALICLOUD_PROVIDER_SHA256}, got ${ACTUAL_SHA256}." >&2
  rm -f "${TMP_PROVIDER_ZIP_PATH}"
  exit 1
fi

mv "${TMP_PROVIDER_ZIP_PATH}" "${PROVIDER_ZIP_PATH}"
trap - HUP INT TERM
echo "Alibaba Cloud provider cache is ready: ${PROVIDER_ZIP_PATH}"
