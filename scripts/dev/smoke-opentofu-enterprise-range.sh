#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXAMPLE_DIR="$ROOT_DIR/infra/opentofu/examples/alicloud-enterprise-range"
TOFU_VERSION="${TOFU_VERSION:-1.12.3}"
TOFU_IMAGE="${TOFU_IMAGE:-ghcr.io/opentofu/opentofu:${TOFU_VERSION}-minimal}"
TOFU_IMAGE_BINARY_PATH="${TOFU_IMAGE_BINARY_PATH:-/usr/local/bin/tofu}"
ALICLOUD_PROVIDER_ZIP_PATH="${ALICLOUD_PROVIDER_ZIP_PATH:-}"
HOST_CERT_BUNDLE_PATH="${HOST_CERT_BUNDLE_PATH:-}"
DOCKER_TMP_DIR="${DOCKER_TMP_DIR:-}"
TMP_DIR=""
TOFU_BIN="${TOFU_BIN:-}"
TOFU_MODE="${TOFU_MODE:-}"
TOFU_CLI_CONFIG_FILE_HOST=""
TOFU_CLI_CONFIG_FILE_DOCKER=""
PROVIDER_MIRROR_READY=""
SMOKE_RUN_ID="${SMOKE_RUN_ID:-$(date +%Y%m%d%H%M%S)}"
SMOKE_RELATIVE_DIR=".smoke/$SMOKE_RUN_ID"
SMOKE_DIR="$EXAMPLE_DIR/.smoke/$SMOKE_RUN_ID"
SMOKE_TFVARS_PATH="$SMOKE_DIR/smoke.auto.tfvars.json"
SMOKE_PLAN_PATH="$SMOKE_DIR/smoke.tfplan"
SMOKE_OUTPUT_PATH="$SMOKE_DIR/outputs.json"
SMOKE_TFVARS_ARG_PATH="$SMOKE_RELATIVE_DIR/smoke.auto.tfvars.json"
SMOKE_PLAN_ARG_PATH="$SMOKE_RELATIVE_DIR/smoke.tfplan"
SMOKE_APPLIED="0"
SMOKE_DESTROYED="0"
SMOKE_KEEP_RESOURCES="${SMOKE_KEEP_RESOURCES:-0}"
SMOKE_EXECUTION_MODE="${SMOKE_EXECUTION_MODE:-full}"
DEFAULT_AUTO_INSTANCE_TYPE_PREFERENCES="ecs.u1-c1m2.large,ecs.e-c1m2.large,ecs.t6-c1m2.large,ecs.c6t.large,ecs.hfc6.large,ecs.sn1ne.large,ecs.sn1.medium,ecs.n1.medium,ecs.c7.large,ecs.g7.large,ecs.c6.large,ecs.g6.large"
DEFAULT_AUTO_IMAGE_ID_PREFERENCES="ubuntu_24_04_x64_20G_alibase_20260615.vhd,ubuntu_22_04_x64_20G_alibase_20260615.vhd,debian_12_14_x64_20G_alibase_20260609.vhd,centos_stream_9_x64_20G_alibase_20260616.vhd"
SMOKE_TEMPLATE_MODE="${SMOKE_TEMPLATE_MODE:-resource-driven}"
TOFU_DOCKER_PASSTHROUGH_PROXY="${TOFU_DOCKER_PASSTHROUGH_PROXY:-0}"

warn_proxy_passthrough_strategy() {
  local proxy_detected="0"

  for proxy_var in HTTPS_PROXY HTTP_PROXY ALL_PROXY https_proxy http_proxy all_proxy; do
    if [ -n "${!proxy_var:-}" ]; then
      proxy_detected="1"
      break
    fi
  done

  if [ "$proxy_detected" = "0" ]; then
    return
  fi

  if [ "$TOFU_DOCKER_PASSTHROUGH_PROXY" = "1" ]; then
    echo "[smoke] warning: TOFU_DOCKER_PASSTHROUGH_PROXY=1，OpenTofu 容器将透传本机代理；这可能导致阿里云 apply 阶段假性卡住。"
    return
  fi

  echo "[smoke] detected local proxy env; defaulting TOFU_DOCKER_PASSTHROUGH_PROXY=0 for real Aliyun API calls."
}

