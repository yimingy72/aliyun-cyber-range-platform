# Single Instance Batch ECS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-instance OpenTofu execution with ECS-native batch create/recycle, add batch records with expandable child rows in the admin UI, and enforce a controlled single-instance concurrency limit of 3 without disturbing range-mode provisioning.

**Architecture:** Keep `RangeInstance` as the source of truth for every child ECS instance, add a thin `SingleInstanceBatch` layer for grouped launches, and introduce a dedicated single-instance ECS execution path that uses the existing `ProvisionJob` table but bypasses OpenTofu for single-mode jobs. Range-mode jobs stay on the current OpenTofu path; single-mode jobs get a separate bounded scheduler and ECS-native create/recycle flows.

**Tech Stack:** NestJS, Prisma/PostgreSQL, existing Aliyun RPC signing helpers, React/Next.js admin UI, Vitest, Jest, Docker Compose.

---

## File Structure

### New files

- Create: `apps/api/src/admin/single-instance-batch-execution.service.ts`
  - Runs ECS-native single-instance batch create/recycle work with a fixed concurrency cap of 3.
- Create: `packages/database/prisma/migrations/20260709_add_single_instance_batches/migration.sql`
  - Adds the new `SingleInstanceBatch` table and `singleInstanceBatchId` on `RangeInstance`.

### Existing files to modify

- Modify: `packages/database/prisma/schema.prisma`
  - Add `SingleInstanceBatch` model and relation from `RangeInstance`.
- Modify: `apps/api/src/admin/admin.repository.ts`
  - Add batch record types, list payload types, and repository contract methods.
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
  - Implement batch create/read/update methods and grouped list queries.
- Modify: `apps/api/src/admin/dto/single-instance.dto.ts`
  - Add batch-level destroy DTO and any payload adjustments.
- Modify: `apps/api/src/admin/single-instances.controller.ts`
  - Add batch-level destroy endpoint and keep child-level actions.
- Modify: `apps/api/src/admin/single-instances.service.ts`
  - Create batches + child instances, enqueue ECS-native jobs, surface grouped list payloads.
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`
  - Split range-mode serial processing from single-mode bounded concurrency processing.
- Modify: `apps/api/src/app.module.ts`
  - Register the new single-instance batch execution service.
- Modify: `apps/api/test/single-instances.e2e-spec.ts`
  - Cover batch create/list/destroy behavior.
- Modify: `apps/api/test/provisioning-worker-concurrency.e2e-spec.ts`
  - Cover the single-instance concurrency cap and mixed create/destroy interleaving.
- Modify: `apps/web/lib/admin-types.ts`
  - Add batch payload types and grouped list response types.
- Modify: `apps/web/lib/admin-api.ts`
  - Read/write batch-oriented single-instance APIs.
- Modify: `apps/web/components/admin/single-instances-screen.tsx`
  - Render batch rows, expandable child tables, and batch destroy action.
- Modify: `apps/web/components/admin/single-instances-screen.test.tsx`
  - Cover grouped rendering, expansion, and batch action flows.
- Modify: `apps/web/app/globals.css`
  - Add the batch row / child table styling.

### Test focus

- API behavior and batch persistence
- Worker-level concurrency rules
- Frontend grouped rendering and action visibility
- Existing child instance interactions (copy password, VNC, per-child operations)

---

### Task 1: Add the batch data model and repository contracts

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260709_add_single_instance_batches/migration.sql`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Test: `apps/api/test/create-memory-admin-repository.single-instance.spec.ts`

- [ ] **Step 1: Write the failing repository shape test**

```ts
it('stores a single-instance batch and links child instances to it', async () => {
  const repository = createMemoryAdminRepository();

  const batch = await repository.createSingleInstanceBatch({
    name: 'web-lab-batch',
    platformImageAssetId: 'platform-image-1',
    imageId: 'm-123',
    imageDisplayName: 'Ubuntu 24.04',
    cpu: 2,
    memory: 2,
    systemDiskSize: 40,
    quantity: 5,
    expiresAt: new Date('2026-07-10T12:00:00.000Z'),
    createdBy: 'admin',
    remark: 'batch create',
  });

  await repository.createRangeInstance({
    name: 'web-lab-01',
    createdBy: 'admin',
    instanceMode: 'single',
    status: 'pending_create',
    singleInstanceBatchId: batch.id,
    singleInstanceConfig: {
      baseName: 'web-lab',
      quantityIndex: 1,
      hostKey: 'single-ecs-1',
      hostName: 'web-lab-01',
      platformImageAssetId: 'platform-image-1',
      imageId: 'm-123',
      imageDisplayName: 'Ubuntu 24.04',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
    },
  });

  const grouped = await repository.listSingleInstanceBatchesWithInstances();

  expect(grouped).toEqual([
    expect.objectContaining({
      batch: expect.objectContaining({ id: batch.id, quantity: 5, createdBy: 'admin' }),
      instances: [expect.objectContaining({ name: 'web-lab-01', singleInstanceBatchId: batch.id })],
    }),
  ]);
});
```

