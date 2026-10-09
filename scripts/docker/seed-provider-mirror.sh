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

UNPACKED_ROOT="${WORKSPACES_ROOT}/provider-mirror-unpacked/${ACTUAL_SHA256}"
node - "${PROVIDER_ZIP_PATH}" "${UNPACKED_ROOT}" "${ALICLOUD_PROVIDER_VERSION}" "${ACTUAL_SHA256}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const [archive, destination, version, sha256] = process.argv.slice(2);
const readyPath = path.join(destination, '.provider-ready.json');
function verifyReady() {
  const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
  if (ready.sha256 !== sha256 || ready.version !== version || ready.platform !== 'linux_amd64'
    || typeof ready.executable !== 'string' || path.basename(ready.executable) !== ready.executable)
    throw new Error('Existing unpacked provider readiness differs from the verified archive');
  const binary = fs.statSync(path.join(destination, 'registry.opentofu.org/aliyun/alicloud', version, 'linux_amd64', ready.executable));
  if (!binary.isFile() || !(binary.mode & 0o111) || binary.mode & 0o222)
    throw new Error('Existing unpacked provider is not a read-only executable');
}
function setDirectoryModes(directory, readOnly, readOnlyFiles = readOnly) {
  if (!readOnly) fs.chmodSync(directory, 0o755);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (readOnly) throw new Error('Provider archive contains a symbolic link');
      continue;
    }
    if (entry.isDirectory()) setDirectoryModes(name, readOnly, readOnlyFiles);
    else if (readOnlyFiles) fs.chmodSync(name, fs.statSync(name).mode & 0o111 ? 0o555 : 0o444);
  }
  if (readOnly) fs.chmodSync(directory, 0o555);
}
if (fs.existsSync(destination)) {
  verifyReady();
} else {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, '.seed-'));
  try {
    const providerDir = path.join(temporary, 'registry.opentofu.org/aliyun/alicloud', version, 'linux_amd64');
    fs.mkdirSync(providerDir, { recursive: true });
    execFileSync('unzip', ['-q', archive, '-d', providerDir], { timeout: 120000, stdio: 'pipe' });
    const executables = fs.readdirSync(providerDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.startsWith('terraform-provider-alicloud_'));
    if (executables.length !== 1) throw new Error('Verified archive must contain exactly one Alibaba Cloud provider executable');
    const executable = executables[0].name;
    fs.chmodSync(path.join(providerDir, executable), 0o555);
    fs.writeFileSync(path.join(temporary, '.provider-ready.json'), JSON.stringify({ sha256, version, platform: 'linux_amd64', executable }));
    // Keep directories writable until publication for macOS bind mounts; provider files are already read-only.
    setDirectoryModes(temporary, false, true);
    try { fs.renameSync(temporary, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) && !(error.code === 'EACCES' && fs.existsSync(destination))) throw error;
      verifyReady();
    }
    setDirectoryModes(destination, true);
    verifyReady();
  } finally {
    if (fs.existsSync(temporary)) {
      setDirectoryModes(temporary, false);
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
NODE
export OPENTOFU_PROVIDER_UNPACKED_MIRROR_ROOT="${UNPACKED_ROOT}"

exec "$@"