normalize_optional_value() {
  local value="${1:-}"

  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  if [ -z "$value" ]; then
    return
  fi

  printf '%s' "$value"
}

cleanup() {
  local exit_code=$?
  local should_destroy="0"

  if [ "$SMOKE_DESTROYED" = "0" ] && [ "$SMOKE_KEEP_RESOURCES" != "1" ]; then
    if [ "$SMOKE_APPLIED" = "1" ] || example_has_state_resources; then
      should_destroy="1"
    fi
  fi

  if [ "$should_destroy" = "1" ]; then
    set +e
    echo "[smoke] cleanup: destroy residual enterprise range resources"
    run_tofu_in_example destroy -auto-approve -var-file "$SMOKE_TFVARS_ARG_PATH"
    set -e
  fi

  rm -rf "$SMOKE_DIR"

  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi

  exit "$exit_code"
}

trap cleanup EXIT

ensure_tmp_dir() {
  if [ -z "$TMP_DIR" ]; then
    TMP_DIR="$(mktemp -d)"
  fi
}

ensure_docker_tmp_dir() {
  if [ -n "$DOCKER_TMP_DIR" ]; then
    mkdir -p "$DOCKER_TMP_DIR"
    return
  fi

  ensure_tmp_dir
  DOCKER_TMP_DIR="$TMP_DIR/docker-tmp"
  mkdir -p "$DOCKER_TMP_DIR"
}

detect_host_cert_bundle() {
  if [ -n "$HOST_CERT_BUNDLE_PATH" ] && [ -f "$HOST_CERT_BUNDLE_PATH" ]; then
    return
  fi

  for candidate in /etc/ssl/cert.pem /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do
    if [ -f "$candidate" ]; then
      HOST_CERT_BUNDLE_PATH="$candidate"
      return
    fi
  done
}

write_provider_installation_config() {
  local mirror_root="$1"
  local config_path="$2"

  cat >"$config_path" <<EOF
provider_installation {
  filesystem_mirror {
    path    = "${mirror_root}"
    include = ["registry.opentofu.org/aliyun/alicloud"]
  }
  direct {
    exclude = ["registry.opentofu.org/aliyun/alicloud"]
  }
}
EOF
}

prepare_alicloud_provider_mirror() {
  local provider_mirror_root
  local provider_mirror_dir
  local provider_zip_name

  if [ -n "$PROVIDER_MIRROR_READY" ]; then
    return
  fi

  if [ -z "$ALICLOUD_PROVIDER_ZIP_PATH" ] || [ ! -f "$ALICLOUD_PROVIDER_ZIP_PATH" ]; then
    return
  fi

  ensure_docker_tmp_dir
  provider_mirror_root="$DOCKER_TMP_DIR/provider-mirror"
  provider_mirror_dir="$provider_mirror_root/registry.opentofu.org/aliyun/alicloud"
  provider_zip_name="$(basename "$ALICLOUD_PROVIDER_ZIP_PATH")"

  mkdir -p "$provider_mirror_dir"
  cp -f "$ALICLOUD_PROVIDER_ZIP_PATH" "$provider_mirror_dir/$provider_zip_name"

  TOFU_CLI_CONFIG_FILE_HOST="$DOCKER_TMP_DIR/tofu-host.tfrc"
  TOFU_CLI_CONFIG_FILE_DOCKER="$DOCKER_TMP_DIR/tofu-docker.tfrc"

  write_provider_installation_config "$provider_mirror_root" "$TOFU_CLI_CONFIG_FILE_HOST"
  write_provider_installation_config "/tmp/provider-mirror" "$TOFU_CLI_CONFIG_FILE_DOCKER"

  PROVIDER_MIRROR_READY="1"
}

download_tofu_binary() {
  local os
  local arch
  local asset_name
  local download_url

  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) return 1 ;;
  esac

  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="amd64" ;;
    *) return 1 ;;
  esac

  if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    return 1
  fi

  ensure_tmp_dir
  asset_name="tofu_${TOFU_VERSION}_${os}_${arch}.tar.gz"
  download_url="https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/${asset_name}"

  curl -fsSL "$download_url" -o "$TMP_DIR/$asset_name"
  tar -xzf "$TMP_DIR/$asset_name" -C "$TMP_DIR"

  if [ ! -x "$TMP_DIR/tofu" ]; then
    return 1
  fi

  TOFU_BIN="$TMP_DIR/tofu"
}

