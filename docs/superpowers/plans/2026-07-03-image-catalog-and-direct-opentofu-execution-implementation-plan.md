# Image Catalog And Direct OpenTofu Execution Implementation Plan

- 日期：2026-07-03
- 状态：执行中，核心链路已完成，当前进入部署收口和后续体验增强阶段
- 最新同步：2026-07-03，已补充部署目录快照 `deploy/current-system/`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the runtime `aliyun CLI` pre-resolution layer, make instance creation consume final `image_id + instance_type` directly, and introduce an account-aware image catalog with public/custom image views plus catalog collection.

**Architecture:** This plan is intentionally split into a practical MVP path: first fix the provisioning runtime so new instances stop depending on `aliyun` CLI, then add backend image-catalog persistence and sync APIs, and finally wire the admin image center and template editor onto those stable catalog records. The runtime path will only consume final execution values; catalog and display names remain product-layer metadata.

**Tech Stack:** NestJS, Prisma/PostgreSQL, Next.js, Vitest, Jest, Docker Compose, Alibaba Cloud ECS OpenAPI/SDK, OpenTofu

## Execution Snapshot

截至 2026-07-03，本计划对应的已完成结果如下：

- 已完成：
  - OpenTofu 运行时移除 `aliyun CLI` 依赖，改为内置签名 RPC 请求
  - root wrapper + worker + provider mirror + 持久化云配置链路
  - 镜像中心后端接口与前端页面
  - 编排器镜像目录接入
  - ECS 规格实时校验接口与前端提示
  - `runtime_selections` 混合策略对象兼容修复
- 已完成容器态验证：
  - `for-api-1`
  - `for-provisioner-worker-1`
  - `for-web-1`
- 当前剩余重点：
  - 历史模板数据进一步归一化
  - 部署资料持续收口
  - 后续镜像中心和编排体验增强

## Deployment Snapshot Directory

当前部署相关文件已经集中整理到：

- [deploy/current-system](/Users/yym/Documents/阿里云For综合靶场竞赛平台/deploy/current-system)

后续如果要继续补部署手册、环境模板或镜像构建说明，优先在这个目录中维护快照。

---

## File Structure

### Runtime execution

- `apps/api/src/provisioning/open-tofu-range-provisioner.ts`
  - Remove runtime `aliyun CLI` dependency for instance/image resolution
  - Read final `imageId` / `instanceType` from compiled template data
- `apps/api/src/provisioning/renderers/alibaba-cloud-opentofu-renderer.ts`
  - Keep final execution values explicit in rendered tfvars
- `apps/api/test/open-tofu-range-provisioner.e2e-spec.ts`
  - Regression tests for direct execution values

### Static instance-type mapping

- `apps/api/src/provisioning/instance-type-catalog.ts`
  - Backend source of truth for `cpu/memory -> instance_type`
- `apps/web/lib/instance-type-catalog.ts`
  - Frontend mirror for editor save/validation
- `apps/web/lib/topology-graph-to-scenario-template.ts`
  - Persist final `instanceType`
- `apps/web/components/admin/template-editor/template-editor-screen.tsx`
  - Save final execution values in the graph/template data

### Image catalog backend

- `packages/database/prisma/schema.prisma`
  - Add account-aware image snapshot and catalog tables
- `packages/database/prisma/migrations/20260703...`
  - Migration for image snapshot/catalog schema
- `apps/api/src/admin/admin.repository.ts`
  - Add image snapshot/catalog repository contracts
- `apps/api/src/database/prisma-admin.repository.ts`
  - Prisma implementations
- `apps/api/src/admin/system-config.service.ts`
  - Provide account identity context for image sync
- `apps/api/src/admin/image-catalog.service.ts`
  - Sync public/custom images, list catalog items, collect into catalog
- `apps/api/src/admin/image-catalog.controller.ts`
  - REST endpoints for image center
- `apps/api/src/app.module.ts`
  - Register service/controller
