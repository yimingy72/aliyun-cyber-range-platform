#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOFU_VERSION="${TOFU_VERSION:-1.13.1}"
TOFU_IMAGE="${TOFU_IMAGE:-ghcr.io/opentofu/opentofu:${TOFU_VERSION}-minimal}"
TOFU_IMAGE_BINARY_PATH="${TOFU_IMAGE_BINARY_PATH:-/usr/local/bin/tofu}"
ALICLOUD_PROVIDER_ZIP_PATH="${ALICLOUD_PROVIDER_ZIP_PATH:-}"
HOST_CERT_BUNDLE_PATH="${HOST_CERT_BUNDLE_PATH:-}"
DOCKER_TMP_DIR="${DOCKER_TMP_DIR:-}"
TMP_DIR=""
TOFU_BIN="${TOFU_BIN:-}"
TOFU_MODE=""
TOFU_CLI_CONFIG_FILE_HOST=""
TOFU_CLI_CONFIG_FILE_DOCKER=""
PROVIDER_MIRROR_READY=""

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
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
    *)
      return 1
      ;;
  esac

  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="amd64" ;;
    *)
      return 1
      ;;
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

run_tofu_root() {
  detect_tofu_mode
  prepare_alicloud_provider_mirror

  if [ "$TOFU_MODE" = "docker" ]; then
    run_tofu_docker "/workspace" "$@"
    return
  fi

  (
    cd "$ROOT_DIR"
    if [ -n "$TOFU_CLI_CONFIG_FILE_HOST" ]; then
      TF_CLI_CONFIG_FILE="$TOFU_CLI_CONFIG_FILE_HOST" "$TOFU_BIN" "$@"
    else
      "$TOFU_BIN" "$@"
    fi
  )
}

run_tofu_in_directory() {
  local relative_dir="$1"
  shift
  detect_tofu_mode
  prepare_alicloud_provider_mirror

  if [ "$TOFU_MODE" = "docker" ]; then
    run_tofu_docker "/workspace/$relative_dir" "$@"
    return
  fi

  (
    cd "$ROOT_DIR/$relative_dir"
    if [ -n "$TOFU_CLI_CONFIG_FILE_HOST" ]; then
      TF_CLI_CONFIG_FILE="$TOFU_CLI_CONFIG_FILE_HOST" "$TOFU_BIN" "$@"
    else
      "$TOFU_BIN" "$@"
    fi
  )
}

run_tofu_in_example() {
  run_tofu_in_directory "infra/opentofu/examples/alicloud-enterprise-range" "$@"
}

cd "$ROOT_DIR"
run_tofu_root fmt -check -recursive infra/opentofu
run_tofu_in_example init -backend=false
run_tofu_in_example validate

for module in alicloud-enterprise-range alicloud-vpc-single-ecs alicloud-single-instance-network alicloud-single-instance-batch; do
  run_tofu_in_directory "infra/opentofu/modules/$module" init -backend=false
  run_tofu_in_directory "infra/opentofu/modules/$module" validate
done
run_tofu_in_directory "infra/opentofu/examples/alicloud-vpc-single-ecs" init -backend=false
run_tofu_in_directory "infra/opentofu/examples/alicloud-vpc-single-ecs" validate
run_tofu_in_directory "infra/opentofu/modules/alicloud-vpc-single-ecs" test -no-color
run_tofu_in_directory "infra/opentofu/modules/alicloud-single-instance-batch" test -no-color