extract_tofu_binary_from_image() {
  local container_id

  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi

  ensure_tmp_dir
  container_id="$(docker create "$TOFU_IMAGE")"

  docker cp "$container_id:$TOFU_IMAGE_BINARY_PATH" "$TMP_DIR/tofu"
  docker rm "$container_id" >/dev/null
  chmod +x "$TMP_DIR/tofu"

  if [ ! -x "$TMP_DIR/tofu" ]; then
    return 1
  fi

  TOFU_BIN="$TMP_DIR/tofu"
}

detect_tofu_mode() {
  if [ -n "$TOFU_MODE" ]; then
    return
  fi

  if [ -n "$TOFU_BIN" ] && [ -x "$TOFU_BIN" ]; then
    TOFU_MODE="binary"
    return
  fi

  if command -v tofu >/dev/null 2>&1; then
    TOFU_BIN="$(command -v tofu)"
    TOFU_MODE="binary"
    return
  fi

  if command -v docker >/dev/null 2>&1 && docker image inspect "$TOFU_IMAGE" >/dev/null 2>&1; then
    if [ "$(uname -s)" = "Linux" ] && extract_tofu_binary_from_image; then
      TOFU_MODE="binary"
      return
    fi

    TOFU_MODE="docker"
    return
  fi

  if download_tofu_binary; then
    TOFU_MODE="binary"
    return
  fi

  if command -v docker >/dev/null 2>&1; then
    TOFU_MODE="docker"
    return
  fi

  echo "no available OpenTofu runtime found" >&2
  exit 1
}

run_tofu_docker() {
  local workdir="$1"
  local -a docker_env_args

  shift
  ensure_docker_tmp_dir
  detect_host_cert_bundle
  prepare_alicloud_provider_mirror

  docker_env_args=()

  if [ "$TOFU_DOCKER_PASSTHROUGH_PROXY" = "1" ]; then
    docker_env_args=(
      -e HTTPS_PROXY
      -e HTTP_PROXY
      -e ALL_PROXY
      -e https_proxy
      -e http_proxy
      -e all_proxy
      -e NO_PROXY
      -e no_proxy
    )
  fi

  if [ -n "$TOFU_CLI_CONFIG_FILE_DOCKER" ]; then
    docker_env_args+=(-e TF_CLI_CONFIG_FILE=/tmp/tofu-docker.tfrc)
  fi

  if [ -n "$HOST_CERT_BUNDLE_PATH" ]; then
    docker run --rm \
      "${docker_env_args[@]}" \
      -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
      -v "$HOST_CERT_BUNDLE_PATH:/etc/ssl/certs/ca-certificates.crt:ro" \
      -v "$DOCKER_TMP_DIR:/tmp" \
      -v "$ROOT_DIR:/workspace" \
      -w "$workdir" \
      "$TOFU_IMAGE" \
      "$@"
    return
  fi

  docker run --rm \
    "${docker_env_args[@]}" \
    -v "$DOCKER_TMP_DIR:/tmp" \
    -v "$ROOT_DIR:/workspace" \
    -w "$workdir" \
    "$TOFU_IMAGE" \
    "$@"
}

run_tofu_in_example() {
  detect_tofu_mode
  prepare_alicloud_provider_mirror

  if [ "$TOFU_MODE" = "docker" ]; then
    run_tofu_docker "/workspace/infra/opentofu/examples/alicloud-enterprise-range" "$@"
    return
  fi

  (
    cd "$EXAMPLE_DIR"
    if [ -n "$TOFU_CLI_CONFIG_FILE_HOST" ]; then
      TF_CLI_CONFIG_FILE="$TOFU_CLI_CONFIG_FILE_HOST" "$TOFU_BIN" "$@"
    else
      "$TOFU_BIN" "$@"
    fi
  )
}