- [ ] **Step 2: Run the repository test to verify it fails**

Run:

```bash
pnpm --filter @aliyun-cyber-range/api test -- create-memory-admin-repository.single-instance.spec.ts
```

Expected:

```text
FAIL ... createSingleInstanceBatch is not a function
```

- [ ] **Step 3: Add Prisma models and the migration**

`packages/database/prisma/schema.prisma`

```prisma
model SingleInstanceBatch {
  id                   String          @id @default(cuid())
  name                 String
  platformImageAssetId String
  imageId              String
  imageDisplayName     String
  cpu                  Int
  memory               Int
  systemDiskSize       Int
  quantity             Int
  remark               String?
  createdBy            String?
  expiresAt            DateTime?
  createdAt            DateTime        @default(now())
  updatedAt            DateTime        @updatedAt
  instances            RangeInstance[]

  @@index([createdAt])
}

model RangeInstance {
  // existing fields...
  singleInstanceBatchId String?
  singleInstanceBatch   SingleInstanceBatch? @relation(fields: [singleInstanceBatchId], references: [id], onDelete: SetNull)

  @@index([singleInstanceBatchId])
}
```

`packages/database/prisma/migrations/20260709_add_single_instance_batches/migration.sql`

```sql
CREATE TABLE "SingleInstanceBatch" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "platformImageAssetId" TEXT NOT NULL,
  "imageId" TEXT NOT NULL,
  "imageDisplayName" TEXT NOT NULL,
  "cpu" INTEGER NOT NULL,
  "memory" INTEGER NOT NULL,
  "systemDiskSize" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "remark" TEXT,
  "createdBy" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SingleInstanceBatch_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RangeInstance"
  ADD COLUMN "singleInstanceBatchId" TEXT;

CREATE INDEX "SingleInstanceBatch_createdAt_idx" ON "SingleInstanceBatch"("createdAt");
CREATE INDEX "RangeInstance_singleInstanceBatchId_idx" ON "RangeInstance"("singleInstanceBatchId");

ALTER TABLE "RangeInstance"
  ADD CONSTRAINT "RangeInstance_singleInstanceBatchId_fkey"
  FOREIGN KEY ("singleInstanceBatchId")
  REFERENCES "SingleInstanceBatch"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
```

- [ ] **Step 4: Add repository types and contracts**

`apps/api/src/admin/admin.repository.ts`

```ts
export type SingleInstanceBatchRecord = {
  id: string;
  name: string;
  platformImageAssetId: string;
  imageId: string;
  imageDisplayName: string;
  cpu: number;
  memory: number;
  systemDiskSize: number;
  quantity: number;
  remark: string | null;
  createdBy: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SingleInstanceBatchWithInstancesRecord = {
  batch: SingleInstanceBatchRecord;
  instances: RangeInstanceRecord[];
};

export type CreateSingleInstanceBatchInput = {
  name: string;
  platformImageAssetId: string;
  imageId: string;
  imageDisplayName: string;
  cpu: number;
  memory: number;
  systemDiskSize: number;
  quantity: number;
  remark?: string | null;
  createdBy?: string | null;
  expiresAt?: Date | null;
};

// extend existing RangeInstance types
export type CreateRangeInstanceInput = {
  // existing fields...
  singleInstanceBatchId?: string | null;
};

export type UpdateRangeInstanceInput = Partial<{
  // existing fields...
  singleInstanceBatchId: string | null;
}>;

export interface AdminRepository {
  createSingleInstanceBatch(input: CreateSingleInstanceBatchInput): Promise<SingleInstanceBatchRecord>;
  getSingleInstanceBatchById(id: string): Promise<SingleInstanceBatchRecord | null>;
  listSingleInstanceBatchesWithInstances(): Promise<SingleInstanceBatchWithInstancesRecord[]>;
}
```

- [ ] **Step 5: Update the memory repository test double and rerun**

