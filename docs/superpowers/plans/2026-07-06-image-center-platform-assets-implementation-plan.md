# Image Center Platform Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Last Updated:** 2026-07-06
**Plan Status:** In Progress

## Implementation Status Snapshot

### Completed

- Image center has been split into three tabs: platform assets, Aliyun custom images, and Aliyun public images
- Platform image assets are now the editor-facing source of truth for ECS image selection
- Core platform asset actions are connected: collect, rename, enable/disable, remove from platform
- Aliyun custom images support cloud-side deletion with downstream platform asset handling

### In Progress

- Table layout and interaction polish are still being refined to match the rest of the admin workspace
- More validation between platform image assets and downstream provisioning constraints still needs tightening

### Next Focus

- Verify account-scoped image isolation under more real cloud configurations
- Continue polishing the template-editor image combobox and the image-center management flow together

**Goal:** Rebuild `/admin/image-center` around three tabs and a new account-bound platform image asset layer so the editor only consumes platform-collected images.

**Architecture:** Keep `CloudImageSnapshot` as the Aliyun sync cache, add a new `PlatformImageAsset` model as the platform-owned catalog, then split the image center into three tabs: platform assets, Aliyun custom snapshots, and Aliyun public snapshots. Backend services expose dedicated platform-image endpoints plus custom-image deletion with platform-asset cleanup; frontend switches both the image center and template editor to the new source of truth.

**Tech Stack:** Next.js App Router, React 19, Vitest, NestJS 11, Prisma, Jest, Docker Compose.

## Post-implementation update (2026-07-14)

在原始平台镜像资产方案完成后，镜像中心又补充落地了以下收口：

- 平台镜像和我的镜像都已支持创建人展示与单实例创建入口
- 个人镜像支持发布到平台，平台镜像支持回退为私有
- 平台镜像和我的镜像的行内动作都已经收敛成“主动作 + 更多操作”布局
- 云上镜像来源已改成按 tab 惰性加载，公共镜像接口也已改成轻量字段返回
- `GET /admin/image-catalog/public` 的实际响应体积已从约 `170 KB` 降到约 `90 KB`

---

## File Structure

### Database and shared persistence

- Create: `packages/database/prisma/migrations/20260706_add_platform_image_assets/migration.sql`
- Modify: `packages/database/prisma/schema.prisma`

### Backend admin contracts and repository

- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`

### Backend image services and controllers

- Create: `apps/api/src/admin/platform-images.controller.ts`
- Create: `apps/api/src/admin/dto/platform-image.dto.ts`
- Create: `apps/api/src/admin/dto/delete-custom-image.dto.ts` if a request payload becomes necessary
- Modify: `apps/api/src/admin/image-catalog.service.ts`
- Modify: `apps/api/src/admin/image-catalog.controller.ts`
- Modify: `apps/api/src/app.module.ts`

### Frontend types and API layer

- Modify: `apps/web/lib/admin-types.ts`
- Modify: `apps/web/lib/admin-api.ts`

### Frontend image center UI

- Modify: `apps/web/components/admin/image-center-screen.tsx`
- Modify: `apps/web/components/admin/image-center-screen.test.tsx`
- Modify: `apps/web/app/globals.css`

### Template editor image-source switch

- Modify: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- Modify: `apps/web/components/admin/template-editor/template-property-panel.tsx`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- Modify: `apps/web/components/admin/template-editor/template-property-panel.test.tsx`

### Backend integration tests

- Modify: `apps/api/test/admin-image-catalog.e2e-spec.ts`

### Deployment verification

- Modify if needed: `deploy/current-system/README.md`
- Modify if needed: `deploy/current-system/docker-compose.yml`

## Task 1: Add Platform Image Asset Persistence Model

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260706_add_platform_image_assets/migration.sql`
- Test: `apps/api/test/admin-image-catalog.e2e-spec.ts`

- [ ] **Step 1: Write the failing persistence test expectations**

