# Admin Billing And Cost Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only `账单费用` module that shows platform-wide and per-user Alibaba Cloud bill totals from real cloud billing data, enforces full attribution for tagged platform-created resources, records unmatched bill lines as anomalies, and supports CSV / Excel export without counting unrelated account spend.

**Architecture:** Keep Alibaba Cloud as the source of monetary truth and add a local billing attribution layer in PostgreSQL. Every platform-created billable resource gets a stable billing tag set plus a local billing ledger row; a lightweight billing sync service periodically pulls BSS OpenAPI bill lines, matches them against the ledger, stores normalized snapshots, and surfaces anomalies when a line cannot be attributed. Admin UI reads only normalized local tables, not raw cloud bill responses. No new scheduler dependency is needed; a small NestJS service can reuse `setInterval` / `OnModuleInit` for periodic sync and expose manual resync endpoints for controlled backfills.

**Tech Stack:** NestJS 11, Prisma/PostgreSQL, existing Aliyun RPC signing helpers, React/Next.js App Router admin UI, Vitest/Jest, Docker Compose, OpenTofu modules, Alibaba Cloud BSS OpenAPI.

## Current bill inventory (used to scope v1)

The current account's read-only bill inspection already shows these real charge families in scope:

- `ecs`: `云服务器配置`, `系统盘`, `流出流量`
- `eip`: `公网IP保有费`, `公网流出流量`
- `nat_gw`: `网关类型（实例费）`
- `snapshot`: `快照链容量`
- `oss`: `标准存储（同城冗余）容量`, `外网流出流量` (observed in the shared account, but excluded from v1 until the platform has an isolated OSS ownership boundary)

This means v1 cannot stop at ECS + disk + EIP + NAT; it must also plan for snapshot-chain storage. OSS is not in the v1 must-have path right now because the current platform does not clearly own a dedicated OSS bucket/prefix boundary.

---

## File Structure

### Persistence and repository

- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260716_add_billing_attribution_tables/migration.sql`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Create: `apps/api/test/create-memory-admin-repository.billing.spec.ts`

Responsibility:
- Add billing ledger tables, normalized bill line storage, anomaly storage, and repository contracts for ledger writes, bill-line upserts, export reads, and anomaly queries.

### Billing backend

- Create: `apps/api/src/admin/billing-tagging.ts`
- Create: `apps/api/src/admin/billing-classifier.ts`
- Create: `apps/api/src/admin/billing-bss-client.ts`
- Create: `apps/api/src/admin/billing-sync.service.ts`
- Create: `apps/api/src/admin/billing.service.ts`
- Create: `apps/api/src/admin/billing.controller.ts`
- Create: `apps/api/src/admin/dto/billing.dto.ts`
- Create: `apps/api/test/billing-sync.spec.ts`
- Create: `apps/api/test/admin-billing.e2e-spec.ts`
- Modify: `apps/api/src/app.module.ts`

Responsibility:
- Pull bill lines from Alibaba Cloud, classify them, match them to local ledger rows, store normalized snapshots, expose admin summary/list/detail/export APIs, and run periodic/manual sync.

### Resource tagging and ledger hooks

- Modify: `apps/api/src/provisioning/open-tofu-range-provisioner.ts`
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`
- Modify: `apps/api/src/provisioning/provisioning.types.ts`
- Modify: `apps/api/src/admin/single-instance-batch-execution.service.ts`
- Modify: `apps/api/src/admin/single-instances.service.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Modify: `apps/api/src/admin/range-instance-node-actions.service.ts`
- Modify: `apps/api/src/admin/image-catalog.service.ts`
- Modify: `infra/opentofu/modules/alicloud-enterprise-range/main.tf`
- Modify: `infra/opentofu/modules/alicloud-enterprise-range/variables.tf`
- Modify: `infra/opentofu/modules/alicloud-vpc-single-ecs/main.tf`
- Modify: `infra/opentofu/modules/alicloud-vpc-single-ecs/variables.tf`
- Modify: `infra/opentofu/modules/alicloud-single-instance-network/main.tf`
- Modify: `infra/opentofu/modules/alicloud-single-instance-network/variables.tf`

Responsibility:
- Ensure platform-created ECS / disk / EIP / NAT resources and image-pack flows carry consistent billing tags and write local billing ledger rows with `billingStartAt`, `billingScope`, owner, and business linkage.

### Admin UI and exports

- Modify: `apps/web/components/admin/admin-workspace-shell.tsx`
- Modify: `apps/web/components/admin/admin-workspace-shell.test.tsx`
- Create: `apps/web/app/admin/billing/page.tsx`
- Create: `apps/web/components/admin/billing-screen.tsx`
- Create: `apps/web/components/admin/billing-screen.test.tsx`
- Modify: `apps/web/lib/admin-types.ts`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/app/globals.css`

