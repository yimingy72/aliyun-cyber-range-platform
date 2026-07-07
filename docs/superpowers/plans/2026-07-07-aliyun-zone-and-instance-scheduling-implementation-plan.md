# Alibaba Cloud Zone And Instance Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mixed zone scheduling for instance creation so the platform stays inside `defaultRegion`, tries `defaultZoneId` first, falls back to other zones in the same region when needed, and prefers economy-family ECS SKUs with price as a secondary sort key.

**Architecture:** Keep the existing “template compile -> range launch -> OpenTofu workspace render” chain, but move zone selection into the provisioning layer before `range.auto.tfvars.json` is written. Reuse the current Aliyun RPC signing path, generate per-host candidate SKUs from `CPU/内存`, evaluate zone feasibility for the whole topology, and write the chosen zone plus resolved host instance types into OpenTofu variables and resource summary outputs.

**Tech Stack:** NestJS 11, Prisma/PostgreSQL, OpenTofu 1.12.x, Alibaba Cloud ECS OpenAPI, Jest, Vitest, Next.js 15

---

## File Structure

### Backend scheduling and RPC

- Create: [apps/api/src/provisioning/aliyun-zone-instance-scheduler.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/aliyun-zone-instance-scheduler.ts)
  - Owns zone discovery, feasibility scoring, price-based ranking, and final `zone + hostInstanceTypes` selection.
- Modify: [apps/api/src/provisioning/open-tofu-range-provisioner.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/open-tofu-range-provisioner.ts)
  - Replaces single-zone/single-preference selection with scheduler integration.
- Modify: [apps/api/src/provisioning/provisioning.types.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/provisioning.types.ts)
  - Adds typed scheduling diagnostics on `resourceSummary`.

### Shared instance-type candidates

- Modify: [packages/scenario-runtime/src/instance-type-catalog.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/scenario-runtime/src/instance-type-catalog.ts)
- Modify: [apps/web/lib/instance-type-catalog.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/lib/instance-type-catalog.ts)
- Modify: [apps/api/src/provisioning/instance-type-catalog.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/instance-type-catalog.ts)
  - Convert “one fixed SKU per size” into “economy-first candidate list per size”, while keeping a convenience helper for “first preferred SKU”.

### Renderer / module outputs

- Modify: [apps/api/src/provisioning/renderers/alibaba-cloud-opentofu-renderer.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/renderers/alibaba-cloud-opentofu-renderer.ts)
  - Writes selected zone and per-host resolved SKUs into variables.
- Modify: [apps/api/src/provisioning/root-wrapper-template.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/root-wrapper-template.ts)
  - Declares any new wrapper variables if needed.
- Modify: [infra/opentofu/modules/alicloud-enterprise-range/outputs.tf](/Users/yym/Documents/阿里云For综合靶场竞赛平台/infra/opentofu/modules/alicloud-enterprise-range/outputs.tf)
  - Surfaces selected zone and scheduling diagnostics.

### Frontend draft normalization / validation

- Modify: [apps/web/components/admin/template-editor/template-editor-screen.tsx](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/components/admin/template-editor/template-editor-screen.tsx)
  - Keeps validated drafts normalized to current `CPU/内存`-derived preferred SKU, instead of stale persisted `instanceType`.
- Modify: [apps/web/components/admin/template-editor/template-editor-screen.test.tsx](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/components/admin/template-editor/template-editor-screen.test.tsx)
  - Covers stale fixed-SKU cleanup and candidate persistence.

### Tests

- Modify: [apps/api/test/open-tofu-range-provisioner.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/open-tofu-range-provisioner.e2e-spec.ts)
- Modify: [apps/api/test/alibaba-cloud-opentofu-renderer.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/alibaba-cloud-opentofu-renderer.e2e-spec.ts)
- Modify: [apps/web/lib/topology-graph-to-scenario-template.test.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/lib/topology-graph-to-scenario-template.test.ts)

---

### Task 1: Lock the scheduling behavior with failing tests

