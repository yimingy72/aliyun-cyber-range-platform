# Template Deletion And Failed Instance Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce template deletion only when all linked instances are `destroyed`, preserve destroyed-instance history after template deletion via snapshots, and add direct deletion for `create_failed` instances.

**Architecture:** Extend `RangeInstance` with template snapshot fields and nullable `templateId`, then route template deletion through a backend rule that blocks non-destroyed references and snapshots destroyed-history records before deleting the template. Add a dedicated instance delete endpoint for `create_failed` records and surface both behaviors in the admin UI.

**Tech Stack:** NestJS, Prisma/PostgreSQL, Next.js, Vitest, Jest, Docker Compose

---

### Task 1: Add History Snapshot Fields To Range Instances

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260703015000_preserve_destroyed_instance_template_snapshots/migration.sql`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/web/lib/admin-types.ts`

- [ ] **Step 1: Add nullable template relation and snapshot fields in Prisma schema**

Add these fields to `RangeInstance` in `packages/database/prisma/schema.prisma`:

```prisma
model RangeInstance {
  id                         String              @id @default(cuid())
  name                       String
  templateId                 String?
  sourceTemplateVersionId    String?
  templateNameSnapshot       String?
  templateSlugSnapshot       String?
  templateVersionSnapshot    String?
  templateModulePathSnapshot String?
  status                     RangeInstanceStatus @default(draft)
  allocatedCidr              String?
  cloudProvider              CloudProvider       @default(alibaba_cloud)
  accessEntry                Json?
  resourceSummary            Json?
  errorSummary               String?             @db.Text
  expiresAt                  DateTime?
  lastJobId                  String?             @unique
  createdAt                  DateTime            @default(now())
  updatedAt                  DateTime            @updatedAt
  template                   RangeTemplate?      @relation(fields: [templateId], references: [id], onDelete: SetNull)
  jobs                       ProvisionJob[]
  lastJob                    ProvisionJob?       @relation("RangeInstanceLastJob", fields: [lastJobId], references: [id], onDelete: SetNull)

  @@index([templateId])
  @@index([sourceTemplateVersionId])
  @@index([status])
}
```

- [ ] **Step 2: Add the matching SQL migration**

Create `packages/database/prisma/migrations/20260703015000_preserve_destroyed_instance_template_snapshots/migration.sql`:

```sql
ALTER TABLE "RangeInstance"
ADD COLUMN "templateNameSnapshot" TEXT,
ADD COLUMN "templateSlugSnapshot" TEXT,
ADD COLUMN "templateVersionSnapshot" TEXT,
ADD COLUMN "templateModulePathSnapshot" TEXT;

ALTER TABLE "RangeInstance"
ALTER COLUMN "templateId" DROP NOT NULL;

ALTER TABLE "RangeInstance"
DROP CONSTRAINT "RangeInstance_templateId_fkey";

ALTER TABLE "RangeInstance"
ADD CONSTRAINT "RangeInstance_templateId_fkey"
FOREIGN KEY ("templateId") REFERENCES "RangeTemplate"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
```

- [ ] **Step 3: Mirror the new fields in backend repository types**

Update `apps/api/src/admin/admin.repository.ts` so `RangeInstanceRecord` includes:

```ts
templateId: string | null;
templateNameSnapshot: string | null;
templateSlugSnapshot: string | null;
templateVersionSnapshot: string | null;
templateModulePathSnapshot: string | null;
```

- [ ] **Step 4: Mirror the new fields in web API types**

Update `apps/web/lib/admin-types.ts` so `RangeInstance` / `RangeInstanceDetail` support:

```ts
templateId?: string | null;
templateNameSnapshot?: string | null;
templateSlugSnapshot?: string | null;
templateVersionSnapshot?: string | null;
templateModulePathSnapshot?: string | null;
```

- [ ] **Step 5: Validate Prisma schema**

Run:

```bash
./packages/database/node_modules/.bin/prisma validate --schema packages/database/prisma/schema.prisma
```

Expected: `The schema ... is valid`

- [ ] **Step 6: Commit**

```bash
git add packages/database/prisma/schema.prisma \
  packages/database/prisma/migrations/20260703015000_preserve_destroyed_instance_template_snapshots/migration.sql \
  apps/api/src/admin/admin.repository.ts \
  apps/web/lib/admin-types.ts
git commit -m "feat: add template snapshots to range instances"
```

### Task 2: Enforce Template Deletion Rules In Backend

**Files:**
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/src/admin/range-templates.service.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Modify: `apps/api/test/admin-resources.e2e-spec.ts`

- [ ] **Step 1: Add repository methods for snapshotting and deleting failed instances**

Extend `AdminRepository` in `apps/api/src/admin/admin.repository.ts`:

```ts
snapshotDestroyedRangeInstancesForTemplate(input: {
  templateId: string;
  templateName: string;
  templateSlug: string;
  templateVersion: string;
  templateModulePath: string;
}): Promise<void>;

deleteRangeInstance(id: string): Promise<void>;
```

