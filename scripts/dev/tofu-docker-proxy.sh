#!/usr/bin/env bash

set -euo pipefail

IMAGE="${TOFU_DOCKER_IMAGE:-ghcr.io/opentofu/opentofu:1.13.1-minimal}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKDIR="$(pwd)"
CONTAINER_ROOT="/workspace"
if [[ "$WORKDIR" == "$ROOT_DIR"* ]]; then
  RELATIVE_WORKDIR="${WORKDIR#"$ROOT_DIR"}"
  CONTAINER_WORKDIR="${CONTAINER_ROOT}${RELATIVE_WORKDIR}"
else
  CONTAINER_WORKDIR="${CONTAINER_ROOT}"
fi
if [[ -n "${TF_CLI_CONFIG_FILE:-}" && -f "${TF_CLI_CONFIG_FILE}" ]]; then
  mkdir -p "${ROOT_DIR}/.local/tofu-docker-proxy"
  TMP_TF_CLI_CONFIG_FILE="${ROOT_DIR}/.local/tofu-docker-proxy/terraform.$$.tfrc"
  sed "s|${ROOT_DIR}|${CONTAINER_ROOT}|g" "${TF_CLI_CONFIG_FILE}" > "${TMP_TF_CLI_CONFIG_FILE}"
  TF_CLI_CONFIG_FILE="${CONTAINER_ROOT}${TMP_TF_CLI_CONFIG_FILE#"$ROOT_DIR"}"
fi
HOST_CERT_BUNDLE_PATH="${HOST_CERT_BUNDLE_PATH:-}"

TRANSLATED_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "$ROOT_DIR"* ]]; then
    TRANSLATED_ARGS+=("${CONTAINER_ROOT}${arg#"$ROOT_DIR"}")
  else
    TRANSLATED_ARGS+=("$arg")
  fi
done

if [ -z "$HOST_CERT_BUNDLE_PATH" ]; then
  for candidate in /etc/ssl/cert.pem /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do
    if [ -f "$candidate" ]; then
      HOST_CERT_BUNDLE_PATH="$candidate"
      break
    fi
  done
fi

if [ -n "$HOST_CERT_BUNDLE_PATH" ] && [ -f "$HOST_CERT_BUNDLE_PATH" ]; then
  docker run --rm \
    -e ALICLOUD_ACCESS_KEY \
    -e ALICLOUD_SECRET_KEY \
    -e ALICLOUD_REGION \
    -e TF_CLI_CONFIG_FILE \
    -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    -v "${HOST_CERT_BUNDLE_PATH}:/etc/ssl/certs/ca-certificates.crt:ro" \
    -v "${ROOT_DIR}:${CONTAINER_ROOT}" \
    -w "${CONTAINER_WORKDIR}" \
    "${IMAGE}" \
    "${TRANSLATED_ARGS[@]}"
  exit 0
fi

docker run --rm \
  -e ALICLOUD_ACCESS_KEY \
  -e ALICLOUD_SECRET_KEY \
  -e ALICLOUD_REGION \
  -e TF_CLI_CONFIG_FILE \
  -v "${ROOT_DIR}:${CONTAINER_ROOT}" \
  -w "${CONTAINER_WORKDIR}" \
  "${IMAGE}" \
  "${TRANSLATED_ARGS[@]}"
