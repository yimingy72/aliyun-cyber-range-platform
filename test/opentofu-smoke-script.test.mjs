import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('plan-only smoke script uses docker-safe tofu file paths', () => {
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opentofu-smoke-script-'));
  const fakeBinDir = path.join(tempRoot, 'bin');
  const dockerLogPath = path.join(tempRoot, 'docker-commands.log');
  const fakeDockerPath = path.join(fakeBinDir, 'docker');

  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.writeFileSync(
    fakeDockerPath,
    `#!/usr/bin/env bash
set -euo pipefail

if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  exit 0
fi

if [ "$1" != "run" ]; then
  echo "unexpected docker invocation: $*" >&2
  exit 1
fi

shift

while [ "$#" -gt 0 ]; do
  if [ "$1" = "fake-image" ]; then
    shift
    printf '%s\\n' "$*" >> "${dockerLogPath}"
    for arg in "$@"; do
      case "$arg" in
        ${repoRoot}/*)
          echo "host path leaked into tofu command: $arg" >&2
          exit 42
          ;;
      esac
    done
    exit 0
  fi
  shift
done

echo "docker image marker not found" >&2
exit 1
`,
    'utf8',
  );
  fs.chmodSync(fakeDockerPath, 0o755);

  const scriptPath = path.join(repoRoot, 'scripts', 'dev', 'smoke-opentofu-enterprise-range.sh');

  execFileSync('/bin/bash', [scriptPath, '--plan-only'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      TOFU_IMAGE: 'fake-image',
      ALICLOUD_ACCESS_KEY: 'ak',
      ALICLOUD_SECRET_KEY: 'sk',
      ALICLOUD_REGION: 'cn-hangzhou',
      ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
      OPENTOFU_IMAGE_ID: 'ubuntu_22_04_x64_20G_alibase_20260615.vhd',
      OPENTOFU_INSTANCE_PASSWORD: 'TmpPlanOnly123!',
      DOCKER_TMP_DIR: path.join(tempRoot, 'docker-tmp'),
      SMOKE_RUN_ID: 'test-smoke-script',
    },
    stdio: 'pipe',
  });

  const dockerCommands = fs.readFileSync(dockerLogPath, 'utf8');

  assert.match(dockerCommands, /^init\b/m);
  assert.match(dockerCommands, /^validate\b/m);
  assert.match(dockerCommands, /^plan\b/m);
});

test('full smoke script destroys residual resources when apply fails after partial creation', () => {
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opentofu-smoke-cleanup-'));
  const fakeBinDir = path.join(tempRoot, 'bin');
  const dockerLogPath = path.join(tempRoot, 'docker-commands.log');
  const fakeDockerPath = path.join(fakeBinDir, 'docker');

  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.writeFileSync(
    fakeDockerPath,
    `#!/usr/bin/env bash
set -euo pipefail

if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  exit 0
fi

if [ "$1" != "run" ]; then
  echo "unexpected docker invocation: $*" >&2
  exit 1
fi

shift

while [ "$#" -gt 0 ]; do
  if [ "$1" = "fake-image" ]; then
    shift
    printf '%s\\n' "$*" >> "${dockerLogPath}"

    case "$1" in
      state)
        if [ "$2" = "list" ]; then
          printf 'alicloud_vpc.range\\n'
          exit 0
        fi
        ;;
      apply)
        echo "simulated apply failure" >&2
        exit 9
        ;;
      destroy)
        exit 0
        ;;
      *)
        exit 0
        ;;
    esac
  fi
  shift
done

echo "docker image marker not found" >&2
exit 1
`,
    'utf8',
  );
  fs.chmodSync(fakeDockerPath, 0o755);

  const scriptPath = path.join(repoRoot, 'scripts', 'dev', 'smoke-opentofu-enterprise-range.sh');

  assert.throws(
    () =>
      execFileSync('/bin/bash', [scriptPath, '--full'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          TOFU_IMAGE: 'fake-image',
          ALICLOUD_ACCESS_KEY: 'ak',
          ALICLOUD_SECRET_KEY: 'sk',
          ALICLOUD_REGION: 'cn-hangzhou',
          ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
          OPENTOFU_IMAGE_ID: 'ubuntu_22_04_x64_20G_alibase_20260615.vhd',
          OPENTOFU_INSTANCE_PASSWORD: 'TmpApplyFail123!',
          OPENTOFU_INSTANCE_TYPE: 'ecs.t6-c1m2.large',
          DOCKER_TMP_DIR: path.join(tempRoot, 'docker-tmp'),
          SMOKE_RUN_ID: 'test-smoke-cleanup',
        },
        stdio: 'pipe',
      }),
    /Command failed/,
  );

  const dockerCommands = fs.readFileSync(dockerLogPath, 'utf8');

  assert.match(dockerCommands, /^apply\b/m);
  assert.match(dockerCommands, /^state list\b/m);
  assert.match(dockerCommands, /^destroy\b/m);
});

