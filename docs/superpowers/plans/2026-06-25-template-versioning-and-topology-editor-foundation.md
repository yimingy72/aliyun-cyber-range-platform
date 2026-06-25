# 模板版本化与拓扑编辑器底座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把综合靶场模板中心升级为“模板身份 + 模板版本 + 发布编译产物”的可扩展底座，并落下第一版可视化拓扑编辑器后端/前端骨架。

**Architecture:** 保持现有模块化单体架构，在 API 层引入 `RangeTemplateVersion`、草稿/已发布指针和发布流程，在 Web 层引入独立的模板编辑工作区。模板编辑器只操作草稿版本，实例创建和编排执行只引用已发布版本。拓扑编辑状态使用平台内部 `TopologyGraph JSON`，编排执行继续兼容当前 `topologySpec`，后续再逐步切到统一编译器。

**Tech Stack:** NestJS 11、Next.js 15 App Router、React 19、Prisma/PostgreSQL、Vitest/Jest、OpenTofu Runner、现有 Admin REST API

## 当前进度快照（2026-06-25）

- 已完成 Task 1：模板版本化后端模型、内存仓储、数据库仓储、实例/worker 读取已发布版本的主链路已落地。
- 已完成 Task 2：模板发布流程与“实例只能引用已发布模板”的约束已落地。
- 已完成 Task 3：`topologyGraph` / `compiledSpec` 通用 JSON 边界、草稿/顶层字段一致性、负例测试、Prisma migration 与存量模板回填已落地。
- 已完成 Task 4：模板中心已显示草稿/已发布状态，并可进入编辑器、发布模板。
- 已完成 Task 5 且已超过原骨架目标：模板编辑器不仅已可渲染，还支持节点新增、按节点类型编辑属性、保存草稿、发布模板。
- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`
  - `pnpm --filter web test -- --runInBand apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- 已完成的关键提交：
  - `91f9ed4 feat: add extensible topology graph fields`
  - `a1043fe fix: finalize template versioning migration and guardrails`

## 下一步执行起点

- 当前计划文档中的 Task 1 到 Task 5 已不再是待做项，而是历史完成记录。
- 下一步应新开“Task 6：`TopologyGraph -> compiledSpec` 编译层最小闭环”，把当前编辑器草稿图稳定编译为后端可消费的模板发布产物。
- 紧随其后应做“Task 7：企业靶场默认骨架生成器”，让模板编辑器可一键生成 `DMZ + Server + DB + Router` 的标准综合靶场初始拓扑。

### Task 6: 打通 `TopologyGraph -> compiledSpec` 的最小编译闭环

**Status:** 已完成

- 已完成内容：
  - 新增前端最小编译器 `apps/web/lib/template-compiler.ts`
  - 保存草稿时同时提交 `compiledSpec`
  - `compiledSpec` 收敛为最小载荷：`schemaVersion + resources[]`
  - `resources[].config` 已按 `host/switch/router` 白名单字段稳定编译
  - 编译器已补穷尽保护，未知节点类型会显式抛错
  - 已新增 `apps/web/lib/template-compiler.test.ts`，锁定三类节点的稳定 shape

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx lib/template-compiler.test.ts`

- 已完成提交：
  - `66f4c17 feat: compile topology graph into template spec`
  - `776938a`（Task 6 规格收窄修正）

**Files:**
- Create: `apps/web/lib/template-compiler.ts`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- Modify: `apps/web/lib/admin-types.ts`

- [x] **Step 1: 先写失败测试，定义保存草稿时会同时提交 `compiledSpec`**

```tsx
it('compiles topology graph into compiledSpec when saving draft', async () => {
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

  await waitFor(() => {
    expect(updateRangeTemplateMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      'template-1',
      expect.objectContaining({
        compiledSpec: expect.objectContaining({
          schemaVersion: '1.0.0',
          resources: expect.arrayContaining([
            expect.objectContaining({ id: 'host-1', type: 'host' }),
          ]),
        }),
      }),
    );
  });
});
```

- [x] **Step 2: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`