Add a new describe block in `apps/api/test/admin-image-catalog.e2e-spec.ts` that assumes a platform asset layer exists and is unique per `provider + accountScopeKey + regionId + imageId`.

```ts
it('collects one platform image asset per account and region even when recollected from snapshots', async () => {
  const first = await repository.collectPlatformImageAsset({
    snapshotId: publicSnapshot.id,
    displayName: 'Ubuntu 24.04',
  });

  const second = await repository.collectPlatformImageAsset({
    snapshotId: publicSnapshot.id,
    displayName: 'Ubuntu 24.04',
  });

  expect(second.id).toBe(first.id);

  const assets = await repository.listPlatformImageAssets({
    accountScopeKey: 'aliyun::1234567890',
    regionId: 'cn-hangzhou',
  });

  expect(assets).toHaveLength(1);
  expect(assets[0]).toEqual(
    expect.objectContaining({
      imageId: publicSnapshot.imageId,
      displayName: 'Ubuntu 24.04',
      enabled: true,
      sourceScope: 'public',
    }),
  );
});
```

- [ ] **Step 2: Run the targeted backend test to verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api && pnpm test -- admin-image-catalog.e2e-spec.ts
```

Expected: FAIL because `collectPlatformImageAsset` / `listPlatformImageAssets` and the Prisma model do not exist.

- [ ] **Step 3: Add the Prisma model and relation**

Update `packages/database/prisma/schema.prisma` by adding a dedicated `PlatformImageAsset` model and linking it to `CloudImageSnapshot`.

```prisma
model PlatformImageAsset {
  id               String        @id @default(cuid())
  provider         CloudProvider @default(alibaba_cloud)
  accountUid       String?
  accountScopeKey  String
  regionId         String
  sourceScope      String
  sourceSnapshotId String?
  imageId          String
  displayName      String
  enabled          Boolean       @default(true)
  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt
  sourceSnapshot   CloudImageSnapshot? @relation(fields: [sourceSnapshotId], references: [id], onDelete: SetNull)

  @@unique([provider, accountScopeKey, regionId, imageId])
  @@index([provider, accountScopeKey, regionId])
  @@index([sourceSnapshotId])
}
```

- [ ] **Step 4: Add the SQL migration**

Create `packages/database/prisma/migrations/20260706_add_platform_image_assets/migration.sql` with explicit SQL.

```sql
CREATE TABLE "PlatformImageAsset" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'alibaba_cloud',
  "accountUid" TEXT,
  "accountScopeKey" TEXT NOT NULL,
  "regionId" TEXT NOT NULL,
  "sourceScope" TEXT NOT NULL,
  "sourceSnapshotId" TEXT,
  "imageId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformImageAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformImageAsset_provider_accountScopeKey_regionId_imageId_key"
ON "PlatformImageAsset"("provider", "accountScopeKey", "regionId", "imageId");

CREATE INDEX "PlatformImageAsset_provider_accountScopeKey_regionId_idx"
ON "PlatformImageAsset"("provider", "accountScopeKey", "regionId");

CREATE INDEX "PlatformImageAsset_sourceSnapshotId_idx"
ON "PlatformImageAsset"("sourceSnapshotId");

ALTER TABLE "PlatformImageAsset"
ADD CONSTRAINT "PlatformImageAsset_sourceSnapshotId_fkey"
FOREIGN KEY ("sourceSnapshotId") REFERENCES "CloudImageSnapshot"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 5: Re-run the persistence test to confirm the failure moves to repository methods**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api && pnpm test -- admin-image-catalog.e2e-spec.ts
```

Expected: FAIL because the repository contracts and implementations still lack platform-asset methods.

- [ ] **Step 6: Commit the schema work**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260706_add_platform_image_assets/migration.sql apps/api/test/admin-image-catalog.e2e-spec.ts
git commit -m "feat: add platform image asset persistence model"
```

## Task 2: Extend Repository Contracts for Platform Assets