- [ ] **Step 2: Implement destroyed-instance snapshotting in Prisma repository**

Add to `apps/api/src/database/prisma-admin.repository.ts`:

```ts
async snapshotDestroyedRangeInstancesForTemplate(input: {
  templateId: string;
  templateName: string;
  templateSlug: string;
  templateVersion: string;
  templateModulePath: string;
}): Promise<void> {
  await this.prisma.rangeInstance.updateMany({
    where: {
      templateId: input.templateId,
      status: 'destroyed',
    },
    data: {
      templateId: null,
      templateNameSnapshot: input.templateName,
      templateSlugSnapshot: input.templateSlug,
      templateVersionSnapshot: input.templateVersion,
      templateModulePathSnapshot: input.templateModulePath,
    },
  });
}

async deleteRangeInstance(id: string): Promise<void> {
  await this.prisma.rangeInstance.delete({
    where: { id },
  });
}
```

- [ ] **Step 3: Implement the same behavior in the memory repository**

Update `apps/api/test/support/create-memory-admin-repository.ts` so destroyed instances can be snapshotted and individual failed instances removed from in-memory `rangeInstances`.

- [ ] **Step 4: Rewrite template delete service rule**

Update `apps/api/src/admin/range-templates.service.ts` `delete(id)` to:

```ts
const linkedInstances = (await this.adminRepository.listRangeInstances()).filter(
  (instance) => instance.templateId === id,
);
const blockingInstances = linkedInstances.filter((instance) => instance.status !== 'destroyed');

if (blockingInstances.length > 0) {
  throw new ConflictException('Range template cannot be deleted while non-destroyed instances still reference it');
}

if (linkedInstances.length > 0) {
  await this.adminRepository.snapshotDestroyedRangeInstancesForTemplate({
    templateId: id,
    templateName: existingTemplate.name,
    templateSlug: existingTemplate.slug,
    templateVersion: existingTemplate.version,
    templateModulePath: existingTemplate.modulePathOrRef,
  });
}

await this.adminRepository.deleteRangeTemplate(id);
```

- [ ] **Step 5: Keep the foreign-key fallback guard**

Retain the existing `P2003 -> ConflictException` translation in `RangeTemplatesService.delete()` so race conditions still return `409`, not `500`.

- [ ] **Step 6: Add backend tests for both delete branches**

Update `apps/api/test/admin-resources.e2e-spec.ts` with these assertions:

```ts
it('deletes templates that are referenced only by destroyed instances', async () => {
  // expect 204
  // expect history instance remains listable with snapshot fields
});

it('rejects deleting templates that are still referenced by non-destroyed instances', async () => {
  // expect 409
  // expect error message contains non-destroyed reference warning
});
```

- [ ] **Step 7: Run the focused API tests**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/admin-resources.e2e-spec.ts --runInBand
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/admin/admin.repository.ts \
  apps/api/src/database/prisma-admin.repository.ts \
  apps/api/src/admin/range-templates.service.ts \
  apps/api/test/support/create-memory-admin-repository.ts \
  apps/api/test/admin-resources.e2e-spec.ts
git commit -m "feat: enforce template deletion snapshot rules"
```

### Task 3: Add Create-Failed Instance Deletion Endpoint

**Files:**
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Modify: `apps/api/src/admin/ranges.controller.ts`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Modify: `apps/api/test/admin-resources.e2e-spec.ts`

- [ ] **Step 1: Add service method for deleting failed instances**

In `apps/api/src/admin/range-instances.service.ts` add:

```ts
async delete(id: string) {
  const instance = await this.adminRepository.getRangeInstanceById(id);

  if (!instance) {
    throw new NotFoundException('Range instance not found');
  }

  if (instance.status !== 'create_failed') {
    throw new ConflictException('Only create_failed instances can be deleted directly');
  }

  await this.adminRepository.deleteRangeInstance(id);
}
```

- [ ] **Step 2: Expose the REST endpoint**

In `apps/api/src/admin/ranges.controller.ts` add:

```ts
import { Delete } from '@nestjs/common';

@Delete(':id')
delete(@Param('id') id: string) {
  return this.rangeInstancesService.delete(id);
}
```

- [ ] **Step 3: Ensure repository delete removes job history transitively**

No extra Prisma code should be needed beyond `deleteRangeInstance(id)` because `ProvisionJob` and `ProvisionJobStepLog` already cascade from `RangeInstance`.

- [ ] **Step 4: Add API tests**

Add to `apps/api/test/admin-resources.e2e-spec.ts`:

```ts
it('deletes create_failed instances', async () => {
  // create failed instance fixture
  // expect DELETE /admin/ranges/:id -> 204
});

it('rejects deleting non-create_failed instances', async () => {
  // running or destroyed fixture
  // expect 409
});
```

- [ ] **Step 5: Run the focused API tests**

Run:

```bash
cd apps/api && ./node_modules/.bin/jest test/admin-resources.e2e-spec.ts --runInBand
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/admin/range-instances.service.ts \
  apps/api/src/admin/ranges.controller.ts \
  apps/api/src/admin/admin.repository.ts \
  apps/api/src/database/prisma-admin.repository.ts \
  apps/api/test/support/create-memory-admin-repository.ts \
  apps/api/test/admin-resources.e2e-spec.ts
