import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
    const archive = Buffer.from('provider-archive-fixture');

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