- `apps/api/test/admin-image-catalog.e2e-spec.ts`
  - Backend API behavior tests

### Image center UI

- `apps/web/lib/admin-types.ts`
  - Add image snapshot/catalog response types
- `apps/web/lib/admin-api.ts`
  - Add image center API calls
- `apps/web/components/admin/image-center-screen.tsx`
  - Replace placeholder with public/custom modules + collect action
- `apps/web/components/admin/image-center-screen.test.tsx`
  - UI tests

### Template editor image selection

- `apps/web/lib/scenario-graph.ts`
  - Add `imageCatalogItemId?`, `instanceType?`
- `apps/web/components/admin/template-editor/template-property-panel.tsx`
  - Use image catalog selection rather than free text only
- `apps/web/components/admin/template-editor/template-property-panel.test.tsx`
  - Selection tests
- `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
  - Save behavior tests

---

### Task 1: Remove Runtime `aliyun CLI` Resolution From Provisioning

**Files:**
- Modify: `apps/api/src/provisioning/open-tofu-range-provisioner.ts`
- Modify: `apps/api/test/open-tofu-range-provisioner.e2e-spec.ts`
- Modify: `apps/api/src/provisioning/renderers/alibaba-cloud-opentofu-renderer.ts`

- [ ] **Step 1: Write the failing runtime tests for direct execution values**

Add/adjust focused tests in `apps/api/test/open-tofu-range-provisioner.e2e-spec.ts` so provisioning succeeds without any `availableImageIdResolver` / `availableInstanceTypeResolver` call when compiled template data already contains final values:

```ts
it('uses final imageId and instanceType from compiled host data without calling aliyun runtime resolvers', async () => {
  const availableInstanceTypeResolver = jest.fn().mockResolvedValue('should-not-be-used');
  const availableImageIdResolver = jest.fn().mockResolvedValue('should-not-be-used');

  // build compiledSpec host config with:
  // imageId: 'ubuntu_22_04_x64_20G_alibase'
  // instanceType: 'ecs.u1-c1m2.large'

  await provisioner.create({ ... });

  expect(availableInstanceTypeResolver).not.toHaveBeenCalled();
  expect(availableImageIdResolver).not.toHaveBeenCalled();
  expect(renderedVariables.hosts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: 'ecs-1',
        instance_type: 'ecs.u1-c1m2.large',
      }),
    ]),
  );
  expect(renderedVariables.image_id).toBe('ubuntu_22_04_x64_20G_alibase');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/open-tofu-range-provisioner.e2e-spec.ts -t "uses final imageId and instanceType from compiled host data without calling aliyun runtime resolvers" --runInBand
```

Expected: FAIL because current implementation still reaches runtime resolvers

- [ ] **Step 3: Introduce direct host runtime value readers**

In `apps/api/src/provisioning/open-tofu-range-provisioner.ts`, add helper readers that prefer final execution values from compiled data:

```ts
function readCompiledHostExecutionValues(
  compiledSpec: RangeTemplateCompiledSpec | null | undefined,
) {
  const values = new Map<string, { imageId?: string; instanceType?: string; cpu?: number; memory?: number }>();

  for (const resource of compiledSpec?.resources ?? []) {
    if (resource.type !== 'host') continue;

    values.set(resource.id, {
      ...(typeof resource.config.imageId === 'string' ? { imageId: resource.config.imageId } : {}),
      ...(typeof resource.config.instanceType === 'string' ? { instanceType: resource.config.instanceType } : {}),
      ...(typeof resource.config.cpu === 'number' ? { cpu: resource.config.cpu } : {}),
      ...(typeof resource.config.memory === 'number' ? { memory: resource.config.memory } : {}),
    });
  }

  return values;
}
```

- [ ] **Step 4: Stop calling runtime image resolver when a final imageId already exists**

Update `buildVariables()` / `resolveImageId()` so image resolution becomes:

```ts
const hostExecutionValues = readCompiledHostExecutionValues(input.compiledSpec);
const defaultImageId =
  hostExecutionValues.get(plan.entryHostKey)?.imageId ??
  [...hostExecutionValues.values()].find((item) => item.imageId)?.imageId ??
  null;