**Files:**
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Test: `apps/api/test/admin-image-catalog.e2e-spec.ts`

- [ ] **Step 1: Add failing repository contract coverage**

Extend the backend tests so they expect these repository operations:

```ts
const renamed = await repository.updatePlatformImageAsset(asset.id, {
  displayName: 'Ubuntu 24.04 LTS',
});

await repository.setPlatformImageAssetEnabled(asset.id, false);
await repository.deletePlatformImageAsset(asset.id);

const remainingAssets = await repository.listPlatformImageAssets({
  accountScopeKey: 'aliyun::1234567890',
  regionId: 'cn-hangzhou',
});

expect(remainingAssets).toHaveLength(0);
```

- [ ] **Step 2: Run the test to verify repository APIs are missing**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api && pnpm test -- admin-image-catalog.e2e-spec.ts
```

Expected: FAIL with TypeScript/runtime errors around missing platform-asset repository methods.

- [ ] **Step 3: Extend repository types in `admin.repository.ts`**

Add explicit record and input/filter types plus interface methods.

```ts
export type PlatformImageAssetRecord = {
  id: string;
  provider: CloudProvider;
  accountUid: string | null;
  accountScopeKey: string;
  regionId: string;
  sourceScope: CloudImageScope;
  sourceSnapshotId: string | null;
  imageId: string;
  displayName: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CollectPlatformImageAssetInput = {
  snapshotId: string;
  displayName: string;
};

export type ListPlatformImageAssetsFilter = {
  provider?: CloudProvider;
  accountUid?: string | null;
  accountScopeKey?: string;
  regionId?: string;
  enabled?: boolean;
};
```

And add methods such as:

```ts
listPlatformImageAssets(filter?: ListPlatformImageAssetsFilter): Promise<PlatformImageAssetRecord[]>;
collectPlatformImageAsset(input: CollectPlatformImageAssetInput): Promise<PlatformImageAssetRecord>;
updatePlatformImageAsset(id: string, input: { displayName: string }): Promise<PlatformImageAssetRecord>;
setPlatformImageAssetEnabled(id: string, enabled: boolean): Promise<PlatformImageAssetRecord>;
deletePlatformImageAsset(id: string): Promise<void>;
deletePlatformImageAssetsBySnapshotId(snapshotId: string): Promise<number>;
```

- [ ] **Step 4: Implement Prisma repository methods**

In `apps/api/src/database/prisma-admin.repository.ts`, add the Prisma-backed implementations. Use `upsert` for collection so recollecting the same image updates the display name instead of duplicating rows.

```ts
async collectPlatformImageAsset(input: CollectPlatformImageAssetInput) {
  const snapshot = await this.prisma.cloudImageSnapshot.findUniqueOrThrow({
    where: { id: input.snapshotId },
  });

  return this.prisma.platformImageAsset.upsert({
    where: {
      provider_accountScopeKey_regionId_imageId: {
        provider: snapshot.provider,
        accountScopeKey: snapshot.accountScopeKey,
        regionId: snapshot.regionId,
        imageId: snapshot.imageId,
      },
    },
    update: {
      displayName: input.displayName,
      enabled: true,
      sourceScope: snapshot.scope,
      sourceSnapshotId: snapshot.id,
      accountUid: snapshot.accountUid,
    },
    create: {
      provider: snapshot.provider,
      accountUid: snapshot.accountUid,
      accountScopeKey: snapshot.accountScopeKey,
      regionId: snapshot.regionId,
      sourceScope: snapshot.scope,
      sourceSnapshotId: snapshot.id,
      imageId: snapshot.imageId,
      displayName: input.displayName,
      enabled: true,
    },
  });
}
```

- [ ] **Step 5: Implement the memory repository methods**

Mirror the same methods inside `apps/api/test/support/create-memory-admin-repository.ts` so the e2e-style tests still run in memory.

```ts
async setPlatformImageAssetEnabled(id: string, enabled: boolean) {
  const asset = platformImageAssets.find((item) => item.id === id);
  if (!asset) {
    throw new Error(`Platform image asset not found: ${id}`);
  }

  asset.enabled = enabled;
  asset.updatedAt = new Date();
  return { ...asset };
}
```

- [ ] **Step 6: Re-run the repository tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api && pnpm test -- admin-image-catalog.e2e-spec.ts
```

Expected: PASS for repository-level platform-asset cases, while API-level cases still fail because controllers/services are not wired.

- [ ] **Step 7: Commit the repository work**

```bash
git add apps/api/src/admin/admin.repository.ts apps/api/src/database/prisma-admin.repository.ts apps/api/test/support/create-memory-admin-repository.ts apps/api/test/admin-image-catalog.e2e-spec.ts
git commit -m "feat: add platform image asset repository operations"
```

## Task 3: Add Platform Image Backend APIs and Custom Image Deletion Sync

**Files:**
- Create: `apps/api/src/admin/platform-images.controller.ts`
- Create: `apps/api/src/admin/dto/platform-image.dto.ts`
- Modify: `apps/api/src/admin/image-catalog.service.ts`
- Modify: `apps/api/src/admin/image-catalog.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/admin-image-catalog.e2e-spec.ts`

- [ ] **Step 1: Add failing API tests for platform image endpoints**

Add backend tests for the new REST surface.

```ts
it('lists platform image assets for the configured account and region', async () => {
  await repository.collectPlatformImageAsset({
    snapshotId: publicSnapshot.id,
    displayName: 'Ubuntu 24.04',
  });

  const response = await request(app.getHttpServer())
    .get('/admin/platform-images')
    .set('Authorization', `Bearer ${adminToken}`)
    .expect(200);

  expect(response.body.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ displayName: 'Ubuntu 24.04', enabled: true }),
    ]),
  );
});

it('removes platform assets when deleting a custom image from Aliyun', async () => {
  const asset = await repository.collectPlatformImageAsset({
    snapshotId: customSnapshot.id,
    displayName: 'My Custom Ubuntu',
  });

  await request(app.getHttpServer())
    .delete(`/admin/image-catalog/custom/${customSnapshot.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .expect(204);

  const assets = await repository.listPlatformImageAssets({ accountScopeKey: customSnapshot.accountScopeKey });
  expect(assets.find((item) => item.id === asset.id)).toBeUndefined();
});
```

- [ ] **Step 2: Run the backend image catalog suite and confirm failure**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api && pnpm test -- admin-image-catalog.e2e-spec.ts
```