Expected: FAIL，当前保存草稿还没有稳定生成 `compiledSpec`。

- [x] **Step 3: 新建最小编译器，把节点列表编译为通用资源数组**

```ts
export function compileTopologyGraph(input: { nodes: TemplateNode[]; topologySpec?: RangeTemplateTopologySpec | null }) {
  return {
    schemaVersion: '1.0.0',
    resources: input.nodes.map((node) => ({
      id: node.id,
      type: node.kind,
      provider: 'alibaba_cloud',
      config: node,
    })),
    topologySpec: input.topologySpec ?? null,
  };
}
```

- [x] **Step 4: 编辑器保存草稿时同时提交 `topologyGraph + compiledSpec`**

```tsx
const compiledSpec = compileTopologyGraph({
  nodes,
  topologySpec,
});

await updateRangeTemplate(apiBaseUrl, session.token, template.id, {
  topologyGraph,
  compiledSpec,
  topologySpec,
});
```

- [x] **Step 5: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`

Expected: PASS，保存草稿会提交稳定的 `compiledSpec`。

- [x] **Step 6: Commit**

```bash
git add apps/web/lib/template-compiler.ts \
  apps/web/components/admin/template-editor/template-editor-screen.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.test.tsx \
  apps/web/lib/admin-types.ts
git commit -m "feat: compile topology graph into template spec"
```

---

## 代码结构预定稿

- Modify: `packages/database/prisma/schema.prisma`
  - 为模板版本化补齐正式字段与关系，补数据库持久化结构
- Modify: `apps/api/src/admin/admin.repository.ts`
  - 统一模板/模板版本/拓扑图/编译产物的仓储类型
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
  - 实现模板创建、草稿更新、发布、实例引用的数据库逻辑
- Modify: `apps/api/src/admin/dto/range-template.dto.ts`
  - 调整模板 DTO，支持更通用的拓扑图与编译产物输入
- Modify: `apps/api/src/admin/range-templates.service.ts`
  - 增加发布逻辑、草稿校验、节点/拓扑兼容校验
- Modify: `apps/api/src/admin/range-templates.controller.ts`
  - 增加 `POST /admin/range-templates/:id/publish`
- Modify: `apps/api/src/admin/range-instances.service.ts`
  - 强制实例只引用已发布模板版本
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`
  - 编排执行改为优先读取已发布版本
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
  - 内存仓储支持模板版本化，用于 e2e
- Modify: `apps/api/test/admin-resources.e2e-spec.ts`
  - 覆盖模板创建、草稿/发布、实例执行引用发布版本
- Modify: `apps/api/test/admin-resource-validation.e2e-spec.ts`
  - 适配“模板必须先发布”规则
- Modify: `apps/api/test/admin-provisioning-failure.e2e-spec.ts`
  - 适配失败用例的模板发布前置
- Create: `apps/web/app/admin/templates/[templateId]/page.tsx`
  - 模板编辑页路由入口
- Create: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
  - 模板编辑器页面容器
- Create: `apps/web/components/admin/template-editor/template-node-palette.tsx`
  - 左侧节点素材库
- Create: `apps/web/components/admin/template-editor/template-canvas.tsx`
  - 中央拓扑画布骨架
- Create: `apps/web/components/admin/template-editor/template-property-panel.tsx`
  - 右侧属性面板骨架
- Modify: `apps/web/lib/admin-types.ts`
  - 对齐模板版本、拓扑图、编译产物类型
- Modify: `apps/web/lib/admin-api.ts`
  - 增加模板发布、模板详情、模板版本相关 API
- Modify: `apps/web/components/admin/settings/settings-screen.tsx`
  - 模板列表接入版本化响应，并提供“进入编辑器/发布”入口
- Modify: `apps/web/components/admin/settings/templates-panel.tsx`
  - 调整模板卡片展示，显示草稿/发布状态