const imageId = defaultImageId ?? (await this.resolveImageId(runtimeConfig));
```

And keep `resolveImageId()` only for legacy templates that still lack a final `imageId`.

- [ ] **Step 5: Stop calling runtime instance-type resolver when a final instanceType already exists**

Update `resolveHostInstanceTypes()` so the first branch becomes:

```ts
const directExecutionValues = readCompiledHostExecutionValues(input.compiledSpec);

for (const host of input.plan.hostDefinitions) {
  const directInstanceType = directExecutionValues.get(host.key)?.instanceType;
  if (directInstanceType) {
    resolvedHostInstanceTypes[host.key] = directInstanceType;
    continue;
  }

  // fall back to cpu/memory mapping only when final instanceType is absent
}
```

- [ ] **Step 6: Keep rendered tfvars explicit**

In `apps/api/src/provisioning/renderers/alibaba-cloud-opentofu-renderer.ts`, ensure every host still receives final execution values:

```ts
hosts: plan.hostDefinitions.map((host) => ({
  key: host.key,
  name: host.name,
  zone_key: host.zoneKey,
  private_ip: host.privateIp,
  role: host.role,
  expose_public: host.exposePublic,
  instance_type: input.hostInstanceTypes[host.key] ?? input.instanceType,
}))
```

- [ ] **Step 7: Run the focused test to verify it passes**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/open-tofu-range-provisioner.e2e-spec.ts -t "uses final imageId and instanceType from compiled host data without calling aliyun runtime resolvers" --runInBand
```

Expected: PASS

- [ ] **Step 8: Run runtime regression tests**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/open-tofu-range-provisioner.e2e-spec.ts test/alibaba-cloud-opentofu-renderer.e2e-spec.ts --runInBand
```

Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/provisioning/open-tofu-range-provisioner.ts \
  apps/api/src/provisioning/renderers/alibaba-cloud-opentofu-renderer.ts \
  apps/api/test/open-tofu-range-provisioner.e2e-spec.ts
git commit -m "feat: remove runtime aliyun resolution from provisioning"
```

### Task 2: Introduce Fixed `CPU/Memory -> instance_type` Mapping

**Files:**
- Create: `apps/api/src/provisioning/instance-type-catalog.ts`
- Create: `apps/web/lib/instance-type-catalog.ts`
- Modify: `apps/web/lib/scenario-graph.ts`
- Modify: `apps/web/lib/topology-graph-to-scenario-template.ts`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- Modify: `apps/web/lib/topology-graph-to-scenario-template.test.ts`

- [ ] **Step 1: Write the failing frontend save-path test**

In `apps/web/lib/topology-graph-to-scenario-template.test.ts`, add:

```ts
it('derives final instanceType from cpu and memory before emitting template spec', () => {
  const template = buildScenarioTemplateSpecFromTopologyGraph({
    topologyGraph: {
      schemaVersion: '2.0.0',
      nodes: [
        {
          id: 'ecs-1',
          kind: 'ecs',
          label: 'ECS 1',
          zoneKey: 'zone-1',
          role: 'entry',
          privateIp: '',
          exposePublic: true,
          image: 'ubuntu_22_04_x64_20G_alibase',
          imageId: 'ubuntu_22_04_x64_20G_alibase',
          imageName: 'Ubuntu 22.04',
          cpu: 1,
          memory: 2,
          imageStrategy: { mode: 'fixed', imageId: 'ubuntu_22_04_x64_20G_alibase' },
          instanceTypeStrategy: { mode: 'fixed', instanceType: 'ecs.u1-c1m2.large', preferredInstanceTypes: [] },
          portGroups: [],
          dnatMappings: [],
          networkInterfaces: [{ zoneKey: 'zone-1', privateIp: '10.0.0.10' }],
          initScript: '',
        },
      ],
      edges: [],
    },
    metadata: { ... },
  });

  expect(template.runtimePreferences.instanceTypePolicies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        instanceType: 'ecs.u1-c1m2.large',
        mode: 'fixed',
      }),
    ]),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/web && ./node_modules/.bin/vitest run lib/topology-graph-to-scenario-template.test.ts
```

