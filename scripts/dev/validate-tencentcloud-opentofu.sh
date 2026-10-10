#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../.." && pwd)
VALIDATION_RUN_ID="${TENCENTCLOUD_RUN_ID:-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}}"
TOFU_IMAGE="${TENCENTCLOUD_IAC_IMAGE:-range-tencentcloud-iac:${VALIDATION_RUN_ID}}"
MIRROR_ROOT="${TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH:-${REPO_ROOT}/.local/tencentcloud-idempotency/mirror}"
VALIDATION_ROOT="${TENCENTCLOUD_VALIDATION_ROOT:-${REPO_ROOT}/.local/tencentcloud-provider/validation}"
PROVIDER_VERSION="${TENCENTCLOUD_PROVIDER_VERSION:-1.83.34-range.1}"
PROVIDER_SHA256="${TENCENTCLOUD_PROVIDER_SHA256:-d6537266986c80b5c936cf84be3d8bbca31b1e1249277ced332399a3c65f4535}"

mkdir -p "${VALIDATION_ROOT}"
RUN_ROOT=$(mktemp -d "${VALIDATION_ROOT}/run.XXXXXX")
docker build --platform linux/amd64 \
  --build-arg "OPENTOFU_IMAGE=${OPENTOFU_IMAGE:-ghcr.io/opentofu/opentofu:1.13.1-minimal}" \
  -f "${REPO_ROOT}/scripts/docker/tencentcloud-iac.Dockerfile" -t "${TOFU_IMAGE}" "${REPO_ROOT}"
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
  for module in tencentcloud-single-instance-network tencentcloud-single-instance-batch tencentcloud-enterprise-range; do
    tofu -chdir="/source/$module" fmt -check -recursive
    cp -R "/source/$module" "/validation/$module"
    tofu -chdir="/validation/$module" init -backend=false -input=false -no-color
    tofu -chdir="/validation/$module" validate -no-color
    tofu -chdir="/validation/$module" test -no-color
  done
  tofu -chdir=/validation/tencentcloud-enterprise-range test -verbose -json > /validation/tencent-range-update-tests.jsonl
  node /source/check-tencentcloud-range-update-plan.cjs /validation/tencent-range-update-tests.jsonl
  tofu -chdir=/validation/tencentcloud-single-instance-batch providers schema -json > /validation/provider-schema.json
  node /source/check-tencentcloud-provider-schema.cjs /validation/provider-schema.json
  '
cp "${RUN_ROOT}/provider-schema.json" "${VALIDATION_ROOT}/provider-schema.json"
echo "Tencent Cloud Docker validation evidence: ${RUN_ROOT}"