- Test: `apps/web/components/admin/settings/settings-screen.test.tsx`
- Test: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`

### Task 1: 收口模板版本化后端模型

**Status:** 已完成

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Test: `apps/api/test/admin-resources.e2e-spec.ts`
- Test: `apps/api/test/provisioning-worker-concurrency.e2e-spec.ts`

- [x] **Step 1: 先写失败测试，定义模板创建即带草稿版本**

```ts
it('creates a template with a draft version pointer', async () => {
  const response = await request(app.getHttpServer())
    .post('/admin/range-templates')
    .set('authorization', 'Bearer dev-admin-token')
    .send({
      name: 'Enterprise Practice Range',
      slug: 'enterprise-practice-range',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: fixtureTopologySpec,
    })
    .expect(201);

  expect(response.body).toEqual(
    expect.objectContaining({
      currentDraftVersionId: expect.any(String),
      currentPublishedVersionId: null,
      currentDraftVersion: expect.objectContaining({
        status: 'draft',
        version: 'v1',
      }),
    }),
  );
});
```

- [x] **Step 2: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts`

Expected: FAIL，返回体仍是单层模板，没有 `currentDraftVersionId` / `currentDraftVersion`。

- [ ] **Step 3: 扩数据库结构，加入模板版本关系与指针**

```prisma
enum RangeTemplateVersionStatus {
  draft
  published
  archived
}

model RangeTemplate {
  currentDraftVersionId     String? @unique
  currentPublishedVersionId String? @unique
  versions                  RangeTemplateVersion[]
  currentDraftVersion       RangeTemplateVersion? @relation("RangeTemplateCurrentDraftVersion", fields: [currentDraftVersionId], references: [id], onDelete: SetNull)
  currentPublishedVersion   RangeTemplateVersion? @relation("RangeTemplateCurrentPublishedVersion", fields: [currentPublishedVersionId], references: [id], onDelete: SetNull)
}

model RangeTemplateVersion {
  id              String  @id @default(cuid())
  templateId      String
  version         String
  status          RangeTemplateVersionStatus @default(draft)
  modulePathOrRef String
  topologySpec    Json?
  compiledSpec    Json?
  variableSchema  Json
  outputSchema    Json
  defaultNetworkPolicy Json?
  template        RangeTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
}
```

- [x] **Step 4: 在仓储层实现“创建模板自动建首个草稿版本”**

```ts
async createRangeTemplate(input: CreateRangeTemplateInput): Promise<RangeTemplateRecord> {
  return this.prisma.$transaction(async (tx) => {
    const template = await tx.rangeTemplate.create({
      data: {
        name: input.name,
        slug: input.slug,
        version: input.version,
        cloudProvider: input.cloudProvider ?? 'alibaba_cloud',
        iacType: input.iacType ?? 'opentofu',
        modulePathOrRef: input.modulePathOrRef,
        topologySpec: input.topologySpec as Prisma.InputJsonValue,
        variableSchema: (input.variableSchema ?? {}) as Prisma.InputJsonValue,
        outputSchema: (input.outputSchema ?? {}) as Prisma.InputJsonValue,
      },
    });

    const draftVersion = await tx.rangeTemplateVersion.create({
      data: {
        templateId: template.id,
        version: input.version,
        status: 'draft',
        modulePathOrRef: input.modulePathOrRef,
        topologySpec: input.topologySpec as Prisma.InputJsonValue,
        compiledSpec: (input.compiledSpec ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
        variableSchema: (input.variableSchema ?? {}) as Prisma.InputJsonValue,
        outputSchema: (input.outputSchema ?? {}) as Prisma.InputJsonValue,
      },
    });

    await tx.rangeTemplate.update({
      where: { id: template.id },
      data: { currentDraftVersionId: draftVersion.id },
    });

    return tx.rangeTemplate.findUniqueOrThrow({
      where: { id: template.id },
      include: {
        currentDraftVersion: true,
        currentPublishedVersion: true,
        versions: true,
      },
    }) as unknown as RangeTemplateRecord;
  });
}
```

- [x] **Step 5: 内存仓储同步支持版本模型**

