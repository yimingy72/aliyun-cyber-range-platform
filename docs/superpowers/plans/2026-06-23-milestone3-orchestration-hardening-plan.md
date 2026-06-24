# Milestone 3 编排收口 Implementation Plan

> **历史计划说明**
>
> - 本文件建立在“single-ecs 主线继续收口 + CIDR 池优先”的前提上。
> - 该前提已被 2026-06-23 最终需求说明取代：当前第一优先级应是企业网络型靶场骨架、固定拓扑模板和 DMZ EIP 入口。
> - 其中关于步骤日志、job claim、重试等内容仍有参考价值，但执行顺序必须后移到企业网络型 IaC 与模板模型对齐之后。
> - 当前有效文档请优先阅读：
>   - [2026-06-23-cloud-cyber-range-saas-design.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/specs/2026-06-23-cloud-cyber-range-saas-design.md)
>   - [2026-06-23-cloud-cyber-range-saas-implementation-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-06-23-cloud-cyber-range-saas-implementation-plan.md)
>   - [2026-06-23-enterprise-range-bootstrap-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-06-23-enterprise-range-bootstrap-plan.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前“最小可跑”的编排链路收口成“可真实演练、可排错、可重试”的 Milestone 3 完整后端闭环，为后续 Milestone 4 管理台可视化提供稳定 API 面。

**Architecture:** 保持 `apps/api` 模块化单体结构不变，在现有 `RangeInstance + ProvisionJob + worker + provisioner` 基础上，补上四个当前缺口：自动分配 CIDR、任务步骤日志、原子化 job claim/重试、任务详情接口。`dry-run` 继续保留为默认执行模式，`opentofu` 作为真实执行模式共用同一套编排接口和状态机。

**Tech Stack:** NestJS、TypeScript、Prisma、Jest E2E、OpenTofu Runner、PostgreSQL、pnpm workspace

---

## 为什么下一步是这个，而不是别的

根据总计划 `docs/superpowers/plans/2026-06-23-cloud-cyber-range-saas-implementation-plan.md`，当前项目状态是：

- `Milestone 1` 已完成
- `Milestone 2` 已完成
- `Milestone 3` 已完成“最小闭环”部分
- 但 `Milestone 3` 计划里明确列出的这些点还没真正落地：
  - 任务加锁与并发保护
  - 操作与执行过程可观测
  - 失败后可重试
  - 真实执行前预校验
  - 自动分配 `allocatedCidr`

所以**下一步不应该直接开始 Milestone 4 页面开发**，因为任务中心、步骤日志页、异常实例页现在还缺后端支撑；也**不应该直接跳到 Milestone 5 多机模板**，因为单机真实编排链路还没有达到“可稳定排错”的标准。

## 范围检查

本计划只覆盖 Milestone 3 剩余的后端收口内容：

- 自动分配 `allocatedCidr`
- `ProvisionJobStepLog` 真正落库并可查询
- worker 原子 claim job，避免同一 job 被重复执行
- 真实 OpenTofu 执行过程写入步骤日志
- 增加 job 详情、步骤日志、重试接口

本计划明确不包含：

- Milestone 4 的前端页面重构
- 多机综合靶场模板
- 完整 CIDR 池后台管理界面
- 审计日志独立模型与审计页
- 定时过期回收 worker

## 文件结构

### 现有文件修改

- 修改：`apps/api/src/admin/admin.repository.ts`
  职责：补齐 `ProvisionJobStepLog` record、job claim、retry 所需 repository 契约
- 修改：`apps/api/src/database/prisma-admin.repository.ts`
  职责：把新增 repository 契约落到 Prisma，并实现原子 claim
- 修改：`apps/api/test/support/create-memory-admin-repository.ts`
  职责：让内存仓储支持步骤日志、claim、retry
- 修改：`apps/api/src/admin/range-instances.service.ts`
  职责：在触发 create 前自动分配 CIDR，并加最小预校验
- 修改：`apps/api/src/admin/provision-jobs.controller.ts`
  职责：增加 job 详情、步骤日志、重试接口
- 修改：`apps/api/src/admin/provision-jobs.service.ts`
  职责：封装 job 查询与 retry 逻辑
- 修改：`apps/api/src/provisioning/provisioning.types.ts`
  职责：让 provisioner 支持步骤事件回调
- 修改：`apps/api/src/provisioning/dry-run-range-provisioner.ts`
  职责：补充 dry-run 下的步骤日志事件
- 修改：`apps/api/src/provisioning/open-tofu-range-provisioner.ts`
  职责：把 `init/plan/apply/output/destroy` 拆成可记录的步骤
- 修改：`apps/api/src/provisioning/provisioning-worker.service.ts`
  职责：先 claim job，再写步骤日志，再回写状态
- 修改：`apps/api/src/app.module.ts`
  职责：注册新增服务
- 修改：`.env.example`
  职责：补充 CIDR 池配置

### 新增文件

- 新建：`apps/api/src/admin/dto/provision-job.dto.ts`
  职责：定义 retry DTO
- 新建：`apps/api/src/provisioning/cidr-pool.service.ts`
  职责：从固定 CIDR 池中挑选可用网段
- 新建：`apps/api/test/provision-job-observability.e2e-spec.ts`
  职责：覆盖步骤日志、job 详情和 retry 行为
- 新建：`apps/api/test/cidr-allocation.e2e-spec.ts`
  职责：覆盖自动分配 CIDR 与冲突场景

## 任务 1：补齐 repository 契约，支撑步骤日志和 job claim

**Files:**
- Modify: `apps/api/test/admin-resources.e2e-spec.ts`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`

- [ ] **Step 1: 先写失败测试，要求 job 详情和步骤日志可查询**

在 `apps/api/test/admin-resources.e2e-spec.ts` 末尾增加最小断言：

```ts
const jobsResponse = await request(app.getHttpServer())
  .get('/admin/provision-jobs')
  .set('authorization', 'Bearer dev-admin-token')
  .expect(200);

const latestJobId = jobsResponse.body[0].id;

await request(app.getHttpServer())
  .get(`/admin/provision-jobs/${latestJobId}`)
  .set('authorization', 'Bearer dev-admin-token')
  .expect(200);

await request(app.getHttpServer())
  .get(`/admin/provision-jobs/${latestJobId}/steps`)
  .set('authorization', 'Bearer dev-admin-token')
  .expect(200);
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`

Expected: FAIL，因为还没有 job 详情接口、步骤日志 repository 契约和步骤日志数据。

- [ ] **Step 3: 在 repository 契约里补齐步骤日志与 claim 能力**

在 `apps/api/src/admin/admin.repository.ts` 增加：

```ts
export type ProvisionJobStepStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type ProvisionJobStepLogRecord = {
  id: string;
  jobId: string;
  stepName: string;
  status: ProvisionJobStepStatus;
  message: string | null;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

claimProvisionJob(id: string, startedAt: Date): Promise<ProvisionJobRecord | null>;
listProvisionJobStepLogs(jobId: string): Promise<ProvisionJobStepLogRecord[]>;
createProvisionJobStepLog(input: {
  jobId: string;
  stepName: string;
  status?: ProvisionJobStepStatus;
  message?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}): Promise<ProvisionJobStepLogRecord>;
updateProvisionJobStepLog(
  id: string,
  input: Partial<{
    status: ProvisionJobStepStatus;
    message: string | null;
    stdoutExcerpt: string | null;
    stderrExcerpt: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
  }>,
): Promise<ProvisionJobStepLogRecord>;
```

- [ ] **Step 4: 在 Prisma 和内存仓储中补实现**

Prisma 侧：

```ts
async claimProvisionJob(id: string, startedAt: Date) {
  const result = await this.prisma.provisionJob.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'running', startedAt, finishedAt: null, errorSummary: null },
  });

  if (result.count === 0) {
    return null;
  }

  return this.getProvisionJobById(id);
}
```

内存仓储侧：

```ts
async claimProvisionJob(id: string, startedAt: Date) {
  const record = provisionJobs.find((job) => job.id === id && job.status === 'pending');

  if (!record) {
    return null;
  }

  Object.assign(record, {
    status: 'running',
    startedAt,
    finishedAt: null,
    errorSummary: null,
    updatedAt: now(),
  });

  return clone(record);
}
```

- [ ] **Step 5: 重新运行测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`

