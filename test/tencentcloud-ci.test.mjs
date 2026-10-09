import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

function runCi(failStage = '') {
  const root = mkdtempSync(join(tmpdir(), 'tencentcloud-ci-'));
  const bin = join(root, 'bin');
  const log = join(root, 'docker.jsonl');
  const aliMirror = join(root, 'alicloud');
  const tencentMirror = join(root, 'tencentcloud');
  for (const directory of [bin, aliMirror, tencentMirror]) mkdirSync(directory);
  const fakeDocker = join(bin, 'docker');
  writeFileSync(fakeDocker, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args.includes('scripts/dev/download-tencentcloud-provider.sh') && process.env.TEST_FAIL_STAGE === 'download') process.exit(1);
if (args[0] === 'inspect') console.log('healthy');
const validation = args.find(arg => typeof arg === 'string' && arg.includes('node /source/check-tencentcloud-provider-schema.cjs'));
if (validation) {
  if (process.env.TEST_FAIL_STAGE === 'validate') process.exit(1);
  const mount = args.find(arg => typeof arg === 'string' && arg.endsWith(':/validation'));
  fs.writeFileSync(mount.slice(0, -':/validation'.length) + '/provider-schema.json', '{}');
}
`);
  chmodSync(fakeDocker, 0o755);
  const result = spawnSync('bash', [join(repo, 'scripts/ci/verify-docker.sh')], {
    cwd: repo,
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`,
      GITHUB_RUN_ID: 'ci-fixture', GITHUB_RUN_ATTEMPT: '2',
      CI_IMAGE: 'cyber-range-ci:fixture', CI_BASE_IMAGE: 'fixture-dependencies',
      OPENTOFU_PROVIDER_MIRROR_HOST_PATH: aliMirror,
      TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH: tencentMirror,
      TENCENTCLOUD_VALIDATION_ROOT: join(root, 'validation'),
      TEST_FAIL_STAGE: failStage,
    },
    encoding: 'utf8',
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  rmSync(root, { recursive: true, force: true });
  return { result, calls, tencentMirror };
}

test('default CI verifies Tencent in Docker with a frozen cache and an isolated run image', () => {
  const { result, calls, tencentMirror } = runCi();
  assert.equal(result.status, 0, result.stderr);
  const download = calls.find(args => args.includes('scripts/dev/download-tencentcloud-provider.sh'));
  assert(download);
  assert(download.includes('cyber-range-ci:fixture'));
  assert(download.includes('--user'));
  assert(download.includes(`${tencentMirror}:/app/.local/tencentcloud-provider/mirror:ro`));
  assert(!download.some(arg => /TENCENTCLOUD_SECRET_ID|TENCENTCLOUD_SECRET_KEY/.test(arg)));
  const validation = calls.find(args => args.some(arg => arg.includes('node /source/check-tencentcloud-provider-schema.cjs')));
  assert(validation.includes('none'));
  assert(validation.includes('cyber-range-tencentcloud-iac:ci-fixture-2'));
  assert(validation.some(arg => arg.includes('for module in tencentcloud-single-instance-network tencentcloud-single-instance-batch')));
  const apiTests = calls.find(args => args.some(arg => arg.includes('pnpm test')));
  assert(calls.indexOf(validation) < calls.indexOf(apiTests));
  const workflow = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /path: \.local\/tencentcloud-provider\/mirror/);
  assert.match(workflow, /hashFiles\('scripts\/dev\/download-tencentcloud-provider\.sh'\)/);
});

for (const stage of ['download', 'validate']) {
  test(`a Tencent ${stage} failure stops CI before database startup and application tests`, () => {
    const { result, calls } = runCi(stage);
    assert.notEqual(result.status, 0);
    assert(!calls.some(args => args.includes('--health-cmd')));
    assert(!calls.some(args => args.some(arg => arg.includes('pnpm test'))));
  });
}
