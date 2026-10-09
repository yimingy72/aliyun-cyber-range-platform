import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { copyProviderArchiveAtomically, writeProviderConfigAtomically, prepareOpenTofuProviderEnv } from '../src/provisioning/provider-mirror-publication';

const checksum = (data: Buffer) => createHash('sha256').update(data).digest('hex');
describe('provider mirror publication across concurrent jobs', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-publication-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('readers see complete old or new archives while multiple jobs publish replacements', async () => {
    const first = Buffer.alloc(8 * 1024 * 1024, 0x61), second = Buffer.alloc(first.length, 0x62);
    const sourceA = path.join(root, 'a.zip'), sourceB = path.join(root, 'b.zip'), destination = path.join(root, 'mirror/provider.zip');
    await fs.writeFile(sourceA, first); await fs.writeFile(sourceB, second);
    await copyProviderArchiveAtomically(sourceA, destination);
    const allowed = new Set([checksum(first), checksum(second)]);
    let running = true, reads = 0;
    const reader = (async () => {
      while (running) { expect(allowed.has(checksum(await fs.readFile(destination)))).toBe(true); reads++; }
    })();
    try {
      await Promise.all([sourceA, sourceB].map(async source => {
        for (let i = 0; i < 12; i++) await copyProviderArchiveAtomically(source, destination);
      }));
    } finally { running = false; await reader; }
    expect(reads).toBeGreaterThan(0);
    expect(await fs.readdir(path.dirname(destination))).toEqual(['provider.zip']);
  });

  it('publishes complete CLI config and keeps an existing archive if a copy fails', async () => {
    const destination = path.join(root, 'provider.zip'), config = path.join(root, 'tofu.tfrc');
    await fs.writeFile(destination, 'previous verified archive');
    await expect(copyProviderArchiveAtomically(path.join(root, 'missing.zip'), destination)).rejects.toThrow();
    expect(await fs.readFile(destination, 'utf8')).toBe('previous verified archive');
    await Promise.all(Array.from({ length: 12 }, () => writeProviderConfigAtomically(config, 'provider_installation {\n}\n')));
    expect(await fs.readFile(config, 'utf8')).toBe('provider_installation {\n}\n');
    expect((await fs.readdir(root)).sort()).toEqual(['provider.zip', 'tofu.tfrc']);
  });

  it('retains the traditional packed ZIP environment and leaves caller credentials out of the helper', async () => {
    const source = path.join(root, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip');
    await fs.writeFile(source, 'legacy mock archive');
    const env = await prepareOpenTofuProviderEnv({ providerZipPath: source, workspacesRootDir: root });
    expect(Object.keys(env)).toEqual(['TF_CLI_CONFIG_FILE']);
    expect(await fs.readFile(path.join(root, 'provider-mirror/registry.opentofu.org/aliyun/alicloud', path.basename(source)), 'utf8')).toBe('legacy mock archive');
    expect(await fs.readFile(env.TF_CLI_CONFIG_FILE!, 'utf8')).toContain(JSON.stringify(path.join(root, 'provider-mirror')));
    expect(await prepareOpenTofuProviderEnv({ workspacesRootDir: root })).toEqual({});
  });

  it('reuses a ready read-only unpacked mirror without copying archives or replacing identical CLI config', async () => {
    const sha256 = checksum(Buffer.from('fixture'));
    const unpackedMirrorRootDir = path.join(root, 'unpacked', sha256);
    const executable = 'terraform-provider-alicloud_v1.282.0';
    const binary = path.join(unpackedMirrorRootDir, 'registry.opentofu.org/aliyun/alicloud/1.282.0/linux_amd64', executable);
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, 'offline fixture', { mode: 0o555 });
    await fs.writeFile(path.join(unpackedMirrorRootDir, '.provider-ready.json'), JSON.stringify({ sha256, version: '1.282.0', platform: 'linux_amd64', executable }));
    const options = { workspacesRootDir: root, unpackedMirrorRootDir,
      providerZipPath: path.join(root, 'terraform-provider-alicloud_1.282.0_linux_amd64.zip') };
    const first = await prepareOpenTofuProviderEnv(options);
    const before = await fs.stat(first.TF_CLI_CONFIG_FILE!);
    const repeated = await Promise.all(Array.from({ length: 12 }, () => prepareOpenTofuProviderEnv(options)));
    expect(repeated.every(env => env.TF_CLI_CONFIG_FILE === first.TF_CLI_CONFIG_FILE)).toBe(true);
    expect((await fs.stat(first.TF_CLI_CONFIG_FILE!)).ino).toBe(before.ino);
    expect(await fs.readFile(first.TF_CLI_CONFIG_FILE!, 'utf8')).toContain(JSON.stringify(unpackedMirrorRootDir));
    expect((await fs.readdir(path.join(root, 'provider-mirror'))).every(name => name.endsWith('.tfrc'))).toBe(true);
    await expect(prepareOpenTofuProviderEnv({ ...options, providerZipPath: '/different_1.0.0.zip' })).rejects.toThrow('differs');
    await fs.chmod(binary, 0o755);
    await expect(prepareOpenTofuProviderEnv(options)).rejects.toThrow('read-only');
  });
});