Expected: FAIL 点前移到 controller/service 和 worker 还没有真正写出步骤日志。

## 任务 2：补最小 CIDR 池分配，让真实 OpenTofu create 可直接跑

**Files:**
- Create: `apps/api/test/cidr-allocation.e2e-spec.ts`
- Create: `apps/api/src/provisioning/cidr-pool.service.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `.env.example`

- [ ] **Step 1: 先写失败测试，要求触发 create 时自动写入 allocatedCidr**

新建 `apps/api/test/cidr-allocation.e2e-spec.ts`：

```ts
it('allocates a cidr when a draft instance starts creation', async () => {
  process.env.RANGE_CIDR_POOL = '10.80.0.0/16,10.81.0.0/16';

  const triggerResponse = await request(app.getHttpServer())
    .post(`/admin/range-instances/${rangeInstanceId}/create`)
    .set('authorization', 'Bearer dev-admin-token')
    .send({ triggeredBy: 'admin' })
    .expect(201);

  expect(triggerResponse.body).toEqual(
    expect.objectContaining({
      jobType: 'create',
    }),
  );

  const instancesResponse = await request(app.getHttpServer())
    .get('/admin/range-instances')
    .set('authorization', 'Bearer dev-admin-token')
    .expect(200);

  expect(instancesResponse.body[0]).toEqual(
    expect.objectContaining({
      allocatedCidr: '10.80.0.0/16',
    }),
  );
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- cidr-allocation.e2e-spec.ts`

Expected: FAIL，因为当前 `allocatedCidr` 仍然需要手工提供。

- [ ] **Step 3: 写最小 CIDR 池服务**

新建 `apps/api/src/provisioning/cidr-pool.service.ts`：

```ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class CidrPoolService {
  getPool(envValue = process.env.RANGE_CIDR_POOL ?? '') {
    return envValue
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  allocate(pool: string[], occupied: string[]) {
    const match = pool.find((cidr) => !occupied.includes(cidr));

    if (!match) {
      throw new Error('No CIDR available in RANGE_CIDR_POOL');
    }

    return match;
  }
}
```

- [ ] **Step 4: 在 triggerCreate 前补自动分配**

在 `apps/api/src/admin/range-instances.service.ts` 增加：

```ts
const occupiedCidrs = (await this.adminRepository.listRangeInstances())
  .filter((item) => item.id !== instance.id)
  .filter((item) => item.status !== 'destroyed')
  .map((item) => item.allocatedCidr)
  .filter((value): value is string => Boolean(value));

const allocatedCidr =
  instance.allocatedCidr ??
  this.cidrPoolService.allocate(this.cidrPoolService.getPool(), occupiedCidrs);

await this.adminRepository.updateRangeInstance(instance.id, {
  allocatedCidr,
  status: 'pending_create',
  lastJobId: job.id,
});
```

- [ ] **Step 5: 重新运行测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- cidr-allocation.e2e-spec.ts`

Expected: PASS

## 任务 3：让 provisioner 发出步骤事件，worker 把步骤日志真正写出来

**Files:**
- Create: `apps/api/test/provision-job-observability.e2e-spec.ts`
- Modify: `apps/api/src/provisioning/provisioning.types.ts`
- Modify: `apps/api/src/provisioning/dry-run-range-provisioner.ts`
- Modify: `apps/api/src/provisioning/open-tofu-range-provisioner.ts`
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`

- [ ] **Step 1: 先写失败测试，要求 create job 产出步骤日志**

新建 `apps/api/test/provision-job-observability.e2e-spec.ts`：

```ts
it('writes step logs for a create job', async () => {
  const createJobResponse = await request(app.getHttpServer())
    .post(`/admin/range-instances/${rangeInstanceId}/create`)
    .set('authorization', 'Bearer dev-admin-token')
    .send({ triggeredBy: 'admin' })
    .expect(201);

  const jobId = createJobResponse.body.id;

  await waitForRangeInstanceStatus(rangeInstanceId, 'running');

  const stepsResponse = await request(app.getHttpServer())
    .get(`/admin/provision-jobs/${jobId}/steps`)
    .set('authorization', 'Bearer dev-admin-token')
    .expect(200);

  expect(stepsResponse.body).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        jobId,
        stepName: expect.any(String),
        status: 'succeeded',
      }),
    ]),
  );
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- provision-job-observability.e2e-spec.ts`

Expected: FAIL，因为 worker 还没有写步骤日志。

- [ ] **Step 3: 扩展 provisioner 类型，支持步骤事件回调**

在 `apps/api/src/provisioning/provisioning.types.ts` 改成：

```ts
export type RangeProvisionStepEvent = {
  stepName: string;
  status: 'running' | 'succeeded' | 'failed';
  message?: string;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
};