Expected: FAIL because final `instanceType` is not persisted consistently yet

- [ ] **Step 3: Add the backend/frontend fixed mapping tables**

Create `apps/api/src/provisioning/instance-type-catalog.ts`:

```ts
export const FIXED_INSTANCE_TYPE_BY_RESOURCES: Record<string, string> = {
  '1c2g': 'ecs.u1-c1m2.large',
  '2c4g': 'ecs.c7.large',
  '4c8g': 'ecs.c7.xlarge',
};

export function resolveFixedInstanceType(cpu?: number, memoryGiB?: number) {
  if (!cpu || !memoryGiB) {
    return null;
  }

  return FIXED_INSTANCE_TYPE_BY_RESOURCES[`${cpu}c${memoryGiB}g`] ?? null;
}
```

Mirror the same file in `apps/web/lib/instance-type-catalog.ts`.

- [ ] **Step 4: Persist final `instanceType` in the graph/template path**

In `apps/web/lib/scenario-graph.ts`, extend the ECS node shape:

```ts
export type EcsTemplateNode = TemplateNodeBase & {
  // existing fields...
  instanceType?: string;
};
```

In `apps/web/lib/topology-graph-to-scenario-template.ts`, resolve and persist:

```ts
const resolvedInstanceType =
  node.instanceType ??
  node.instanceTypeStrategy.instanceType ??
  resolveFixedInstanceType(node.cpu, node.memory);

instanceTypePolicies: hostNodes.map((host) => ({
  key: `${host.id}-instance-type-policy`,
  mode: resolvedInstanceType ? 'fixed' : 'auto',
  instanceType: resolvedInstanceType ?? undefined,
  preferredInstanceTypes: [],
}));
```

- [ ] **Step 5: Keep the editor node state consistent**

In `apps/web/components/admin/template-editor/template-editor-screen.tsx`, whenever CPU or memory changes for an ECS node, recompute:

```ts
instanceType: resolveFixedInstanceType(nextCpu, nextMemory) ?? selectedNode.instanceType,
instanceTypeStrategy: {
  mode: resolveFixedInstanceType(nextCpu, nextMemory) ? 'fixed' : 'auto',
  instanceType: resolveFixedInstanceType(nextCpu, nextMemory) ?? undefined,
  preferredInstanceTypes: [],
},
```

- [ ] **Step 6: Run the focused web tests**

Run:

```bash
cd apps/web && ./node_modules/.bin/vitest run lib/topology-graph-to-scenario-template.test.ts components/admin/template-editor/template-editor-screen.test.tsx
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/provisioning/instance-type-catalog.ts \
  apps/web/lib/instance-type-catalog.ts \
  apps/web/lib/scenario-graph.ts \
  apps/web/lib/topology-graph-to-scenario-template.ts \
  apps/web/components/admin/template-editor/template-editor-screen.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.test.tsx \
  apps/web/lib/topology-graph-to-scenario-template.test.ts
git commit -m "feat: persist fixed instance types from cpu memory mapping"
```

### Task 3: Add Image Snapshot And Catalog Data Model

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260703xxxxxx_add_image_snapshot_and_catalog_tables/migration.sql`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/src/admin/system-config.service.ts`
- Test: `apps/api/test/admin-image-catalog.e2e-spec.ts`

- [ ] **Step 1: Write the failing backend image-catalog tests**

Create `apps/api/test/admin-image-catalog.e2e-spec.ts` with focused API tests:

```ts
it('lists public image snapshots for the current cloud account context', async () => {
  // expect GET /admin/image-catalog/public to return rows
});

it('lists custom image snapshots scoped to the current account', async () => {
  // expect GET /admin/image-catalog/custom to return only current-account rows
});

it('collects an image snapshot into the platform catalog', async () => {
  // expect POST /admin/image-catalog/collect to persist a displayName -> imageId record
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/admin-image-catalog.e2e-spec.ts --runInBand
```

Expected: FAIL because schema/API do not exist

- [ ] **Step 3: Add Prisma models**

Add to `packages/database/prisma/schema.prisma`:

```prisma
model CloudImageSnapshot {
  id            String   @id @default(cuid())
  provider      String
  accountUid    String?
  regionId      String
  scope         String
  imageId       String
  sourceImageName String
  osType        String?
  platform      String?
  architecture  String?
  status        String?
  isAvailable   Boolean  @default(true)
  lastSyncedAt  DateTime
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([provider, accountUid, regionId, scope, imageId])
}

model ImageCatalogItem {
  id              String   @id @default(cuid())
  displayName     String
  imageId         String
  provider        String
  scope           String
  accountUid      String?
  regionId        String
  enabled         Boolean  @default(true)
  sourceSnapshotId String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

- [ ] **Step 4: Add repository contracts**

In `apps/api/src/admin/admin.repository.ts`, add types and methods:

```ts
listImageCatalogItems(scope?: 'public' | 'custom'): Promise<ImageCatalogItemRecord[]>;
upsertImageSnapshots(input: UpsertImageSnapshotsInput): Promise<void>;
collectImageCatalogItem(input: CollectImageCatalogItemInput): Promise<ImageCatalogItemRecord>;
```

- [ ] **Step 5: Add account identity resolution**

Extend `SystemConfigService` with a method like:

```ts
async getAccountContext(): Promise<{
  provider: 'alibaba_cloud';
  accountUid: string;
  defaultRegion: string;
  defaultZoneId: string;
  accessKeyId: string;
  accessKeySecret: string;
}> { /* call Alibaba Cloud STS/GetCallerIdentity or equivalent */ }
```

- [ ] **Step 6: Run Prisma validation**

Run:

```bash
./packages/database/node_modules/.bin/prisma validate --schema packages/database/prisma/schema.prisma
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/database/prisma/schema.prisma \
  packages/database/prisma/migrations/20260703xxxxxx_add_image_snapshot_and_catalog_tables/migration.sql \
  apps/api/src/admin/admin.repository.ts \
  apps/api/src/database/prisma-admin.repository.ts \
  apps/api/src/admin/system-config.service.ts \
  apps/api/test/admin-image-catalog.e2e-spec.ts
git commit -m "feat: add image snapshot and catalog persistence"
```

### Task 4: Add Image Catalog Backend APIs

**Files:**
- Create: `apps/api/src/admin/image-catalog.service.ts`
- Create: `apps/api/src/admin/image-catalog.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/test/admin-image-catalog.e2e-spec.ts`

- [ ] **Step 1: Implement ECS image sync service**

Create `apps/api/src/admin/image-catalog.service.ts` with methods:

```ts
async syncPublicImages() { /* query ECS DescribeImages for public images */ }
async syncCustomImages() { /* query ECS DescribeImages for custom images scoped to current account */ }
async listCatalog(scope?: 'public' | 'custom') { /* read ImageCatalogItem */ }
async collectFromSnapshot(snapshotId: string, displayName: string) { /* create catalog item */ }
```

- [ ] **Step 2: Expose REST endpoints**

Create `apps/api/src/admin/image-catalog.controller.ts`:

```ts
@Controller('admin/image-catalog')
@UseGuards(AdminAuthGuard)
export class ImageCatalogController {
  @Get('public')
  listPublic() { ... }

  @Get('custom')
  listCustom() { ... }

  @Post('public/sync')
  syncPublic() { ... }

  @Post('custom/sync')
  syncCustom() { ... }