```ts
const draftVersion: RangeTemplateVersionRecord = {
  id: nextId(),
  templateId: record.id,
  version: input.version,
  status: 'draft',
  modulePathOrRef: input.modulePathOrRef,
  topologySpec: input.topologySpec,
  createdAt: now(),
  updatedAt: now(),
};

record.currentDraftVersionId = draftVersion.id;
record.currentDraftVersion = clone(draftVersion);
record.currentPublishedVersionId = null;
record.currentPublishedVersion = null;
record.versions = [clone(draftVersion)];
```

- [x] **Step 6: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts`

Expected: PASS，模板返回草稿版本指针；并发 worker 测试仍通过。

- [x] **Step 7: Commit**

```bash
git add packages/database/prisma/schema.prisma \
  apps/api/src/admin/admin.repository.ts \
  apps/api/src/database/prisma-admin.repository.ts \
  apps/api/test/support/create-memory-admin-repository.ts \
  apps/api/test/admin-resources.e2e-spec.ts \
  apps/api/test/provisioning-worker-concurrency.e2e-spec.ts
git commit -m "feat: add template version foundation"
```

### Task 2: 打通模板发布流程与实例只引用已发布版本

**Status:** 已完成

**Files:**
- Modify: `apps/api/src/admin/range-templates.controller.ts`
- Modify: `apps/api/src/admin/range-templates.service.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`
- Modify: `apps/api/test/admin-resources.e2e-spec.ts`
- Modify: `apps/api/test/admin-resource-validation.e2e-spec.ts`
- Modify: `apps/api/test/admin-provisioning-failure.e2e-spec.ts`

- [ ] **Step 1: 先写失败测试，定义 publish 语义**

```ts
it('publishes a template and forks a fresh draft version', async () => {
  const response = await request(app.getHttpServer())
    .post(`/admin/range-templates/${templateId}/publish`)
    .set('authorization', 'Bearer dev-admin-token')
    .expect(200);

  expect(response.body).toEqual(
    expect.objectContaining({
      currentPublishedVersionId: expect.any(String),
      currentDraftVersionId: expect.any(String),
      currentPublishedVersion: expect.objectContaining({ status: 'published', version: 'v1' }),
      currentDraftVersion: expect.objectContaining({ status: 'draft', version: 'v1' }),
    }),
  );
});
```

- [ ] **Step 2: 先写失败测试，定义实例必须引用已发布模板**

```ts
it('rejects creating a range instance from an unpublished template', async () => {
  await request(app.getHttpServer())
    .post('/admin/range-instances')
    .set('authorization', 'Bearer dev-admin-token')
    .send({ competitionId, teamId, templateId: unpublishedTemplateId })
    .expect(409);
});
```

- [ ] **Step 3: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts admin-resource-validation.e2e-spec.ts admin-provisioning-failure.e2e-spec.ts`

Expected: FAIL，缺少 `publish` 路由，且实例仍允许直接引用未发布模板。

- [ ] **Step 4: 增加发布路由与服务实现**

```ts
@Post(':id/publish')
@HttpCode(200)
publish(@Param('id') id: string) {
  return this.rangeTemplatesService.publish(id);
}
```

```ts
async publish(id: string) {
  const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

  if (!existingTemplate) {
    throw new NotFoundException('Range template not found');
  }

  const topologySpec = existingTemplate.currentDraftVersion?.topologySpec ?? existingTemplate.topologySpec;

  if (!topologySpec) {
    throw new BadRequestException('Template topology spec not found');
  }

  this.validateTopologySpec(topologySpec);

  return this.adminRepository.publishRangeTemplate(id);
}
```

- [ ] **Step 5: 在仓储层实现“发布当前草稿 + fork 新草稿”**

