# Range Instance Detail Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current range-instance detail modal with a standalone instance workbench, add launch-time instance naming and expiration input, support instance draft editing plus manual apply, and close the loop with auto-expire destroy and node-level runtime actions.

**Architecture:** Keep the existing template editor as the source of truth for topology-editing UI primitives, but move instance detail into a separate route backed by instance-owned runtime and draft snapshots. Backend responsibilities are split into four layers: atomic launch, instance-detail read/write APIs, update/destroy job orchestration in the worker, and direct Aliyun RPC operations for host runtime actions that do not fit the OpenTofu lifecycle.

**Tech Stack:** Next.js App Router, React 19, Vitest, NestJS 11, Prisma/PostgreSQL, OpenTofu worker, Docker Compose, Alibaba Cloud RPC signing.

---

## File Structure

### Database and repository

- Modify: `packages/database/prisma/schema.prisma`
  - Add instance runtime/draft snapshot fields, `createdBy`, and `update` provision jobs.
- Create: `packages/database/prisma/migrations/20260706_add_range_instance_workbench_runtime_state/migration.sql`
  - Persist the new `RangeInstance` columns and `ProvisionJobType.update`.
- Modify: `apps/api/src/admin/admin.repository.ts`
  - Extend repository records and command payloads for runtime/draft snapshots and createdBy.
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
  - Read/write the new fields from Prisma.
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
  - Keep unit tests aligned with the richer repository contract.

### Shared backend validation

- Create: `apps/api/src/admin/range-blueprint-validation.service.ts`
  - Extract reusable scenario/spec/compiledProvisionSpec validation logic from `RangeTemplatesService`.
- Modify: `apps/api/src/admin/range-templates.service.ts`
  - Delegate existing publish validation to the new service.

### Range launch and detail APIs

- Modify: `apps/api/src/admin/dto/range-instance.dto.ts`
  - Add launch, draft-save, and apply request DTOs.
- Modify: `apps/api/src/admin/ranges.controller.ts`
  - Add `POST /launch`, `PATCH /:id/draft`, `DELETE /:id/draft`, and `POST /:id/apply`.
- Modify: `apps/api/src/admin/range-instances.service.ts`
  - Implement atomic launch, detail draft persistence, draft discard, apply validation, and auto-expire helpers.

### Worker and provisioning

- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`
  - Process `update` jobs and periodic expire/destroy work.
- Modify: `apps/api/src/provisioning/provisioning.types.ts`
  - Allow `update` in the provisioner-facing job flow.
- Modify: `apps/api/src/provisioning/open-tofu-range-provisioner.ts`
  - Reuse the existing workspace/state for update apply, not just create/destroy.

### Direct cloud runtime actions

- Create: `apps/api/src/admin/range-instance-node-actions.service.ts`
  - Encapsulate Stop/Reboot/VNC/CreateImage operations against Aliyun RPC APIs.
- Create: `apps/api/src/admin/range-instance-node-actions.controller.ts`
  - Expose node runtime action endpoints for the detail workbench.
- Modify: `apps/api/src/admin/image-catalog-rpc-signer.ts`
  - Reuse existing signer helpers for ECS and image APIs.
- Modify: `apps/api/src/app.module.ts`
  - Register the new services/controllers.

### Frontend launch and navigation

- Modify: `apps/web/lib/admin-types.ts`
  - Add route-level detail payloads, runtime/draft snapshots, and node action payloads.
- Modify: `apps/web/lib/admin-api.ts`
  - Add launch, draft, apply, and node action client helpers.
- Modify: `apps/web/components/admin/templates-screen.tsx`
  - Replace direct create with the launch dialog.
- Modify: `apps/web/components/admin/templates-screen.test.tsx`
  - Cover the new launch dialog flow.
- Modify: `apps/web/components/admin/range-instances-screen.tsx`
  - Replace modal detail with route navigation.
- Modify: `apps/web/components/admin/range-instances-screen.test.tsx`
  - Update “查看详情” expectations to route navigation.

### Standalone instance detail workbench

- Create: `apps/web/app/admin/ranges/[rangeId]/page.tsx`
  - Route entry for the instance workbench.
- Create: `apps/web/components/admin/range-instance-detail-screen.tsx`
  - Orchestrate overview, tabs, topology, node directory, and action bars.
- Create: `apps/web/components/admin/range-instance-overview.tsx`
  - Render the top summary block.
- Create: `apps/web/components/admin/range-instance-node-directory.tsx`
  - Render node cards and host actions.
- Create: `apps/web/components/admin/range-instance-topology-workbench.tsx`
  - Wrap the canvas and property panel in instance mode.
- Create: `apps/web/components/admin/range-instance-detail-screen.test.tsx`
  - Cover read-only, editable, and action states.

### Reused editor primitives

- Modify: `apps/web/components/admin/template-editor/template-canvas.tsx`
  - Add a mode that preserves node selection and viewport interaction while disabling topology mutation.
- Modify: `apps/web/components/admin/template-editor/template-property-panel.tsx`
  - Add an instance mode that hides template-only controls and exposes save/apply callbacks.
- Modify: `apps/web/components/admin/template-editor/template-canvas.test.tsx`
  - Verify read-only mutation guards for instance mode.
- Modify: `apps/web/components/admin/template-editor/template-property-panel.test.tsx`
  - Verify instance-mode field visibility and callbacks.

### Backend tests

- Create: `apps/api/test/range-blueprint-validation.spec.ts`
- Create: `apps/api/test/range-instance-launch.e2e-spec.ts`
- Create: `apps/api/test/range-instance-draft.e2e-spec.ts`
- Create: `apps/api/test/range-instance-apply.e2e-spec.ts`
- Create: `apps/api/test/range-instance-auto-expire.spec.ts`
- Create: `apps/api/test/range-instance-node-actions.spec.ts`

---

### Task 1: Extract Reusable Blueprint Validation

**Files:**
- Create: `apps/api/src/admin/range-blueprint-validation.service.ts`
- Modify: `apps/api/src/admin/range-templates.service.ts`
- Test: `apps/api/test/range-blueprint-validation.spec.ts`

- [ ] **Step 1: Write the failing validation extraction test**

```ts
import { RangeBlueprintValidationService } from '../src/admin/range-blueprint-validation.service';

