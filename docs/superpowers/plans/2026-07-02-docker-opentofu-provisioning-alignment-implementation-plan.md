# Docker/OpenTofu Provisioning Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Last Updated:** 2026-07-06
**Plan Status:** In Progress

## Implementation Status Snapshot

### 已完成

- API / worker 角色拆分与 `worker-main.ts` 启动入口
- `docker-compose.yml` 中 `provisioner-worker`、workspace 卷、provider mirror 卷
- 系统云配置持久化
- OpenTofu wrapper workspace 渲染主链路
- `deploy/current-system/` 部署快照目录

### 正在收尾

- 前端拓扑与实例创建链路在真实阿里云上的更多容器态回归
- 实例规格策略与前端 CPU/内存之间的对齐
- 部署快照与根目录 compose / 文档的持续同步

### 后续重点

- 补齐以自定义拓扑为输入的端到端 smoke 场景
- 把实例创建前检测与运行时选型策略继续收口

**Goal:** Make platform-created topologies provision through a Docker-friendly OpenTofu chain that matches the previously validated example-root smoke path, including persistent cloud config, stable provider/runtime handling, and a dedicated provisioning worker.

**Architecture:** Keep frontend topology compilation unchanged, but replace the current “run module directly” execution with a generated root-wrapper workspace that calls the existing OpenTofu module. Split provisioning into a dedicated worker service/container, persist cloud settings in Postgres, and move OpenTofu workspaces and provider mirror data into Docker volumes.

**Tech Stack:** NestJS 11, Prisma/PostgreSQL, Docker Compose, OpenTofu 1.12.x, Alibaba Cloud provider, Jest, Vitest

---

## File Structure

### Backend execution and config

- Modify: [apps/api/src/admin/system-config.service.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/system-config.service.ts)
  - Stop using process-only config as the source of truth.
- Modify: [apps/api/src/admin/system-config.controller.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/system-config.controller.ts)
  - Return masked secrets and accept write/update semantics.
- Modify: [apps/api/src/admin/range-instances.service.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/range-instances.service.ts)
  - Enqueue jobs only; no in-process “pretend worker” assumptions.
- Modify: [apps/api/src/provisioning/provisioning-worker.service.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/provisioning-worker.service.ts)
  - Consume DB-backed cloud config and run from a dedicated worker role.
- Modify: [apps/api/src/provisioning/open-tofu-range-provisioner.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/open-tofu-range-provisioner.ts)
  - Generate root-wrapper workspaces instead of executing the module directory directly.
- Modify: [apps/api/src/app.module.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/app.module.ts)
  - Split API and worker bootstrap configuration.
- Create: [apps/api/src/worker-main.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/worker-main.ts)
  - Dedicated provisioning worker bootstrap.
- Create: [apps/api/src/provisioning/root-wrapper-template.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/root-wrapper-template.ts)
  - Stable generated wrapper `.tf` file contents.

### Database

- Modify: [packages/database/prisma/schema.prisma](/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/database/prisma/schema.prisma)
  - Add persistent system config table.
- Create: `packages/database/prisma/migrations/<timestamp>_add_system_cloud_config/`
  - Prisma migration for persistent cloud settings.

### Docker/runtime

- Modify: [docker-compose.yml](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docker-compose.yml)
  - Add `provisioner-worker` and persistent volumes.
- Modify: [apps/api/Dockerfile](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/Dockerfile)
  - Include stable OpenTofu runtime and provider seed assets.
- Create: [scripts/docker/seed-provider-mirror.sh](/Users/yym/Documents/阿里云For综合靶场竞赛平台/scripts/docker/seed-provider-mirror.sh)
  - Prepare provider mirror volume at container startup.

### Tests

- Modify: [apps/api/test/admin-system-config.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/admin-system-config.e2e-spec.ts)
- Modify: [apps/api/test/enterprise-provision-plan.spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/enterprise-provision-plan.spec.ts)
- Modify: [apps/api/test/alibaba-cloud-opentofu-renderer.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/alibaba-cloud-opentofu-renderer.e2e-spec.ts)
- Modify: [apps/api/test/open-tofu-range-provisioner.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/open-tofu-range-provisioner.e2e-spec.ts)
- Modify: [apps/api/test/admin-resources.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/admin-resources.e2e-spec.ts)

## Task 1: Persist System Cloud Config

**Files:**
- Modify: [packages/database/prisma/schema.prisma](/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/database/prisma/schema.prisma)
- Create: `packages/database/prisma/migrations/<timestamp>_add_system_cloud_config/`
- Modify: [apps/api/src/admin/system-config.service.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/system-config.service.ts)
- Modify: [apps/api/src/admin/system-config.controller.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/system-config.controller.ts)
- Modify: [apps/api/test/admin-system-config.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/admin-system-config.e2e-spec.ts)

- [ ] **Step 1: Write the failing persistence test**