Expected: FAIL because `/admin/platform-images` and custom-image deletion are not implemented.

- [ ] **Step 3: Add DTOs and controller endpoints**

Create `apps/api/src/admin/dto/platform-image.dto.ts`.

```ts
export class CollectPlatformImageDto {
  @IsString()
  snapshotId!: string;

  @IsString()
  displayName!: string;
}

export class UpdatePlatformImageDto {
  @IsString()
  displayName!: string;
}
```

Create `apps/api/src/admin/platform-images.controller.ts` with endpoints:

```ts
@Controller('admin/platform-images')
@UseGuards(AdminAuthGuard)
export class PlatformImagesController {
  constructor(private readonly imageCatalogService: ImageCatalogService) {}

  @Get()
  list() {
    return this.imageCatalogService.listPlatformAssets();
  }

  @Post()
  collect(@Body() body: CollectPlatformImageDto) {
    return this.imageCatalogService.collectPlatformAsset(body.snapshotId, body.displayName);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() body: UpdatePlatformImageDto) {
    return this.imageCatalogService.renamePlatformAsset(id, body.displayName);
  }

  @Post(':id/enable')
  enable(@Param('id') id: string) {
    return this.imageCatalogService.setPlatformAssetEnabled(id, true);
  }

  @Post(':id/disable')
  disable(@Param('id') id: string) {
    return this.imageCatalogService.setPlatformAssetEnabled(id, false);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    await this.imageCatalogService.removePlatformAsset(id);
  }
}
```

