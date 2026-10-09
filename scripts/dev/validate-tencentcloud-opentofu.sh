#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../.." && pwd)
TOFU_IMAGE="${TENCENTCLOUD_IAC_IMAGE:-range-tencentcloud-iac:validation}"
MIRROR_ROOT="${TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH:-${REPO_ROOT}/.local/tencentcloud-provider/mirror}"
VALIDATION_ROOT="${TENCENTCLOUD_VALIDATION_ROOT:-${REPO_ROOT}/.local/tencentcloud-provider/validation}"
PROVIDER_VERSION="${TENCENTCLOUD_PROVIDER_VERSION:-1.83.34}"
PROVIDER_SHA256="${TENCENTCLOUD_PROVIDER_SHA256:-c94c2074fef39d38b351c4e24190ec0bed6f7e1bc6b014f98a8672921eaf2c8b}"

mkdir -p "${VALIDATION_ROOT}"
RUN_ROOT=$(mktemp -d "${VALIDATION_ROOT}/run.XXXXXX")
docker build --platform linux/amd64 -f "${REPO_ROOT}/scripts/docker/tencentcloud-iac.Dockerfile" -t "${TOFU_IMAGE}" "${REPO_ROOT}"
cat >"${RUN_ROOT}/tofu.tfrc" <<'EOF'
provider_installation {
  filesystem_mirror {
    path    = "/provider-mirror"
    include = ["registry.opentofu.org/tencentcloudstack/tencentcloud"]
  }
}
EOF

# No environment credentials, state volumes or cloud network are attached to validation.
docker run --rm --network none --platform linux/amd64 --entrypoint /bin/sh \
  -e TF_CLI_CONFIG_FILE=/validation/tofu.tfrc \
  -e PROVIDER_VERSION="${PROVIDER_VERSION}" -e PROVIDER_SHA256="${PROVIDER_SHA256}" \
  -v "${MIRROR_ROOT}:/provider-mirror:ro" -v "${RUN_ROOT}:/validation" \
  "${TOFU_IMAGE}" -eu -c '
  archive="/provider-mirror/registry.opentofu.org/tencentcloudstack/tencentcloud/terraform-provider-tencentcloud_${PROVIDER_VERSION}_linux_amd64.zip"
  actual=$(sha256sum "$archive" | cut -d " " -f 1)
  [ "$actual" = "$PROVIDER_SHA256" ] || { echo "Provider checksum mismatch" >&2; exit 1; }
  for module in tencentcloud-single-instance-network tencentcloud-single-instance-batch; do
    tofu -chdir="/source/$module" fmt -check -recursive
    cp -R "/source/$module" "/validation/$module"
    tofu -chdir="/validation/$module" init -backend=false -input=false -no-color
    tofu -chdir="/validation/$module" validate -no-color
    tofu -chdir="/validation/$module" test -no-color
  done
  tofu -chdir=/validation/tencentcloud-single-instance-batch providers schema -json > /validation/provider-schema.json
  node /source/check-tencentcloud-provider-schema.cjs /validation/provider-schema.json
  '
cp "${RUN_ROOT}/provider-schema.json" "${VALIDATION_ROOT}/provider-schema.json"
echo "Tencent Cloud Docker validation evidence: ${RUN_ROOT}"