example_has_state_resources() {
  local state_output=""
  local state_status=0

  set +e
  state_output="$(run_tofu_in_example state list 2>/dev/null)"
  state_status=$?
  set -e

  if [ "$state_status" -ne 0 ]; then
    return 1
  fi

  [ -n "$(printf '%s' "$state_output" | tr -d '[:space:]')" ]
}

require_env_value() {
  local name="$1"
  local value="${!name:-}"

  if [ -z "$value" ]; then
    echo "missing required environment variable: $name" >&2
    exit 1
  fi

  printf '%s' "$value"
}

require_first_env_value() {
  local names=("$@")
  local name
  local value=""

  for name in "${names[@]}"; do
    value="${!name:-}"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return
    fi
  done

  echo "missing required environment variable: ${names[*]}" >&2
  exit 1
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --plan-only)
        SMOKE_EXECUTION_MODE="plan-only"
        ;;
      --full)
        SMOKE_EXECUTION_MODE="full"
        ;;
      *)
        echo "unsupported argument: $1" >&2
        exit 1
        ;;
    esac
    shift
  done
}

read_instance_type_preferences() {
  local configured

  configured="$(normalize_optional_value "${OPENTOFU_INSTANCE_TYPE_PREFERENCES:-${ALICLOUD_INSTANCE_TYPE_PREFERENCES:-}}")"

  if [ -n "$configured" ]; then
    printf '%s' "$configured"
    return
  fi

  printf '%s' "$DEFAULT_AUTO_INSTANCE_TYPE_PREFERENCES"
}

read_image_id_preferences() {
  local configured

  configured="$(normalize_optional_value "${OPENTOFU_IMAGE_ID_PREFERENCES:-${ALICLOUD_IMAGE_ID_PREFERENCES:-}}")"

  if [ -n "$configured" ]; then
    printf '%s' "$configured"
    return
  fi

  printf '%s' "$DEFAULT_AUTO_IMAGE_ID_PREFERENCES"
}

resolve_auto_instance_type() {
  local access_key="$1"
  local secret_key="$2"
  local region="$3"
  local zone_id="$4"
  local available_resource_json
  local instance_type_preferences
  local system_disk_category

  if ! command -v aliyun >/dev/null 2>&1; then
    echo "missing required command for auto instance type resolution: aliyun" >&2
    exit 1
  fi

  instance_type_preferences="$(read_instance_type_preferences)"
  system_disk_category="$(normalize_optional_value "${OPENTOFU_SYSTEM_DISK_CATEGORY:-}")"

  if [ -n "$system_disk_category" ]; then
    available_resource_json="$(
      ALICLOUD_ACCESS_KEY="$access_key" \
      ALICLOUD_SECRET_KEY="$secret_key" \
      aliyun ecs DescribeAvailableResource \
        --RegionId "$region" \
        --ZoneId "$zone_id" \
        --DestinationResource InstanceType \
        --ResourceType instance \
        --InstanceChargeType PostPaid \
        --IoOptimized optimized \
        --NetworkCategory vpc \
        --SystemDiskCategory "$system_disk_category"
    )"
  else
    available_resource_json="$(
      ALICLOUD_ACCESS_KEY="$access_key" \
      ALICLOUD_SECRET_KEY="$secret_key" \
      aliyun ecs DescribeAvailableResource \
        --RegionId "$region" \
        --ZoneId "$zone_id" \
        --DestinationResource InstanceType \
        --ResourceType instance \
        --InstanceChargeType PostPaid \
        --IoOptimized optimized \
        --NetworkCategory vpc
    )"
  fi

  printf '%s' "$available_resource_json" | INSTANCE_TYPE_PREFERENCES="$instance_type_preferences" node -e '
    const fs = require("node:fs");

    const input = fs.readFileSync(0, "utf8").trim();
    const preferences = (process.env.INSTANCE_TYPE_PREFERENCES || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    const payload = JSON.parse(input);
    const supportedResources =
      payload?.AvailableZones?.AvailableZone?.flatMap((zone) =>
        (zone?.AvailableResources?.AvailableResource || [])
          .filter((resource) => resource?.Type === "InstanceType")
          .flatMap((resource) => resource?.SupportedResources?.SupportedResource || []),
      ) || [];

    const availableTypes = [...new Set(
      supportedResources
        .filter((resource) => resource?.Status === "Available" && typeof resource?.Value === "string")
        .map((resource) => resource.Value.trim())
        .filter(Boolean),
    )];

    const availableSet = new Set(availableTypes);
    const selectedType =
      preferences.find((candidate) => availableSet.has(candidate)) ||
      availableTypes[0];

    if (!selectedType) {
      console.error("unable to resolve a saleable ECS instance type from DescribeAvailableResource");
      process.exit(1);
    }

    process.stdout.write(selectedType);
  '
}

