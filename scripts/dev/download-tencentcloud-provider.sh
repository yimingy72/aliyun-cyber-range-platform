#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../.." && pwd)
TENCENTCLOUD_PROVIDER_VERSION="${TENCENTCLOUD_PROVIDER_VERSION:-1.83.34}"
TENCENTCLOUD_PROVIDER_SHA256="${TENCENTCLOUD_PROVIDER_SHA256:-c94c2074fef39d38b351c4e24190ec0bed6f7e1bc6b014f98a8672921eaf2c8b}"
TENCENTCLOUD_PROVIDER_DOWNLOAD_URL="${TENCENTCLOUD_PROVIDER_DOWNLOAD_URL:-https://github.com/tencentcloudstack/terraform-provider-tencentcloud/releases/download/v${TENCENTCLOUD_PROVIDER_VERSION}/terraform-provider-tencentcloud_${TENCENTCLOUD_PROVIDER_VERSION}_linux_amd64.zip}"
MIRROR_ROOT="${TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH:-${REPO_ROOT}/.local/tencentcloud-provider/mirror}"
PROVIDER_DIR="${MIRROR_ROOT}/registry.opentofu.org/tencentcloudstack/tencentcloud"
PROVIDER_ZIP_PATH="${PROVIDER_DIR}/terraform-provider-tencentcloud_${TENCENTCLOUD_PROVIDER_VERSION}_linux_amd64.zip"

case "${TENCENTCLOUD_PROVIDER_VERSION}" in
  *[!0-9.]*|'') echo "Invalid Tencent Cloud provider version." >&2; exit 1 ;;
esac
if ! printf '%s' "${TENCENTCLOUD_PROVIDER_SHA256}" | awk 'length($0) == 64 && $0 !~ /[^0-9a-f]/ { valid = 1 } END { exit !valid }'; then
  echo "A pinned Tencent Cloud provider SHA-256 is required." >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "Missing SHA-256 utility." >&2
    exit 1
  fi
}

if [ -f "${PROVIDER_ZIP_PATH}" ] && [ "$(sha256_file "${PROVIDER_ZIP_PATH}")" = "${TENCENTCLOUD_PROVIDER_SHA256}" ]; then
  echo "Tencent Cloud provider cache is ready: ${PROVIDER_ZIP_PATH}"
  exit 0
fi
mkdir -p "${PROVIDER_DIR}"
TMP_PROVIDER_ZIP_PATH=$(mktemp "${PROVIDER_ZIP_PATH}.download.XXXXXX")
trap 'rm -f "${TMP_PROVIDER_ZIP_PATH}"' EXIT HUP INT TERM
curl --fail --silent --show-error --location --connect-timeout 15 --max-time 600 --retry 5 --retry-delay 2 \
  "${TENCENTCLOUD_PROVIDER_DOWNLOAD_URL}" -o "${TMP_PROVIDER_ZIP_PATH}"
if [ "$(sha256_file "${TMP_PROVIDER_ZIP_PATH}")" != "${TENCENTCLOUD_PROVIDER_SHA256}" ]; then
  echo "Tencent Cloud provider checksum mismatch; refusing the archive." >&2
  exit 1
fi
mv "${TMP_PROVIDER_ZIP_PATH}" "${PROVIDER_ZIP_PATH}"
trap - EXIT HUP INT TERM
echo "Tencent Cloud provider cache is ready: ${PROVIDER_ZIP_PATH}"