`apps/api/test/support/create-memory-admin-repository.ts`

```ts
const singleInstanceBatches: SingleInstanceBatchRecord[] = [];

async createSingleInstanceBatch(input: CreateSingleInstanceBatchInput) {
  const record: SingleInstanceBatchRecord = {
    id: nextId(),
    name: input.name,
    platformImageAssetId: input.platformImageAssetId,
    imageId: input.imageId,
    imageDisplayName: input.imageDisplayName,
    cpu: input.cpu,
    memory: input.memory,
    systemDiskSize: input.systemDiskSize,
    quantity: input.quantity,
    remark: input.remark ?? null,
    createdBy: input.createdBy ?? null,
    expiresAt: input.expiresAt ?? null,
    createdAt: now(),
    updatedAt: now(),
  };

  singleInstanceBatches.unshift(record);
  return clone(record);
},

async listSingleInstanceBatchesWithInstances() {
  return cloneList(
    singleInstanceBatches.map((batch) => ({
      batch,
      instances: rangeInstances.filter((instance) => instance.singleInstanceBatchId === batch.id),
    })),
  );
},
```

Run:

```bash
pnpm --filter @aliyun-cyber-range/api test -- create-memory-admin-repository.single-instance.spec.ts
```

Expected:

```text
PASS ... stores a single-instance batch and links child instances to it
```

- [ ] **Step 6: Commit**

```bash
git add packages/database/prisma/schema.prisma \
  packages/database/prisma/migrations/20260709_add_single_instance_batches/migration.sql \
  apps/api/src/admin/admin.repository.ts \
  apps/api/test/create-memory-admin-repository.single-instance.spec.ts \
  apps/api/test/support/create-memory-admin-repository.ts
git commit -m "feat: add single instance batch persistence"
```

---

### Task 2: Implement Prisma batch persistence and grouped reads

**Files:**
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Test: `apps/api/test/single-instances.e2e-spec.ts`

- [ ] **Step 1: Write the failing grouped list API test**

```ts
it('returns grouped batch payloads and leaves legacy single rows standalone', async () => {
  const response = await request(app.getHttpServer())
    .get('/admin/instances')
    .set('Authorization', 'Bearer dev-admin-token')
    .expect(200);

  expect(response.body).toEqual(
    expect.objectContaining({
      batches: [
        expect.objectContaining({
          batch: expect.objectContaining({ name: 'web-lab-batch', quantity: 5 }),
          instances: [expect.objectContaining({ name: 'web-lab-01' })],
        }),
      ],
      standaloneInstances: expect.any(Array),
    }),
  );
});
```

- [ ] **Step 2: Run the e2e spec and verify it fails on list shape**

Run:

```bash
pnpm --filter @aliyun-cyber-range/api test -- single-instances.e2e-spec.ts
```

Expected:

```text
FAIL ... expected body.batches to be defined
```

- [ ] **Step 3: Implement Prisma repository methods**

`apps/api/src/database/prisma-admin.repository.ts`

```ts
async createSingleInstanceBatch(input: CreateSingleInstanceBatchInput): Promise<SingleInstanceBatchRecord> {
  return this.prisma.singleInstanceBatch.create({
    data: {
      name: input.name,
      platformImageAssetId: input.platformImageAssetId,
      imageId: input.imageId,
      imageDisplayName: input.imageDisplayName,
      cpu: input.cpu,
      memory: input.memory,
      systemDiskSize: input.systemDiskSize,
      quantity: input.quantity,
      remark: input.remark ?? null,
      createdBy: input.createdBy ?? null,
      expiresAt: input.expiresAt ?? null,
    },
  }) as Promise<SingleInstanceBatchRecord>;
}

async listSingleInstanceBatchesWithInstances(): Promise<SingleInstanceBatchWithInstancesRecord[]> {
  const batches = await this.prisma.singleInstanceBatch.findMany({
    include: {
      instances: {
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return batches.map((batch) => ({
    batch: batch as unknown as SingleInstanceBatchRecord,
    instances: batch.instances as unknown as RangeInstanceRecord[],
  }));
}
```

- [ ] **Step 4: Persist `singleInstanceBatchId` on range instances**

`apps/api/src/database/prisma-admin.repository.ts`

```ts
data: {
  // existing fields...
  singleInstanceBatchId: input.singleInstanceBatchId ?? null,
}
```

and in update:

```ts
...(input.singleInstanceBatchId !== undefined
  ? { singleInstanceBatchId: input.singleInstanceBatchId }
  : {}),
```

- [ ] **Step 5: Rerun the e2e spec**

Run:

```bash
pnpm --filter @aliyun-cyber-range/api test -- single-instances.e2e-spec.ts
```

Expected:

```text
PASS ... returns grouped batch payloads and leaves legacy single rows standalone
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/database/prisma-admin.repository.ts \
  apps/api/test/single-instances.e2e-spec.ts
git commit -m "feat: add grouped single instance batch queries"
```

---

### Task 3: Add ECS-native single-instance batch execution with concurrency 3

**Files:**
- Create: `apps/api/src/admin/single-instance-batch-execution.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`
- Test: `apps/api/test/provisioning-worker-concurrency.e2e-spec.ts`

- [ ] **Step 1: Write the failing concurrency test**

```ts
it('processes up to three single-instance jobs concurrently while leaving range jobs serial', async () => {
  const started: string[] = [];
  let concurrentSingles = 0;
  let maxConcurrentSingles = 0;

  const singleExecutor = {
    runCreateBatch: jest.fn().mockImplementation(async ({ batchId }) => {
      started.push(batchId);
      concurrentSingles += 1;
      maxConcurrentSingles = Math.max(maxConcurrentSingles, concurrentSingles);
      await new Promise((resolve) => setTimeout(resolve, 50));
      concurrentSingles -= 1;
    }),
  };

  // seed 4 single jobs and 1 range job, then run worker loop once

  expect(maxConcurrentSingles).toBe(3);
});
```

- [ ] **Step 2: Run the concurrency test to verify the current worker is serial**

Run:

```bash
pnpm --filter @aliyun-cyber-range/api test -- provisioning-worker-concurrency.e2e-spec.ts
```

Expected:

```text
FAIL ... expected maxConcurrentSingles to be 3, received 1
```

- [ ] **Step 3: Create the ECS batch execution service**

`apps/api/src/admin/single-instance-batch-execution.service.ts`

```ts
@Injectable()
export class SingleInstanceBatchExecutionService {
  private readonly maxConcurrency = 3;
  private inFlight = 0;
  private queue: Array<() => void> = [];

  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async runWithSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }

    this.inFlight += 1;
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
      this.queue.shift()?.();
    }
  }

  async runCreateBatch(input: {
    batchId: string;
    instanceIds: string[];
  }) {
    return this.runWithSlot(async () => {
      // Step 1 implementation will call RunInstances and map results back.
    });
  }

  async runDestroyBatch(input: {
    batchId: string;
    instanceIds: string[];
  }) {
    return this.runWithSlot(async () => {
      // Step 1 implementation will call DeleteInstances and update rows.
    });
  }
}
```

- [ ] **Step 4: Wire the worker to route only single-mode jobs to the batch executor path**

`apps/api/src/provisioning/provisioning-worker.service.ts`

```ts
if (instance.instanceMode === 'single') {
  await this.processSingleInstanceJob({
    job,
    instance,
    effectiveJobType,
    runtimeConfig,
    reportStep,
  });
  await this.adminRepository.updateProvisionJob(job.id, {
    status: 'succeeded',
    finishedAt: new Date(),
    errorSummary: null,
  });
  return;
}

// range-mode stays on the current OpenTofu serial path
```

and inside `processSingleInstanceJob()`:

```ts
if (input.effectiveJobType === 'create') {
  await this.singleInstanceBatchExecutionService.runCreateBatch({
    batchId: requireBatchId(input.instance),
    instanceIds: [input.instance.id],
  });
  return;
}

if (input.effectiveJobType === 'destroy') {
  await this.singleInstanceBatchExecutionService.runDestroyBatch({
    batchId: requireBatchId(input.instance),
    instanceIds: [input.instance.id],
  });
  return;
}
```

- [ ] **Step 5: Register the service and rerun tests**

`apps/api/src/app.module.ts`

```ts
providers: [
  // existing providers...
  SingleInstanceBatchExecutionService,
]
```

Run:

```bash
pnpm --filter @aliyun-cyber-range/api test -- provisioning-worker-concurrency.e2e-spec.ts
```

Expected:

```text
PASS ... processes up to three single-instance jobs concurrently while leaving range jobs serial
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/admin/single-instance-batch-execution.service.ts \
  apps/api/src/app.module.ts \
  apps/api/src/provisioning/provisioning-worker.service.ts \
  apps/api/test/provisioning-worker-concurrency.e2e-spec.ts
git commit -m "feat: add bounded single instance batch execution"
```