```ts
async publishRangeTemplate(id: string): Promise<RangeTemplateRecord> {
  return this.prisma.$transaction(async (tx) => {
    const template = await tx.rangeTemplate.findUniqueOrThrow({
      where: { id },
      include: { currentDraftVersion: true },
    });

    const publishedVersion = await tx.rangeTemplateVersion.update({
      where: { id: template.currentDraftVersion!.id },
      data: { status: 'published' },
    });

    const nextDraft = await tx.rangeTemplateVersion.create({
      data: {
        templateId: template.id,
        version: publishedVersion.version,
        status: 'draft',
        modulePathOrRef: publishedVersion.modulePathOrRef,
        topologySpec: publishedVersion.topologySpec as Prisma.InputJsonValue,
        compiledSpec: publishedVersion.compiledSpec as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
        variableSchema: publishedVersion.variableSchema as Prisma.InputJsonValue,
        outputSchema: publishedVersion.outputSchema as Prisma.InputJsonValue,
      },
    });

    await tx.rangeTemplate.update({
      where: { id: template.id },
      data: {
        version: publishedVersion.version,
        modulePathOrRef: publishedVersion.modulePathOrRef,
        topologySpec: publishedVersion.topologySpec as Prisma.InputJsonValue,
        currentPublishedVersionId: publishedVersion.id,
        currentDraftVersionId: nextDraft.id,
      },
    });

    return tx.rangeTemplate.findUniqueOrThrow({
      where: { id: template.id },
      include: { currentDraftVersion: true, currentPublishedVersion: true, versions: true },
    }) as unknown as RangeTemplateRecord;
  });
}
```

- [ ] **Step 6: 实例与编排统一改为读取已发布版本**

```ts
if (!template.currentPublishedVersionId) {
  throw new ConflictException('Range template must be published before creating range instances');
}
```

```ts
const publishedVersion = template.currentPublishedVersion;
const templateModulePath = publishedVersion?.modulePathOrRef ?? template.modulePathOrRef;
const topologySpec = publishedVersion?.topologySpec ?? template.topologySpec;
```

- [ ] **Step 7: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts admin-resource-validation.e2e-spec.ts admin-provisioning-failure.e2e-spec.ts`

Expected: PASS，模板必须先发布；执行只引用已发布版本。

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/admin/range-templates.controller.ts \
  apps/api/src/admin/range-templates.service.ts \
  apps/api/src/admin/range-instances.service.ts \
  apps/api/src/provisioning/provisioning-worker.service.ts \
  apps/api/test/admin-resources.e2e-spec.ts \
  apps/api/test/admin-resource-validation.e2e-spec.ts \
  apps/api/test/admin-provisioning-failure.e2e-spec.ts
git commit -m "feat: publish template versions before provisioning"
```

### Task 3: 为未来多资源类型补齐通用拓扑图与编译产物边界

**Status:** 已完成并追加收口

- 已补充：顶层模板字段与 `currentDraftVersion` 一致性。
- 已补充：非法输入负例测试与“状态未污染”验证。
- 已补充：Prisma migration、存量模板回填、回填完整性断言。

**Files:**
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/admin/dto/range-template.dto.ts`
- Modify: `apps/api/src/admin/range-templates.service.ts`
- Modify: `apps/api/test/admin-resources.e2e-spec.ts`

- [x] **Step 1: 先写失败测试，定义模板可接受拓扑图与编译产物字段**

```ts
it('accepts topologyGraph and compiledSpec alongside topologySpec', async () => {
  const response = await request(app.getHttpServer())
    .post('/admin/range-templates')
    .set('authorization', 'Bearer dev-admin-token')
    .send({
      name: 'Hybrid Template',
      slug: 'hybrid-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: fixtureTopologySpec,
      topologyGraph: {
        schemaVersion: '1.0.0',
        nodes: [{ id: 'switch-dmz', kind: 'switch', data: { cidr: '10.70.10.0/24' } }],
        edges: [],
      },
      compiledSpec: {
        schemaVersion: '1.0.0',
        resources: [{ id: 'switch-dmz', type: 'switch', config: { cidr: '10.70.10.0/24' } }],
      },
    })
    .expect(201);

  expect(response.body.currentDraftVersion).toEqual(
    expect.objectContaining({
      topologyGraph: expect.objectContaining({ schemaVersion: '1.0.0' }),
      compiledSpec: expect.objectContaining({ schemaVersion: '1.0.0' }),
    }),
  );
});
```

- [x] **Step 2: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`

Expected: FAIL，当前输入/输出没有完整透传 `topologyGraph` / `compiledSpec`。

