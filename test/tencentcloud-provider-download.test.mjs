import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(repo, 'scripts/dev/download-tencentcloud-provider.sh');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tencentcloud-provider-'));
  const archive = join(root, 'provider.zip');
  const bytes = Buffer.from('local non-executable download fixture');
  writeFileSync(archive, bytes);
  const env = {
    ...process.env,
    TENCENTCLOUD_PROVIDER_VERSION: '1.83.34',
    TENCENTCLOUD_PROVIDER_SHA256: sha256(bytes),
    TENCENTCLOUD_PROVIDER_DOWNLOAD_URL: pathToFileURL(archive).href,
    TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH: join(root, 'mirror'),
  };
  const cached = join(env.TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH, 'registry.opentofu.org/tencentcloudstack/tencentcloud/terraform-provider-tencentcloud_1.83.34_linux_amd64.zip');
  return { root, archive, bytes, env, cached };
}

test('publishes only a verified download and reuses a verified cache', () => {
  const f = fixture();
  try {
    assert.equal(spawnSync('sh', [script], { env: f.env }).status, 0);
    assert.deepEqual(readFileSync(f.cached), f.bytes);
    f.env.TENCENTCLOUD_PROVIDER_DOWNLOAD_URL = 'file:///missing-fixture';
    assert.equal(spawnSync('sh', [script], { env: f.env }).status, 0);
    assert.equal(readdirSync(dirname(f.cached)).length, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('refuses a changed download and never publishes it', () => {
  const f = fixture();
  try {
    writeFileSync(f.archive, 'changed upstream fixture');
    const result = spawnSync('sh', [script], { env: f.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum mismatch/);
    assert.equal(existsSync(f.cached), false);
    assert.equal(readdirSync(dirname(f.cached)).length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects a tampered cache before download and preserves it for inspection', () => {
  const f = fixture();
  try {
    mkdirSync(dirname(f.cached), { recursive: true });
    writeFileSync(f.cached, 'invalid cache');
    const result = spawnSync('sh', [script], { env: f.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cache checksum mismatch/);
    assert.equal(readFileSync(f.cached, 'utf8'), 'invalid cache');
    assert.equal(readdirSync(dirname(f.cached)).length, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects version path traversal and unpinned checksums before writing the mirror', () => {
  const f = fixture();
  try {
    for (const overrides of [{ TENCENTCLOUD_PROVIDER_VERSION: '../../escape' }, { TENCENTCLOUD_PROVIDER_SHA256: 'not-pinned' }]) {
      const result = spawnSync('sh', [script], { env: { ...f.env, ...overrides } });
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(f.env.TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH), false);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('falls back from the official mirror only for download failure, with the pinned hash intact', () => {
  const f = fixture();
  try {
    const bin = join(f.root, 'bin');
    mkdirSync(bin);
    const log = join(f.root, 'curl-log.jsonl');
    const fakeCurl = join(bin, 'curl');
    writeFileSync(fakeCurl, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args[args.indexOf('-o') - 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(url) + '\\n');
if (url.startsWith('https://mirrors.tencent.com/')) process.exit(22);
fs.copyFileSync(${JSON.stringify(f.archive)}, args[args.indexOf('-o') + 1]);
`);
    chmodSync(fakeCurl, 0o755);
    delete f.env.TENCENTCLOUD_PROVIDER_DOWNLOAD_URL;
    f.env.PATH = `${bin}:${f.env.PATH}`;
    assert.equal(spawnSync('sh', [script], { env: f.env }).status, 0);
    const urls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /^https:\/\/mirrors\.tencent\.com\/terraform\//);
    assert.match(urls[1], /^https:\/\/github\.com\/tencentcloudstack\/terraform-provider-tencentcloud\/releases\/download\/v1\.83\.34\//);
    assert.deepEqual(readFileSync(f.cached), f.bytes);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