- [ ] **Step 4: Extend `ImageCatalogService` for platform assets and custom deletion**

Add service methods that use the saved default cloud config to scope account and region.

```ts
async listPlatformAssets() {
  const scope = await this.resolveRuntimeScope();
  const items = await this.repository.listPlatformImageAssets({
    provider: 'alibaba_cloud',
    accountScopeKey: scope.accountScopeKey,
    regionId: scope.regionId,
  });

  return { items };
}

async deleteCustomSnapshot(snapshotId: string) {
  const snapshot = await this.requireCustomSnapshot(snapshotId);
  await this.deleteAliyunImage(snapshot.imageId);
  await this.repository.deletePlatformImageAssetsBySnapshotId(snapshot.id);
  await this.repository.upsertCloudImageSnapshot({
    ...snapshot,
    isAvailable: false,
  });
}
```

Also rename existing `collectFromSnapshot()` behavior internally to `collectPlatformAsset()` so the terminology matches the spec.

- [ ] **Step 5: Expose custom-image deletion in `image-catalog.controller.ts`**

Add a controller method:

```ts
@Delete('custom/:snapshotId')
@HttpCode(204)
async deleteCustomImage(@Param('snapshotId') snapshotId: string) {
  await this.imageCatalogService.deleteCustomSnapshot(snapshotId);
}
```

- [ ] **Step 6: Register the new controller in `AppModule`**

Update `apps/api/src/app.module.ts` so `PlatformImagesController` is listed beside the existing admin controllers.

```ts
controllers: [
  AppController,
  AdminSessionController,
  ScenariosController,
  RangesController,
  ProvisionJobsController,
  SystemConfigController,
  ImageCatalogController,
  PlatformImagesController,
],
```

- [ ] **Step 7: Run the backend image-catalog suite again**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api && pnpm test -- admin-image-catalog.e2e-spec.ts
```

Expected: PASS for platform-image APIs and custom deletion sync.

- [ ] **Step 8: Commit the backend API work**

```bash
git add apps/api/src/admin/platform-images.controller.ts apps/api/src/admin/dto/platform-image.dto.ts apps/api/src/admin/image-catalog.service.ts apps/api/src/admin/image-catalog.controller.ts apps/api/src/app.module.ts apps/api/test/admin-image-catalog.e2e-spec.ts
git commit -m "feat: add platform image admin APIs"
```

## Task 4: Add Frontend Platform Image Types and API Calls

**Files:**
- Modify: `apps/web/lib/admin-types.ts`
- Modify: `apps/web/lib/admin-api.ts`
- Test: `apps/web/components/admin/image-center-screen.test.tsx`

- [ ] **Step 1: Add failing frontend tests for three-tab data loading**

Extend `apps/web/components/admin/image-center-screen.test.tsx` so the screen expects a dedicated platform-assets request in addition to public/custom requests.

```tsx
expect(fetchPlatformImagesMock).toHaveBeenCalledTimes(1);
expect(fetchCustomImageCatalogScopeMock).toHaveBeenCalledTimes(1);
expect(fetchPublicImageCatalogScopeMock).toHaveBeenCalledTimes(1);
expect(screen.getByRole('button', { name: '平台收录镜像' })).toBeInTheDocument();
```

- [ ] **Step 2: Run the focused frontend test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web && pnpm test -- image-center-screen.test.tsx
```

Expected: FAIL because there is no platform-image API in the frontend layer.

- [ ] **Step 3: Add platform-image frontend types**

In `apps/web/lib/admin-types.ts`, add the platform-asset payload shapes.

```ts
export type PlatformImageAsset = {
  id: string;
  provider: 'alibaba_cloud';
  accountUid?: string | null;
  accountScopeKey: string;
  regionId: string;
  sourceScope: 'public' | 'custom';
  sourceSnapshotId?: string | null;
  imageId: string;
  displayName: string;
  enabled: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type PlatformImageAssetListPayload = {
  items: PlatformImageAsset[];
};
```