Add a case to `admin-system-config.e2e-spec.ts` that:

```ts
it('persists cloud config across service reload boundaries', async () => {
  // save config
  // create a fresh service/app context
  // expect the saved config to still be present
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/admin-system-config.e2e-spec.ts --runInBand
```

Expected: failure because config currently lives only in `process.env`.

- [ ] **Step 3: Add the Prisma model and migration**

Add a single-row config model shaped like:

```prisma
model SystemCloudConfig {
  id              String   @id
  provider        String
  defaultRegion   String
  defaultZoneId   String
  accessKeyId     String
  accessKeySecret String
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

- [ ] **Step 4: Move `SystemConfigService` to DB-backed reads/writes**

Implement service behavior with:

```ts
getSnapshot(): Promise<SystemCloudConfig>
updateSnapshot(payload: Partial<SystemCloudConfig>): Promise<SystemCloudConfig>
```

Rules:
- create default row on first read if absent
- return masked secret on controller GET
- preserve existing secret if PATCH omits or sends empty replacement semantics by explicit policy

- [ ] **Step 5: Re-run system-config tests**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/admin-system-config.e2e-spec.ts --runInBand
```

Expected: PASS

## Task 2: Split API and Provisioning Worker Roles

**Files:**
- Create: [apps/api/src/worker-main.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/worker-main.ts)
- Modify: [apps/api/src/app.module.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/app.module.ts)
- Modify: [apps/api/src/provisioning/provisioning-worker.service.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/provisioning-worker.service.ts)
- Modify: [apps/api/src/admin/range-instances.service.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/range-instances.service.ts)
- Modify: [apps/api/test/admin-resources.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/admin-resources.e2e-spec.ts)

- [ ] **Step 1: Write the failing enqueue-vs-worker test**

Add a case asserting that API-side create only enqueues work and does not depend on `queueMicrotask` execution in the same process:

```ts
it('creates provision jobs that can be claimed by a separate worker process', async () => {
  // create instance
  // trigger create
  // assert pending job exists before worker processes it
});
```

- [ ] **Step 2: Run the test to verify current coupling**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/admin-resources.e2e-spec.ts --runInBand
```

- [ ] **Step 3: Introduce a worker bootstrap**

Create `worker-main.ts` that boots the Nest container and starts a polling loop such as:

```ts
await app.init();
await workerService.runLoop();
```

- [ ] **Step 4: Refactor worker service to support polling**

Add a loop-oriented entrypoint:

```ts
async runLoop(): Promise<void>
```

Rules:
- claim pending jobs from DB
- process one job at a time per loop iteration
- sleep/backoff between polls
- keep existing per-job `process(jobId)` logic reusable

- [ ] **Step 5: Keep API trigger endpoints enqueue-only**

`RangeInstancesService` should:
- create jobs
- update instance status
- return immediately
- not rely on in-process long-running execution

- [ ] **Step 6: Re-run API resource tests**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/admin-resources.e2e-spec.ts --runInBand
```

Expected: PASS with explicit worker-compatible queue semantics

## Task 3: Generate a Stable Root Wrapper Workspace

**Files:**
- Create: [apps/api/src/provisioning/root-wrapper-template.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/root-wrapper-template.ts)
- Modify: [apps/api/src/provisioning/open-tofu-range-provisioner.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/open-tofu-range-provisioner.ts)
- Modify: [apps/api/test/open-tofu-range-provisioner.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/open-tofu-range-provisioner.e2e-spec.ts)

- [ ] **Step 1: Write the failing workspace-shape test**

Add a test asserting that generated workspaces contain:

```ts
[
  'main.tf',
  'variables.tf',
  'outputs.tf',
  'versions.tf',
  'range.auto.tfvars.json',
]
```

and that `main.tf` contains:

```hcl
module "range" {
  source = "/app/infra/opentofu/modules/alicloud-enterprise-range"
}
```

- [ ] **Step 2: Run the provisioner test to verify it fails**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/open-tofu-range-provisioner.e2e-spec.ts --runInBand
```

- [ ] **Step 3: Replace “copy module as root” with generated wrapper files**

Move `prepareWorkspace()` to:
- create empty workspace dir
- write wrapper `.tf` files from `root-wrapper-template.ts`
- write `range.auto.tfvars.json`

Do not copy `modules/alicloud-enterprise-range` into the workspace.

- [ ] **Step 4: Keep `compiledProvisionSpec -> tfvars` unchanged**

The renderer output remains the source of truth for tfvars:

```ts
const variables = await this.buildVariables(input);
await fs.writeFile(varsFilePath, JSON.stringify(variables, null, 2));
```

- [ ] **Step 5: Re-run provisioner tests**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/open-tofu-range-provisioner.e2e-spec.ts --runInBand
```

Expected: PASS with wrapper-root workspace assertions

## Task 4: Standardize Docker Runtime and Provider Mirror