export type RangeProvisionStepEmitter = (event: RangeProvisionStepEvent) => Promise<void>;

export type RangeProvisionCreateInput = {
  rangeInstanceId: string;
  templateModulePath: string;
  allocatedCidr: string | null;
  onStep?: RangeProvisionStepEmitter;
};
```

- [ ] **Step 4: 在 OpenTofu provisioner 中拆步骤**

在 `apps/api/src/provisioning/open-tofu-range-provisioner.ts` 增加一个最小 helper：

```ts
private async runStep<T>(
  stepName: string,
  execute: () => Promise<T>,
  onStep?: RangeProvisionStepEmitter,
) {
  await onStep?.({ stepName, status: 'running' });

  try {
    const result = await execute();
    await onStep?.({ stepName, status: 'succeeded' });
    return result;
  } catch (error) {
    await onStep?.({
      stepName,
      status: 'failed',
      message: error instanceof Error ? error.message : 'Unknown step error',
    });
    throw error;
  }
}
```

然后在 `create` 里按顺序包起来：

```ts
await this.runStep('init', () => this.runner.init(...), input.onStep);
await this.runStep('plan', () => this.runner.plan(...), input.onStep);
await this.runStep('apply', () => this.runner.apply(...), input.onStep);
const outputs = await this.runStep('output', () => this.runner.output(...), input.onStep);
```

- [ ] **Step 5: 在 worker 中消费步骤事件并写日志**

在 `apps/api/src/provisioning/provisioning-worker.service.ts` 增加：

```ts
const stepLogMap = new Map<string, string>();