resolve_requested_instance_type() {
  local requested_instance_type

  requested_instance_type="$(normalize_optional_value "${OPENTOFU_INSTANCE_TYPE:-${ALICLOUD_INSTANCE_TYPE:-}}")"

  if [ -n "$requested_instance_type" ] && [ "$requested_instance_type" != "auto" ]; then
    printf '%s' "$requested_instance_type"
    return
  fi

  resolve_auto_instance_type "$@"
}

resolve_requested_image_id() {
  local access_key="$1"
  local secret_key="$2"
  local region="$3"
  local requested_image_id
  local image_id_preferences
  local images_json

  requested_image_id="$(normalize_optional_value "${OPENTOFU_IMAGE_ID:-${ALICLOUD_IMAGE_ID:-}}")"
  image_id_preferences="$(read_image_id_preferences)"

  if ! command -v aliyun >/dev/null 2>&1; then
    echo "missing required command for image resolution: aliyun" >&2
    exit 1
  fi

  images_json="$({
    env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy -u NO_PROXY -u no_proxy \
      ALICLOUD_ACCESS_KEY="$access_key" \
      ALICLOUD_SECRET_KEY="$secret_key" \
      aliyun ecs DescribeImages \
        --RegionId "$region" \
        --ImageOwnerAlias system \
        --Status Available \
        --OSType linux \
        --Architecture x86_64 \
        --PageSize 100
  })"

  printf '%s' "$images_json" | REQUESTED_IMAGE_ID="$requested_image_id" IMAGE_ID_PREFERENCES="$image_id_preferences" REGION_ID="$region" node -e '
    const fs = require("node:fs");

    const input = fs.readFileSync(0, "utf8").trim();
    const requestedImageId = (process.env.REQUESTED_IMAGE_ID || "").trim();
    const regionId = (process.env.REGION_ID || "").trim();
    const preferences = (process.env.IMAGE_ID_PREFERENCES || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    const payload = JSON.parse(input);
    const availableImageIds = (payload?.Images?.Image || [])
      .filter((image) => image?.Status === "Available" && typeof image?.ImageId === "string")
      .map((image) => image.ImageId.trim())
      .filter(Boolean);

    if (requestedImageId && requestedImageId.toLowerCase() !== "auto") {
      if (!availableImageIds.includes(requestedImageId)) {
        console.error(`Configured image ID is not available in region ${regionId}: ${requestedImageId}`);
        process.exit(1);
      }

      process.stdout.write(requestedImageId);
      process.exit(0);
    }

    const selectedImageId = preferences.find((candidate) => availableImageIds.includes(candidate)) || availableImageIds[0];

    if (!selectedImageId) {
      console.error(`No saleable ECS system image found in region ${regionId}`);
      process.exit(1);
    }

    process.stdout.write(selectedImageId);
  '
}