  @Post('collect')
  collect(@Body() body: { snapshotId: string; displayName: string }) { ... }
}
```

- [ ] **Step 3: Register the module wiring**

In `apps/api/src/app.module.ts`, add the controller/service to the existing module providers/controllers arrays.

- [ ] **Step 4: Run backend image-catalog tests**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/admin-image-catalog.e2e-spec.ts --runInBand
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/admin/image-catalog.service.ts \
  apps/api/src/admin/image-catalog.controller.ts \
  apps/api/src/app.module.ts \
  apps/api/test/admin-image-catalog.e2e-spec.ts
git commit -m "feat: add image catalog sync and collection apis"
```

### Task 5: Replace Image Center Placeholder With Public/Custom Modules

**Files:**
- Modify: `apps/web/lib/admin-types.ts`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/components/admin/image-center-screen.tsx`
- Modify: `apps/web/components/admin/image-center-screen.test.tsx`

- [ ] **Step 1: Write the failing image-center UI test**

Replace the placeholder expectations in `apps/web/components/admin/image-center-screen.test.tsx` with:

```ts
it('renders public and custom image modules with sync and collect actions', async () => {
  render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

  expect(await screen.findByRole('heading', { name: '公共镜像' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: '自定义镜像' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '同步公共镜像' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '同步自定义镜像' })).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd apps/web && ./node_modules/.bin/vitest run components/admin/image-center-screen.test.tsx
```

Expected: FAIL because placeholder screen is still rendered

- [ ] **Step 3: Add API helpers**

In `apps/web/lib/admin-api.ts`, add:

```ts
export async function fetchPublicImageSnapshots(...) { ... }
export async function fetchCustomImageSnapshots(...) { ... }
export async function syncPublicImages(...) { ... }
export async function syncCustomImages(...) { ... }
export async function collectImageCatalogItem(...) { ... }
```

- [ ] **Step 4: Add response types**

In `apps/web/lib/admin-types.ts`, add frontend types for:

```ts
export type ImageSnapshot = { ... };
export type ImageCatalogItem = { ... };
```

- [ ] **Step 5: Replace the placeholder component**

In `apps/web/components/admin/image-center-screen.tsx`, render two list modules:

```tsx
<section className="template-workbench-shell">
  <div className="template-workbench-list image-center-list">
    <div className="template-workbench-list-header">
      <div className="template-workbench-list-header-copy">
        <h2>公共镜像</h2>
      </div>
      <button type="button" onClick={() => void handleSyncPublicImages()}>
        同步公共镜像
      </button>
    </div>
    {/* list rows */}
  </div>

  <div className="template-workbench-list image-center-list">
    <div className="template-workbench-list-header">
      <div className="template-workbench-list-header-copy">
        <h2>自定义镜像</h2>
      </div>
      <button type="button" onClick={() => void handleSyncCustomImages()}>
        同步自定义镜像
      </button>
    </div>
    {/* list rows */}
  </div>
</section>
```

Each row should include a `收录到目录` button.

- [ ] **Step 6: Run web image-center tests**

Run:

```bash
cd apps/web && ./node_modules/.bin/vitest run components/admin/image-center-screen.test.tsx
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/admin-types.ts \
  apps/web/lib/admin-api.ts \
  apps/web/components/admin/image-center-screen.tsx \
  apps/web/components/admin/image-center-screen.test.tsx
git commit -m "feat: replace placeholder image center with public and custom modules"
```

### Task 6: Connect Template Editor To Catalog And Final Execution Values

**Files:**
- Modify: `apps/web/lib/scenario-graph.ts`
- Modify: `apps/web/components/admin/template-editor/template-property-panel.tsx`
- Modify: `apps/web/components/admin/template-editor/template-property-panel.test.tsx`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- Modify: `apps/web/lib/topology-graph-to-scenario-template.ts`

- [ ] **Step 1: Write the failing editor integration test**

In `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`, add:

```ts
it('stores imageCatalogItemId, imageName, imageId, and final instanceType when saving ecs nodes', async () => {
  // simulate selecting a catalog image
  // simulate cpu/memory selection
  // assert saved compiled spec contains imageId + instanceType
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd apps/web && ./node_modules/.bin/vitest run components/admin/template-editor/template-editor-screen.test.tsx components/admin/template-editor/template-property-panel.test.tsx
```

Expected: FAIL because catalog-backed selection is not wired yet

- [ ] **Step 3: Extend graph node shape**

In `apps/web/lib/scenario-graph.ts`, add:

```ts
imageCatalogItemId?: string;
instanceType?: string;
```

- [ ] **Step 4: Render catalog-driven image selection**

In `apps/web/components/admin/template-editor/template-property-panel.tsx`, replace plain free-text mirror behavior with:

```tsx
<PropertyField label="镜像名">
  <select
    aria-label="镜像名"
    value={selectedNode.imageCatalogItemId ?? ''}
    onChange={(event) => {
      const selected = imageCatalogItems.find((item) => item.id === event.target.value);
      onUpdateNode(selectedNode.id, {
        ...selectedNode,
        imageCatalogItemId: selected?.id,
        imageName: selected?.displayName ?? '',
        imageId: selected?.imageId ?? '',
        imageStrategy: {
          mode: 'fixed',
          imageId: selected?.imageId,
        },
      });
    }}
  >
```

- [ ] **Step 5: Ensure compiled/template paths emit final values**

In `apps/web/lib/topology-graph-to-scenario-template.ts`, keep emitting:

```ts
image: node.image || node.imageId || node.imageName,
imagePolicyRef: `${node.id}-image-policy`,
```

but ensure the policy is now always:

```ts
{
  key: `${host.id}-image-policy`,
  mode: 'fixed',
  imageId: host.imageId,
}
```

And instance type policy:

```ts
{
  key: `${host.id}-instance-type-policy`,
  mode: 'fixed',
  instanceType: host.instanceType,
  preferredInstanceTypes: [],
}
```

- [ ] **Step 6: Run editor tests**

Run:

```bash
cd apps/web && ./node_modules/.bin/vitest run \
  components/admin/template-editor/template-property-panel.test.tsx \
  components/admin/template-editor/template-editor-screen.test.tsx \
  lib/topology-graph-to-scenario-template.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/scenario-graph.ts \
  apps/web/components/admin/template-editor/template-property-panel.tsx \
  apps/web/components/admin/template-editor/template-property-panel.test.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.test.tsx \
  apps/web/lib/topology-graph-to-scenario-template.ts \
  apps/web/lib/topology-graph-to-scenario-template.test.ts
git commit -m "feat: wire template editor to image catalog execution values"
```

### Task 7: Container Verification

**Files:**
- Verify: `.env`
- Verify: `docker-compose.yml`

- [ ] **Step 1: Rebuild runtime containers**

Run:

```bash
COMPOSE_BAKE=false docker compose up -d --build api provisioner-worker web
```

Expected: all runtime containers start successfully

- [ ] **Step 2: Run container-side focused backend regression**

Run:

```bash
docker exec for-api-1 sh -lc 'cd /app/apps/api && ./node_modules/.bin/jest test/open-tofu-range-provisioner.e2e-spec.ts test/admin-image-catalog.e2e-spec.ts --runInBand'
```

Expected: PASS

- [ ] **Step 3: Run container-side focused frontend regression**

Run:

```bash
docker exec for-web-1 sh -lc 'cd /app/apps/web && ./node_modules/.bin/vitest run components/admin/image-center-screen.test.tsx components/admin/template-editor/template-editor-screen.test.tsx'
```

Expected: PASS

- [ ] **Step 4: Manual runtime spot-check**

Verify in browser:

1. `/admin/image-center` shows 公共镜像 / 自定义镜像
2. 同步动作可返回数据
3. 编排器镜像选择不再是纯自由文本
4. 新建实例不再因为 `spawn aliyun ENOENT` 失败

- [ ] **Step 5: Commit**

```bash
git add .env docker-compose.yml
git commit -m "chore: rebuild containers for direct image execution flow"
```
