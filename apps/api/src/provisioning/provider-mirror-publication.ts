import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

export async function prepareOpenTofuProviderEnv(input: {
  providerZipPath?: string;
  workspacesRootDir: string;
  unpackedMirrorRootDir?: string;
}): Promise<NodeJS.ProcessEnv> {
  const packedRoot = path.join(input.workspacesRootDir, 'provider-mirror');
  let mirrorRoot = packedRoot;
  let configName = 'tofu.tfrc';
  if (input.unpackedMirrorRootDir) {
    mirrorRoot = input.unpackedMirrorRootDir;
    const ready = JSON.parse(await fs.readFile(path.join(mirrorRoot, '.provider-ready.json'), 'utf8')) as {
      sha256?: string; version?: string; platform?: string; executable?: string;
    };
    if (!ready.sha256 || !/^[a-f0-9]{64}$/.test(ready.sha256) || path.basename(mirrorRoot) !== ready.sha256
      || !ready.version || !/^\d+\.\d+\.\d+$/.test(ready.version) || ready.platform !== 'linux_amd64'
      || !ready.executable || path.basename(ready.executable) !== ready.executable
      || !ready.executable.startsWith('terraform-provider-alicloud_')) {
      throw new Error('Unpacked provider mirror readiness is malformed');
    }
    const providerDir = path.join(mirrorRoot, 'registry.opentofu.org/aliyun/alicloud', ready.version, ready.platform);
    const executable = await fs.stat(path.join(providerDir, ready.executable));
    if (!executable.isFile() || !(executable.mode & 0o111) || executable.mode & 0o222) {
      throw new Error('Unpacked provider executable must be readable, executable and read-only');
    }
    if (input.providerZipPath && path.basename(input.providerZipPath) !== `terraform-provider-alicloud_${ready.version}_${ready.platform}.zip`) {
      throw new Error('Unpacked provider mirror differs from the configured provider archive');
    }
    configName = `tofu-unpacked-${ready.sha256}.tfrc`;
  } else if (input.providerZipPath) {
    const source = await fs.stat(input.providerZipPath).catch(() => null);
    if (!source?.isFile()) throw new Error(`ALICLOUD provider zip does not exist: ${input.providerZipPath}`);
    await copyProviderArchiveAtomically(input.providerZipPath,
      path.join(packedRoot, 'registry.opentofu.org/aliyun/alicloud', path.basename(input.providerZipPath)));
  } else {
    return {};
  }
  const configPath = path.join(packedRoot, configName);
  const contents = [
    'provider_installation {',
    '  filesystem_mirror {',
    `    path = ${JSON.stringify(mirrorRoot)}`,
    '    include = ["registry.opentofu.org/aliyun/alicloud"]',
    '  }',
    '  direct {',
    '    exclude = ["registry.opentofu.org/aliyun/alicloud"]',
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