- [x] **Step 3: 在 DTO 和仓储类型中保留通用 JSON 边界**

```ts
export type RangeTemplateVersionRecord = {
  topologyGraph?: Record<string, unknown> | null;
  compiledSpec?: Record<string, unknown> | null;
};
```

```ts
export class CreateRangeTemplateDto {
  @IsOptional()
  @IsObject()
  topologyGraph?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  compiledSpec?: Record<string, unknown>;
}
```

- [x] **Step 4: 服务层仅做最小兼容校验，不写死资源类型**

```ts
if (input.topologyGraph && typeof input.topologyGraph !== 'object') {
  throw new BadRequestException('topologyGraph must be an object');
}

if (input.compiledSpec && typeof input.compiledSpec !== 'object') {
  throw new BadRequestException('compiledSpec must be an object');
}
```

- [x] **Step 5: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`

Expected: PASS，模板草稿版本能保存并返回通用拓扑图/编译产物。

- [x] **Step 6: Commit**

```bash
git add apps/api/src/admin/admin.repository.ts \
  apps/api/src/admin/dto/range-template.dto.ts \
  apps/api/src/admin/range-templates.service.ts \
  apps/api/test/admin-resources.e2e-spec.ts
git commit -m "feat: add extensible topology graph fields"
```

### Task 4: 接 Web 端模板中心到版本化响应

**Status:** 已完成

**Files:**
- Modify: `apps/web/lib/admin-types.ts`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/components/admin/settings/settings-screen.tsx`
- Modify: `apps/web/components/admin/settings/templates-panel.tsx`
- Test: `apps/web/components/admin/settings/settings-screen.test.tsx`

- [ ] **Step 1: 先写失败测试，定义模板列表卡片显示草稿/发布状态**

```tsx
it('shows draft and published version badges for templates', async () => {
  fetchAdminBootstrapMock.mockResolvedValue({
    competitions: [],
    teams: [],
    rangeInstances: [],
    provisionJobs: [],
    rangeTemplates: [
      {
        id: 'template-1',
        name: 'Enterprise Template',
        slug: 'enterprise-template',
        version: 'v1.1.0',
        currentDraftVersionId: 'draft-1',
        currentPublishedVersionId: 'published-1',
        currentDraftVersion: { id: 'draft-1', status: 'draft', version: 'v1.2.0' },
        currentPublishedVersion: { id: 'published-1', status: 'published', version: 'v1.1.0' },
      },
    ],
  });

  render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

  expect(await screen.findByText('已发布 v1.1.0')).toBeInTheDocument();
  expect(screen.getByText('草稿 v1.2.0')).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/settings/settings-screen.test.tsx`

Expected: FAIL，前端类型和模板卡片仍按旧单层模板结构渲染。

- [ ] **Step 3: 扩前端模板类型与 API 封装**

```ts
export type RangeTemplateVersion = {
  id: string;
  status: 'draft' | 'published' | 'archived';
  version: string;
  topologySpec?: Record<string, unknown> | null;
  topologyGraph?: Record<string, unknown> | null;
  compiledSpec?: Record<string, unknown> | null;
};

export type RangeTemplate = {
  id: string;
  name: string;
  slug: string;
  version: string;
  currentDraftVersionId: string | null;
  currentPublishedVersionId: string | null;
  currentDraftVersion?: RangeTemplateVersion | null;
  currentPublishedVersion?: RangeTemplateVersion | null;
};
```

- [ ] **Step 4: 在模板卡片中显示发布/草稿状态并提供操作入口**

```tsx
<div className="template-version-row">
  {template.currentPublishedVersion ? <span>已发布 {template.currentPublishedVersion.version}</span> : <span>未发布</span>}
  {template.currentDraftVersion ? <span>草稿 {template.currentDraftVersion.version}</span> : null}
</div>

<div className="template-actions">
  <button type="button" onClick={() => onOpenEditor(template.id)}>进入编辑器</button>
  <button type="button" onClick={() => onPublish(template.id)} disabled={!template.currentDraftVersionId}>发布</button>
</div>
```

