import fs from 'node:fs/promises';
import path from 'node:path';
import { TENCENTCLOUD_PROVIDER_VERSION, TENCENTCLOUD_PROVIDER_LINUX_AMD64_SHA256 } from './renderers/tencent-cloud-opentofu-renderer';
import { createHash, randomUUID } from 'node:crypto';

// API and worker share this mirror. Never truncate files that a concurrent init may be reading.
async function publishAtomically(destination: string, write: (temporary: string) => Promise<void>) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await write(temporary);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function copyProviderArchiveAtomically(source: string, destination: string) {
  return publishAtomically(destination, temporary => fs.copyFile(source, temporary));
}

export function writeProviderConfigAtomically(destination: string, contents: string) {
  return publishAtomically(destination, temporary => fs.writeFile(temporary, contents, 'utf8'));
}

export async function migrateAliCloudWorkspaceProvider(workspaceDir: string) {
  const versionsPath = path.join(workspaceDir, 'versions.tf');
  const existing = await fs.readFile(versionsPath, 'utf8');
  const next = existing.replace(/\balicloud\s*=\s*\{[^}]*\}/g, block => {
    if (!/\bsource\s*=\s*"aliyun\/alicloud"/.test(block)) return block;
    const version = block.match(/\bversion\s*=\s*"([^"]+)"/);
    if (!version || !['~> 1.253', '= 1.282.0', '= 1.282.0-range.1'].includes(version[1])) {
      throw new Error('Persisted Alibaba Cloud provider constraint is not supported for migration');
    }
    return block.replace(version[0], 'version = "= 1.282.0-range.1"');
  });
  if (next !== existing) await writeProviderConfigAtomically(versionsPath, next);
}

export async function prepareOpenTofuProviderEnv(input: {
  provider?: 'alibaba_cloud' | 'tencent_cloud';
  providerZipPath?: string;
  workspacesRootDir: string;
  unpackedMirrorRootDir?: string;
}): Promise<NodeJS.ProcessEnv> {
  const providerName = input.provider === 'tencent_cloud' ? 'tencentcloud' : 'alicloud';
  const source = input.provider === 'tencent_cloud' ? 'tencentcloudstack/tencentcloud' : 'aliyun/alicloud';
  if (input.provider === 'tencent_cloud' && input.providerZipPath && path.basename(input.providerZipPath) !== 'terraform-provider-tencentcloud_1.83.34-range.1_linux_amd64.zip') throw new Error('Tencent execution requires the pinned durable ClientToken provider');
  const packedRoot = path.join(input.workspacesRootDir, 'provider-mirror');
  let mirrorRoot = packedRoot;
  let configName = providerName === 'alicloud' ? 'tofu.tfrc' : 'tofu-tencentcloud.tfrc';
  if (input.unpackedMirrorRootDir) {
    mirrorRoot = input.unpackedMirrorRootDir;
    const ready = JSON.parse(await fs.readFile(path.join(mirrorRoot, '.provider-ready.json'), 'utf8')) as {
      sha256?: string; version?: string; platform?: string; executable?: string;
    };
    if (!ready.sha256 || !/^[a-f0-9]{64}$/.test(ready.sha256) || path.basename(mirrorRoot) !== ready.sha256
      || !ready.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(ready.version) || ready.platform !== 'linux_amd64'
      || !ready.executable || path.basename(ready.executable) !== ready.executable
      || !ready.executable.startsWith(`terraform-provider-${providerName}_`)) {
      throw new Error('Unpacked provider mirror readiness is malformed');
    }
    if (input.provider === 'tencent_cloud' && (ready.version !== TENCENTCLOUD_PROVIDER_VERSION || ready.sha256 !== TENCENTCLOUD_PROVIDER_LINUX_AMD64_SHA256)) throw new Error('Tencent unpacked provider differs from the audited pinned artifact');
    const providerDir = path.join(mirrorRoot, `registry.opentofu.org/${source}`, ready.version, ready.platform);
    const executable = await fs.stat(path.join(providerDir, ready.executable));
    if (!executable.isFile() || !(executable.mode & 0o111) || executable.mode & 0o222) {
      throw new Error('Unpacked provider executable must be readable, executable and read-only');
    }
    if (input.providerZipPath && path.basename(input.providerZipPath) !== `terraform-provider-${providerName}_${ready.version}_${ready.platform}.zip`) {
      throw new Error('Unpacked provider mirror differs from the configured provider archive');
    }
    configName = providerName === 'alicloud' ? `tofu-unpacked-${ready.sha256}.tfrc` : `tofu-tencentcloud-unpacked-${ready.sha256}.tfrc`;
  } else if (input.providerZipPath) {
    const archive = await fs.stat(input.providerZipPath).catch(() => null);
    if (!archive?.isFile()) throw new Error(`ALICLOUD provider zip does not exist: ${input.providerZipPath}`);
    if (input.provider === 'tencent_cloud' && createHash('sha256').update(await fs.readFile(input.providerZipPath)).digest('hex') !== TENCENTCLOUD_PROVIDER_LINUX_AMD64_SHA256) throw new Error('Tencent provider archive checksum mismatch');
    await copyProviderArchiveAtomically(input.providerZipPath,
      path.join(packedRoot, `registry.opentofu.org/${source}`, path.basename(input.providerZipPath)));
  } else {
    return {};
  }
  const configPath = path.join(packedRoot, configName);
  const contents = [
    'provider_installation {',
    '  filesystem_mirror {',
    `    path = ${JSON.stringify(mirrorRoot)}`,
    `    include = ["registry.opentofu.org/${source}"]`,
    '  }',
    '  direct {',
    `    exclude = ["registry.opentofu.org/${source}"]`,
    '  }',
    '}',
    '',
  ].join('\n');
  const existing = await fs.readFile(configPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing !== contents) await writeProviderConfigAtomically(configPath, contents);
  return { TF_CLI_CONFIG_FILE: configPath };
}