test('plan-only smoke script resolves auto instance type from zone-available ECS inventory', () => {
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opentofu-smoke-auto-instance-'));
  const fakeBinDir = path.join(tempRoot, 'bin');
  const dockerLogPath = path.join(tempRoot, 'docker-commands.log');
  const aliyunLogPath = path.join(tempRoot, 'aliyun-commands.log');
  const capturedTfvarsPath = path.join(tempRoot, 'captured-smoke.auto.tfvars.json');
  const fakeDockerPath = path.join(fakeBinDir, 'docker');
  const fakeAliyunPath = path.join(fakeBinDir, 'aliyun');

  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.writeFileSync(
    fakeDockerPath,
    `#!/usr/bin/env bash
set -euo pipefail

if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  exit 0
fi

if [ "$1" != "run" ]; then
  echo "unexpected docker invocation: $*" >&2
  exit 1
fi

shift

while [ "$#" -gt 0 ]; do
  if [ "$1" = "fake-image" ]; then
    shift
    printf '%s\\n' "$*" >> "${dockerLogPath}"

    if [ "$1" = "plan" ]; then
      previous=""
      for arg in "$@"; do
        if [ "$previous" = "-var-file" ]; then
          cp "${repoRoot}/infra/opentofu/examples/alicloud-enterprise-range/$arg" "${capturedTfvarsPath}"
          break
        fi
        previous="$arg"
      done
    fi

    exit 0
  fi
  shift
done

echo "docker image marker not found" >&2
exit 1
`,
    'utf8',
  );
  fs.chmodSync(fakeDockerPath, 0o755);

  fs.writeFileSync(
    fakeAliyunPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${aliyunLogPath}"
cat <<'EOF'
{
  "AvailableZones": {
    "AvailableZone": [
      {
        "ZoneId": "cn-hangzhou-h",
        "Status": "Available",
        "AvailableResources": {
          "AvailableResource": [
            {
              "Type": "InstanceType",
              "Status": "Available",
              "SupportedResources": {
                "SupportedResource": [
                  { "Value": "ecs.c7.large", "Status": "SoldOut" },
                  { "Value": "ecs.u1-c1m2.large", "Status": "Available" },
                  { "Value": "ecs.sn1.medium", "Status": "Available" }
                ]
              }
            }
          ]
        }
      }
    ]
  }
}
EOF
`,
    'utf8',
  );
  fs.chmodSync(fakeAliyunPath, 0o755);

  const scriptPath = path.join(repoRoot, 'scripts', 'dev', 'smoke-opentofu-enterprise-range.sh');

  execFileSync('/bin/bash', [scriptPath, '--plan-only'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      TOFU_IMAGE: 'fake-image',
      ALICLOUD_ACCESS_KEY: 'ak',
      ALICLOUD_SECRET_KEY: 'sk',
      ALICLOUD_REGION: 'cn-hangzhou',
      ALICLOUD_ZONE_ID: 'cn-hangzhou-h',
      OPENTOFU_IMAGE_ID: 'ubuntu_22_04_x64_20G_alibase_20260615.vhd',
      OPENTOFU_INSTANCE_PASSWORD: 'TmpPlanOnly123!',
      OPENTOFU_INSTANCE_TYPE: 'auto',
      DOCKER_TMP_DIR: path.join(tempRoot, 'docker-tmp'),
      SMOKE_RUN_ID: 'test-smoke-auto-instance',
    },
    stdio: 'pipe',
  });

  const tfvars = JSON.parse(fs.readFileSync(capturedTfvarsPath, 'utf8'));
  const aliyunCommands = fs.readFileSync(aliyunLogPath, 'utf8');

  assert.equal(tfvars.instance_type, 'ecs.u1-c1m2.large');
  assert.match(aliyunCommands, /ecs DescribeAvailableResource/);
  assert.match(aliyunCommands, /--ZoneId cn-hangzhou-h/);
  assert.match(aliyunCommands, /--RegionId cn-hangzhou/);
  assert.match(aliyunCommands, /--DestinationResource InstanceType/);
});