git commit -m "feat: add failed instance deletion endpoint"
```

### Task 4: Surface The New Rules In The Frontend

**Files:**
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/components/admin/templates-screen.tsx`
- Modify: `apps/web/components/admin/range-instances-screen.tsx`
- Modify: `apps/web/components/admin/templates-screen.test.tsx`
- Modify: `apps/web/components/admin/range-instances-screen.test.tsx`

- [ ] **Step 1: Add frontend API helper for deleting instances**

Add to `apps/web/lib/admin-api.ts`:

```ts
export async function deleteRangeInstance(apiBaseUrl: string, token: string, id: string) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${id}`, {
    method: 'DELETE',
    headers: createAdminHeaders(token),
  });

  if (!response.ok) {
    throw new AdminApiError(response.status);
  }
}
```

- [ ] **Step 2: Make template delete dialog mention the rule up front**

Update `apps/web/components/admin/templates-screen.tsx` delete dialog copy to state:

```tsx
<p className="template-workbench-confirm-copy">
  如果该模板仍存在未销毁实例，必须先销毁这些实例后才能删除模板；已销毁实例历史会保留。
</p>
```

- [ ] **Step 3: Surface 409 conflict copy cleanly**

In `handleDeleteTemplate`, when `deleteRangeTemplate(...)` throws `AdminApiError` with status `409`, set a targeted message:

```ts
setActionErrorMessage('当前模板仍有关联实例未销毁，必须先销毁这些实例后才能删除模板。');
```

- [ ] **Step 4: Add delete action for create_failed instances**

In `apps/web/components/admin/range-instances-screen.tsx`:

- add `deleteRangeInstance` import
- add helper:

```ts
function canDeleteFailedInstance(instance: ExtendedRangeInstance) {
  return instance.status === 'create_failed';
}
```

- render `删除` button only for `create_failed`
- on click call new API helper
- remove the row from snapshot on success

- [ ] **Step 5: Update row action rendering**

For active list rows, final action logic should be:

```tsx
{actionLabel ? <button>...</button> : null}
{canDeleteFailedInstance(instance) ? <button type="button">删除</button> : null}
```

- [ ] **Step 6: Add frontend tests**

In `apps/web/components/admin/templates-screen.test.tsx`:

```ts
it('shows the non-destroyed instance deletion warning in the delete dialog', async () => {
  // open delete dialog and assert warning copy
});
```

In `apps/web/components/admin/range-instances-screen.test.tsx`:

```ts
it('shows delete for create_failed instances and removes the row after deletion', async () => {
  // mock deleteRangeInstance
  // assert row disappears
});
```

- [ ] **Step 7: Run web tests**

Run:

```bash
cd apps/web && ./node_modules/.bin/vitest run components/admin/templates-screen.test.tsx components/admin/range-instances-screen.test.tsx
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/admin-api.ts \
  apps/web/components/admin/templates-screen.tsx \
  apps/web/components/admin/range-instances-screen.tsx \
  apps/web/components/admin/templates-screen.test.tsx \
  apps/web/components/admin/range-instances-screen.test.tsx
git commit -m "feat: surface template delete rules and failed instance deletion"
```

### Task 5: Container Validation And Runtime Cleanup

**Files:**
- Modify if needed: `.env`
- Verify: `docker-compose.yml`

- [ ] **Step 1: Apply Prisma migration locally if needed before container rebuild**

Run:

```bash
./packages/database/node_modules/.bin/prisma migrate deploy --schema packages/database/prisma/schema.prisma
```

Expected: migration applied or no pending migrations

- [ ] **Step 2: Rebuild API, worker, and web containers**

Run:

```bash
COMPOSE_BAKE=false docker compose up -d --build api provisioner-worker web
```

Expected: all three services recreated successfully

- [ ] **Step 3: Run container-side backend regression**

Run:

```bash
docker exec for-api-1 sh -lc 'cd /app/apps/api && ./node_modules/.bin/jest test/admin-resources.e2e-spec.ts --runInBand'
```

Expected: PASS

- [ ] **Step 4: Spot-check runtime behavior**

Verify via HTTP:

```bash
curl -s http://127.0.0.1:3001/admin/scenarios -H 'Authorization: Bearer dev-admin-token' | jq 'length'
curl -s http://127.0.0.1:3001/admin/ranges -H 'Authorization: Bearer dev-admin-token' | jq 'length'
```

Expected: non-error JSON responses

- [ ] **Step 5: Manually verify from the UI**

Check in browser:

1. Template delete dialog shows the new warning copy
2. Template with non-destroyed instances cannot be deleted
3. `create_failed` instance row shows `删除`
4. Deleting a failed instance removes it from the list

- [ ] **Step 6: Commit**

```bash
git add .env docker-compose.yml
git commit -m "chore: rebuild containers for deletion workflow changes"
```