Responsibility:
- Add the admin-only navigation entry, time-range filters, platform summary, user list, user detail, anomaly views, and export actions.

### Container and smoke validation

- Modify: `docker-compose.yml`
- Modify: project Dockerfiles or image build inputs as needed by touched services
- Create or modify targeted container test scripts under `scripts/` if needed

Responsibility:
- Rebuild touched images and validate backend, frontend, worker, and sync behavior in Docker before delivery.

---

## Task 1: Add billing persistence tables and repository contracts

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260716_add_billing_attribution_tables/migration.sql`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Create: `apps/api/test/create-memory-admin-repository.billing.spec.ts`

- [ ] **Step 1: Write the failing repository contract test**

Create `apps/api/test/create-memory-admin-repository.billing.spec.ts`:

```ts
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('createMemoryAdminRepository billing extensions', () => {
  it('stores ledger resources, normalized bill lines, and anomalies', async () => {
    const repository = createMemoryAdminRepository();

    const ledger = await repository.createBillingLedgerResource({
      cloudProvider: 'alibaba_cloud',
      cloudAccountUid: '1672470067548805',
      regionId: 'cn-hangzhou',
      cloudResourceId: 'i-test-1',
      cloudResourceType: 'ecs',
      billingScope: 'user',
      ownerUserId: 'user-1',
      rangeInstanceId: 'range-1',
      billingStartAt: new Date('2026-07-16T00:00:00.000Z'),
      tagsSnapshot: { CreatedBy: 'cyber-range-platform' },
    });

    await repository.upsertBillingLineItems([
      {
        syncBatchId: 'sync-1',
        billCycle: '2026-07',
        billingDate: '2026-07-16',
        productCode: 'ecs',
        productDetail: '云服务器ECS-按量付费',
        billItem: '云服务器配置',
        cloudResourceId: 'i-test-1',
        cloudResourceType: 'ecs',
        pretaxAmount: 0.12,
        currency: 'CNY',
        billingScope: 'user',
        ownerUserId: 'user-1',
        matchedLedgerId: ledger.id,
        rawPayload: { InstanceID: 'i-test-1' },
      },
    ]);

    await repository.createBillingAnomaly({
      syncBatchId: 'sync-1',
      billCycle: '2026-07',
      billingDate: '2026-07-16',
      cloudResourceId: 'cn-hangzhou',
      cloudResourceType: 'snapshot-region',
      pretaxAmount: 0.88,
      reason: 'missing aggregation rule',
      rawPayload: { ProductCode: 'snapshot' },
    });

    expect(await repository.listBillingLedgerResources()).toHaveLength(1);
    expect(await repository.listBillingLineItems({ startAt: '2026-07-16', endAt: '2026-07-16' })).toHaveLength(1);
    expect(await repository.listBillingAnomalies({ startAt: '2026-07-16', endAt: '2026-07-16' })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the repository contract test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- create-memory-admin-repository.billing.spec.ts
```

Expected: FAIL because the billing repository methods and new models do not exist yet.

- [ ] **Step 3: Add Prisma billing models and migration**

Extend `packages/database/prisma/schema.prisma` with:

- `BillingLedgerResource`
- `BillingLineItem`
- `BillingAnomaly`
- small enums for:
  - `BillingScope` (`user`, `platform`)
  - `BillingLedgerResourceType` (start with `ecs`, `disk`, `eip`, `nat_gateway`, `snat_entry`, `dnat_entry`, `image`, `snapshot`, `snapshot_region`, `oss_bucket`, `oss_prefix`, `unknown`)

Key constraints:

- Unique ledger key on `cloudProvider + cloudAccountUid + regionId + cloudResourceId + cloudResourceType`
- `billingScope=user` requires `ownerUserId`
- `matchedLedgerId` is nullable on `BillingLineItem` so unmatched lines can stay in anomalies only
- `BillingLineItem` uniqueness should prevent duplicate rows on resync, for example via `(syncSourceFingerprint)` or a stable composite built from bill-cycle/date/product/item/resource`

Migration must:

- create the three tables
- create useful indexes for `billingDate`, `ownerUserId`, `billingScope`, and `cloudResourceId`
- leave existing tables untouched beyond new foreign keys if needed

- [ ] **Step 4: Implement repository contracts in `admin.repository.ts` and `prisma-admin.repository.ts`**

Add:

- ledger create/upsert/update-release methods
- normalized bill line upsert/list methods
- summary aggregation queries
- anomaly create/list methods
- export-friendly read methods

Mirror the same behavior in `create-memory-admin-repository.ts` so service tests stay cheap.

---

## Task 2: Add a reusable billing tag builder and hook it into resource creation flows

**Files:**
- Create: `apps/api/src/admin/billing-tagging.ts`
- Modify: `apps/api/src/provisioning/open-tofu-range-provisioner.ts`
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`
- Modify: `apps/api/src/provisioning/provisioning.types.ts`
- Modify: `apps/api/src/admin/single-instance-batch-execution.service.ts`
- Modify: `apps/api/src/admin/single-instances.service.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Modify: `apps/api/src/admin/range-instance-node-actions.service.ts`
- Modify: `apps/api/src/admin/image-catalog.service.ts`
- Modify: `infra/opentofu/modules/alicloud-enterprise-range/main.tf`
- Modify: `infra/opentofu/modules/alicloud-enterprise-range/variables.tf`
- Modify: `infra/opentofu/modules/alicloud-vpc-single-ecs/main.tf`
- Modify: `infra/opentofu/modules/alicloud-vpc-single-ecs/variables.tf`
- Modify: `infra/opentofu/modules/alicloud-single-instance-network/main.tf`
- Modify: `infra/opentofu/modules/alicloud-single-instance-network/variables.tf`

- [ ] **Step 1: Write the failing billing tag builder test**

Create a focused unit test for `buildBillingTags(...)`:

```ts
it('builds stable billing tags for user-owned resources', () => {
  expect(
    buildBillingTags({
      billingScope: 'user',
      ownerUserId: 'user-1',
      rangeInstanceId: 'range-1',
      billingStartAt: '2026-07-16',
    }),
  ).toEqual({
    CreatedBy: 'cyber-range-platform',
    PlatformScope: 'user',
    PlatformUserId: 'user-1',
    RangeInstanceId: 'range-1',
    BillingStartAt: '2026-07-16',
  });
});
```

- [ ] **Step 2: Run the new unit test and verify it fails**

Run only the new billing-tagging test.

- [ ] **Step 3: Implement `billing-tagging.ts`**

The helper should:

- centralize required tag keys
- omit empty optional business IDs
- expose a stable `billingStartAt` string
- return both a cloud-tag map and a DB-ready `tagsSnapshot`

- [ ] **Step 4: Thread billing tags through OpenTofu-backed resource creation**

Update the OpenTofu path so `common_tags` merge in the billing tags for:

- VPC/switch/security group resources where they are bill-relevant
- ECS instances
- EIP / NAT / SNAT / DNAT

Do not introduce new abstraction layers in Terraform beyond passing one `billing_tags` variable into the existing modules and merging it with `local.common_tags`.

- [ ] **Step 5: Record ledger rows after successful creation**

Use the existing `resourceSummary` IDs to create ledger rows for:

- `ecs`
- `eip`
- `nat_gateway`
- `snat_entry`
- `dnat_entry`
- `disk` when the bill is identifiable through the instance/system disk path

Prefer one shared helper in the worker or service layer over sprinkling ad hoc inserts at every caller.

- [ ] **Step 6: Hook image-pack flows into the ledger**

`pack-image` and custom image creation/removal must:

- tag created images where the API supports it or preserve a local snapshot/image ledger row otherwise
- create ledger rows for `image` and `snapshot`
- set `releasedAt` when images/snapshots are deleted by the platform

---

## Task 3: Add bill classification and sync services around Alibaba Cloud BSS OpenAPI

**Files:**
- Create: `apps/api/src/admin/billing-classifier.ts`
- Create: `apps/api/src/admin/billing-bss-client.ts`
- Create: `apps/api/src/admin/billing-sync.service.ts`
- Create: `apps/api/test/billing-sync.spec.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Write the failing sync classification test**

Create a unit test that proves:

- `ecs` instance config lines match a direct ledger row
- `snapshot` `快照链容量` lines with only region-level identifiers fall into aggregation handling
- if OSS is later brought into scope, `oss` capacity/egress lines either match a configured OSS ledger boundary or become anomalies

Example shape:

```ts
it('classifies direct, aggregated, and unmatched bill lines correctly', async () => {
  const result = classifyBillLine({
    ProductCode: 'snapshot',
    BillingItem: '快照链容量',
    InstanceID: 'cn-hangzhou',
  });

  expect(result.kind).toBe('aggregated');
  expect(result.resourceType).toBe('snapshot_region');
});
```

- [ ] **Step 2: Run the sync classification test and verify it fails**

- [ ] **Step 3: Implement `billing-bss-client.ts` using existing signing helpers**

Use the existing RPC signing style instead of adding a new cloud SDK.

The client should:

- call `DescribeInstanceBill` for normalized instance-level detail
- optionally call `QueryBill` when product-level cross-checks help exports or diagnostics
- page through results
- keep raw payloads for later audit/debug

- [ ] **Step 4: Implement `billing-classifier.ts`**

Normalize current real bill families into internal types:

- `ecs`
- `disk`
- `eip`
- `nat_gateway`
- `snapshot_region`
- `oss_bucket` / `oss_prefix`
- `unknown`

Seed this mapping from the bill inventory already observed in the account:

- `云服务器配置`
- `系统盘`
- `流出流量`
- `公网IP保有费`
- `公网流出流量`
- `网关类型（实例费）`
- `快照链容量`
- `标准存储（同城冗余）容量`
- `外网流出流量`

- [ ] **Step 5: Implement `billing-sync.service.ts`**

The service should:

- fetch recent bill lines
- match direct resource IDs to ledger rows
- apply aggregation rules for snapshot-region charges and keep OSS explicitly out of v1 attribution unless a dedicated boundary is introduced
- write normalized bill lines
- write anomalies for unmatched lines
- support:
  - periodic incremental sync for the last 7 days
  - manual admin-triggered resync for the last 30 days

Keep the scheduler minimal:

- implement `OnModuleInit` / `OnModuleDestroy`
- use one interval timer
- guard against overlapping runs with a boolean lock

No new queue or scheduler framework is needed for v1.

---

## Task 4: Add admin billing APIs, exports, and auth coverage

**Files:**
- Create: `apps/api/src/admin/billing.service.ts`
- Create: `apps/api/src/admin/billing.controller.ts`
- Create: `apps/api/src/admin/dto/billing.dto.ts`
- Create: `apps/api/test/admin-billing.e2e-spec.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Write the failing admin billing e2e test**

Cover:

- admin can read `/admin/billing/summary`
- admin can read `/admin/billing/users`
- admin can read `/admin/billing/users/:userId/items`
- admin can download export endpoints
- normal user gets rejected for all billing routes

- [ ] **Step 2: Run the billing e2e test and verify it fails**

- [ ] **Step 3: Implement the controller/service pair**

Endpoints:

- `GET /admin/billing/summary`
- `GET /admin/billing/users`
- `GET /admin/billing/users/:userId`
- `GET /admin/billing/users/:userId/items`
- `GET /admin/billing/anomalies`
- `POST /admin/billing/sync`
- `GET /admin/billing/export/platform.csv`
- `GET /admin/billing/export/users.csv`
- `GET /admin/billing/export/users/:userId.csv`

The service should aggregate from normalized local tables only.

- [ ] **Step 4: Keep exports boring**

Do not build an async export job system in v1.

Return CSV directly from the request path. If Excel is needed in the UI, generate a thin CSV-compatible download first and only add `.xlsx` if the repo already has a clean existing pattern.

---

## Task 5: Add the admin UI, navigation entry, filters, and anomaly views

**Files:**
- Modify: `apps/web/components/admin/admin-workspace-shell.tsx`
- Modify: `apps/web/components/admin/admin-workspace-shell.test.tsx`
- Create: `apps/web/app/admin/billing/page.tsx`
- Create: `apps/web/components/admin/billing-screen.tsx`
- Create: `apps/web/components/admin/billing-screen.test.tsx`
- Modify: `apps/web/lib/admin-types.ts`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Write the failing workspace-shell visibility test**

Add one test that proves:

- `admin` sees `账单费用`
- `user` does not

- [ ] **Step 2: Write the failing billing screen render test**

Cover:

- default recent-30-day filter
- platform summary cards / rows
- user list table
- user detail drawer or detail section
- anomaly banner / anomaly tab
- export buttons

- [ ] **Step 3: Run the UI tests and verify they fail**

- [ ] **Step 4: Extend web contracts**

Add billing DTOs/types and fetch helpers in:

- `apps/web/lib/admin-types.ts`
- `apps/web/lib/admin-api.ts`

- [ ] **Step 5: Implement `billing-screen.tsx`**

Keep the first screen practical:

- top filter bar
- platform totals and type breakdown
- user table
- click-through user detail
- anomaly callout

No charting library is needed if the repo does not already use one; a compact table/list view and small CSS bars are enough for v1.

---

## Task 6: Support aggregation rules for snapshot-region charges, with OSS explicitly deferred

**Files:**
- Modify: `apps/api/src/admin/billing-classifier.ts`
- Modify: `apps/api/src/admin/billing-sync.service.ts`
- Modify: `apps/api/src/admin/billing.service.ts`
- Add targeted tests under `apps/api/test/billing-sync.spec.ts`

- [ ] **Step 1: Write the failing aggregation-rule tests**

Scenarios:

- region-scoped snapshot chain line maps to a platform storage ledger boundary
- if OSS is ever pulled back in, its egress lines must map to a dedicated platform bucket/prefix boundary or stay outside user attribution

- [ ] **Step 2: Run the tests and verify they fail**

- [ ] **Step 3: Implement the narrowest aggregation rules that work**

Rules:

- Direct `cloudResourceId` match always wins
- Snapshot-region lines may map to one platform-level storage boundary if the platform owns the entire chain scope
- OSS remains out of v1 user-cost attribution; if reintroduced later, its lines only map to user costs when the platform can isolate them via bucket/prefix/ledger boundary
- Otherwise:
  - route to `billingScope=platform`, or
  - create an anomaly if even platform attribution is unsafe

Do not implement heuristic user splitting in v1.

---

## Task 7: Container rebuilds, backend/frontend verification, and one controlled cloud check

**Files:**
- Modify any touched Docker build inputs
- Use existing compose services and smoke scripts

- [ ] **Step 1: Rebuild touched images**

After backend/frontend/worker/OpenTofu changes, rebuild the relevant Docker images instead of relying on local dev processes.

- [ ] **Step 2: Run focused container tests**

At minimum:

- backend tests for repository + billing sync + e2e auth
- frontend tests for nav visibility + billing screen
- any worker/provisioning tests changed by tagging hooks

- [ ] **Step 3: Verify the module in Docker**

Bring up the updated stack with Docker Compose and verify:

- admin nav contains `账单费用`
- user nav does not
- billing endpoints return normalized local results
- manual sync endpoint can run without overlapping another sync

- [ ] **Step 4: Run one controlled Alibaba Cloud smoke check if needed**

Within the repo's allowed scope:

- use the configured shared Alibaba Cloud account only for a non-destructive read-oriented validation, or
- if a temporary resource is required to verify tagging propagation, create only the smallest necessary temporary resource and destroy it immediately after the check

The smoke check must not leave persistent resources behind.

---

## Task 8: Final pass and documentation alignment

**Files:**
- Modify implementation notes or README snippets only if the final behavior changed user-facing operations

- [ ] **Step 1: Confirm the implementation still matches the approved design**

Check:

- admin-only visibility
- tagged/ledger-based attribution boundary
- support for the bill families already seen in the account (`ecs`, `eip`, `nat_gw`, `snapshot`, `oss`)
- no accidental inclusion of unrelated account spend

- [ ] **Step 2: Update docs only where behavior materially changed**

Keep edits minimal and local to the billing feature.

- [ ] **Step 3: Capture any deliberate shortcuts with `ponytail:` comments**

Examples:

- `// ponytail: snapshot-region aggregation assumes one platform-owned chain boundary per region; split per project if this stops holding`
- `// ponytail: CSV export only; add xlsx when finance consumers actually need native spreadsheets`

---

## Test focus

- Repository coverage for billing ledger / bill lines / anomalies
- Sync classification and anomaly handling
- Aggregation rules for snapshot-region charges
- Admin auth on all billing routes
- Navigation visibility by role
- Billing screen rendering and export actions
- Worker / provisioning regression around added tagging hooks
- Docker-based verification of backend + frontend + sync behavior