- [ ] **Step 4: Add frontend API helpers**

In `apps/web/lib/admin-api.ts`, add a dedicated platform-image client set.

```ts
export async function fetchPlatformImages(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-images`, {
    headers: createAdminHeaders(token),
  });

  return readJson<PlatformImageAssetListPayload>(response);
}

export async function collectPlatformImage(apiBaseUrl: string, token: string, payload: CollectImageCatalogItemInput) {
  const response = await fetch(`${apiBaseUrl}/admin/platform-images`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<PlatformImageAsset>(response);
}
```

Add matching helpers for rename, enable, disable, remove, and delete custom cloud image.

- [ ] **Step 5: Re-run the frontend test**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web && pnpm test -- image-center-screen.test.tsx
```

Expected: FAIL shifts into the screen component because the UI still renders the old two-list layout.

- [ ] **Step 6: Commit the frontend contract layer**

```bash
git add apps/web/lib/admin-types.ts apps/web/lib/admin-api.ts apps/web/components/admin/image-center-screen.test.tsx
git commit -m "feat: add frontend platform image API contracts"
```

## Task 5: Rebuild Image Center into Three Tabs with Real Pagination and Actions

**Files:**
- Modify: `apps/web/components/admin/image-center-screen.tsx`
- Modify: `apps/web/components/admin/image-center-screen.test.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/components/admin/image-center-screen.test.tsx`

- [ ] **Step 1: Add failing UI tests for tab order, actions, and pagination**

Add tests that lock the target behavior.

```tsx
it('renders tabs in platform/custom/public order', async () => {
  render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

  const tabs = await screen.findAllByRole('button', { pressed: /true|false/ as any });
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    '平台收录镜像',
    '阿里云自定义镜像',
    '阿里云公共镜像',
  ]);
});

it('supports renaming and disabling a platform image asset', async () => {
  render(<ImageCenterScreen apiBaseUrl="http://localhost:3001" />);

  await user.click(await screen.findByRole('button', { name: '平台收录镜像' }));
  await user.click(screen.getByRole('button', { name: /编辑镜像名/i }));
  await user.type(screen.getByLabelText('镜像名'), 'Ubuntu 24.04 LTS');
  await user.click(screen.getByRole('button', { name: '保存' }));

  expect(renamePlatformImageMock).toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '停用' }));
  expect(disablePlatformImageMock).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused frontend test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web && pnpm test -- image-center-screen.test.tsx
```

Expected: FAIL because the current screen still renders stacked public/custom lists with no tab model or real pagination.

- [ ] **Step 3: Refactor `ImageCenterScreen` state around three tab payloads**

Rework the component so it loads three data sources on session-ready and renders one active tab at a time.

```tsx
type ImageCenterTabKey = 'platform' | 'custom' | 'public';

const tabOrder: Array<{ key: ImageCenterTabKey; label: string }> = [
  { key: 'platform', label: '平台收录镜像' },
  { key: 'custom', label: '阿里云自定义镜像' },
  { key: 'public', label: '阿里云公共镜像' },
];

const [activeTab, setActiveTab] = useState<ImageCenterTabKey>('platform');
const [platformAssets, setPlatformAssets] = useState<PlatformImageAsset[]>([]);
const [customScope, setCustomScope] = useState<ImageCatalogScopePayload | null>(null);
const [publicScope, setPublicScope] = useState<ImageCatalogScopePayload | null>(null);
```

- [ ] **Step 4: Implement real client-side pagination shared by all three tabs**

Add a small local pagination helper so the pagination controls actually slice data.

```ts
function paginateItems<T>(items: T[], page: number, pageSize: number) {
  const total = items.length;
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), maxPage);
  const start = (safePage - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    total,
    page: safePage,
    maxPage,
  };
}
```

Use page-size options such as `20`, `50`, `100` to match the requested UI direction.

- [ ] **Step 5: Add platform-asset row actions and custom-image delete action**

Wire the new API helpers into the screen:

```tsx
async function handleDeleteCustomSnapshot(snapshot: ImageSnapshot) {
  await deleteCustomImageSnapshot(apiBaseUrl, session.token!, snapshot.id);
  setCustomScope((previous) => removeSnapshot(previous, snapshot.id));
  setPlatformAssets((previous) => previous.filter((item) => item.sourceSnapshotId !== snapshot.id));
}

async function handleTogglePlatformAsset(asset: PlatformImageAsset) {
  const next = asset.enabled
    ? await disablePlatformImage(apiBaseUrl, session.token!, asset.id)
    : await enablePlatformImage(apiBaseUrl, session.token!, asset.id);
  setPlatformAssets((previous) => previous.map((item) => (item.id === next.id ? next : item)));
}
```

- [ ] **Step 6: Update styles to match the existing admin list language**

Add CSS in `apps/web/app/globals.css` for the new tab row, pagination, and inline edit controls while keeping the visual language aligned with `靶场实例`.

```css
.image-center-tabs {
  display: inline-flex;
  gap: 8px;
  padding: 4px;
  border: 1px solid var(--admin-border-subtle);
  border-radius: 999px;
  background: var(--admin-surface-soft);
}

.image-center-pagination {
  display: flex;
  align-items: center;
  gap: 10px;
}
```

- [ ] **Step 7: Re-run the image center frontend suite**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web && pnpm test -- image-center-screen.test.tsx
```

Expected: PASS for the three-tab structure, actions, and pagination behavior.

- [ ] **Step 8: Commit the image center UI work**

```bash
git add apps/web/components/admin/image-center-screen.tsx apps/web/components/admin/image-center-screen.test.tsx apps/web/app/globals.css
git commit -m "feat: rebuild image center around platform assets"
```

## Task 6: Switch Template Editor to Platform Image Assets Only

**Files:**
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- Modify: `apps/web/components/admin/template-editor/template-property-panel.tsx`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- Modify: `apps/web/components/admin/template-editor/template-property-panel.test.tsx`

- [ ] **Step 1: Add failing editor tests for the new image source**

Extend the template-editor tests so the editor fetches platform images and no longer merges public/custom catalog items.

```tsx
expect(fetchPlatformImagesMock).toHaveBeenCalledTimes(1);
expect(fetchPublicImageCatalogScopeMock).not.toHaveBeenCalled();
expect(fetchCustomImageCatalogScopeMock).not.toHaveBeenCalled();

expect(screen.getByRole('combobox', { name: '镜像' })).toHaveTextContent('Ubuntu 24.04 LTS');
```

- [ ] **Step 2: Run the targeted editor tests and verify they fail**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web && pnpm test -- template-editor-screen.test.tsx template-property-panel.test.tsx
```

Expected: FAIL because the editor still fetches and merges public/custom `catalogItems`.

- [ ] **Step 3: Change `TemplateEditorScreen` to load platform assets only**

Replace the current dual-scope catalog fetch with a single platform-assets fetch.

```tsx
const [platformImageAssets, setPlatformImageAssets] = useState<PlatformImageAsset[]>([]);

const platformImageOptions = useMemo(
  () => platformImageAssets.filter((item) => item.enabled),
  [platformImageAssets],
);

const nextPlatformAssets = await fetchPlatformImages(apiBaseUrl, session.token);
setPlatformImageAssets(nextPlatformAssets.items);
```

- [ ] **Step 4: Update `TemplatePropertyPanel` to use platform asset metadata**

Change the panel prop and option rendering so it relies on `PlatformImageAsset` instead of `ImageCatalogItem`.

```tsx
type TemplatePropertyPanelProps = {
  imageCatalogItems?: PlatformImageAsset[];
  // ...
};

function resolveImageOptions(imageCatalogItems: PlatformImageAsset[], selectedNode: EcsTemplateNode) {
  return imageCatalogItems.map((item) => ({
    id: item.id,
    displayName: item.displayName,
    imageId: item.imageId,
  }));
}
```

Persist the selected `platformImageAssetId` together with `imageId` and `imageName` into the node data.

- [ ] **Step 5: Re-run the editor tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web && pnpm test -- template-editor-screen.test.tsx template-property-panel.test.tsx
```

Expected: PASS with the editor consuming only platform-collected images.

- [ ] **Step 6: Commit the editor integration**

```bash
git add apps/web/components/admin/template-editor/template-editor-screen.tsx apps/web/components/admin/template-editor/template-property-panel.tsx apps/web/components/admin/template-editor/template-editor-screen.test.tsx apps/web/components/admin/template-editor/template-property-panel.test.tsx
git commit -m "feat: source editor images from platform assets"
```

## Task 7: Container Verification and Deployment Snapshot Refresh

**Files:**
- Modify if needed: `deploy/current-system/README.md`
- Modify if needed: `deploy/current-system/docker-compose.yml`

- [ ] **Step 1: Run backend and frontend test suites locally before container rebuild**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api && pnpm test -- admin-image-catalog.e2e-spec.ts
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web && pnpm test -- image-center-screen.test.tsx template-editor-screen.test.tsx template-property-panel.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Rebuild the required containers**

Run from the repository root:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
COMPOSE_BAKE=false docker compose build web api provisioner-worker
```

Expected: all three images build successfully.

- [ ] **Step 3: Start the updated container stack**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
docker compose up -d web api provisioner-worker
```

Expected: `docker compose ps` shows all three services healthy/running.

- [ ] **Step 4: Run container-state smoke verification**

Verify the main user flows against the containerized app at `http://127.0.0.1:3000`:

```text
1. 打开 /admin/image-center
2. 验证 tab 顺序：平台收录镜像 -> 阿里云自定义镜像 -> 阿里云公共镜像
3. 验证分页控件可切页、可改页大小、可跳页
4. 验证平台收录镜像支持编辑名、启用/停用、删除出目录
5. 验证自定义镜像支持收录、删除云端镜像，并联动移除平台资产
6. 打开 /admin/scenarios/[scenarioId]
7. 验证 ECS 镜像下拉只展示启用的平台收录镜像
```

Expected: all UI behaviors match the spec in container state.

- [ ] **Step 5: Refresh deployment snapshot files if behavior or env notes changed**

If new env expectations or operational notes were introduced, update `deploy/current-system/README.md` and copy any changed compose hints into the deployment snapshot.

```md
- 镜像中心现在分为 3 个 tab：平台收录镜像、阿里云自定义镜像、阿里云公共镜像
- 平台镜像资产按阿里云账号和默认地域隔离
```

- [ ] **Step 6: Commit the verification and deploy snapshot updates**

```bash
git add deploy/current-system/README.md deploy/current-system/docker-compose.yml
git commit -m "docs: refresh deployment notes for platform image assets"
```

## Self-Review

### Spec coverage

- Three tabs in fixed order: covered by Task 5
- Platform asset layer replacing old directory semantics: covered by Tasks 1-3
- Editor consumes platform-collected images only: covered by Task 6
- Custom images scoped to default region: covered by Task 3 service scoping and Task 5 UI wiring
- Delete custom image and sync-remove platform assets: covered by Task 3 and Task 5
- Real pagination in image center: covered by Task 5

### Placeholder scan

- No `TODO` / `TBD` placeholders remain
- Every code-changing step includes concrete code or a concrete file-level change
- Every verification step includes an exact command or manual smoke checklist

### Type consistency

- New persistent model: `PlatformImageAsset`
- Backend record type: `PlatformImageAssetRecord`
- Frontend payload type: `PlatformImageAsset`
- REST base path: `/admin/platform-images`