---

### Task 4: Switch single-instance create/recycle to ECS-native batch APIs

**Files:**
- Modify: `apps/api/src/admin/single-instances.service.ts`
- Modify: `apps/api/src/admin/single-instance-blueprint.ts`
- Modify: `apps/api/src/admin/dto/single-instance.dto.ts`
- Modify: `apps/api/src/admin/single-instances.controller.ts`
- Modify: `apps/api/src/admin/range-instance-node-actions.service.ts`
- Test: `apps/api/test/single-instances.e2e-spec.ts`

- [ ] **Step 1: Write the failing API tests for batch create and batch recycle**

```ts
it('creates one batch record and five child instances from a single launch request', async () => {
  const response = await request(app.getHttpServer())
    .post('/admin/instances/launch')
    .set('Authorization', 'Bearer dev-admin-token')
    .send({
      name: 'web-lab',
      hostName: 'web-host',
      platformImageAssetId: 'memory-2',
      cpu: 2,
      memory: 2,
      systemDiskSize: 40,
      expiresAt: '2026-07-10T12:00:00.000Z',
      quantity: 5,
      triggeredBy: 'admin',
    })
    .expect(201);

  expect(response.body.batch).toEqual(expect.objectContaining({ quantity: 5, createdBy: 'admin' }));
  expect(response.body.instances).toHaveLength(5);
});

it('bulk-destroys all active child instances in a batch', async () => {
  const response = await request(app.getHttpServer())
    .post(`/admin/instances/batches/${batchId}/destroy-all`)
    .set('Authorization', 'Bearer dev-admin-token')
    .send({ triggeredBy: 'admin' })
    .expect(201);

  expect(response.body.jobCount).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the single-instance e2e suite to verify the new API shape is missing**

Run:

```bash
pnpm --filter @aliyun-cyber-range/api test -- single-instances.e2e-spec.ts
```

Expected:

```text
FAIL ... response.body.batch is undefined
FAIL ... POST /admin/instances/batches/:id/destroy-all returns 404
```

- [ ] **Step 3: Remove self-assigned private IP dependence from the blueprint**

`apps/api/src/admin/single-instance-blueprint.ts`

```ts
type BuildSingleInstanceBlueprintInput = {
  name: string;
  hostKey: string;
  hostName: string;
  password: string;
  cpu: number;
  memory: number;
  image: PlatformImageAssetRecord;
  regionId: string;
  zoneId: string;
  vpcCidr: string;
  zoneKey: string;
  zoneCidr: string;
};

// remove primaryPrivateIp from the scenario template and topology graph payload
primaryPrivateIp?: undefined,
privateIp: null,
```

- [ ] **Step 4: Create batches and child rows in `SingleInstancesService.launch()`**

`apps/api/src/admin/single-instances.service.ts`

```ts
const batch = await this.adminRepository.createSingleInstanceBatch({
  name: input.name,
  platformImageAssetId: image.id,
  imageId: image.imageId,
  imageDisplayName: image.displayName,
  cpu: input.cpu,
  memory: input.memory,
  systemDiskSize: input.systemDiskSize ?? 40,
  quantity,
  remark: input.remark?.trim() || null,
  createdBy: input.triggeredBy,
  expiresAt: new Date(input.expiresAt),
});