write_smoke_tfvars() {
  mkdir -p "$SMOKE_DIR"

  local access_key secret_key region zone_id image_id instance_password instance_type
  local resource_name_prefix

  access_key="$(require_env_value ALICLOUD_ACCESS_KEY)"
  secret_key="$(require_env_value ALICLOUD_SECRET_KEY)"
  region="$(require_env_value ALICLOUD_REGION)"
  zone_id="$(require_env_value ALICLOUD_ZONE_ID)"
  instance_password="$(node -e 'const { randomBytes } = require("node:crypto"); process.stdout.write(`A${randomBytes(12).toString("hex")}a1!`);')"
  instance_type="$(resolve_requested_instance_type "$access_key" "$secret_key" "$region" "$zone_id")"
  image_id="$(resolve_requested_image_id "$access_key" "$secret_key" "$region")"
  resource_name_prefix="${SMOKE_RESOURCE_NAME_PREFIX:-smoke-${SMOKE_RUN_ID}}"

  echo "[smoke] resolved instance type: $instance_type"
  echo "[smoke] resolved image id: $image_id"

  ACCESS_KEY="$access_key" \
  SECRET_KEY="$secret_key" \
  REGION="$region" \
  ZONE_ID="$zone_id" \
  IMAGE_ID="$image_id" \
  INSTANCE_PASSWORD="$instance_password" \
  INSTANCE_TYPE="$instance_type" \
  RESOURCE_NAME_PREFIX="$resource_name_prefix" \
  VPC_CIDR="${ALICLOUD_RANGE_VPC_CIDR:-10.70.0.0/16}" \
  DMZ_CIDR="${ALICLOUD_RANGE_DMZ_CIDR:-10.70.10.0/24}" \
  OFFICE_CIDR="${ALICLOUD_RANGE_OFFICE_CIDR:-10.70.20.0/24}" \
  SERVER_CIDR="${ALICLOUD_RANGE_SERVER_CIDR:-10.70.30.0/24}" \
  DMZ_PRIVATE_IP="${ALICLOUD_RANGE_DMZ_PRIVATE_IP:-10.70.10.10}" \
  OFFICE_PRIVATE_IP="${ALICLOUD_RANGE_OFFICE_PRIVATE_IP:-10.70.20.10}" \
  SERVER_PRIVATE_IP="${ALICLOUD_RANGE_SERVER_PRIVATE_IP:-10.70.30.10}" \
  TEMPLATE_MODE="$SMOKE_TEMPLATE_MODE" \
  node -e '
    const fs = require("node:fs");
    const filePath = process.argv[1];
    const base = {
      access_key: process.env.ACCESS_KEY,
      secret_key: process.env.SECRET_KEY,
      region: process.env.REGION,
      zone_id: process.env.ZONE_ID,
      resource_name_prefix: process.env.RESOURCE_NAME_PREFIX,
      vpc_cidr: process.env.VPC_CIDR,
      dmz_cidr: process.env.DMZ_CIDR,
      office_cidr: process.env.OFFICE_CIDR,
      server_cidr: process.env.SERVER_CIDR,
      dmz_private_ip: process.env.DMZ_PRIVATE_IP,
      office_private_ip: process.env.OFFICE_PRIVATE_IP,
      server_private_ip: process.env.SERVER_PRIVATE_IP,
      instance_type: process.env.INSTANCE_TYPE,
      image_id: process.env.IMAGE_ID,
      instance_password: process.env.INSTANCE_PASSWORD,
    };
    const data = process.env.TEMPLATE_MODE === "resource-driven"
      ? {
          ...base,
          entry_host_key: "dmz-entry",
          network_zones: [
            { key: "dmz", name: "DMZ", cidr: process.env.DMZ_CIDR, purpose: "public-entry", is_public_entry: true },
            { key: "office", name: "Office", cidr: process.env.OFFICE_CIDR, purpose: "user-workstations", is_public_entry: false },
            { key: "server", name: "Server", cidr: process.env.SERVER_CIDR, purpose: "application-servers", is_public_entry: false },
          ],
          hosts: [
            { key: "dmz-entry", name: "DMZ Entry", zone_key: "dmz", private_ip: process.env.DMZ_PRIVATE_IP, role: "entry", expose_public: true },
            { key: "office-client", name: "Office Client", zone_key: "office", private_ip: process.env.OFFICE_PRIVATE_IP, role: "workstation", expose_public: false },
            { key: "server-app", name: "Server App", zone_key: "server", private_ip: process.env.SERVER_PRIVATE_IP, role: "app", expose_public: false },
          ],
          host_network_interfaces: [
            {
              host_key: "server-app",
              interfaces: [
                { device_index: 1, zone_key: "office", private_ip: "10.70.20.30", description: "pivot" },
              ],
            },
          ],
          nat_gateways: [
            { key: "nat-office", name: "Office NAT", zone_key: "office", snat_enabled: true },
          ],
          eips: [
            { key: "eip-entry", name: "Entry EIP", bind_target_type: "host", bind_target_key: "dmz-entry", bandwidth_mbps: 30 },
            { key: "eip-office-nat", name: "Office NAT EIP", bind_target_type: "nat_gateway", bind_target_key: "nat-office", bandwidth_mbps: 30 },
          ],
          security_group_rules: [
            { key: "sg-entry-ssh", name: "Entry SSH", target_host_key: "dmz-entry", direction: "ingress", policy: "accept", protocol: "tcp", port_range: "22/22", source_cidr: "0.0.0.0/0", priority: 1 },
            { key: "sg-entry-http", name: "Entry HTTP", target_host_key: "dmz-entry", direction: "ingress", policy: "accept", protocol: "tcp", port_range: "80/80", source_cidr: "0.0.0.0/0", priority: 2 },
          ],
          acls: [
            { key: "acl-office-inbound", name: "Office ACL", zone_key: "office", direction: "inbound", policy: "accept", protocol: "tcp", port_range: "3389/3389", source_cidr: process.env.VPC_CIDR, priority: 10 },
          ],
          snat_entries: [
            { key: "snat-office", name: "Office SNAT", nat_gateway_key: "nat-office", source_zone_key: "office", eip_key: "eip-office-nat" },
          ],
          dnat_entries: [
            { key: "dnat-entry-http", name: "Entry HTTP DNAT", nat_gateway_key: "nat-office", eip_key: "eip-office-nat", backend_host_key: "server-app", external_port: 8080, internal_port: 80, protocol: "tcp" },
          ],
          bootstrap_scripts: [
            {
              key: "server-bootstrap",
              name: "Server Bootstrap",
              type: "shell",
              content: "#!/bin/bash\necho smoke-ready >/tmp/range-smoke.txt",
              target_host_keys: ["server-app"],
            },
          ],
          runtime_selections: {
            image_policies: {
              server: {
                mode: "fixed",
                imageId: process.env.IMAGE_ID,
              },
            },
            instance_type_policies: {
              server: {
                mode: "prefer-list",
                preferredInstanceTypes: [process.env.INSTANCE_TYPE],
              },
            },
          },
        }
      : base;
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  ' "$SMOKE_TFVARS_PATH"
}

