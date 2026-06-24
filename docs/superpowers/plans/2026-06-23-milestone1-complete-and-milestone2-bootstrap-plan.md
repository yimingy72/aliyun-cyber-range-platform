# Milestone 1 收尾与 Milestone 2 Bootstrap Implementation Plan

> **历史计划说明**
>
> - 本文件基于早期“单机 bootstrap + single-ecs 模块”假设编写。
> - 2026-06-23 的最终需求说明已经把当前主线调整为“企业网络型综合靶场优先”，因此本文件不再作为当前执行基线。
> - 当前应改为优先执行：
>   - [2026-06-23-cloud-cyber-range-saas-implementation-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-06-23-cloud-cyber-range-saas-implementation-plan.md)
>   - [2026-06-23-enterprise-range-bootstrap-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-06-23-enterprise-range-bootstrap-plan.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成第一阶段后台数据与管理骨架的可改可删、基础校验与真实 PostgreSQL 联调，并启动最小 OpenTofu Runner 与阿里云单 VPC 单 ECS 模块。

**Architecture:** 继续保持模块化单体结构：`apps/api` 承载后台 API 与编排入口，`apps/web` 承载管理员控制台，`packages/database` 承载 Prisma 数据模型与迁移，新增 `packages/iac-runner` 负责 OpenTofu CLI 封装，新增 `infra/opentofu/modules/alicloud-vpc-single-ecs` 承载第一份真实靶场模块。Milestone 1 先确保管理对象在真实库中可稳定读写，Milestone 2 再把业务层与 IaC 执行抽象接起来。

**Tech Stack:** pnpm workspace、TypeScript、NestJS、Next.js App Router、Prisma、PostgreSQL、OpenTofu、Vitest、Jest、Node child_process

---

## 范围检查

本计划覆盖两个紧密相连的子范围：

- `Milestone 1` 收尾：编辑/删除、基础校验、真实 PostgreSQL 联调
- `Milestone 2` bootstrap：最小 OpenTofu Runner、阿里云 VPC/ECS 模块、变量与 outputs 约定

本计划不包含：

- `ProvisionJob` 状态机落库与后台触发
- 真实阿里云 `apply/destroy` 上云验证
- 多机综合靶场模板
- 任务中心、步骤日志页面

## 文件结构

### 现有文件修改

- 修改：`apps/api/src/admin/*`
  职责：补齐比赛、队伍、模板的更新/删除、输入校验与错误处理
- 修改：`apps/api/test/*.e2e-spec.ts`
  职责：补齐 Milestone 1 红绿测试
- 修改：`apps/web/app/admin/*`
  职责：补齐前端编辑/删除与错误态展示
- 修改：`packages/database/prisma/schema.prisma`
  职责：按 Milestone 1 真实联调需要补唯一约束、关系与字段细化
- 修改：`packages/database/package.json`
  职责：补迁移、生成、联调脚本
- 修改：`.env.example`
  职责：补 OpenTofu 与阿里云运行所需环境变量说明

### 新增文件

- 新建：`packages/iac-runner/package.json`
  职责：定义 Runner 包依赖与脚本
- 新建：`packages/iac-runner/src/open-tofu-runner.ts`
  职责：封装 `init/plan/apply/output/destroy`
- 新建：`packages/iac-runner/src/workspace-layout.ts`
  职责：约定工作目录、plan 文件、变量文件与输出文件路径
- 新建：`packages/iac-runner/test/*.test.ts`
  职责：Runner 红绿测试
- 新建：`infra/opentofu/modules/alicloud-vpc-single-ecs/*.tf`
  职责：第一份最小阿里云 VPC + VSwitch + 安全组 + ECS 模块
- 新建：`infra/opentofu/examples/alicloud-vpc-single-ecs/*.tfvars.example`
  职责：提供变量示例与本地验证入口
- 新建：`scripts/dev/start-postgres.sh`
  职责：在无 Docker daemon 时启动本地 Homebrew PostgreSQL

## 任务 1：补齐 Milestone 1 API 编辑/删除与校验

**Files:**
- Modify: `apps/api/test/admin-resources.e2e-spec.ts`
- Create: `apps/api/test/admin-resource-validation.e2e-spec.ts`
- Modify: `apps/api/src/admin/*.controller.ts`
- Modify: `apps/api/src/admin/*.service.ts`
- Create: `apps/api/src/admin/dto/*.ts`

- [ ] **Step 1: 先写失败测试，覆盖 update/delete/validation**
- [ ] **Step 2: 运行 API 定向测试，确认因接口缺失或校验缺失而失败**
- [ ] **Step 3: 用最小 DTO、ValidationPipe 和 service 逻辑实现通过**
- [ ] **Step 4: 重新运行 API 定向测试，确认转绿**
- [ ] **Step 5: 提交 API 管理骨架收尾**

## 任务 2：接通真实 PostgreSQL 联调

**Files:**
- Modify: `packages/database/package.json`
- Modify: `.env.example`
- Create: `scripts/dev/start-postgres.sh`
- Create: `scripts/dev/stop-postgres.sh`
- Create: `packages/database/prisma/migrations/*`

- [ ] **Step 1: 先写失败测试，覆盖真实库脚本、迁移脚本与连接约定**
- [ ] **Step 2: 在本机确认 `postgresql@16` 可启动并建立本地数据目录**
- [ ] **Step 3: 增加 `db:local:start / db:local:stop / prisma:migrate:deploy` 等脚本**
- [ ] **Step 4: 对真实 PostgreSQL 执行迁移并验证 Prisma 读写**
- [ ] **Step 5: 提交真实数据库联调基线**

## 任务 3：补齐管理员控制台的编辑/删除与错误态

**Files:**
- Modify: `apps/web/app/admin/admin-console.test.tsx`
- Modify: `apps/web/app/admin/admin-console.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: 先写失败测试，覆盖编辑、删除和 API 错误展示**
- [ ] **Step 2: 运行 Web 定向测试并确认失败**
- [ ] **Step 3: 用最小交互补齐控制台行为**
- [ ] **Step 4: 重新运行 Web 定向测试并确认转绿**
- [ ] **Step 5: 提交后台 UI 收尾**

## 任务 4：实现最小 OpenTofu Runner

**Files:**
- Create: `packages/iac-runner/package.json`
- Create: `packages/iac-runner/tsconfig.json`
- Create: `packages/iac-runner/src/open-tofu-runner.ts`
- Create: `packages/iac-runner/src/workspace-layout.ts`
- Create: `packages/iac-runner/test/open-tofu-runner.test.ts`

- [ ] **Step 1: 先写失败测试，覆盖 `init/plan/apply/output/destroy` 命令拼装**
- [ ] **Step 2: 运行 Runner 测试并确认失败**
- [ ] **Step 3: 实现最小 CLI 封装、工作目录布局与输出采集**
- [ ] **Step 4: 重新运行 Runner 测试并确认转绿**
- [ ] **Step 5: 提交 Runner bootstrap**

## 任务 5：建立阿里云单 VPC 单 ECS 模块

**Files:**
- Create: `infra/opentofu/modules/alicloud-vpc-single-ecs/providers.tf`
- Create: `infra/opentofu/modules/alicloud-vpc-single-ecs/variables.tf`
- Create: `infra/opentofu/modules/alicloud-vpc-single-ecs/main.tf`
- Create: `infra/opentofu/modules/alicloud-vpc-single-ecs/outputs.tf`
- Create: `infra/opentofu/modules/alicloud-vpc-single-ecs/README.md`
- Create: `infra/opentofu/examples/alicloud-vpc-single-ecs/range.auto.tfvars.example`

- [ ] **Step 1: 先写失败测试，覆盖模块关键变量、输出和文件结构**
- [ ] **Step 2: 运行模块定向测试并确认失败**
- [ ] **Step 3: 基于官方 provider 文档写入最小可用模块**
- [ ] **Step 4: 在本机用 `tofu fmt -check -recursive` 与 `tofu validate` 做静态验证**
- [ ] **Step 5: 提交 IaC 模块 bootstrap**

## 任务 6：整体验证 Milestone 1 收尾与 Milestone 2 起步

**Files:**
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`

- [ ] **Step 1: 整理最终验证清单**

```text
1. pnpm --filter @aliyun-cyber-range/api test
2. pnpm --filter @aliyun-cyber-range/web test
3. pnpm --filter @aliyun-cyber-range/database test
4. pnpm --filter @aliyun-cyber-range/iac-runner test
5. pnpm test
6. pnpm build
7. pnpm verify:bootstrap
8. tofu fmt -check -recursive infra/opentofu
9. tofu validate infra/opentofu/examples/alicloud-vpc-single-ecs
```

- [ ] **Step 2: 运行验证并记录失败点**
- [ ] **Step 3: 做最小修复**
- [ ] **Step 4: 重新运行整体验证并确认通过**
- [ ] **Step 5: 提交本轮里程碑基线**