const onStep: RangeProvisionStepEmitter = async (event) => {
  const existingStepLogId = stepLogMap.get(event.stepName);

  if (!existingStepLogId) {
    const created = await this.adminRepository.createProvisionJobStepLog({
      jobId: job.id,
      stepName: event.stepName,
      status: event.status,
      message: event.message ?? null,
      stdoutExcerpt: event.stdoutExcerpt ?? null,
      stderrExcerpt: event.stderrExcerpt ?? null,
      startedAt: event.status === 'running' ? new Date() : null,
      finishedAt: event.status === 'running' ? null : new Date(),
    });

    stepLogMap.set(event.stepName, created.id);
    return;
  }

  await this.adminRepository.updateProvisionJobStepLog(existingStepLogId, {
    status: event.status,
    message: event.message ?? null,
    stdoutExcerpt: event.stdoutExcerpt ?? null,
    stderrExcerpt: event.stderrExcerpt ?? null,
    finishedAt: event.status === 'running' ? null : new Date(),
  });
};
```

并把 `create/destroy` 调用改成：

```ts
await this.rangeProvisioner.create({
  rangeInstanceId: instance.id,
  templateModulePath: template.modulePathOrRef,
  allocatedCidr: instance.allocatedCidr,
  onStep,
});
```

- [ ] **Step 6: 重新运行测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- provision-job-observability.e2e-spec.ts`

Expected: PASS

## 任务 4：补 job 详情、步骤日志查询与 retry 接口

**Files:**
- Modify: `apps/api/test/provision-job-observability.e2e-spec.ts`
- Create: `apps/api/src/admin/dto/provision-job.dto.ts`
- Modify: `apps/api/src/admin/provision-jobs.controller.ts`
- Modify: `apps/api/src/admin/provision-jobs.service.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts`

- [ ] **Step 1: 先写失败测试，要求 failed job 可以 retry**

