import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const providerRelativePath = path.join(
  'registry.opentofu.org',
  'aliyun',
  'alicloud',
  'terraform-provider-alicloud_1.282.0_linux_amd64.zip',
);

for (const scriptRelativePath of [
  'scripts/docker/seed-provider-mirror.sh',
  'deploy/current-system/scripts/docker/seed-provider-mirror.sh',
]) {
  test(`${scriptRelativePath} seeds a new provider mirror from the bundled archive`, () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-mirror-seed-'));
    const mirrorRoot = path.join(tempRoot, 'mirror');
    const workspacesRoot = path.join(tempRoot, 'workspaces');
    const seededArchivePath = path.join(tempRoot, 'provider.zip');
    const expectedArchive = Buffer.from('provider-archive-fixture');

    try {
      fs.writeFileSync(seededArchivePath, expectedArchive);

      execFileSync('/bin/sh', [path.join(repoRoot, scriptRelativePath), 'true'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPENTOFU_PROVIDER_MIRROR_ROOT: mirrorRoot,
          OPENTOFU_WORKSPACES_ROOT: workspacesRoot,
          SEEDED_PROVIDER_ZIP: seededArchivePath,
        },
        stdio: 'pipe',
      });

      const providerArchivePath = path.join(mirrorRoot, providerRelativePath);
      assert.equal(fs.existsSync(providerArchivePath), true);
      assert.deepEqual(fs.readFileSync(providerArchivePath), expectedArchive);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}