**Files:**
- Modify: [apps/api/test/open-tofu-range-provisioner.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/open-tofu-range-provisioner.e2e-spec.ts)
- Modify: [apps/api/test/alibaba-cloud-opentofu-renderer.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/alibaba-cloud-opentofu-renderer.e2e-spec.ts)
- Modify: [apps/web/components/admin/template-editor/template-editor-screen.test.tsx](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/components/admin/template-editor/template-editor-screen.test.tsx)

- [ ] **Step 1: Add the backend zone fallback test**

Add a new `OpenTofuRangeProvisioner` test proving the scheduler skips the default zone and chooses a fallback zone that can satisfy *all* hosts:

```ts
it('falls back to the next zone in defaultRegion when defaultZoneId cannot satisfy the full topology', async () => {
  expect(renderedVariables.zone_id).toBe('cn-hangzhou-i');
  expect(renderedVariables.hosts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: 'ecs-1', instance_type: 'ecs.e-c1m1.large' }),
      expect.objectContaining({ key: 'ecs-2', instance_type: 'ecs.e-c1m2.xlarge' }),
    ]),
  );
});
```

- [ ] **Step 2: Add the backend price tie-break test**

Add a scheduler-level or provisioner-level test proving that when two fallback zones can create the full topology, the lower total estimated ECS price wins:

```ts
it('ranks feasible fallback zones by estimated total topology price', async () => {
  expect(result.selectedZoneId).toBe('cn-hangzhou-j');
  expect(result.attemptedZones).toEqual(['cn-hangzhou-h', 'cn-hangzhou-i', 'cn-hangzhou-j']);
});
```

- [ ] **Step 3: Add the frontend stale-instance-type rewrite test**

Keep the existing stale fixed-SKU regression, but make the expected result economy-first:

```ts
expect(latestPayload?.compiledProvisionSpec?.runtimeSelections?.instanceTypePolicies).toEqual(
  expect.objectContaining({
    'ecs-1-instance-type-policy': expect.objectContaining({
      mode: 'fixed',
      instanceType: 'ecs.e-c1m1.large',
    }),
  }),
);
```

- [ ] **Step 4: Run the focused tests and verify they fail**

Run:

```bash
apps/web/node_modules/.bin/vitest run --environment jsdom apps/web/components/admin/template-editor/template-editor-screen.test.tsx -t "stale"
pnpm --filter @aliyun-cyber-range/api exec jest --runInBand apps/api/test/open-tofu-range-provisioner.e2e-spec.ts -t "falls back|ranks feasible"
```

Expected:
- frontend stale-SKU test fails if candidate priority still points to old SKU
- backend scheduler tests fail because no fallback ranking exists yet

- [ ] **Step 5: Commit the red tests**

```bash
git add apps/api/test/open-tofu-range-provisioner.e2e-spec.ts apps/api/test/alibaba-cloud-opentofu-renderer.e2e-spec.ts apps/web/components/admin/template-editor/template-editor-screen.test.tsx
git commit -m "test: cover zone fallback and economy-first instance scheduling"
```

### Task 2: Add economy-first candidate generation

**Files:**
- Modify: [packages/scenario-runtime/src/instance-type-catalog.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/scenario-runtime/src/instance-type-catalog.ts)
- Modify: [apps/web/lib/instance-type-catalog.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/lib/instance-type-catalog.ts)
- Modify: [apps/api/src/provisioning/instance-type-catalog.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/instance-type-catalog.ts)
- Modify: [apps/web/lib/topology-graph-to-scenario-template.test.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/lib/topology-graph-to-scenario-template.test.ts)

- [ ] **Step 1: Replace single-SKU mappings with ordered candidate lists**

Introduce a candidate-based catalog shape:

```ts
export type InstanceTypeCandidateCatalogEntry = {
  cpu: number;
  memory: number;
  preferredInstanceTypes: string[];
};

export const INSTANCE_TYPE_CANDIDATE_CATALOG = [
  { cpu: 2, memory: 2, preferredInstanceTypes: ['ecs.e-c1m1.large', 'ecs.u1-c1m1.large', 'ecs.t6-c1m1.large'] },
  { cpu: 4, memory: 8, preferredInstanceTypes: ['ecs.e-c1m2.xlarge'] },
  { cpu: 8, memory: 16, preferredInstanceTypes: ['ecs.e-c1m2.2xlarge'] },
];
```