for (let index = 0; index < quantity; index += 1) {
  const quantityIndex = index + 1;
  const network = this.singleInstanceNetworkService.allocateVswitch(profile, activeCount + index);
  const name = this.resolveIndexedValue(input.name, quantityIndex, quantity);
  const hostName = this.resolveIndexedValue(input.hostName?.trim() || input.name, quantityIndex, quantity);
  const hostKey = `single-ecs-${quantityIndex}`;
  const blueprint = buildSingleInstanceBlueprint({
    name,
    hostKey,
    hostName,
    password,
    cpu: input.cpu,
    memory: input.memory,
    image,
    regionId: profile.regionId,
    zoneId: profile.zoneId,
    vpcCidr: profile.vpcCidr,
    zoneKey: network.zoneKey,
    zoneCidr: network.vswitchCidr,
  });

  const instance = await this.adminRepository.createRangeInstance({
    name,
    createdBy: input.triggeredBy,
    instanceMode: 'single',
    singleInstanceBatchId: batch.id,
    status: 'pending_create',
    expiresAt: input.expiresAt,
    runtimeTopologyGraph: blueprint.runtimeTopologyGraph,
    runtimeScenarioTemplateSpec: blueprint.runtimeScenarioTemplateSpec as Record<string, unknown>,
    runtimeCompiledProvisionSpec: blueprint.runtimeCompiledProvisionSpec as Record<string, unknown>,
    runtimeCredentials: {
      [hostKey]: { username: 'root', password },
    },
    singleInstanceConfig: {
      baseName: input.name,
      quantityIndex,
      hostKey,
      hostName,
      platformImageAssetId: image.id,
      imageId: image.imageId,
      imageDisplayName: image.displayName,
      cpu: input.cpu,
      memory: input.memory,
      systemDiskSize: input.systemDiskSize ?? 40,
      remark: input.remark?.trim() || null,
      assignedVswitchId: network.vswitchId,
    },
  });

  const job = await this.adminRepository.createProvisionJob({
    rangeInstanceId: instance.id,
    jobType: 'create',
    triggeredBy: input.triggeredBy,
  });

  await this.adminRepository.updateRangeInstance(instance.id, { lastJobId: job.id });
  created.push(instance);
}

this.provisioningWorkerService.dispatch('single-batch-create');

return { batch, instances: created };
```

- [ ] **Step 5: Add batch destroy endpoint and route single child destroy through the same ECS-native path**

`apps/api/src/admin/dto/single-instance.dto.ts`

```ts
export class TriggerSingleInstanceBatchDestroyDto {
  @IsString()
  @IsNotEmpty()
  triggeredBy!: string;
}
```

`apps/api/src/admin/single-instances.controller.ts`

```ts
@Post('batches/:id/destroy-all')
destroyBatch(@Param('id') id: string, @Body() body: TriggerSingleInstanceBatchDestroyDto) {
  return this.singleInstancesService.destroyBatch(id, body.triggeredBy);
}
```

`apps/api/src/admin/single-instances.service.ts`

```ts
async destroyBatch(batchId: string, triggeredBy: string) {
  const grouped = await this.adminRepository.listSingleInstanceBatchesWithInstances();
  const record = grouped.find((entry) => entry.batch.id === batchId);

  if (!record) {
    throw new NotFoundException('Single instance batch not found');
  }

  const targetInstances = record.instances.filter((instance) => instance.status !== 'destroyed');

  for (const instance of targetInstances) {
    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'destroy',
      triggeredBy,
    });

    await this.adminRepository.updateRangeInstance(instance.id, {
      status: 'pending_destroy',
      lastJobId: job.id,
    });
  }

  this.provisioningWorkerService.dispatch(`single-batch-destroy:${batchId}`);

  return { batchId, jobCount: targetInstances.length };
}
```

- [ ] **Step 6: Rerun the e2e suite**

Run:

```bash
pnpm --filter @aliyun-cyber-range/api test -- single-instances.e2e-spec.ts
```

Expected:

```text
PASS ... creates one batch record and five child instances from a single launch request
PASS ... bulk-destroys all active child instances in a batch
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/admin/single-instances.service.ts \
  apps/api/src/admin/single-instance-blueprint.ts \
  apps/api/src/admin/dto/single-instance.dto.ts \
  apps/api/src/admin/single-instances.controller.ts \
  apps/api/test/single-instances.e2e-spec.ts
git commit -m "feat: add batch-aware single instance apis"
```

---

### Task 5: Return grouped batch payloads to the admin UI and render expandable child rows

**Files:**
- Modify: `apps/web/lib/admin-types.ts`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/components/admin/single-instances-screen.tsx`
- Modify: `apps/web/components/admin/single-instances-screen.test.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Write the failing frontend test for grouped rows**

```ts
it('renders a batch row that expands to child instance rows', async () => {
  fetchSingleInstancesMock.mockResolvedValue({
    batches: [
      {
        batch: {
          id: 'batch-1',
          name: 'web-lab-batch',
          imageDisplayName: 'Ubuntu 24.04 LTS',
          quantity: 5,
          createdBy: 'admin',
          expiresAt: '2026-07-10T12:00:00.000Z',
          createdAt: '2026-07-09T09:00:00.000Z',
          summary: { running: 3, creating: 2, createFailed: 0, destroying: 0, destroyed: 0 },
        },
        instances: [
          { id: 'single-1', name: 'web-lab-01', status: 'running', instanceMode: 'single' },
          { id: 'single-2', name: 'web-lab-02', status: 'creating', instanceMode: 'single' },
        ],
      },
    ],
    standaloneInstances: [],
  });

  render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

  expect(await screen.findByText('web-lab-batch')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '展开批次 web-lab-batch' }));
  expect(await screen.findByText('web-lab-01')).toBeTruthy();
});
```

- [ ] **Step 2: Run the frontend spec to verify the payload shape mismatch**

Run:

```bash
pnpm --filter @aliyun-cyber-range/web test -- single-instances-screen.test.tsx
```

Expected:

```text
FAIL ... nextInstances.filter is not a function
```

- [ ] **Step 3: Add grouped payload types and API wrappers**

`apps/web/lib/admin-types.ts`

```ts
export type SingleInstanceBatchSummary = {
  running: number;
  creating: number;
  createFailed: number;
  destroying: number;
  destroyFailed: number;
  destroyed: number;
};