describe('RangeBlueprintValidationService', () => {
  it('accepts a compiledProvisionSpec that matches the scenario template spec', () => {
    const service = new RangeBlueprintValidationService();

    expect(() =>
      service.validateDraftBlueprint({
        scenarioTemplateSpec: {
          schemaVersion: '1.0.0',
          metadata: {
            name: 'Detail Draft',
            slug: 'detail-draft',
            version: 'v1',
            cloudProvider: 'alibaba_cloud',
            iacType: 'opentofu',
          },
          topology: {
            vpcCidr: '10.10.0.0/16',
            entryHostKey: 'ecs-1',
          },
          networkZones: [
            {
              key: 'switch-1',
              name: 'Switch 1',
              cidr: '10.10.0.0/24',
              purpose: 'lan',
            },
          ],
          hosts: [
            {
              key: 'ecs-1',
              name: 'ECS 1',
              role: 'target',
              zoneKey: 'switch-1',
              primaryPrivateIp: '10.10.0.10',
            },
          ],
          nat: { natGateways: [], eips: [] },
          access: { portGroups: [], securityGroupRules: [], aclRules: [] },
          bootstrap: { scripts: [] },
          runtimePreferences: { imagePolicies: [], instanceTypePolicies: [] },
        },
        compiledProvisionSpec: {
          schemaVersion: '1.0.0',
          identity: {
            templateSlug: 'detail-draft',
            templateVersion: 'v1',
            cloudProvider: 'alibaba_cloud',
            iacType: 'opentofu',
          },
          topology: {
            vpcCidr: '10.10.0.0/16',
            entryHostKey: 'ecs-1',
          },
          networkZones: [
            {
              key: 'switch-1',
              name: 'Switch 1',
              cidr: '10.10.0.0/24',
              purpose: 'lan',
              isPublicEntry: false,
              routeRole: 'internal',
            },
          ],
          hosts: [
            {
              key: 'ecs-1',
              name: 'ECS 1',
              role: 'target',
              zoneKey: 'switch-1',
              primaryPrivateIp: '10.10.0.10',
              exposePublic: false,
              networkInterfaces: [{ deviceIndex: 0, zoneKey: 'switch-1', privateIp: '10.10.0.10' }],
            },
          ],
          natGateways: [],
          eips: [],
          snatEntries: [],
          dnatEntries: [],
          securityGroupRules: [],
          aclRules: [],
          bootstrapScripts: [],
          runtimeSelections: { imagePolicies: {}, instanceTypePolicies: {} },
        },
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the new backend unit test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-blueprint-validation.spec.ts
```

Expected: FAIL because `RangeBlueprintValidationService` does not exist.

- [ ] **Step 3: Implement the validation service and delegate the template publish path**

Create `apps/api/src/admin/range-blueprint-validation.service.ts`:

```ts
import { BadRequestException, Injectable } from '@nestjs/common';

@Injectable()
export class RangeBlueprintValidationService {
  validateDraftBlueprint(input: {
    scenarioTemplateSpec: Record<string, unknown>;
    compiledProvisionSpec?: Record<string, unknown> | null;
    compiledSpec?: Record<string, unknown> | null;
  }) {
    this.validateScenarioTemplateSpec(input.scenarioTemplateSpec);

    if (input.compiledProvisionSpec) {
      this.validateCompiledProvisionSpec(input.compiledProvisionSpec, input.scenarioTemplateSpec);
    }

    if (input.compiledSpec && input.scenarioTemplateSpec) {
      this.validateCompiledTopologyConsistency(input.compiledSpec, input.scenarioTemplateSpec);
    }
  }

  private validateScenarioTemplateSpec(scenarioTemplateSpec: Record<string, unknown>) {
    if (scenarioTemplateSpec.schemaVersion !== '1.0.0') {
      throw new BadRequestException('scenarioTemplateSpec schemaVersion must be 1.0.0');
    }
  }

  private validateCompiledProvisionSpec(
    compiledProvisionSpec: Record<string, unknown>,
    scenarioTemplateSpec: Record<string, unknown>,
  ) {
    const topology = compiledProvisionSpec.topology as Record<string, unknown> | undefined;
    const templateTopology = scenarioTemplateSpec.topology as Record<string, unknown> | undefined;

    if (!topology || !templateTopology || topology.vpcCidr !== templateTopology.vpcCidr) {
      throw new BadRequestException('compiledProvisionSpec topology does not match scenarioTemplateSpec');
    }
  }

  private validateCompiledTopologyConsistency(
    compiledSpec: Record<string, unknown>,
    scenarioTemplateSpec: Record<string, unknown>,
  ) {
    const topology = compiledSpec.topology as Record<string, unknown> | undefined;
    const templateTopology = scenarioTemplateSpec.topology as Record<string, unknown> | undefined;

    if (!topology || !templateTopology || topology.vpcCidr !== templateTopology.vpcCidr) {
      throw new BadRequestException('compiledSpec topology does not match scenarioTemplateSpec');
    }
  }
}
```

Update `apps/api/src/admin/range-templates.service.ts` constructor and callsites:

```ts
constructor(
  @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
  private readonly validationService: RangeBlueprintValidationService,
) {}

// inside publish/validate flows
this.validationService.validateDraftBlueprint({
  scenarioTemplateSpec,
  compiledProvisionSpec,
  compiledSpec,
});
```

- [ ] **Step 4: Run the targeted backend tests and confirm they pass**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-blueprint-validation.spec.ts range-templates-publish-precheck.e2e-spec.ts
```

Expected: PASS with the new service covering both instance-draft and template-publish validation.

- [ ] **Step 5: Commit the validation extraction**

```bash
git add apps/api/src/admin/range-blueprint-validation.service.ts apps/api/src/admin/range-templates.service.ts apps/api/test/range-blueprint-validation.spec.ts
git commit -m "refactor: extract reusable range blueprint validation"
```

### Task 2: Persist Instance Runtime and Draft Snapshots

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260706_add_range_instance_workbench_runtime_state/migration.sql`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Test: `apps/api/test/range-instance-launch.e2e-spec.ts`

- [ ] **Step 1: Write the failing persistence test for runtime and draft state**

```ts
import { RangeInstancesService } from '../src/admin/range-instances.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('RangeInstancesService launch snapshots', () => {
  it('copies template snapshots into runtime state and leaves draft state empty', async () => {
    const repository = createMemoryAdminRepository();
    const service = new RangeInstancesService(repository as never, { serialize: async <T>(run: () => Promise<T>) => run(), getPool: () => [], allocate: () => null } as never, { dispatch: () => undefined } as never);

    const template = await repository.createRangeTemplate({
      name: 'Workbench Template',
      slug: 'workbench-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: { vpcCidr: '10.20.0.0/16', networkZones: [], hosts: [], publicEntry: { hostKey: 'ecs-1', protocols: [] } },
      topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      scenarioTemplateSpec: { schemaVersion: '1.0.0', topology: { vpcCidr: '10.20.0.0/16', entryHostKey: 'ecs-1' }, networkZones: [], hosts: [], nat: { natGateways: [], eips: [] }, access: { portGroups: [] }, bootstrap: { scripts: [] }, runtimePreferences: { imagePolicies: [], instanceTypePolicies: [] }, metadata: { name: 'Workbench Template', slug: 'workbench-template', version: 'v1', cloudProvider: 'alibaba_cloud', iacType: 'opentofu' } },
      compiledProvisionSpec: { schemaVersion: '1.0.0', topology: { vpcCidr: '10.20.0.0/16', entryHostKey: 'ecs-1' }, networkZones: [], hosts: [], natGateways: [], eips: [], snatEntries: [], dnatEntries: [], securityGroupRules: [], aclRules: [], bootstrapScripts: [], runtimeSelections: { imagePolicies: {}, instanceTypePolicies: {} }, identity: { templateSlug: 'workbench-template', templateVersion: 'v1', cloudProvider: 'alibaba_cloud', iacType: 'opentofu' } },
      variableSchema: {},
      outputSchema: {},
    });

    const launched = await service.launch({
      templateId: template.id,
      name: '实战实例',
      expiresAt: '2026-07-08T18:00:00.000Z',
      triggeredBy: 'admin',
    });

    expect(launched.runtimeTopologyGraph).toEqual(template.topologyGraph);
    expect(launched.runtimeScenarioTemplateSpec).toEqual(template.scenarioTemplateSpec);
    expect(launched.runtimeCompiledProvisionSpec).toEqual(template.compiledProvisionSpec);
    expect(launched.draftTopologyGraph).toBeNull();
    expect(launched.createdBy).toBe('admin');
  });
});
```

- [ ] **Step 2: Run the persistence test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-instance-launch.e2e-spec.ts
```

Expected: FAIL because `launch`, `createdBy`, and runtime/draft snapshot fields do not exist.

- [ ] **Step 3: Add the Prisma columns, repository types, and memory repository support**

Update `packages/database/prisma/schema.prisma`:

```prisma
enum ProvisionJobType {
  create
  update
  destroy
  retry
  refresh_status
}

model RangeInstance {
  id                           String              @id @default(cuid())
  name                         String
  createdBy                    String?
  templateId                   String?
  sourceTemplateVersionId      String?
  templateNameSnapshot         String?
  templateSlugSnapshot         String?
  templateVersionSnapshot      String?
  templateModulePathSnapshot   String?
  runtimeTopologyGraph         Json?
  runtimeScenarioTemplateSpec  Json?
  runtimeCompiledProvisionSpec Json?
  draftTopologyGraph           Json?
  draftScenarioTemplateSpec    Json?
  draftCompiledProvisionSpec   Json?
  draftUpdatedBy               String?
  draftUpdatedAt               DateTime?
  status                       RangeInstanceStatus @default(draft)
  allocatedCidr                String?
  cloudProvider                CloudProvider       @default(alibaba_cloud)
  accessEntry                  Json?
  resourceSummary              Json?
  errorSummary                 String?             @db.Text
  expiresAt                    DateTime?
  lastJobId                    String?             @unique
  createdAt                    DateTime            @default(now())
  updatedAt                    DateTime            @updatedAt
}
```

Create `packages/database/prisma/migrations/20260706_add_range_instance_workbench_runtime_state/migration.sql`:

```sql
ALTER TYPE "ProvisionJobType" ADD VALUE IF NOT EXISTS 'update';

ALTER TABLE "RangeInstance"
  ADD COLUMN "createdBy" TEXT,
  ADD COLUMN "runtimeTopologyGraph" JSONB,
  ADD COLUMN "runtimeScenarioTemplateSpec" JSONB,
  ADD COLUMN "runtimeCompiledProvisionSpec" JSONB,
  ADD COLUMN "draftTopologyGraph" JSONB,
  ADD COLUMN "draftScenarioTemplateSpec" JSONB,
  ADD COLUMN "draftCompiledProvisionSpec" JSONB,
  ADD COLUMN "draftUpdatedBy" TEXT,
  ADD COLUMN "draftUpdatedAt" TIMESTAMP(3);
```

Extend `apps/api/src/admin/admin.repository.ts`:

```ts
export type RangeInstanceRecord = {
  id: string;
  name: string;
  createdBy: string | null;
  templateId: string | null;
  sourceTemplateVersionId: string | null;
  templateNameSnapshot: string | null;
  templateSlugSnapshot: string | null;
  templateVersionSnapshot: string | null;
  templateModulePathSnapshot: string | null;
  runtimeTopologyGraph: Record<string, unknown> | null;
  runtimeScenarioTemplateSpec: Record<string, unknown> | null;
  runtimeCompiledProvisionSpec: Record<string, unknown> | null;
  draftTopologyGraph: Record<string, unknown> | null;
  draftScenarioTemplateSpec: Record<string, unknown> | null;
  draftCompiledProvisionSpec: Record<string, unknown> | null;
  draftUpdatedBy: string | null;
  draftUpdatedAt: Date | null;
  status: RangeInstanceStatus;
  allocatedCidr: string | null;
  cloudProvider: CloudProvider;
  accessEntry: RangeAccessEntry | null;
  resourceSummary: RangeResourceSummary | null;
  errorSummary: string | null;
  expiresAt: Date | null;
  lastJobId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
```

- [ ] **Step 4: Re-run the persistence test and repository-adjacent tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-instance-launch.e2e-spec.ts range-instances-retry.spec.ts
```

Expected: PASS with runtime/draft snapshot data present in repository records.

- [ ] **Step 5: Commit the persistence layer**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260706_add_range_instance_workbench_runtime_state/migration.sql apps/api/src/admin/admin.repository.ts apps/api/src/database/prisma-admin.repository.ts apps/api/test/support/create-memory-admin-repository.ts apps/api/test/range-instance-launch.e2e-spec.ts
git commit -m "feat: persist range instance runtime and draft snapshots"
```

### Task 3: Add Atomic Launch Backend API

**Files:**
- Modify: `apps/api/src/admin/dto/range-instance.dto.ts`
- Modify: `apps/api/src/admin/ranges.controller.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Test: `apps/api/test/range-instance-launch.e2e-spec.ts`

- [ ] **Step 1: Add a failing API-level test for `POST /admin/ranges/launch`**

```ts
it('launches a range instance atomically from template id, name, and expiresAt', async () => {
  const response = await request(app.getHttpServer())
    .post('/admin/ranges/launch')
    .set('Authorization', 'Bearer dev-admin-token')
    .send({
      templateId: seededTemplate.id,
      name: 'test-实例-01',
      expiresAt: '2026-07-08T18:00:00.000Z',
      triggeredBy: 'admin',
    });

  expect(response.status).toBe(201);
  expect(response.body).toEqual(
    expect.objectContaining({
      name: 'test-实例-01',
      status: 'pending_create',
      createdBy: 'admin',
      expiresAt: '2026-07-08T18:00:00.000Z',
    }),
  );
});
```

- [ ] **Step 2: Run the API test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-instance-launch.e2e-spec.ts
```

Expected: FAIL with 404 because `/admin/ranges/launch` does not exist.

- [ ] **Step 3: Implement the launch DTO, controller route, and service method**

Update `apps/api/src/admin/dto/range-instance.dto.ts`:

```ts
export class LaunchRangeInstanceDto {
  @IsString()
  @IsNotEmpty()
  templateId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsISO8601()
  expiresAt!: string;

  @IsString()
  @IsNotEmpty()
  triggeredBy!: string;
}
```

Update `apps/api/src/admin/ranges.controller.ts`:

```ts
@Post('launch')
launch(@Body() body: LaunchRangeInstanceDto) {
  return this.rangeInstancesService.launch(body);
}
```

Add `launch` to `apps/api/src/admin/range-instances.service.ts`:

```ts
async launch(input: {
  templateId: string;
  name: string;
  expiresAt: string;
  triggeredBy: string;
}) {
  const template = await this.adminRepository.getRangeTemplateById(input.templateId);

  if (!template) {
    throw new NotFoundException('Range template not found');
  }

  const sourceTemplateVersionId = template.currentDraftVersionId ?? template.currentPublishedVersionId;

  if (!sourceTemplateVersionId) {
    throw new ConflictException('Range template does not have an active template version');
  }

  const instance = await this.adminRepository.createRangeInstance({
    name: input.name,
    templateId: input.templateId,
    sourceTemplateVersionId,
    createdBy: input.triggeredBy,
    expiresAt: input.expiresAt,
    runtimeTopologyGraph: template.currentDraftVersion?.topologyGraph ?? template.currentPublishedVersion?.topologyGraph ?? template.topologyGraph ?? null,
    runtimeScenarioTemplateSpec: template.currentDraftVersion?.scenarioTemplateSpec ?? template.currentPublishedVersion?.scenarioTemplateSpec ?? null,
    runtimeCompiledProvisionSpec: template.currentDraftVersion?.compiledProvisionSpec ?? template.currentPublishedVersion?.compiledProvisionSpec ?? null,
  });

  const job = await this.adminRepository.createProvisionJob({
    rangeInstanceId: instance.id,
    jobType: 'create',
    triggeredBy: input.triggeredBy,
  });

  await this.adminRepository.updateRangeInstance(instance.id, {
    status: 'pending_create',
    lastJobId: job.id,
  });

  this.provisioningWorkerService.dispatch(job.id);

  return this.adminRepository.getRangeInstanceById(instance.id);
}
```

- [ ] **Step 4: Re-run the launch tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-instance-launch.e2e-spec.ts admin-resources.e2e-spec.ts
```

Expected: PASS with atomic launch behavior and no split create/trigger flow.

- [ ] **Step 5: Commit the launch API**

```bash
git add apps/api/src/admin/dto/range-instance.dto.ts apps/api/src/admin/ranges.controller.ts apps/api/src/admin/range-instances.service.ts apps/api/test/range-instance-launch.e2e-spec.ts
git commit -m "feat: add atomic range instance launch api"
```

### Task 4: Replace Direct Create with a Launch Dialog on the Template List

**Files:**
- Modify: `apps/web/lib/admin-types.ts`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/components/admin/templates-screen.tsx`
- Modify: `apps/web/components/admin/templates-screen.test.tsx`

- [ ] **Step 1: Add a failing UI test for the launch dialog**

```tsx
it('opens a launch dialog, validates expiresAt, and calls launchRangeInstance', async () => {
  fetchAdminBootstrapMock.mockResolvedValue({
    scenarios: [
      { id: 'template-1', name: 'Browser Lab', slug: 'browser-lab', version: 'v1', currentDraftVersionId: 'draft-1' },
    ],
    rangeTemplates: [
      { id: 'template-1', name: 'Browser Lab', slug: 'browser-lab', version: 'v1', currentDraftVersionId: 'draft-1' },
    ],
    rangeInstances: [],
    provisionJobs: [],
  });

  render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

  fireEvent.click(await screen.findByRole('button', { name: '生成实例' }));

  expect(await screen.findByRole('dialog', { name: '生成实例' })).toBeTruthy();

  fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'browser-lab-run-01' } });
  fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: '2026-07-08T18:00' } });
  fireEvent.click(screen.getByRole('button', { name: '确认生成' }));

  await waitFor(() => {
    expect(launchRangeInstanceMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      expect.objectContaining({
        templateId: 'template-1',
        name: 'browser-lab-run-01',
      }),
    );
  });
});
```

- [ ] **Step 2: Run the frontend test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test -- components/admin/templates-screen.test.tsx
```

Expected: FAIL because there is no launch dialog or `launchRangeInstance` helper.

- [ ] **Step 3: Implement the frontend API helper and launch dialog**

Add to `apps/web/lib/admin-types.ts`:

```ts
export type RangeInstanceLaunchInput = {
  templateId: string;
  name: string;
  expiresAt: string;
  triggeredBy: string;
};
```

Add to `apps/web/lib/admin-api.ts`:

```ts
export async function launchRangeInstance(
  apiBaseUrl: string,
  token: string,
  payload: RangeInstanceLaunchInput,
) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/launch`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<RangeInstance>(response);
}
```

Update `apps/web/components/admin/templates-screen.tsx` with dialog state:

```tsx
type LaunchDraft = {
  templateId: string;
  templateName: string;
  name: string;
  expiresAt: string;
};

const EMPTY_LAUNCH_DRAFT: LaunchDraft = {
  templateId: '',
  templateName: '',
  name: '',
  expiresAt: '',
};

const [launchDraft, setLaunchDraft] = useState<LaunchDraft>(EMPTY_LAUNCH_DRAFT);
const [isLaunchDialogOpen, setIsLaunchDialogOpen] = useState(false);

function handleOpenGenerateInstance(template: Scenario) {
  setLaunchDraft({
    templateId: template.id,
    templateName: getScenarioDisplayName(template),
    name: '',
    expiresAt: '',
  });
  setIsLaunchDialogOpen(true);
}
```

Replace direct create with:

```tsx
const launched = await launchRangeInstance(apiBaseUrl, session.token, {
  templateId: launchDraft.templateId,
  name: launchDraft.name,
  expiresAt: new Date(launchDraft.expiresAt).toISOString(),
  triggeredBy: 'admin',
});

router.push(`/admin/ranges/${launched.id}`);
```

- [ ] **Step 4: Re-run the template list tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test -- components/admin/templates-screen.test.tsx
```

Expected: PASS with dialog-driven instance launch and route navigation.

- [ ] **Step 5: Commit the launch dialog**

```bash
git add apps/web/lib/admin-types.ts apps/web/lib/admin-api.ts apps/web/components/admin/templates-screen.tsx apps/web/components/admin/templates-screen.test.tsx
git commit -m "feat: add range instance launch dialog"
```

### Task 5: Move Range Instance Detail from Modal to Standalone Route

**Files:**
- Create: `apps/web/app/admin/ranges/[rangeId]/page.tsx`
- Create: `apps/web/components/admin/range-instance-detail-screen.tsx`
- Modify: `apps/web/components/admin/range-instances-screen.tsx`
- Modify: `apps/web/components/admin/range-instances-screen.test.tsx`
- Test: `apps/web/components/admin/range-instance-detail-screen.test.tsx`

- [ ] **Step 1: Add a failing test for route-driven detail navigation**

```tsx
it('navigates to the standalone range detail route instead of opening a modal', async () => {
  fetchAdminBootstrapMock.mockResolvedValue({
    rangeTemplates: [{ id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' }],
    rangeInstances: [
      {
        id: 'range-1',
        name: '蓝队靶场 01',
        templateId: 'template-1',
        status: 'running',
        createdAt: '2026-06-29T09:00:00.000Z',
      },
    ],
    provisionJobs: [],
  });

  render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

  fireEvent.click(await screen.findByRole('button', { name: '查看详情' }));

  await waitFor(() => {
    expect(pushMock).toHaveBeenCalledWith('/admin/ranges/range-1');
  });

  expect(screen.queryByRole('dialog', { name: '实例详情' })).toBeNull();
});
```

- [ ] **Step 2: Run the route/navigation tests and verify they fail**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test -- components/admin/range-instances-screen.test.tsx
```

Expected: FAIL because the screen still opens the modal detail dialog.

- [ ] **Step 3: Implement the standalone page skeleton and replace modal navigation**

Create `apps/web/app/admin/ranges/[rangeId]/page.tsx`:

```tsx
import { RangeInstanceDetailScreen } from '../../../../components/admin/range-instance-detail-screen';

export default async function AdminRangeDetailPage({
  params,
}: {
  params: Promise<{ rangeId: string }>;
}) {
  const { rangeId } = await params;
  return <RangeInstanceDetailScreen rangeId={rangeId} />;
}
```

Create `apps/web/components/admin/range-instance-detail-screen.tsx`:

```tsx
'use client';

export function RangeInstanceDetailScreen({
  rangeId,
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: {
  rangeId: string;
  apiBaseUrl?: string;
}) {
  return (
    <section className="range-instance-detail-screen">
      <header className="range-instance-detail-header">
        <h1>实例详情</h1>
        <p>{rangeId}</p>
      </header>
    </section>
  );
}
```

Replace the old modal entry in `apps/web/components/admin/range-instances-screen.tsx`:

```tsx
function handleViewDetail(id: string) {
  router.push(`/admin/ranges/${id}`);
}
```

Delete the modal JSX block instead of rendering it conditionally.

- [ ] **Step 4: Re-run the list screen tests and add the new detail screen smoke test**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test -- components/admin/range-instances-screen.test.tsx components/admin/range-instance-detail-screen.test.tsx
```

Expected: PASS with route navigation and the new page component mounting successfully.

- [ ] **Step 5: Commit the route conversion**

```bash
git add apps/web/app/admin/ranges/[rangeId]/page.tsx apps/web/components/admin/range-instance-detail-screen.tsx apps/web/components/admin/range-instances-screen.tsx apps/web/components/admin/range-instances-screen.test.tsx apps/web/components/admin/range-instance-detail-screen.test.tsx
git commit -m "feat: move range detail to standalone route"
```

### Task 6: Build the Read-Only Instance Workbench UI

**Files:**
- Create: `apps/web/components/admin/range-instance-overview.tsx`
- Create: `apps/web/components/admin/range-instance-node-directory.tsx`
- Create: `apps/web/components/admin/range-instance-topology-workbench.tsx`
- Modify: `apps/web/components/admin/range-instance-detail-screen.tsx`
- Modify: `apps/web/lib/admin-types.ts`
- Modify: `apps/web/lib/admin-api.ts`
- Test: `apps/web/components/admin/range-instance-detail-screen.test.tsx`

- [ ] **Step 1: Write the failing read-only workbench test**

```tsx
it('renders overview, node directory, and topology tabs for a running instance', async () => {
  fetchRangeInstanceDetailMock.mockResolvedValue({
    id: 'range-1',
    name: 'browser-lab-run-01',
    createdBy: 'admin',
    status: 'running',
    templateId: 'template-1',
    templateNameSnapshot: 'Browser Lab',
    createdAt: '2026-07-06T10:00:00.000Z',
    expiresAt: '2026-07-08T18:00:00.000Z',
    accessEntry: { publicIp: '1.2.3.4', privateIp: '10.10.0.10', hostRole: 'target', ssh: 'ssh root@1.2.3.4' },
    runtimeTopologyGraph: {
      schemaVersion: '1.0.0',
      nodes: [
        { id: 'router-1', kind: 'router', label: 'Router' },
        { id: 'switch-1', kind: 'switch', label: 'Switch 1' },
        { id: 'ecs-1', kind: 'ecs', label: 'ECS 1' },
      ],
      edges: [
        { id: 'edge-1', fromNodeId: 'router-1', toNodeId: 'switch-1', relationType: 'manual' },
        { id: 'edge-2', fromNodeId: 'switch-1', toNodeId: 'ecs-1', relationType: 'manual' },
      ],
    },
    runtimeScenarioTemplateSpec: { schemaVersion: '1.0.0', metadata: { name: 'Browser Lab', slug: 'browser-lab', version: 'v1', cloudProvider: 'alibaba_cloud', iacType: 'opentofu' }, topology: { vpcCidr: '10.10.0.0/16', entryHostKey: 'ecs-1' }, networkZones: [], hosts: [], nat: { natGateways: [], eips: [] }, access: { portGroups: [], securityGroupRules: [], aclRules: [] }, bootstrap: { scripts: [] }, runtimePreferences: { imagePolicies: [], instanceTypePolicies: [] } },
    runtimeCompiledProvisionSpec: { schemaVersion: '1.0.0', topology: { vpcCidr: '10.10.0.0/16', entryHostKey: 'ecs-1' }, networkZones: [], hosts: [], natGateways: [], eips: [], snatEntries: [], dnatEntries: [], securityGroupRules: [], aclRules: [], bootstrapScripts: [], runtimeSelections: { imagePolicies: {}, instanceTypePolicies: {} }, identity: { templateSlug: 'browser-lab', templateVersion: 'v1', cloudProvider: 'alibaba_cloud', iacType: 'opentofu' } },
  });

  render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

  expect(await screen.findByText('实例名')).toBeTruthy();
  expect(screen.getByText('场景名称')).toBeTruthy();
  expect(screen.getByRole('button', { name: '节点目录' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '拓扑结构' })).toBeTruthy();
  expect(screen.getByText('ECS 1')).toBeTruthy();
});
```

- [ ] **Step 2: Run the read-only workbench test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test -- components/admin/range-instance-detail-screen.test.tsx
```

Expected: FAIL because the detail route is only a skeleton.

- [ ] **Step 3: Implement the read-only overview, node directory, and topology workbench**

Add to `apps/web/lib/admin-types.ts`:

```ts
export type RangeInstanceDetail = RangeInstance & {
  templateId: string;
  createdBy?: string | null;
  runtimeTopologyGraph?: Record<string, unknown> | null;
  runtimeScenarioTemplateSpec?: Record<string, unknown> | null;
  runtimeCompiledProvisionSpec?: CompiledProvisionSpec | null;
  draftTopologyGraph?: Record<string, unknown> | null;
  draftScenarioTemplateSpec?: ScenarioTemplateSpec | null;
  draftCompiledProvisionSpec?: CompiledProvisionSpec | null;
  draftUpdatedBy?: string | null;
  draftUpdatedAt?: string | null;
};
```

Create `apps/web/components/admin/range-instance-overview.tsx`:

```tsx
export function RangeInstanceOverview({ detail }: { detail: RangeInstanceDetail }) {
  return (
    <section className="range-instance-overview">
      <div><span>实例名</span><strong>{detail.name}</strong></div>
      <div><span>场景名称</span><strong>{detail.templateNameSnapshot ?? '未知场景'}</strong></div>
      <div><span>当前状态</span><strong>{detail.status}</strong></div>
      <div><span>创建人</span><strong>{detail.createdBy ?? '暂无'}</strong></div>
      <div><span>创建时间</span><strong>{detail.createdAt ?? '暂无'}</strong></div>
      <div><span>公网IP</span><strong>{detail.accessEntry?.publicIp ?? '暂无'}</strong></div>
      <div><span>到期时间</span><strong>{detail.expiresAt ?? '暂无'}</strong></div>
    </section>
  );
}
```

Create `apps/web/components/admin/range-instance-node-directory.tsx`:

```tsx
export function RangeInstanceNodeDirectory({
  nodes,
}: {
  nodes: Array<{ id: string; kind: string; label: string; ip?: string; spec?: string; account?: string; password?: string }>;
}) {
  return (
    <div className="range-instance-node-directory">
      {nodes.map((node) => (
        <article key={node.id} className="range-instance-node-card">
          <strong>{node.label}</strong>
          <span>IP地址：{node.ip ?? '暂无'}</span>
          <span>规格信息：{node.spec ?? '暂无'}</span>
          <span>节点类型：{node.kind}</span>
          <span>账号：{node.account ?? '暂无'}</span>
          <span>密码：{node.password ?? '暂无'}</span>
        </article>
      ))}
    </div>
  );
}
```

Create `apps/web/components/admin/range-instance-topology-workbench.tsx`:

```tsx
export function RangeInstanceTopologyWorkbench({
  detail,
}: {
  detail: RangeInstanceDetail;
}) {
  return (
    <section className="range-instance-topology-shell">
      <div className="range-instance-topology-canvas">拓扑结构</div>
      <aside className="range-instance-topology-panel">点击节点后查看配置</aside>
    </section>
  );
}
```

- [ ] **Step 4: Re-run the detail workbench tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test -- components/admin/range-instance-detail-screen.test.tsx
```

Expected: PASS with the read-only workbench structure rendered from detail payloads.

- [ ] **Step 5: Commit the read-only workbench**

```bash
git add apps/web/lib/admin-types.ts apps/web/lib/admin-api.ts apps/web/components/admin/range-instance-overview.tsx apps/web/components/admin/range-instance-node-directory.tsx apps/web/components/admin/range-instance-topology-workbench.tsx apps/web/components/admin/range-instance-detail-screen.tsx apps/web/components/admin/range-instance-detail-screen.test.tsx
git commit -m "feat: add read-only range instance workbench"
```

### Task 7: Add Draft Save/Discard APIs and Instance-Mode Property Editing

**Files:**
- Modify: `apps/api/src/admin/dto/range-instance.dto.ts`
- Modify: `apps/api/src/admin/ranges.controller.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/components/admin/template-editor/template-canvas.tsx`
- Modify: `apps/web/components/admin/template-editor/template-property-panel.tsx`
- Modify: `apps/web/components/admin/range-instance-topology-workbench.tsx`
- Test: `apps/api/test/range-instance-draft.e2e-spec.ts`
- Test: `apps/web/components/admin/template-editor/template-canvas.test.tsx`
- Test: `apps/web/components/admin/template-editor/template-property-panel.test.tsx`

- [ ] **Step 1: Write the failing backend and frontend draft-mode tests**

```ts
it('persists instance draft snapshots without changing runtime state', async () => {
  const response = await request(app.getHttpServer())
    .patch('/admin/ranges/range-1/draft')
    .set('Authorization', 'Bearer dev-admin-token')
    .send({
      topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] },
      scenarioTemplateSpec: { schemaVersion: '1.0.0', metadata: { name: 'draft', slug: 'draft', version: 'v1', cloudProvider: 'alibaba_cloud', iacType: 'opentofu' }, topology: { vpcCidr: '10.10.0.0/16', entryHostKey: 'ecs-1' }, networkZones: [], hosts: [], nat: { natGateways: [], eips: [] }, access: { portGroups: [], securityGroupRules: [], aclRules: [] }, bootstrap: { scripts: [] }, runtimePreferences: { imagePolicies: [], instanceTypePolicies: [] } },
      compiledProvisionSpec: { schemaVersion: '1.0.0', identity: { templateSlug: 'draft', templateVersion: 'v1', cloudProvider: 'alibaba_cloud', iacType: 'opentofu' }, topology: { vpcCidr: '10.10.0.0/16', entryHostKey: 'ecs-1' }, networkZones: [], hosts: [], natGateways: [], eips: [], snatEntries: [], dnatEntries: [], securityGroupRules: [], aclRules: [], bootstrapScripts: [], runtimeSelections: { imagePolicies: {}, instanceTypePolicies: {} } },
      updatedBy: 'admin',
    });

  expect(response.status).toBe(200);
  expect(response.body.draftTopologyGraph).toEqual(expect.any(Object));
  expect(response.body.runtimeTopologyGraph).toEqual(expect.any(Object));
});
```

```tsx
it('disables node movement and topology mutation in instance mode', async () => {
  render(
    <TemplateCanvas
      mode="instance"
      nodes={[{ id: 'ecs-1', kind: 'ecs', label: 'ECS 1', data: {}, position: { x: 100, y: 100 } }]}
      edges={[]}
      selectedNodeId="ecs-1"
      onSelectNode={vi.fn()}
      onChangeNodePosition={vi.fn()}
    />,
  );

  expect(screen.queryByText('生成第一阶段骨架')).toBeNull();
});
```

- [ ] **Step 2: Run the targeted tests and verify they fail**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-instance-draft.e2e-spec.ts

cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test -- components/admin/template-editor/template-canvas.test.tsx components/admin/template-editor/template-property-panel.test.tsx
```

Expected: FAIL because draft endpoints and instance editor mode do not exist.

- [ ] **Step 3: Implement draft persistence and instance editor mode**

Add DTOs in `apps/api/src/admin/dto/range-instance.dto.ts`:

```ts
export class SaveRangeInstanceDraftDto {
  @IsDefined()
  topologyGraph!: Record<string, unknown>;

  @IsDefined()
  scenarioTemplateSpec!: Record<string, unknown>;

  @IsDefined()
  compiledProvisionSpec!: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  updatedBy!: string;
}
```

Add controller methods:

```ts
@Patch(':id/draft')
saveDraft(@Param('id') id: string, @Body() body: SaveRangeInstanceDraftDto) {
  return this.rangeInstancesService.saveDraft(id, body);
}

@Delete(':id/draft')
discardDraft(@Param('id') id: string) {
  return this.rangeInstancesService.discardDraft(id);
}
```

Add service methods:

```ts
async saveDraft(
  id: string,
  input: {
    topologyGraph: Record<string, unknown>;
    scenarioTemplateSpec: Record<string, unknown>;
    compiledProvisionSpec: Record<string, unknown>;
    updatedBy: string;
  },
) {
  const instance = await this.requireInstance(id);

  this.validationService.validateDraftBlueprint({
    scenarioTemplateSpec: input.scenarioTemplateSpec,
    compiledProvisionSpec: input.compiledProvisionSpec,
  });

  await this.adminRepository.updateRangeInstance(id, {
    draftTopologyGraph: input.topologyGraph,
    draftScenarioTemplateSpec: input.scenarioTemplateSpec,
    draftCompiledProvisionSpec: input.compiledProvisionSpec,
    draftUpdatedBy: input.updatedBy,
    draftUpdatedAt: new Date(),
  });

  return this.getById(id);
}
```

Modify `apps/web/components/admin/template-editor/template-canvas.tsx` to add:

```tsx
type TemplateCanvasProps = {
  mode?: 'template' | 'instance';
};

const isInstanceMode = mode === 'instance';

if (isInstanceMode) {
  // block add/delete/connect affordances while preserving select + pan + zoom
}
```

Modify `apps/web/components/admin/template-editor/template-property-panel.tsx`:

```tsx
type TemplatePropertyPanelProps = {
  mode?: 'template' | 'instance';
  onSaveDraft?: (payload: {
    topologyGraph: Record<string, unknown>;
    scenarioTemplateSpec: ScenarioTemplateSpec;
    compiledProvisionSpec: CompiledProvisionSpec;
  }) => void;
};

const isInstanceMode = mode === 'instance';
```

- [ ] **Step 4: Re-run draft and instance-mode tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-instance-draft.e2e-spec.ts

cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test -- components/admin/template-editor/template-canvas.test.tsx components/admin/template-editor/template-property-panel.test.tsx components/admin/range-instance-detail-screen.test.tsx
```

Expected: PASS with draft persistence and instance-mode editor reuse.

- [ ] **Step 5: Commit draft save/discard and instance-mode editing**

```bash
git add apps/api/src/admin/dto/range-instance.dto.ts apps/api/src/admin/ranges.controller.ts apps/api/src/admin/range-instances.service.ts apps/web/lib/admin-api.ts apps/web/components/admin/template-editor/template-canvas.tsx apps/web/components/admin/template-editor/template-property-panel.tsx apps/web/components/admin/range-instance-topology-workbench.tsx apps/api/test/range-instance-draft.e2e-spec.ts apps/web/components/admin/template-editor/template-canvas.test.tsx apps/web/components/admin/template-editor/template-property-panel.test.tsx
git commit -m "feat: add instance draft editing flow"
```

### Task 8: Apply Drafts Through `update` Provision Jobs

**Files:**
- Modify: `apps/api/src/admin/dto/range-instance.dto.ts`
- Modify: `apps/api/src/admin/ranges.controller.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Modify: `apps/api/src/provisioning/provisioning.types.ts`
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`
- Modify: `apps/api/src/provisioning/open-tofu-range-provisioner.ts`
- Test: `apps/api/test/range-instance-apply.e2e-spec.ts`

- [ ] **Step 1: Write the failing apply/update tests**

```ts
it('creates an update job from a running instance draft and blocks non-running instances', async () => {
  const runningResponse = await request(app.getHttpServer())
    .post('/admin/ranges/range-running/apply')
    .set('Authorization', 'Bearer dev-admin-token')
    .send({ triggeredBy: 'admin' });

  expect(runningResponse.status).toBe(201);
  expect(runningResponse.body.jobType).toBe('update');

  const failedResponse = await request(app.getHttpServer())
    .post('/admin/ranges/range-destroyed/apply')
    .set('Authorization', 'Bearer dev-admin-token')
    .send({ triggeredBy: 'admin' });

  expect(failedResponse.status).toBe(409);
});
```

- [ ] **Step 2: Run the apply tests and verify they fail**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-instance-apply.e2e-spec.ts
```

Expected: FAIL because there is no apply endpoint and no `update` job path.

- [ ] **Step 3: Implement apply validation and worker update handling**

Add DTO:

```ts
export class ApplyRangeInstanceDraftDto {
  @IsString()
  @IsNotEmpty()
  triggeredBy!: string;
}
```

Add service method:

```ts
async applyDraft(id: string, triggeredBy: string) {
  const instance = await this.requireInstance(id);

  if (instance.status !== 'running') {
    throw new ConflictException('Only running instances can apply draft changes');
  }

  if (!instance.draftScenarioTemplateSpec || !instance.draftCompiledProvisionSpec) {
    throw new ConflictException('Range instance draft does not exist');
  }

  this.validationService.validateDraftBlueprint({
    scenarioTemplateSpec: instance.draftScenarioTemplateSpec,
    compiledProvisionSpec: instance.draftCompiledProvisionSpec,
  });

  const job = await this.adminRepository.createProvisionJob({
    rangeInstanceId: id,
    jobType: 'update',
    triggeredBy,
  });

  await this.adminRepository.updateRangeInstance(id, {
    lastJobId: job.id,
  });

  this.provisioningWorkerService.dispatch(job.id);

  return job;
}
```

Update worker effective job handling:

```ts
if (effectiveJobType === 'update') {
  await this.runWorkerStep(reportStep, 'prepare_update', async () => {
    await this.adminRepository.updateProvisionJob(job.id, {
      status: 'running',
    });
  });

  const result = await this.rangeProvisioner.update({
    rangeInstanceId: instance.id,
    templateModulePath,
    allocatedCidr: instance.allocatedCidr,
    runtimeConfig,
    topologySpec: this.getTopologySpecFromCompiledProvisionSpec(instance.draftCompiledProvisionSpec ?? compiledProvisionSpec) ?? topologySpec,
    compiledProvisionSpec: instance.draftCompiledProvisionSpec ?? compiledProvisionSpec,
    compiledSpec,
    reportStep,
  });

  await this.adminRepository.updateRangeInstance(instance.id, {
    runtimeTopologyGraph: instance.draftTopologyGraph,
    runtimeScenarioTemplateSpec: instance.draftScenarioTemplateSpec,
    runtimeCompiledProvisionSpec: instance.draftCompiledProvisionSpec,
    draftTopologyGraph: null,
    draftScenarioTemplateSpec: null,
    draftCompiledProvisionSpec: null,
    draftUpdatedBy: null,
    draftUpdatedAt: null,
    accessEntry: result.accessEntry,
    resourceSummary: result.resourceSummary,
    errorSummary: null,
  });
}
```

- [ ] **Step 4: Re-run the apply/update tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-instance-apply.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts open-tofu-range-provisioner.e2e-spec.ts
```

Expected: PASS with `update` jobs flowing through the worker and promoting draft state into runtime state on success.

- [ ] **Step 5: Commit the update job flow**

```bash
git add apps/api/src/admin/dto/range-instance.dto.ts apps/api/src/admin/ranges.controller.ts apps/api/src/admin/range-instances.service.ts apps/api/src/provisioning/provisioning.types.ts apps/api/src/provisioning/provisioning-worker.service.ts apps/api/src/provisioning/open-tofu-range-provisioner.ts apps/api/test/range-instance-apply.e2e-spec.ts
git commit -m "feat: apply range instance drafts through update jobs"
```

### Task 9: Add Auto-Expire Destroy Scanning

**Files:**
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`
- Test: `apps/api/test/range-instance-auto-expire.spec.ts`

- [ ] **Step 1: Write the failing auto-expire test**

```ts
it('queues destroy jobs for running instances whose expiresAt is in the past', async () => {
  const repository = createMemoryAdminRepository();
  const service = new RangeInstancesService(repository as never, { serialize: async <T>(run: () => Promise<T>) => run(), getPool: () => [], allocate: () => null } as never, { dispatch: () => undefined } as never);

  const instance = await repository.createRangeInstance({
    name: 'expired-range',
    status: 'running',
    expiresAt: '2026-07-01T00:00:00.000Z',
  });

  const expired = await service.queueExpiredDestroyJobs(new Date('2026-07-02T00:00:00.000Z'));

  expect(expired).toEqual([instance.id]);
});
```

- [ ] **Step 2: Run the auto-expire test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-instance-auto-expire.spec.ts
```

Expected: FAIL because there is no expire sweep helper.

- [ ] **Step 3: Implement the expire sweep and invoke it from the worker loop**

Add to `apps/api/src/admin/range-instances.service.ts`:

```ts
async queueExpiredDestroyJobs(now = new Date()) {
  const instances = await this.adminRepository.listRangeInstances();
  const expired = instances.filter((instance) => instance.status === 'running' && instance.expiresAt && instance.expiresAt <= now);

  const queued: string[] = [];

  for (const instance of expired) {
    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: instance.id,
      jobType: 'destroy',
      triggeredBy: 'system:auto-expire',
    });

    await this.adminRepository.updateRangeInstance(instance.id, {
      status: 'pending_destroy',
      lastJobId: job.id,
    });

    this.provisioningWorkerService.dispatch(job.id);
    queued.push(instance.id);
  }

  return queued;
}
```

Invoke from `apps/api/src/provisioning/provisioning-worker.service.ts`:

```ts
while (true) {
  await this.rangeInstancesService.queueExpiredDestroyJobs(new Date());

  const pendingJob = (await this.adminRepository.listProvisionJobs()).find((job) => job.status === 'pending');
  if (pendingJob) {
    await this.process(pendingJob.id);
    continue;
  }

  await sleep(readWorkerPollIntervalMs());
}
```

- [ ] **Step 4: Re-run the auto-expire tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-instance-auto-expire.spec.ts
```

Expected: PASS with destroy jobs queued only for expired running instances.

- [ ] **Step 5: Commit auto-expire support**

```bash
git add apps/api/src/admin/range-instances.service.ts apps/api/src/provisioning/provisioning-worker.service.ts apps/api/test/range-instance-auto-expire.spec.ts
git commit -m "feat: auto-expire running range instances"
```

### Task 10: Add Node Runtime Actions and Image Packaging APIs

**Files:**
- Create: `apps/api/src/admin/range-instance-node-actions.service.ts`
- Create: `apps/api/src/admin/range-instance-node-actions.controller.ts`
- Modify: `apps/api/src/admin/image-catalog-rpc-signer.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/range-instance-node-actions.spec.ts`

- [ ] **Step 1: Write the failing node action tests**

```ts
import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';

describe('RangeInstanceNodeActionsService', () => {
  it('builds signed StopInstance and RebootInstance RPC requests from instance resource summary', async () => {
    const service = new RangeInstanceNodeActionsService({
      getSnapshot: async () => ({
        provider: 'alibaba_cloud',
        defaultRegion: 'cn-hangzhou',
        defaultZoneId: 'cn-hangzhou-h',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
      }),
    } as never);

    const signed = await service.buildActionRequest({
      action: 'reboot',
      regionId: 'cn-hangzhou',
      ecsInstanceId: 'i-abc123',
    });

    expect(signed.url).toContain('Action=RebootInstance');
    expect(signed.url).toContain('InstanceId=i-abc123');
  });
});
```

- [ ] **Step 2: Run the node action test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-instance-node-actions.spec.ts
```

Expected: FAIL because `RangeInstanceNodeActionsService` does not exist.

- [ ] **Step 3: Implement direct ECS actions and image packing**

Create `apps/api/src/admin/range-instance-node-actions.service.ts`:

```ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class RangeInstanceNodeActionsService {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  async buildActionRequest(input: {
    action: 'start' | 'stop' | 'reboot' | 'vnc' | 'create_image';
    regionId: string;
    ecsInstanceId: string;
    imageName?: string;
  }) {
    const config = await this.systemConfigService.getSnapshot();
    const actionMap = {
      start: 'StartInstance',
      stop: 'StopInstance',
      reboot: 'RebootInstance',
      vnc: 'DescribeInstanceVncUrl',
      create_image: 'CreateImage',
    } as const;

    const parameters: Record<string, string> = {
      Action: actionMap[input.action],
      Version: '2014-05-26',
      AccessKeyId: config.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      Timestamp: new Date().toISOString(),
      SignatureVersion: '1.0',
      SignatureNonce: crypto.randomUUID(),
      Format: 'JSON',
      RegionId: input.regionId,
      InstanceId: input.ecsInstanceId,
    };

    if (input.action === 'create_image' && input.imageName) {
      parameters.ImageName = input.imageName;
    }

    const signedQuery = signAliyunRpcQuery(parameters, config.accessKeySecret);
    return {
      url: `https://ecs.aliyuncs.com/?${signedQuery}`,
      method: 'GET' as const,
    };
  }
}
```

Create controller endpoints like:

```ts
@Post(':rangeId/nodes/:nodeId/reboot')
rebootNode(@Param('rangeId') rangeId: string, @Param('nodeId') nodeId: string) {
  return this.rangeInstanceNodeActionsService.reboot(rangeId, nodeId);
}

@Post(':rangeId/nodes/:nodeId/package-image')
packageNodeImage(@Param('rangeId') rangeId: string, @Param('nodeId') nodeId: string, @Body() body: { imageName: string }) {
  return this.rangeInstanceNodeActionsService.packageImage(rangeId, nodeId, body.imageName);
}
```

- [ ] **Step 4: Re-run the node action tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- range-instance-node-actions.spec.ts
```

Expected: PASS with signed RPC request generation for runtime actions and image packaging.

- [ ] **Step 5: Commit the node action backend**

```bash
git add apps/api/src/admin/range-instance-node-actions.service.ts apps/api/src/admin/range-instance-node-actions.controller.ts apps/api/src/admin/image-catalog-rpc-signer.ts apps/api/src/app.module.ts apps/api/test/range-instance-node-actions.spec.ts
git commit -m "feat: add range instance node action apis"
```

### Task 11: Wire Node Actions and Apply Controls into the Detail Workbench

**Files:**
- Modify: `apps/web/lib/admin-types.ts`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/components/admin/range-instance-node-directory.tsx`
- Modify: `apps/web/components/admin/range-instance-detail-screen.tsx`
- Modify: `apps/web/components/admin/range-instance-topology-workbench.tsx`
- Test: `apps/web/components/admin/range-instance-detail-screen.test.tsx`

- [ ] **Step 1: Add the failing UI tests for apply and node actions**

```tsx
it('shows host runtime actions and applies a saved draft from the workbench action bar', async () => {
  render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

  expect(await screen.findByRole('button', { name: '应用变更' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '保存变更草稿' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '放弃未应用修改' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '关机' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '重启' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '打开VNC' })).toBeTruthy();
});
```

- [ ] **Step 2: Run the UI tests and verify they fail**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test -- components/admin/range-instance-detail-screen.test.tsx
```

Expected: FAIL because the detail workbench does not yet expose these action controls.

- [ ] **Step 3: Implement the workbench action bar and node action wiring**

Add to `apps/web/lib/admin-api.ts`:

```ts
export async function saveRangeInstanceDraft(apiBaseUrl: string, token: string, id: string, payload: {
  topologyGraph: Record<string, unknown>;
  scenarioTemplateSpec: Record<string, unknown>;
  compiledProvisionSpec: Record<string, unknown>;
  updatedBy: string;
}) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${id}/draft`, {
    method: 'PATCH',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<RangeInstanceDetail>(response);
}

export async function applyRangeInstanceDraft(apiBaseUrl: string, token: string, id: string, triggeredBy: string) {
  const response = await fetch(`${apiBaseUrl}/admin/ranges/${id}/apply`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify({ triggeredBy }),
  });

  return readJson<ProvisionJob>(response);
}
```

Update `apps/web/components/admin/range-instance-node-directory.tsx`:

```tsx
{node.kind === 'ecs' ? (
  <div className="range-instance-node-actions">
    <button type="button" onClick={() => onNodeAction(node.id, 'stop')}>关机</button>
    <button type="button" onClick={() => onNodeAction(node.id, 'reboot')}>重启</button>
    <button type="button" onClick={() => onNodeAction(node.id, 'vnc')}>打开VNC</button>
    <button type="button" onClick={() => onNodeAction(node.id, 'package-image')}>二次打包镜像</button>
  </div>
) : null}
```

Update `apps/web/components/admin/range-instance-detail-screen.tsx`:

```tsx
<div className="range-instance-workbench-actions">
  <button type="button" onClick={() => void handleSaveDraft()} disabled={!canEdit}>保存变更草稿</button>
  <button type="button" onClick={() => void handleApplyDraft()} disabled={!canEdit}>应用变更</button>
  <button type="button" onClick={() => void handleDiscardDraft()} disabled={!canEdit}>放弃未应用修改</button>
</div>
```

- [ ] **Step 4: Re-run the detail workbench UI tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test -- components/admin/range-instance-detail-screen.test.tsx components/admin/range-instances-screen.test.tsx
```

Expected: PASS with the final workbench actions visible and wired.

- [ ] **Step 5: Commit the detail workbench action layer**

```bash
git add apps/web/lib/admin-types.ts apps/web/lib/admin-api.ts apps/web/components/admin/range-instance-node-directory.tsx apps/web/components/admin/range-instance-detail-screen.tsx apps/web/components/admin/range-instance-topology-workbench.tsx apps/web/components/admin/range-instance-detail-screen.test.tsx
git commit -m "feat: wire range instance workbench actions"
```

### Task 12: Container Verification and End-to-End Smoke

**Files:**
- Modify: `docker-compose.yml` only if an API/worker wiring change is required
- Modify: `deploy/current-system/README.md` if runtime commands change

- [ ] **Step 1: Build the updated containers**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
COMPOSE_BAKE=false docker compose up -d --build web api provisioner-worker
```

Expected: `web`, `api`, and `provisioner-worker` rebuild successfully and come up healthy.

- [ ] **Step 2: Run focused container health checks**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
docker compose ps
docker compose logs --tail=100 api
docker compose logs --tail=100 provisioner-worker
```

Expected: no boot-time exceptions, no Prisma migration mismatch, and no worker crash loop.

- [ ] **Step 3: Perform one manual browser verification flow against `http://127.0.0.1:3000`**

Checklist:

```text
1. 在靶场编排页点击“生成实例”
2. 填写实例名与到期时间
3. 跳转到 /admin/ranges/[rangeId]
4. 查看顶部概览、节点目录、拓扑结构
5. 修改一个 ECS 字段并保存草稿
6. 点击“应用变更”
7. 确认任务进入 update
8. 验证到期实例会进入自动销毁队列
```

Expected: all UI and API actions complete in container mode.

- [ ] **Step 4: Run one controlled Aliyun smoke test and immediately destroy resources**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
docker compose exec api node dist/worker-main.js
```

Checklist:

```text
1. 只选一个最小拓扑实例
2. 记录实例 id 与 job id
3. 验证创建成功后立即销毁
4. 确认阿里云侧资源已清空
```

Expected: the full create -> detail -> update -> destroy chain works once against real cloud resources.

- [ ] **Step 5: Commit deployment/doc sync if any runtime command changed**

```bash
git add docker-compose.yml deploy/current-system/README.md
git commit -m "docs: sync container verification steps for range instance workbench"
```

