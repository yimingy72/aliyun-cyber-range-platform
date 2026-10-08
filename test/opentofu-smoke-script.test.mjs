import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const sourceScript = new URL('../scripts/dev/smoke-opentofu-enterprise-range.sh', import.meta.url);
const imageId = 'ubuntu_22_04_x64_20G_alibase_20260615.vhd';

function createSmokeFixture(t, overrides = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opentofu-smoke-script-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const repoRoot = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const exampleDir = path.join(repoRoot, 'infra/opentofu/examples/alicloud-enterprise-range');
  const scriptPath = path.join(repoRoot, 'scripts/dev/smoke-opentofu-enterprise-range.sh');
  const dockerLogPath = path.join(tempRoot, 'docker.log');
  const aliyunLogPath = path.join(tempRoot, 'aliyun.log');
  const capturedTfvarsPath = path.join(tempRoot, 'tfvars.json');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(exampleDir, { recursive: true });
  fs.mkdirSync(binDir);
  fs.copyFileSync(sourceScript, scriptPath);

  fs.writeFileSync(path.join(binDir, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" != "run" ]; then
  echo "unexpected docker invocation: $*" >&2
  exit 1
fi
shift
while [ "$#" -gt 0 ] && [ "$1" != "fake-image" ]; do shift; done
[ "$#" -gt 0 ] || exit 1
shift
printf '%s\\n' "$*" >> "$FIXTURE_DOCKER_LOG"
for arg in "$@"; do
  case "$arg" in "$FIXTURE_REPO_ROOT"/*) echo "host path leaked into tofu command" >&2; exit 42 ;; esac
done
case "$1" in
  plan)
    previous=""
    for arg in "$@"; do
      if [ "$previous" = "-var-file" ]; then
        cp "$FIXTURE_EXAMPLE_DIR/$arg" "$FIXTURE_TFVARS"
      fi
      previous="$arg"
    done
    ;;
  apply)
    if [ "$FIXTURE_APPLY_FAILS" = "1" ]; then echo "simulated apply failure" >&2; exit 9; fi
    ;;
  state)
    if [ "$FIXTURE_APPLY_FAILS" = "1" ]; then printf 'alicloud_vpc.range\\n'; fi
    ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'aliyun'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FIXTURE_ALIYUN_LOG"
case "$1 $2" in
  "ecs DescribeImages")
    printf '%s\\n' '{"Images":{"Image":[{"ImageId":"${imageId}","Status":"Available"}]}}'
    ;;
  "ecs DescribeAvailableResource")
    printf '%s\\n' '{"AvailableZones":{"AvailableZone":[{"AvailableResources":{"AvailableResource":[{"Type":"InstanceType","SupportedResources":{"SupportedResource":[{"Value":"ecs.c7.large","Status":"SoldOut"},{"Value":"ecs.u1-c1m2.large","Status":"Available"},{"Value":"ecs.sn1.medium","Status":"Available"}]}}]}}]}}'
    ;;
  *) echo "unexpected Aliyun invocation: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });

  return {
    dockerLogPath,
    aliyunLogPath,
    capturedTfvarsPath,
    exampleDir,
    run(mode) {
      return execFileSync('/bin/bash', [scriptPath, mode], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          TOFU_MODE: 'docker',
          TOFU_IMAGE: 'fake-image',
          TOFU_BIN: '',
          ALICLOUD_PROVIDER_ZIP_PATH: '',
          ALICLOUD_ACCESS_KEY: 'fixture-access-key',
          ALICLOUD_SECRET_KEY: 'fixture-secret-key',
          ALICLOUD_REGION: 'cn-hangzhou',
          ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
          OPENTOFU_IMAGE_ID: imageId,
          OPENTOFU_INSTANCE_TYPE: 'ecs.t6-c1m2.large',
          SMOKE_KEEP_RESOURCES: '0',
          DOCKER_TMP_DIR: path.join(tempRoot, 'docker-tmp'),
          SMOKE_RUN_ID: 'fixture',
          FIXTURE_REPO_ROOT: repoRoot,
          FIXTURE_EXAMPLE_DIR: exampleDir,
          FIXTURE_DOCKER_LOG: dockerLogPath,
          FIXTURE_ALIYUN_LOG: aliyunLogPath,
          FIXTURE_TFVARS: capturedTfvarsPath,
          FIXTURE_APPLY_FAILS: '0',
          ...overrides,
        },
        stdio: 'pipe',
      });
    },
  };
}

test('plan-only smoke script uses docker-safe tofu file paths', (t) => {
  const fixture = createSmokeFixture(t);
  fixture.run('--plan-only');
  const commands = fs.readFileSync(fixture.dockerLogPath, 'utf8');
  assert.match(commands, /^init\b/m);
  assert.match(commands, /^validate\b/m);
  assert.match(commands, /^plan\b/m);
  assert.doesNotMatch(commands, /^(apply|destroy)\b/m);
  assert.equal(fs.existsSync(path.join(fixture.exampleDir, '.smoke/fixture')), false);
});

test('full smoke script destroys residual resources when apply fails after partial creation', (t) => {
  const fixture = createSmokeFixture(t, { FIXTURE_APPLY_FAILS: '1' });
  assert.throws(() => fixture.run('--full'), /Command failed/);
  const commands = fs.readFileSync(fixture.dockerLogPath, 'utf8');
  assert.match(commands, /^apply\b/m);
  assert.match(commands, /^state list\b/m);
  assert.match(commands, /^destroy\b/m);
  assert.equal(fs.existsSync(path.join(fixture.exampleDir, '.smoke/fixture')), false);
});

test('plan-only smoke script resolves auto instance type from zone-available ECS inventory', (t) => {
  const fixture = createSmokeFixture(t, { OPENTOFU_INSTANCE_TYPE: 'auto' });
  fixture.run('--plan-only');
  const tfvars = JSON.parse(fs.readFileSync(fixture.capturedTfvarsPath, 'utf8'));
  const commands = fs.readFileSync(fixture.aliyunLogPath, 'utf8');
  assert.equal(tfvars.instance_type, 'ecs.u1-c1m2.large');
  assert.equal(tfvars.image_id, imageId);
  assert.match(commands, /ecs DescribeImages/);
  assert.match(commands, /ecs DescribeAvailableResource/);
  assert.match(commands, /--ZoneId cn-hangzhou-h/);
  assert.match(commands, /--RegionId cn-hangzhou/);
  assert.match(commands, /--DestinationResource InstanceType/);
});