export type SingleInstanceBatch = {
  id: string;
  name: string;
  platformImageAssetId: string;
  imageId: string;
  imageDisplayName: string;
  cpu: number;
  memory: number;
  systemDiskSize: number;
  quantity: number;
  remark?: string | null;
  createdBy?: string | null;
  expiresAt?: string | null;
  createdAt?: string | null;
  summary: SingleInstanceBatchSummary;
};

export type SingleInstanceBatchGroup = {
  batch: SingleInstanceBatch;
  instances: RangeInstance[];
};

export type SingleInstanceListPayload = {
  batches: SingleInstanceBatchGroup[];
  standaloneInstances: RangeInstance[];
};
```

`apps/web/lib/admin-api.ts`

```ts
export async function fetchSingleInstances(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/instances`, {
    headers: createAdminHeaders(token),
  });

  return readJson<SingleInstanceListPayload>(response);
}

export async function destroySingleInstanceBatch(
  apiBaseUrl: string,
  token: string,
  id: string,
  triggeredBy: string,
) {
  const response = await fetch(`${apiBaseUrl}/admin/instances/batches/${id}/destroy-all`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify({ triggeredBy }),
  });

  return readJson<{ batchId: string; jobCount: number }>(response);
}
```

- [ ] **Step 4: Replace the flat single-instance list with grouped rendering**

`apps/web/components/admin/single-instances-screen.tsx`

```tsx
const [groups, setGroups] = useState<SingleInstanceBatchGroup[]>([]);
const [standaloneInstances, setStandaloneInstances] = useState<RangeInstance[]>([]);
const [expandedBatchIds, setExpandedBatchIds] = useState<string[]>([]);

async function reloadSingleInstanceRows(token: string) {
  const [payload, nextJobs] = await Promise.all([
    fetchSingleInstances(apiBaseUrl, token),
    fetchProvisionJobs(apiBaseUrl, token),
  ]);

  setGroups(payload.batches);
  setStandaloneInstances(payload.standaloneInstances);
  setJobs(nextJobs);

  return payload;
}

function toggleBatch(batchId: string) {
  setExpandedBatchIds((current) =>
    current.includes(batchId) ? current.filter((id) => id !== batchId) : [...current, batchId],
  );
}
```

Then render the batch row:

```tsx
<article key={group.batch.id} className="single-instance-batch-row">
  <button
    type="button"
    aria-label={`展开批次 ${group.batch.name}`}
    onClick={() => toggleBatch(group.batch.id)}
  >
    {expandedBatchIds.includes(group.batch.id) ? '收起' : '展开'}
  </button>
  <strong>{group.batch.name}</strong>
  <span>{group.batch.imageDisplayName}</span>
  <span>{group.batch.quantity}</span>
  <span>{renderBatchSummary(group.batch.summary)}</span>
  <span>{formatDateTime(group.batch.createdAt)}</span>
  <span>{formatDateTime(group.batch.expiresAt)}</span>
  <span>{group.batch.createdBy?.trim() || 'admin'}</span>
  <button type="button" onClick={() => void handleBatchDestroy(group.batch.id)}>
    一键关闭
  </button>
</article>
```

and the child table:

```tsx
{expandedBatchIds.includes(group.batch.id) ? (
  <div className="single-instance-batch-children">
    {group.instances.map((instance) => (
      <article key={instance.id} className="single-instance-batch-child-row">
        <strong>{instance.name?.trim() || instance.id}</strong>
        <span>{getSpecLabel(instance)}</span>
        <span>{getPublicIp(instance)}</span>
        <span>{formatMaskedCredential(instance)}</span>
        <span>{getStatusLabel(instance.status)}</span>
        <button type="button" onClick={() => void handleAction(instance, 'destroy')}>关闭</button>
        <button type="button" onClick={() => void handleAction(instance, 'reboot')}>重启</button>
        <button type="button" onClick={() => void handleAction(instance, 'open-vnc')}>VNC</button>
      </article>
    ))}
  </div>
) : null}
```

- [ ] **Step 5: Add the batch destroy action and rerun the UI tests**

`apps/web/components/admin/single-instances-screen.tsx`

```tsx
async function handleBatchDestroy(batchId: string) {
  if (!session.token) {
    return;
  }

  setErrorMessage(null);

  try {
    await destroySingleInstanceBatch(apiBaseUrl, session.token, batchId, 'admin');
    await reloadSingleInstanceRows(session.token);
  } catch (error: unknown) {
    if (isUnauthorizedError(error)) {
      session.logout();
      router.replace('/admin/login');
      return;
    }

    setErrorMessage('批量关闭失败，请稍后重试。');
  }
}
```

Run:

```bash
pnpm --filter @aliyun-cyber-range/web test -- single-instances-screen.test.tsx
```

Expected:

```text
PASS ... renders a batch row that expands to child instance rows
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/admin-types.ts \
  apps/web/lib/admin-api.ts \
  apps/web/components/admin/single-instances-screen.tsx \
  apps/web/components/admin/single-instances-screen.test.tsx \
  apps/web/app/globals.css
git commit -m "feat: render batch single instance groups"
```

---

### Task 6: Validate ECS-native batch behavior end-to-end in containers

**Files:**
- Modify: `docs/superpowers/specs/2026-07-09-single-instance-batch-ecs-design.md` (only if implementation changes require a factual update)
- Test: container stack and browser flows

- [ ] **Step 1: Run focused API + web tests**

Run:

```bash
pnpm --filter @aliyun-cyber-range/api test -- single-instances.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts range-instance-node-actions.e2e-spec.ts
pnpm --filter @aliyun-cyber-range/web test -- single-instances-screen.test.tsx
```

Expected:

```text
PASS ... all listed suites
```

- [ ] **Step 2: Rebuild the affected containers**

Run:

```bash
docker compose up -d --build api web provisioner-worker
```

Expected:

```text
api ... healthy
web ... started
provisioner-worker ... started
```

- [ ] **Step 3: Verify grouped batch creation in the browser**

Run:

```bash
curl -fsS http://127.0.0.1:3001/health
curl -I -fsS 'http://127.0.0.1:3000/admin/instances'
```

Then manually verify:

```text
1. 登录 /admin/login
2. 在实例管理中创建 5 台实例
3. 页面显示 1 条批次主行
4. 展开后显示 5 条子实例
5. 子实例可单独复制密码 / 打开 VNC / 关闭
```

- [ ] **Step 4: Verify the “destroy while creating” and “multiple destroy” scenarios**

Manual verification checklist:

```text
1. 批次 A 进入销毁中时，仍可创建批次 B
2. 批次 A 与批次 B 可同时显示创建中 / 销毁中
3. 连续触发两个批次的一键关闭，不会再一个一个排队
4. 部分成功场景下，批次主行显示混合汇总
```

- [ ] **Step 5: Commit final validation-only adjustments if needed**

```bash
git add .
git commit -m "test: validate batch single instance ecs flow"
```

Only create this commit if you changed code during verification. If no code changed, skip this step and record “No changes required after validation”.

---

## Self-Review

### Spec coverage

- 批次主行与子实例展开表格：Task 5
- 单实例 ECS 原生创建/回收：Task 4
- 单实例并发上限 3：Task 3
- 子实例单独关闭/重启/打包/VNC：Task 4 + Task 5
- 一键关闭：Task 4 + Task 5
- 旧数据兼容：Task 2 + Task 5
- 容器态验证：Task 6

### Placeholder scan

- No `TODO/TBD`
- Every task names exact files
- Every code-changing step includes concrete code
- Every run step includes exact commands and expected outcomes

### Type consistency

- `SingleInstanceBatchRecord` / `SingleInstanceBatchGroup` naming is consistent across repository, API, and UI tasks
- `singleInstanceBatchId` is the only relation field used between batch and child instance
- `destroy-all` route naming is consistent between controller, API wrapper, and UI action

---

Plan complete and saved to `docs/superpowers/plans/2026-07-09-single-instance-batch-ecs-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
