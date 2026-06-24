# Milestone 3 Minimal Orchestration Implementation Plan

> **历史计划说明**
>
> - 本文件默认前提是“先把 single-ecs 最小编排闭环跑通，再往上叠功能”。
> - 该顺序已经不再符合当前最终需求，因为真实目标是“一队一套企业网络型靶场”，而不是单 ECS 编排演示。
> - 本文件可保留为历史阶段记录，但不得继续作为当前实现依据。
> - 当前有效执行基线请改看：
>   - [2026-06-23-cloud-cyber-range-saas-implementation-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-06-23-cloud-cyber-range-saas-implementation-plan.md)
>   - [2026-06-23-enterprise-range-bootstrap-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-06-23-enterprise-range-bootstrap-plan.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通第一版“创建实例 -> 生成任务 -> 应用内执行 -> 回写状态”的最小编排闭环，并保留后续切换真实 OpenTofu 执行器的接口。

**Architecture:** `apps/api` 新增一层轻量编排服务，负责写入 `RangeInstance` 与 `ProvisionJob`，并通过默认 `dry-run` provisioner 在应用内异步执行任务。数据持久化继续走 `AdminRepository`，因此内存仓储与 Prisma 仓储都要补齐最小读写能力；真实 OpenTofu 执行器后续只需替换 provisioner provider，不需要推翻 API 面。

**Tech Stack:** NestJS、TypeScript、Prisma、Jest E2E、Vitest、pnpm workspace、OpenTofu dry-run adapter

---

## 文件结构

### 现有文件修改

- 修改：`apps/api/src/admin/admin.repository.ts`
  职责：补齐 `RangeInstance / ProvisionJob / StepLog` 所需 record 与 repository 契约
- 修改：`apps/api/src/database/prisma-admin.repository.ts`
  职责：把新增 repository 契约落到 Prisma
- 修改：`apps/api/test/support/create-memory-admin-repository.ts`
  职责：给 E2E 提供可演练的内存编排仓储
- 修改：`apps/api/src/admin/range-instances.controller.ts`
  职责：补创建实例、触发创建、触发销毁接口
- 修改：`apps/api/src/admin/range-instances.service.ts`
  职责：补最小业务校验与任务触发
- 修改：`apps/api/src/app.module.ts`
  职责：注册编排服务与默认 dry-run provisioner
- 修改：`apps/api/test/admin-resources.e2e-spec.ts`
  职责：覆盖实例创建、任务生成、状态回写
- 修改：`infra/opentofu/modules/alicloud-vpc-single-ecs/main.tf`
  职责：收掉 `security_group.name` 的 deprecation warning

### 新增文件

- 新建：`apps/api/src/admin/dto/range-instance.dto.ts`
  职责：定义实例创建、创建任务触发、销毁任务触发 DTO
- 新建：`apps/api/src/admin/provision-jobs.controller.ts`
  职责：提供最小任务列表接口，便于观察任务状态
- 新建：`apps/api/src/admin/provision-jobs.service.ts`
  职责：读取任务列表
- 新建：`apps/api/src/provisioning/provisioning.types.ts`
  职责：定义 provisioner 输入输出与 token
- 新建：`apps/api/src/provisioning/dry-run-range-provisioner.ts`
  职责：提供本地可测的默认 provisioner
- 新建：`apps/api/src/provisioning/provisioning-worker.service.ts`
  职责：应用内拉起一次任务执行并回写状态

## 任务 1：收掉 OpenTofu 模块 warning

**Files:**
- Modify: `infra/opentofu/modules/alicloud-vpc-single-ecs/main.tf`
- Test: `pnpm iac:validate`

- [ ] **Step 1: 先写失败测试**

在 `test/opentofu-bootstrap.test.mjs` 增加断言，要求模块使用 `security_group_name` 而不是废弃的 `name`：

```js
assert.match(mainTf, /security_group_name/);
assert.doesNotMatch(mainTf, /resource "alicloud_security_group" "range"[\\s\\S]*\\n\\s+name\\s*=/);
```

- [ ] **Step 2: 运行失败测试**

Run: `node --test test/opentofu-bootstrap.test.mjs`
Expected: FAIL，因为模块仍然写着废弃字段 `name`

- [ ] **Step 3: 写最小实现**

把：

```tf
resource "alicloud_security_group" "range" {
  name = "${var.resource_name_prefix}-sg"
}
```

改成：

```tf
resource "alicloud_security_group" "range" {
  security_group_name = "${var.resource_name_prefix}-sg"
}
```

- [ ] **Step 4: 重新验证**

Run:

```bash
node --test test/opentofu-bootstrap.test.mjs
TOFU_IMAGE=vdagxumcha4qdz-ghcr.xuanyuan.run/opentofu/opentofu:1.12.3-minimal \
ALICLOUD_PROVIDER_ZIP_PATH=/Users/yym/Downloads/terraform-provider-alicloud_1.282.0_linux_amd64.zip \
HTTPS_PROXY=http://127.0.0.1:7897 \
HTTP_PROXY=http://127.0.0.1:7897 \
ALL_PROXY=socks5://127.0.0.1:7897 \
https_proxy=http://127.0.0.1:7897 \
http_proxy=http://127.0.0.1:7897 \
all_proxy=socks5://127.0.0.1:7897 \
pnpm iac:validate
```

Expected: PASS，且不再出现 `name` deprecation warning

- [ ] **Step 5: 提交 warning 修复**

```bash
git add infra/opentofu/modules/alicloud-vpc-single-ecs/main.tf test/opentofu-bootstrap.test.mjs scripts/dev/validate-opentofu-example.sh .env.example
git commit -m "fix: stabilize opentofu validation flow"
```

## 任务 2：补齐 RangeInstance 与 ProvisionJob repository 契约

**Files:**
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Test: `apps/api/test/admin-resources.e2e-spec.ts`

- [ ] **Step 1: 先写失败测试**

在 `apps/api/test/admin-resources.e2e-spec.ts` 增加最小实例创建断言：

```ts
it('creates a draft range instance for a team and template', async () => {
  const response = await request(app.getHttpServer())
    .post('/admin/range-instances')
    .set('authorization', 'Bearer dev-admin-token')
    .send({
      competitionId,
      teamId,
      templateId,
    })
    .expect(201);

  expect(response.body).toEqual(
    expect.objectContaining({
      id: expect.any(String),
      competitionId,
      teamId,
      templateId,
      status: 'draft',
    }),
  );
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`
Expected: FAIL，因为还没有 `POST /admin/range-instances` 和 repository 写能力

- [ ] **Step 3: 写最小 repository 契约**

在 `admin.repository.ts` 增加：

```ts
export type ProvisionJobRecord = {
  id: string;
  rangeInstanceId: string;
  jobType: 'create' | 'destroy' | 'retry' | 'refresh_status';
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  triggeredBy: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  retryCount: number;
  errorSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
};

createRangeInstance(input: { competitionId: string; teamId: string; templateId: string; expiresAt?: string }): Promise<RangeInstanceRecord>;
getRangeInstanceById(id: string): Promise<RangeInstanceRecord | null>;
updateRangeInstance(id: string, input: Partial<...>): Promise<RangeInstanceRecord>;
createProvisionJob(input: { rangeInstanceId: string; jobType: 'create' | 'destroy'; triggeredBy: string }): Promise<ProvisionJobRecord>;
listProvisionJobs(): Promise<ProvisionJobRecord[]>;
getProvisionJobById(id: string): Promise<ProvisionJobRecord | null>;
updateProvisionJob(id: string, input: Partial<...>): Promise<ProvisionJobRecord>;
```

- [ ] **Step 4: 落到 Prisma 与内存仓储**

Prisma 侧用 `prisma.rangeInstance.create/update/findUnique` 与 `prisma.provisionJob.create/update/findMany/findUnique`；内存仓储侧用数组实现同样行为，并在更新任务后同步 `RangeInstance.lastJobId`。

- [ ] **Step 5: 重新运行测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`
Expected: FAIL 点前移到 service/controller 缺失，而不是 repository 缺失

## 任务 3：打通最小实例创建与任务触发 API

**Files:**
- Create: `apps/api/src/admin/dto/range-instance.dto.ts`
- Modify: `apps/api/src/admin/range-instances.controller.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Create: `apps/api/src/admin/provision-jobs.controller.ts`
- Create: `apps/api/src/admin/provision-jobs.service.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: 先写失败测试**

在 `admin-resources.e2e-spec.ts` 增加：

```ts
it('creates a create job and moves instance into pending_create', async () => {
  const triggerResponse = await request(app.getHttpServer())
    .post(`/admin/range-instances/${rangeInstanceId}/create`)
    .set('authorization', 'Bearer dev-admin-token')
    .send({ triggeredBy: 'admin' })
    .expect(201);

  expect(triggerResponse.body).toEqual(
    expect.objectContaining({
      id: expect.any(String),
      rangeInstanceId,
      jobType: 'create',
      status: 'pending',
    }),
  );
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`
Expected: FAIL，因为没有触发接口和状态更新逻辑

- [ ] **Step 3: 写最小 DTO 和接口**

新增 DTO：

```ts
export class CreateRangeInstanceDto {
  @IsString() @IsNotEmpty() competitionId!: string;
  @IsString() @IsNotEmpty() teamId!: string;
  @IsString() @IsNotEmpty() templateId!: string;
  @IsOptional() @IsISO8601() expiresAt?: string;
}

export class TriggerProvisionJobDto {
  @IsString() @IsNotEmpty() triggeredBy!: string;
}
```

接口约定：

```ts
@Post() create(...)
@Post(':id/create') triggerCreate(...)
@Post(':id/destroy') triggerDestroy(...)
```

- [ ] **Step 4: 写最小 service 校验**

校验：
- competition、team、template、instance 必须存在
- create 只允许 `draft/create_failed/destroyed`
- destroy 只允许 `running/destroy_failed`

状态变更：
- 触发 create 时，实例置为 `pending_create`
- 触发 destroy 时，实例置为 `pending_destroy`

- [ ] **Step 5: 重新运行测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`
Expected: FAIL 点前移到 worker 未执行或状态未回写

## 任务 4：补应用内 dry-run provisioner 与状态回写

**Files:**
- Create: `apps/api/src/provisioning/provisioning.types.ts`
- Create: `apps/api/src/provisioning/dry-run-range-provisioner.ts`
- Create: `apps/api/src/provisioning/provisioning-worker.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/test/admin-resources.e2e-spec.ts`

- [ ] **Step 1: 先写失败测试**

在 `admin-resources.e2e-spec.ts` 增加最终状态轮询断言：

```ts
await waitForRangeInstanceStatus(app, rangeInstanceId, 'running');

const jobs = await request(app.getHttpServer())
  .get('/admin/provision-jobs')
  .set('authorization', 'Bearer dev-admin-token')
  .expect(200);

expect(jobs.body).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      rangeInstanceId,
      jobType: 'create',
      status: 'succeeded',
    }),
  ]),
);
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`
Expected: FAIL，因为还没有 worker、jobs 列表、状态回写

- [ ] **Step 3: 写最小 provisioner 抽象**

`provisioning.types.ts`：

```ts
export const RANGE_PROVISIONER = Symbol('RANGE_PROVISIONER');

export interface RangeProvisioner {
  create(input: { rangeInstanceId: string; templateModulePath: string }): Promise<{
    accessEntry: Record<string, unknown>;
    resourceSummary: Record<string, unknown>;
  }>;
  destroy(input: { rangeInstanceId: string; templateModulePath: string }): Promise<void>;
}
```

`dry-run-range-provisioner.ts`：

```ts
create(...) {
  return {
    accessEntry: {
      url: `https://range.local/${input.rangeInstanceId}`,
      ssh: `ssh root@${input.rangeInstanceId}.range.local`,
    },
    resourceSummary: {
      mode: 'dry-run',
      modulePath: input.templateModulePath,
    },
  };
}
```

- [ ] **Step 4: 写最小 worker**

worker 行为：
- `dispatch(jobId)` 用 `queueMicrotask` 启动
- create：job `running` -> instance `creating` -> provisioner.create -> job `succeeded` -> instance `running`
- destroy：job `running` -> instance `destroying` -> provisioner.destroy -> job `succeeded` -> instance `destroyed`
- 异常时：job `failed` + `errorSummary`，instance 改 `create_failed/destroy_failed`

- [ ] **Step 5: 重新运行测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`
Expected: PASS