- [ ] **Step 5: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/settings/settings-screen.test.tsx`

Expected: PASS，模板卡片可区分草稿与已发布版本。

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/admin-types.ts \
  apps/web/lib/admin-api.ts \
  apps/web/components/admin/settings/settings-screen.tsx \
  apps/web/components/admin/settings/templates-panel.tsx \
  apps/web/components/admin/settings/settings-screen.test.tsx
git commit -m "feat: surface template versions in admin settings"
```

### Task 5: 搭第一版模板编辑器工作区骨架

**Status:** 已完成，且已超出原骨架范围

- 实际已完成内容超过原计划：
  - 节点新增
  - 草稿拓扑读取与保存
  - `host/switch/router` 分类型属性面板
  - 编辑器内发布模板

**Files:**
- Create: `apps/web/app/admin/templates/[templateId]/page.tsx`
- Create: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- Create: `apps/web/components/admin/template-editor/template-node-palette.tsx`
- Create: `apps/web/components/admin/template-editor/template-canvas.tsx`
- Create: `apps/web/components/admin/template-editor/template-property-panel.tsx`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/lib/admin-types.ts`
- Test: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`

- [x] **Step 1: 先写失败测试，定义编辑器基础布局**

```tsx
it('renders the topology editor workspace layout', async () => {
  render(
    <TemplateEditorScreen
      template={{
        id: 'template-1',
        name: 'Enterprise Template',
        currentDraftVersion: { id: 'draft-1', status: 'draft', version: 'v1.2.0', topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] } },
      }}
    />,
  );

  expect(screen.getByText('节点库')).toBeInTheDocument();
  expect(screen.getByText('拓扑画布')).toBeInTheDocument();
  expect(screen.getByText('属性面板')).toBeInTheDocument();
});
```

- [x] **Step 2: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`

Expected: FAIL，编辑器页面和组件尚不存在。

- [x] **Step 3: 建编辑器页面和三个核心骨架组件**

```tsx
export function TemplateEditorScreen({ template }: { template: RangeTemplate }) {
  const draft = template.currentDraftVersion;

  return (
    <section className="template-editor-shell">
      <header className="template-editor-toolbar">
        <h1>{template.name}</h1>
        <div>
          <button type="button">保存草稿</button>
          <button type="button">发布模板</button>
        </div>
      </header>
      <div className="template-editor-body">
        <TemplateNodePalette />
        <TemplateCanvas topologyGraph={draft?.topologyGraph ?? null} />
        <TemplatePropertyPanel />
      </div>
    </section>
  );
}
```

- [x] **Step 4: 节点库先只放三类节点，属性面板先只做空态**

```tsx
export function TemplateNodePalette() {
  return (
    <aside>
      <h2>节点库</h2>
      <button type="button">主机</button>
      <button type="button">交换机</button>
      <button type="button">路由器</button>
    </aside>
  );
}
```

```tsx
export function TemplatePropertyPanel() {
  return (
    <aside>
      <h2>属性面板</h2>
      <p>选择一个节点后即可编辑参数。</p>
    </aside>
  );
}
```

- [x] **Step 5: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`

Expected: PASS，编辑器布局骨架可渲染。

- [x] **Step 6: Commit**

```bash
git add apps/web/app/admin/templates/[templateId]/page.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.tsx \
  apps/web/components/admin/template-editor/template-node-palette.tsx \
  apps/web/components/admin/template-editor/template-canvas.tsx \
  apps/web/components/admin/template-editor/template-property-panel.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.test.tsx
git commit -m "feat: add topology editor workspace skeleton"
```

## 自检

- 覆盖检查：本计划覆盖了模板版本化、发布执行边界、未来多资源扩展字段、模板中心前端适配、编辑器基础工作区。
- 占位检查：无 `TODO` / `TBD` / “类似前文” 之类占位描述。
- 类型一致性：计划中统一使用 `RangeTemplate`、`RangeTemplateVersion`、`topologyGraph`、`compiledSpec`、`currentDraftVersion`、`currentPublishedVersion` 命名。