main() {
  parse_args "$@"
  warn_proxy_passthrough_strategy
  write_smoke_tfvars

  echo "[smoke] enterprise range tfvars written to $SMOKE_TFVARS_PATH"
  echo "[smoke] execution mode: $SMOKE_EXECUTION_MODE"
  echo "[smoke] running init/validate/plan for alicloud-enterprise-range"

  run_tofu_in_example init -backend=false
  run_tofu_in_example validate -var-file "$SMOKE_TFVARS_ARG_PATH"
  run_tofu_in_example plan -out "$SMOKE_PLAN_ARG_PATH" -var-file "$SMOKE_TFVARS_ARG_PATH"

  if [ "$SMOKE_EXECUTION_MODE" = "plan-only" ]; then
    echo "[smoke] skipping apply/output/destroy because SMOKE_EXECUTION_MODE=plan-only"
    return
  fi

  echo "[smoke] continuing with apply/output/destroy for alicloud-enterprise-range"
  run_tofu_in_example apply -auto-approve "$SMOKE_PLAN_ARG_PATH"
  SMOKE_APPLIED="1"

  run_tofu_in_example output -json >"$SMOKE_OUTPUT_PATH"
  echo "[smoke] outputs captured at $SMOKE_OUTPUT_PATH"
  cat "$SMOKE_OUTPUT_PATH"

  if [ "$SMOKE_KEEP_RESOURCES" = "1" ]; then
    echo "[smoke] keeping resources because SMOKE_KEEP_RESOURCES=1"
    return
  fi

  echo "[smoke] destroying enterprise range resources"
  run_tofu_in_example destroy -auto-approve -var-file "$SMOKE_TFVARS_ARG_PATH"
  SMOKE_DESTROYED="1"
  echo "[smoke] destroy completed"
}

main "$@"