## 任务 5：整体验证与收口

**Files:**
- Modify: `apps/api/test/admin-resource-validation.e2e-spec.ts`
- Modify: `test/opentofu-bootstrap.test.mjs`

- [ ] **Step 1: 补充边界验证**

增加至少两个边界：
- 不允许对 `draft` 实例直接 destroy
- 不允许对 `running` 实例重复 create

- [ ] **Step 2: 运行 API 全量测试**

Run: `pnpm --filter @aliyun-cyber-range/api test`
Expected: PASS

- [ ] **Step 3: 运行整仓测试**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 4: 运行整仓构建**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 5: 再跑 OpenTofu 校验**

Run:

```bash
TOFU_IMAGE=vdagxumcha4qdz-ghcr.xuanyuan.run/opentofu/opentofu:1.12.3-minimal \
ALICLOUD_PROVIDER_ZIP_PATH=/Users/yym/Downloads/terraform-provider-alicloud_1.282.0_linux_amd64.zip \
HTTPS_PROXY=http://127.0.0.1:7897 \
HTTP_PROXY=http://127.0.0.1:7897 \
ALL_PROXY=socks5://127.0.0.1:7897 \
https_proxy=http://127.0.0.1:7897 \
http_proxy=http://127.0.0.1:7897 \
all_proxy=socks5://127.0.0.1:7897 \
pnpm iac:validate
```

Expected: PASS