- [ ] **Step 2: Keep a compatibility helper for “first preferred SKU”**

Preserve the old call sites with a small compatibility function:

```ts
export function resolveFixedInstanceType(cpu?: number, memory?: number) {
  return resolvePreferredInstanceTypes(cpu, memory)[0] ?? null;
}

export function resolvePreferredInstanceTypes(cpu?: number, memory?: number) {
  return INSTANCE_TYPE_CANDIDATE_CATALOG.find((entry) => entry.cpu === cpu && entry.memory === memory)?.preferredInstanceTypes ?? [];
}
```

- [ ] **Step 3: Update runtime-spec tests to expect economy-first defaults**

Adjust tests that currently hardcode `u1/c7` defaults so `2C2G` now resolves to `ecs.e-c1m1.large`, `4C8G` to `ecs.e-c1m2.xlarge`, and `8C16G` to `ecs.e-c1m2.2xlarge`.

- [ ] **Step 4: Run the catalog and scenario-template tests**

Run:

```bash
pnpm --filter @aliyun-cyber-range/api exec jest --runInBand apps/api/test/open-tofu-range-provisioner.e2e-spec.ts -t "instance types"
apps/web/node_modules/.bin/vitest run apps/web/lib/topology-graph-to-scenario-template.test.ts
```

Expected: all candidate-mapping tests pass with economy-family-first ordering.

- [ ] **Step 5: Commit the catalog change**

```bash
git add packages/scenario-runtime/src/instance-type-catalog.ts apps/web/lib/instance-type-catalog.ts apps/api/src/provisioning/instance-type-catalog.ts apps/web/lib/topology-graph-to-scenario-template.test.ts
git commit -m "feat: add economy-first instance type candidate catalog"
```

### Task 3: Implement zone discovery, feasibility checks, and price-based ranking

**Files:**
- Create: [apps/api/src/provisioning/aliyun-zone-instance-scheduler.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/aliyun-zone-instance-scheduler.ts)
- Modify: [apps/api/src/provisioning/open-tofu-range-provisioner.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/open-tofu-range-provisioner.ts)
- Modify: [apps/api/test/open-tofu-range-provisioner.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/open-tofu-range-provisioner.e2e-spec.ts)

- [ ] **Step 1: Add a scheduler module that works inside one region**

Create a focused scheduler with a single entrypoint:

```ts
export async function selectZoneAndHostInstanceTypes(input: {
  regionId: string;
  defaultZoneId: string;
  hostRequests: Array<{ hostKey: string; cpu?: number; memoryGiB?: number; preferredInstanceTypes: string[] }>;
  account: { accessKeyId: string; accessKeySecret: string };
}): Promise<{
  selectedZoneId: string;
  hostInstanceTypes: Record<string, string>;
  attemptedZones: Array<{ zoneId: string; canCreateAllHosts: boolean; estimatedTotalPrice: number | null; reason?: string }>;
}>;
```

- [ ] **Step 2: Implement the fast path**

The scheduler must try `defaultZoneId` first:

```ts
const orderedZones = [defaultZoneId, ...fallbackZoneIds.filter((zoneId) => zoneId !== defaultZoneId)];
```

Rules:
- if `defaultZoneId` can satisfy all ECS, return immediately
- do not call price sorting when the fast path succeeds

- [ ] **Step 3: Implement dynamic zone discovery for fallback only**

Use Aliyun `DescribeZones` only after the default zone fails:

```ts
const zones = await describeRegionZones({ accessKeyId, accessKeySecret, regionId });
const fallbackZoneIds = zones.filter((zone) => zone.zoneId !== defaultZoneId && zone.available).map((zone) => zone.zoneId);
```

- [ ] **Step 4: Implement whole-topology feasibility and price ranking**

For each candidate zone:

```ts
for (const host of hostRequests) {
  const saleableTypes = await describeSaleableInstanceTypes({ regionId, zoneId, ... });
  const pricedCandidates = await describePrices({ regionId, zoneId, instanceTypeIds: saleableTypes });
}
```

Rules:
- zone is feasible only if every host gets at least one saleable X86 on-demand candidate
- total zone price is the sum of each host’s selected candidate price
- feasible zones sort before infeasible zones
- among feasible zones, lower `estimatedTotalPrice` wins

