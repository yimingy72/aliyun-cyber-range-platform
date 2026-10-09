import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const downloadScriptPath = path.join(repoRoot, 'scripts/dev/download-alicloud-provider.sh');
const providerRelativePath = path.join(
  'registry.opentofu.org',
  'aliyun',
  'alicloud',
  'terraform-provider-alicloud_1.282.0_linux_amd64.zip',
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('host provider download script verifies a downloaded archive and reuses the cache', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-mirror-download-'));
  const mirrorRoot = path.join(tempRoot, 'mirror');
  const sourceArchivePath = path.join(tempRoot, 'provider.zip');
  const archive = Buffer.from('provider-archive-fixture');

  try {
    fs.writeFileSync(sourceArchivePath, archive);

    const env = {
      ...process.env,
      OPENTOFU_PROVIDER_MIRROR_HOST_PATH: mirrorRoot,
      ALICLOUD_PROVIDER_VERSION: '1.282.0',
      ALICLOUD_PROVIDER_SHA256: sha256(archive),
      ALICLOUD_PROVIDER_DOWNLOAD_URL: pathToFileURL(sourceArchivePath).href,
    };

    execFileSync('/bin/sh', [downloadScriptPath], { cwd: repoRoot, env, stdio: 'pipe' });

    const providerArchivePath = path.join(mirrorRoot, providerRelativePath);
    assert.deepEqual(fs.readFileSync(providerArchivePath), archive);

    fs.rmSync(sourceArchivePath);
    execFileSync('/bin/sh', [downloadScriptPath], { cwd: repoRoot, env, stdio: 'pipe' });
    assert.deepEqual(fs.readFileSync(providerArchivePath), archive);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

for (const scriptRelativePath of [
  'scripts/docker/seed-provider-mirror.sh',
  'deploy/current-system/scripts/docker/seed-provider-mirror.sh',
]) {
  test(`${scriptRelativePath} rejects a missing host provider cache`, () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-mirror-seed-'));

    try {
      const mirrorRoot = path.join(tempRoot, 'mirror');
      const workspacesRoot = path.join(tempRoot, 'workspaces');
      let error;
      try {
        execFileSync('/bin/sh', [path.join(repoRoot, scriptRelativePath), 'true'], {
          cwd: repoRoot,
          env: {
            ...process.env,
            OPENTOFU_PROVIDER_MIRROR_ROOT: mirrorRoot,
            OPENTOFU_WORKSPACES_ROOT: workspacesRoot,
          },
          stdio: 'pipe',
        });
      } catch (caught) {
        error = caught;
      }

      assert.ok(error);
      assert.match(error.stderr.toString(), /Missing Alibaba Cloud provider cache/);
      assert.equal(fs.existsSync(path.join(mirrorRoot, 'registry.opentofu.org')), false);
      assert.equal(fs.existsSync(workspacesRoot), true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test(`${scriptRelativePath} accepts a checksum-verified host provider cache`, () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-mirror-seed-'));
    const mirrorRoot = path.join(tempRoot, 'mirror');
    const archive = providerArchiveFixture(tempRoot);

    try {
      const providerArchivePath = path.join(mirrorRoot, providerRelativePath);
      fs.mkdirSync(path.dirname(providerArchivePath), { recursive: true });
      fs.writeFileSync(providerArchivePath, archive);

      execFileSync('/bin/sh', [path.join(repoRoot, scriptRelativePath), 'true'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPENTOFU_PROVIDER_MIRROR_ROOT: mirrorRoot,
          OPENTOFU_WORKSPACES_ROOT: path.join(tempRoot, 'workspaces'),
          ALICLOUD_PROVIDER_SHA256: sha256(archive),
        },
        stdio: 'pipe',
      });

      assert.deepEqual(fs.readFileSync(providerArchivePath), archive);
      const readyRoot = path.join(tempRoot, 'workspaces/provider-mirror-unpacked', sha256(archive));
      const ready = JSON.parse(fs.readFileSync(path.join(readyRoot, '.provider-ready.json'), 'utf8'));
      assert.equal(ready.sha256, sha256(archive));
      const executable = path.join(readyRoot, 'registry.opentofu.org/aliyun/alicloud/1.282.0/linux_amd64', ready.executable);
      assert.equal(fs.statSync(executable).mode & 0o222, 0);
      assert.ok(fs.statSync(executable).mode & 0o111);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

test('container build and compose configuration use the host provider cache', () => {
  for (const dockerfilePath of ['apps/api/Dockerfile', 'deploy/current-system/apps/api/Dockerfile']) {
    const dockerfile = fs.readFileSync(path.join(repoRoot, dockerfilePath), 'utf8');
    assert.doesNotMatch(dockerfile, /github\.com\/aliyun\/terraform-provider-alicloud\/releases/);
    assert.doesNotMatch(dockerfile, /\/opt\/provider-seed/);
  }

  for (const [composePath, mirrorPath] of [
    ['docker-compose.yml', './.local/provider-mirror'],
    ['deploy/current-system/docker-compose.yml', '../../.local/provider-mirror'],
    ['deploy/current-system/docker-compose.images.yml', '../../.local/provider-mirror'],
  ]) {
    const compose = fs.readFileSync(path.join(repoRoot, composePath), 'utf8');
    assert.match(compose, new RegExp(`\\$\\{OPENTOFU_PROVIDER_MIRROR_HOST_PATH:-${mirrorPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}:/var/lib/cyber-range/provider-mirror:ro`));
    assert.doesNotMatch(compose, /\n  provider-mirror:\n/);
  }
});

function providerArchiveFixture(tempRoot) {
  const executable = path.join(tempRoot, 'terraform-provider-alicloud_v1.282.0');
  const archive = path.join(tempRoot, 'fixture.zip');
  fs.writeFileSync(executable, 'offline provider fixture', { mode: 0o755 });
  execFileSync('zip', ['-q', '-j', archive, executable]);
  return fs.readFileSync(archive);
}

test('concurrent Docker seeds reuse one immutable mirror and publish its path to the child process', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-unpacked-seed-'));
  const archive = providerArchiveFixture(tempRoot);
  const mirrorRoot = path.join(tempRoot, 'mirror');
  const archivePath = path.join(mirrorRoot, providerRelativePath);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, archive);
  const env = { ...process.env, OPENTOFU_PROVIDER_MIRROR_ROOT: mirrorRoot,
    OPENTOFU_WORKSPACES_ROOT: path.join(tempRoot, 'workspaces'), ALICLOUD_PROVIDER_SHA256: sha256(archive) };
  try {
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => promisify(execFile)('/bin/sh', [
      path.join(repoRoot, index % 2 ? 'scripts/docker/seed-provider-mirror.sh' : 'deploy/current-system/scripts/docker/seed-provider-mirror.sh'),
      'node', '-e', 'process.stdout.write(process.env.OPENTOFU_PROVIDER_UNPACKED_MIRROR_ROOT)',
    ], { env })));
    const readyRoot = path.join(tempRoot, 'workspaces/provider-mirror-unpacked', sha256(archive));
    assert.ok(results.every(result => result.stdout === readyRoot));
    assert.deepEqual(fs.readdirSync(path.dirname(readyRoot)), [sha256(archive)]);
    const marker = fs.statSync(path.join(readyRoot, '.provider-ready.json'));
    await promisify(execFile)('/bin/sh', [path.join(repoRoot, 'scripts/docker/seed-provider-mirror.sh'), 'true'], { env });
    assert.equal(fs.statSync(path.join(readyRoot, '.provider-ready.json')).ino, marker.ino);
  } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
});