在 `apps/api/test/provision-job-observability.e2e-spec.ts` 增加：

```ts
it('retries a failed create job by creating a new create job', async () => {
  const retryResponse = await request(app.getHttpServer())
    .post(`/admin/provision-jobs/${failedJobId}/retry`)
    .set('authorization', 'Bearer dev-admin-token')
    .send({ triggeredBy: 'admin-retry' })
    .expect(201);

  expect(retryResponse.body).toEqual(
    expect.objectContaining({
      id: expect.any(String),
      jobType: 'create',
      triggeredBy: 'admin-retry',
      status: 'pending',
    }),
  );
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- provision-job-observability.e2e-spec.ts`

Expected: FAIL，因为 retry 接口和 job 详情接口还不存在。

- [ ] **Step 3: 补 controller 与 DTO**

新建 `apps/api/src/admin/dto/provision-job.dto.ts`：

```ts
import { IsNotEmpty, IsString } from 'class-validator';

export class RetryProvisionJobDto {
  @IsString()
  @IsNotEmpty()
  triggeredBy!: string;
}
```

`apps/api/src/admin/provision-jobs.controller.ts` 增加：

```ts
@Get(':id')
getById(@Param('id') id: string) {
  return this.provisionJobsService.getById(id);
}

@Get(':id/steps')
listSteps(@Param('id') id: string) {
  return this.provisionJobsService.listSteps(id);
}

@Post(':id/retry')
retry(@Param('id') id: string, @Body() body: RetryProvisionJobDto) {
  return this.provisionJobsService.retry(id, body.triggeredBy);
}
```

- [ ] **Step 4: 在 service 中实现 retry 语义**

在 `apps/api/src/admin/provision-jobs.service.ts` 中实现：

```ts
async retry(id: string, triggeredBy: string) {
  const job = await this.adminRepository.getProvisionJobById(id);

  if (!job) {
    throw new NotFoundException('Provision job not found');
  }

  if (job.status !== 'failed') {
    throw new ConflictException('Only failed jobs can be retried');
  }

  const retried = await this.adminRepository.createProvisionJob({
    rangeInstanceId: job.rangeInstanceId,
    jobType: job.jobType,
    triggeredBy,
    status: 'pending',
  });

  await this.adminRepository.updateProvisionJob(retried.id, {
    retryCount: job.retryCount + 1,
  });

  this.provisioningWorkerService.dispatch(retried.id);

  return retried;
}
```

- [ ] **Step 5: 重新运行测试**

Run: `pnpm --filter @aliyun-cyber-range/api test -- provision-job-observability.e2e-spec.ts`

Expected: PASS

## 任务 5：整体验证，确认 Milestone 3 已经可以正式封口

**Files:**
- Modify: `apps/api/test/admin-resource-validation.e2e-spec.ts`
- Modify: `apps/api/test/open-tofu-range-provisioner.e2e-spec.ts`
- Modify: `test/opentofu-bootstrap.test.mjs`

- [ ] **Step 1: 补边界验证**

至少新增这些边界：

```text
1. RANGE_CIDR_POOL 用尽时 create 返回 409
2. 同一 job 被重复 dispatch 只会真正执行一次
3. failed job 才允许 retry
4. retry 后会生成新 job，而不是覆盖旧 job
5. OpenTofu 缺少关键环境变量时 instance 进入 create_failed
```

- [ ] **Step 2: 运行 API 全量测试**

Run: `pnpm --filter @aliyun-cyber-range/api test`

Expected: PASS

- [ ] **Step 3: 运行整仓测试**

Run: `pnpm test`

Expected: PASS

- [ ] **Step 4: 运行整仓构建**

Run: `pnpm build`

Expected: PASS

- [ ] **Step 5: 再跑 OpenTofu 静态校验**

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

## 完成本计划后的状态

当这份计划完成后，我们就可以明确宣布：

- `Milestone 3` 后端编排链路完成
- `dry-run` 和 `opentofu` 共用同一套状态机
- 管理台已经有足够 API 做 `任务中心`、`任务详情`、`失败重试`
- 下一个新计划应该进入 `Milestone 4：管理台可视化与异常处理`