- [ ] **Step 5: Wire the scheduler into `OpenTofuRangeProvisioner`**

Replace single-zone host resolution with:

```ts
const schedulingDecision = await selectZoneAndHostInstanceTypes(...);
const zoneId = schedulingDecision.selectedZoneId;
const hostInstanceTypes = schedulingDecision.hostInstanceTypes;
```

Do not change `region`; always keep `runtimeConfig.defaultRegion`.

- [ ] **Step 6: Run the backend scheduler tests**

Run:

```bash
pnpm --filter @aliyun-cyber-range/api exec jest --runInBand apps/api/test/open-tofu-range-provisioner.e2e-spec.ts -t "falls back|ranks feasible|instance types"
```

Expected: all fallback and ranking tests pass.

- [ ] **Step 7: Commit the scheduler**

```bash
git add apps/api/src/provisioning/aliyun-zone-instance-scheduler.ts apps/api/src/provisioning/open-tofu-range-provisioner.ts apps/api/test/open-tofu-range-provisioner.e2e-spec.ts
git commit -m "feat: add single-region zone fallback scheduler"
```

### Task 4: Surface scheduling decisions in OpenTofu variables and outputs

**Files:**
- Modify: [apps/api/src/provisioning/renderers/alibaba-cloud-opentofu-renderer.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/renderers/alibaba-cloud-opentofu-renderer.ts)
- Modify: [apps/api/src/provisioning/provisioning.types.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/provisioning.types.ts)
- Modify: [infra/opentofu/modules/alicloud-enterprise-range/outputs.tf](/Users/yym/Documents/阿里云For综合靶场竞赛平台/infra/opentofu/modules/alicloud-enterprise-range/outputs.tf)
- Modify: [apps/api/test/alibaba-cloud-opentofu-renderer.e2e-spec.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/alibaba-cloud-opentofu-renderer.e2e-spec.ts)

- [ ] **Step 1: Extend rendered variables with scheduling diagnostics**

Add fields:

```ts
selected_zone_id: string;
attempted_zones: Array<{
  zone_id: string;
  can_create_all_hosts: boolean;
  estimated_total_price: number | null;
  reason?: string;
}>;
```

- [ ] **Step 2: Include the selected zone in resource summary outputs**

Update the module output:

```tf
selected_zone_id = var.zone_id
attempted_zones  = var.runtime_selections.zone_selection.attempted_zones
```

- [ ] **Step 3: Extend the API-side `resourceSummary` type**

Add typed fields:

```ts
selectedZoneId?: string | null;
attemptedZones?: Array<{ zoneId: string; canCreateAllHosts: boolean; estimatedTotalPrice: number | null; reason?: string }> | null;
```

- [ ] **Step 4: Run renderer/output tests**

Run:

```bash
pnpm --filter @aliyun-cyber-range/api exec jest --runInBand apps/api/test/alibaba-cloud-opentofu-renderer.e2e-spec.ts
```

Expected: rendered variables and resource summary include selected zone and attempt metadata.

- [ ] **Step 5: Commit the diagnostics fields**

```bash
git add apps/api/src/provisioning/renderers/alibaba-cloud-opentofu-renderer.ts apps/api/src/provisioning/provisioning.types.ts infra/opentofu/modules/alicloud-enterprise-range/outputs.tf apps/api/test/alibaba-cloud-opentofu-renderer.e2e-spec.ts
git commit -m "feat: expose zone scheduling diagnostics in provisioning outputs"
```

### Task 5: Normalize validated drafts and update operator-facing validation behavior

**Files:**
- Modify: [apps/web/components/admin/template-editor/template-editor-screen.tsx](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/components/admin/template-editor/template-editor-screen.tsx)
- Modify: [apps/web/components/admin/template-editor/template-editor-screen.test.tsx](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/components/admin/template-editor/template-editor-screen.test.tsx)
- Modify: [apps/web/lib/admin-types.ts](/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/lib/admin-types.ts)

- [ ] **Step 1: Normalize ECS nodes before validated draft persistence**

Keep the current draft-save behavior, but normalize ECS nodes for validated saves:

```ts
const normalizedNodes = currentNodes.map((node) =>
  node.kind === 'ecs'
    ? { ...node, ...applyFixedInstanceType(node, { preserveExisting: true }) }
    : node,
);
```

Rules:
- if `CPU/内存` maps to a known candidate head, use that value
- do not preserve stale fixed `instanceType` when current size implies a different economy-first default

- [ ] **Step 2: Keep availability feedback as a warning, not a hard block**

Do not block editing on `instanceTypeAvailability.warning`; keep it as operator feedback only. The actual enforcement remains in backend scheduling.

- [ ] **Step 3: Run full frontend editor tests**

Run:

```bash
apps/web/node_modules/.bin/vitest run --environment jsdom apps/web/components/admin/template-editor/template-editor-screen.test.tsx
```

Expected: all 46 tests pass, including stale-instance-type normalization.

- [ ] **Step 4: Commit the frontend normalization**

```bash
git add apps/web/components/admin/template-editor/template-editor-screen.tsx apps/web/components/admin/template-editor/template-editor-screen.test.tsx apps/web/lib/admin-types.ts
git commit -m "fix: normalize stale ecs instance types before validated save"
```

### Task 6: Container rebuild and end-to-end verification

**Files:**
- Modify: none
- Verify: container images and running services only

- [ ] **Step 1: Rebuild API and Web containers**

Run:

```bash
COMPOSE_BAKE=false docker compose up -d --build api web
```

Expected:
- `for-api-1` becomes healthy
- `for-web-1` becomes running

- [ ] **Step 2: Verify the production images contain the economy-first mapping**

Run:

```bash
docker compose exec -T api node -e "const m=require('/app/apps/api/dist/provisioning/instance-type-catalog.js'); console.log(m.resolveFixedInstanceType(2,2))"
docker compose exec -T web sh -lc "grep -R 'ecs.e-c1m1.large' -n /app/apps/web/.next/static/chunks | head"
```

Expected:
- API prints `ecs.e-c1m1.large`
- Web bundle contains `ecs.e-c1m1.large`

- [ ] **Step 3: Verify current-region exact availability endpoint**

Run:

```bash
curl -s -H 'Authorization: Bearer dev-admin-token' 'http://127.0.0.1:3001/admin/system-config/instance-type-availability?cpu=2&memory=2'
```

Expected: JSON with `exactAvailable: true` and at least one `e/u1/t6` X86 match.

- [ ] **Step 4: Run one controlled smoke verification against a draft like `test3`**

Use a template whose ECS node is set to `2C2G`, then:

```bash
# trigger topology validation in UI first
# create one instance through the platform
# inspect the resulting range.auto.tfvars.json / resource summary
```

Expected:
- selected `zone` is in `defaultRegion`
- all hosts use one zone
- `2C2G` host resolves to the economy-first candidate or the next available fallback

- [ ] **Step 5: Commit verification-only metadata if needed, otherwise stop cleanly**

If no source files changed during verification, do not create a commit.
If source changes were required during verification, commit with:

```bash
git add <exact files>
git commit -m "fix: finalize Aliyun zone and instance scheduling rollout"
```

---

## Self-Review

### Spec coverage

- `defaultRegion` fixed: covered by Tasks 3 and 6
- `defaultZoneId` fast path: covered by Task 3
- fallback zone discovery within one region: covered by Task 3
- `canCreateAllHosts` first, price second: covered by Task 3
- economy-family-first SKU selection: covered by Tasks 1, 2, and 3
- single-zone instance guarantee: covered by Tasks 3 and 6
- retryable fallback on create-time failure: covered by Task 3 and Task 6 smoke verification
- observability of zone choices and failure reasons: covered by Task 4

### Placeholder scan

- No `TODO`/`TBD`
- Every task has exact file paths
- Every task has exact commands
- Code-changing steps include explicit code snippets

### Type consistency

- Shared candidate vocabulary uses:
  - `preferredInstanceTypes`
  - `fixedInstanceType`
  - `selectedZoneId`
  - `attemptedZones`
- Frontend and backend both continue using `instanceType` / `instanceTypeStrategy`
- Output fields consistently use `selectedZoneId` / `attemptedZones`

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-07-aliyun-zone-and-instance-scheduling-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