**Files:**
- Modify: [apps/api/Dockerfile](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/Dockerfile)
- Create: [scripts/docker/seed-provider-mirror.sh](/Users/yym/Documents/阿里云For综合靶场竞赛平台/scripts/docker/seed-provider-mirror.sh)
- Modify: [docker-compose.yml](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docker-compose.yml)

- [ ] **Step 1: Write the failing Docker contract checklist**

Document expected runtime assets in test or smoke assertions:

```text
- api image contains tofu
- provider mirror path is available
- workspaces volume is mounted
- worker service exists
```

- [ ] **Step 2: Build API/worker image with OpenTofu available**

Update Dockerfile so the runtime image includes:

```dockerfile
RUN apk add --no-cache curl unzip bash libc6-compat
# install tofu binary
# copy provider bundle seed assets
```

- [ ] **Step 3: Seed provider mirror at container startup**

Create a script shaped like:

```bash
#!/usr/bin/env sh
set -eu
mkdir -p /var/lib/cyber-range/provider-mirror/registry.opentofu.org/aliyun/alicloud
# copy pinned provider bundle if mirror is empty
```

- [ ] **Step 4: Add `provisioner-worker` and volumes to Compose**

Compose should include:

```yaml
provisioner-worker:
  build:
    context: .
    dockerfile: apps/api/Dockerfile
  command: ["node", "apps/api/dist/worker-main.js"]
  volumes:
    - opentofu-workspaces:/var/lib/cyber-range/workspaces
    - provider-mirror:/var/lib/cyber-range/provider-mirror
```

- [ ] **Step 5: Point `OPENTOFU_WORKSPACES_ROOT` and provider mirror to in-container stable paths**

Use paths like:

```text
/var/lib/cyber-range/workspaces
/var/lib/cyber-range/provider-mirror
```

- [ ] **Step 6: Verify Compose renders correctly**

Run:

```bash
docker compose config
```

Expected: PASS with `api`, `provisioner-worker`, `postgres`, `web`, and both named volumes

## Task 5: Consume Persistent Cloud Config During Provisioning

**Files:**
- Modify: [apps/api/src/provisioning/open-tofu-range-provisioner.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/open-tofu-range-provisioner.ts)
- Modify: [apps/api/src/provisioning/provisioning-worker.service.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/provisioning-worker.service.ts)
- Modify: [apps/api/test/open-tofu-range-provisioner.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/open-tofu-range-provisioner.e2e-spec.ts)

- [ ] **Step 1: Write a failing test for DB-backed runtime config injection**

The test should assert that the provisioner receives AK/SK/region/zone from persisted config rather than only process env.

- [ ] **Step 2: Introduce a runtime config input object**

Shape:

```ts
type ResolvedProvisioningRuntimeConfig = {
  accessKeyId: string;
  accessKeySecret: string;
  defaultRegion: string;
  defaultZoneId: string;
}
```

- [ ] **Step 3: Have worker resolve cloud config before invoking the provisioner**

The worker should pass DB-backed config into provisioner calls rather than assuming env is the only source.

- [ ] **Step 4: Re-run provisioner tests**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/open-tofu-range-provisioner.e2e-spec.ts --runInBand
```

Expected: PASS

## Task 6: End-to-End Verification

**Files:**
- Modify if needed: [README.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/README.md)

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/admin-system-config.e2e-spec.ts test/admin-resources.e2e-spec.ts test/open-tofu-range-provisioner.e2e-spec.ts --runInBand
```

Expected: PASS

- [ ] **Step 2: Run focused frontend compile contract tests**

Run:

```bash
./apps/web/node_modules/.bin/vitest run apps/web/lib/template-compiler.test.ts apps/web/components/admin/template-editor/template-editor-screen.test.tsx
```

Expected: PASS

- [ ] **Step 3: Bring up Docker stack**

Run:

```bash
pnpm compose:up
```

Expected: healthy `postgres`, `api`, `provisioner-worker`, `web`

- [ ] **Step 4: Run platform-managed OpenTofu smoke through the API**

Use the `test` scenario or a dedicated smoke scenario to verify:
- create instance
- worker executes wrapper-root workspace
- `tofu init/validate/plan/apply`
- outputs are written back

- [ ] **Step 5: Immediately destroy smoke resources**

Destroy the created instance and verify:
- `destroy` job succeeds
- state/workspace remain reusable for audit
- no temporary Alibaba Cloud resources are left behind

- [ ] **Step 6: Update README with the final Docker production path**

Add:
- required env vars
- worker service role
- volume expectations
- provider mirror strategy

## Plan Self-Review

- Spec coverage checked: this plan covers root-wrapper execution shape, worker split, Docker volumes, provider mirror, and DB-backed cloud config.
- Scan checked: no unfinished markers remain.
- Type consistency checked: all proposed units reference the same root-wrapper + worker architecture.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-02-docker-opentofu-provisioning-alignment-implementation-plan.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints
