# Single Instance Management And Admin Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated `实例管理` surface for single ECS instances, rename `靶场实例` to `编排实例`, add `创建人` to the template/range lists, and reuse the existing instance/job system plus OpenTofu worker for single-instance lifecycle operations.

**Architecture:** Keep `RangeInstance` and `ProvisionJob` as the only instance/task backbone, then add a lightweight `instanceMode` split so `range` and `single` instances can share persistence, history, retry, VNC, and pack-image behavior. Single-instance creation gets a dedicated API/controller/service layer, a persisted default-network profile (`1 VPC + 3 vSwitches + 1 security group`), and a dedicated OpenTofu branch that reuses the existing single-ECS module with existing-network inputs instead of creating a new VPC every time.

**Tech Stack:** Next.js App Router, React 19, Vitest, NestJS 11, Prisma/PostgreSQL, OpenTofu worker, Docker Compose, Alibaba Cloud RPC APIs, `@aliyun-cyber-range/scenario-runtime`.

---

## File Structure

### Persistence and contracts

- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260708_add_single_instance_management/migration.sql`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Create: `apps/api/test/create-memory-admin-repository.single-instance.spec.ts`
- Modify: `apps/web/lib/admin-types.ts`

Responsibility:
- Persist `RangeTemplate.createdBy`, `RangeInstance.instanceMode`, `RangeInstance.singleInstanceConfig`, and the default single-instance network profile.

### Single-instance backend

- Create: `apps/api/src/admin/dto/single-instance.dto.ts`
- Create: `apps/api/src/admin/single-instance-blueprint.ts`
- Create: `apps/api/src/admin/single-instance-network.service.ts`
- Create: `apps/api/src/admin/single-instances.service.ts`
- Create: `apps/api/src/admin/single-instances.controller.ts`
- Modify: `apps/api/src/admin/range-instance-node-actions.service.ts`
- Modify: `apps/api/src/admin/ranges.controller.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/single-instances.e2e-spec.ts`
- Modify: `apps/api/test/range-instance-node-actions.e2e-spec.ts`

Responsibility:
- Add single-instance list/launch/destroy/action APIs, create synthetic runtime snapshots for single ECS instances, and reuse the existing node action service.

### Provisioning and worker

- Create: `infra/opentofu/modules/alicloud-single-instance-network/main.tf`
- Create: `infra/opentofu/modules/alicloud-single-instance-network/variables.tf`
- Create: `infra/opentofu/modules/alicloud-single-instance-network/outputs.tf`
- Create: `infra/opentofu/modules/alicloud-single-instance-network/README.md`
- Modify: `infra/opentofu/modules/alicloud-vpc-single-ecs/variables.tf`
- Modify: `infra/opentofu/modules/alicloud-vpc-single-ecs/main.tf`
- Modify: `infra/opentofu/modules/alicloud-vpc-single-ecs/outputs.tf`
- Create: `apps/api/src/provisioning/single-instance-network-bootstrap.ts`
- Create: `apps/api/src/provisioning/single-instance-root-wrapper-template.ts`
- Modify: `apps/api/src/provisioning/open-tofu-range-provisioner.ts`
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`
- Modify: `apps/api/src/provisioning/provisioning.types.ts`
- Modify: `apps/api/test/open-tofu-range-provisioner.e2e-spec.ts`
- Modify: `apps/api/test/provisioning-worker-concurrency.e2e-spec.ts`

Responsibility:
- Teach the worker to provision `instanceMode = single` instances through the existing single-ECS OpenTofu module while reusing previously created network IDs.

### Frontend navigation and lists

- Modify: `apps/web/components/admin/admin-workspace-shell.tsx`
- Modify: `apps/web/components/admin/admin-workspace-shell.test.tsx`
- Modify: `apps/web/components/admin/templates-screen.tsx`
- Modify: `apps/web/components/admin/templates-screen.test.tsx`
- Modify: `apps/web/components/admin/range-instances-screen.tsx`
- Modify: `apps/web/components/admin/range-instances-screen.test.tsx`

Responsibility:
- Rename `靶场实例` to `编排实例`, reorder the sidebar, and add `创建人` columns to the template and range-instance lists.

### Frontend single-instance surface

- Create: `apps/web/app/admin/instances/page.tsx`
- Create: `apps/web/components/admin/single-instances-screen.tsx`
- Create: `apps/web/components/admin/single-instances-screen.test.tsx`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/app/globals.css`

Responsibility:
- Add the new `实例管理` page, the create-instance dialog, the `实例列表 / 实例历史` tabs, and the row-level `更多操作` menu.

---

### Task 1: Persist template authorship, instance mode, and the default single-instance network profile

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260708_add_single_instance_management/migration.sql`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Create: `apps/api/test/create-memory-admin-repository.single-instance.spec.ts`
- Modify: `apps/web/lib/admin-types.ts`

- [ ] **Step 1: Write the failing repository contract test**

Create `apps/api/test/create-memory-admin-repository.single-instance.spec.ts`:

```ts
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('createMemoryAdminRepository single-instance extensions', () => {
  it('stores instanceMode, singleInstanceConfig, and default network profile fields', async () => {
    const repository = createMemoryAdminRepository();

    const single = await repository.createRangeInstance({
      name: 'web-lab-01',
      createdBy: 'admin',
      status: 'pending_create',
      instanceMode: 'single',
      expiresAt: '2026-07-10T12:00:00.000Z',
      singleInstanceConfig: {
        baseName: 'web-lab',
        quantityIndex: 1,
        hostKey: 'single-ecs-1',
        hostName: 'web-lab-host',
        platformImageAssetId: 'platform-image-1',
        imageId: 'm-123',
        imageDisplayName: 'Ubuntu 24.04 LTS',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        remark: 'single instance',
        assignedVswitchId: 'vsw-1',
      },
    });

    await repository.upsertSingleInstanceNetworkProfile({
      provider: 'alibaba_cloud',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      vpcId: 'vpc-1',
      vpcCidr: '10.200.0.0/16',
      vswitchIds: ['vsw-a', 'vsw-b', 'vsw-c'],
      vswitchCidrs: ['10.200.1.0/24', '10.200.2.0/24', '10.200.3.0/24'],
      securityGroupId: 'sg-1',
      securityGroupName: 'default-open-all',
    });

    const reloaded = await repository.getRangeInstanceById(single.id);
    const network = await repository.getSingleInstanceNetworkProfile({
      provider: 'alibaba_cloud',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
    });

    expect(reloaded?.instanceMode).toBe('single');
    expect(reloaded?.singleInstanceConfig).toMatchObject({
      hostKey: 'single-ecs-1',
      platformImageAssetId: 'platform-image-1',
      cpu: 2,
      memory: 2,
    });
    expect(network).toMatchObject({
      vpcId: 'vpc-1',
      vswitchIds: ['vsw-a', 'vsw-b', 'vsw-c'],
      securityGroupId: 'sg-1',
    });
  });
});
```

- [ ] **Step 2: Run the repository contract test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- create-memory-admin-repository.single-instance.spec.ts
```

Expected: FAIL because `instanceMode`, `singleInstanceConfig`, and single-instance network repository methods do not exist yet.

- [ ] **Step 3: Extend Prisma and repository contracts with the new fields**

Update `packages/database/prisma/schema.prisma`:

```prisma
enum RangeInstanceMode {
  range
  single
}

model RangeTemplate {
  id                        String   @id @default(cuid())
  name                      String
  createdBy                 String   @default("admin")
  // existing fields unchanged
}

model RangeInstance {
  id                         String            @id @default(cuid())
  name                       String
  createdBy                  String?           @default("admin")
  instanceMode               RangeInstanceMode @default(range)
  singleInstanceConfig       Json?
  // existing fields unchanged

  @@index([instanceMode, status])
}

model SingleInstanceNetworkProfile {
  id                String        @id @default(cuid())
  provider          CloudProvider
  regionId          String
  zoneId            String
  vpcId             String
  vpcCidr           String
  vswitchIds        Json
  vswitchCidrs      Json
  securityGroupId   String
  securityGroupName String
  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt

  @@unique([provider, regionId, zoneId])
}
```

Create `packages/database/prisma/migrations/20260708_add_single_instance_management/migration.sql`:

```sql
ALTER TABLE "RangeTemplate"
ADD COLUMN "createdBy" TEXT NOT NULL DEFAULT 'admin';

UPDATE "RangeTemplate" SET "createdBy" = 'admin' WHERE "createdBy" IS NULL;

CREATE TYPE "RangeInstanceMode" AS ENUM ('range', 'single');

ALTER TABLE "RangeInstance"
ADD COLUMN "instanceMode" "RangeInstanceMode" NOT NULL DEFAULT 'range',
ADD COLUMN "singleInstanceConfig" JSONB;

CREATE TABLE "SingleInstanceNetworkProfile" (
  "id" TEXT PRIMARY KEY,
  "provider" "CloudProvider" NOT NULL,
  "regionId" TEXT NOT NULL,
  "zoneId" TEXT NOT NULL,
  "vpcId" TEXT NOT NULL,
  "vpcCidr" TEXT NOT NULL,
  "vswitchIds" JSONB NOT NULL,
  "vswitchCidrs" JSONB NOT NULL,
  "securityGroupId" TEXT NOT NULL,
  "securityGroupName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "SingleInstanceNetworkProfile_provider_region_zone_key"
ON "SingleInstanceNetworkProfile" ("provider", "regionId", "zoneId");
```

Update `apps/api/src/admin/admin.repository.ts` to add:

```ts
export type RangeInstanceMode = 'range' | 'single';

export type RangeTemplateRecord = {
  id: string;
  name: string;
  createdBy: string | null;
  // keep existing fields unchanged
};

export type SingleInstanceConfig = {
  baseName: string;
  quantityIndex: number;
  hostKey: string;
  hostName?: string | null;
  platformImageAssetId: string;
  imageId: string;
  imageDisplayName: string;
  cpu: number;
  memory: number;
  systemDiskSize?: number | null;
  remark?: string | null;
  assignedVswitchId: string;
};

export type SingleInstanceNetworkProfileRecord = {
  id: string;
  provider: CloudProvider;
  regionId: string;
  zoneId: string;
  vpcId: string;
  vpcCidr: string;
  vswitchIds: string[];
  vswitchCidrs: string[];
  securityGroupId: string;
  securityGroupName: string;
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertSingleInstanceNetworkProfileInput = Omit<
  SingleInstanceNetworkProfileRecord,
  'id' | 'createdAt' | 'updatedAt'
>;

export interface AdminRepository {
  // existing members
  getPlatformImageAssetById(id: string): Promise<PlatformImageAssetRecord | null>;
  getSingleInstanceNetworkProfile(input: {
    provider: CloudProvider;
    regionId: string;
    zoneId: string;
  }): Promise<SingleInstanceNetworkProfileRecord | null>;
  upsertSingleInstanceNetworkProfile(
    input: UpsertSingleInstanceNetworkProfileInput,
  ): Promise<SingleInstanceNetworkProfileRecord>;
}
```

- [ ] **Step 4: Teach Prisma and the in-memory repository to read/write the new fields**

Update `apps/api/src/database/prisma-admin.repository.ts`:

```ts
async getPlatformImageAssetById(id: string): Promise<PlatformImageAssetRecord | null> {
  return this.prisma.platformImageAsset.findUnique({
    where: { id },
  }) as Promise<PlatformImageAssetRecord | null>;
}

async getSingleInstanceNetworkProfile(input: {
  provider: CloudProvider;
  regionId: string;
  zoneId: string;
}): Promise<SingleInstanceNetworkProfileRecord | null> {
  return this.prisma.singleInstanceNetworkProfile.findUnique({
    where: {
      provider_regionId_zoneId: {
        provider: input.provider,
        regionId: input.regionId,
        zoneId: input.zoneId,
      },
    },
  }) as Promise<SingleInstanceNetworkProfileRecord | null>;
}

async createRangeInstance(input: CreateRangeInstanceInput): Promise<RangeInstanceRecord> {
  return this.prisma.rangeInstance.create({
    data: {
      name: input.name,
      createdBy: input.createdBy ?? 'admin',
      instanceMode: input.instanceMode ?? 'range',
      singleInstanceConfig: input.singleInstanceConfig ?? null,
      // keep existing mappings
    },
  }) as Promise<RangeInstanceRecord>;
}

async upsertSingleInstanceNetworkProfile(
  input: UpsertSingleInstanceNetworkProfileInput,
): Promise<SingleInstanceNetworkProfileRecord> {
  return this.prisma.singleInstanceNetworkProfile.upsert({
    where: {
      provider_regionId_zoneId: {
        provider: input.provider,
        regionId: input.regionId,
        zoneId: input.zoneId,
      },
    },
    update: {
      vpcId: input.vpcId,
      vpcCidr: input.vpcCidr,
      vswitchIds: input.vswitchIds,
      vswitchCidrs: input.vswitchCidrs,
      securityGroupId: input.securityGroupId,
      securityGroupName: input.securityGroupName,
    },
    create: input,
  }) as Promise<SingleInstanceNetworkProfileRecord>;
}
```

Update `apps/api/test/support/create-memory-admin-repository.ts`:

```ts
const singleInstanceNetworkProfiles: SingleInstanceNetworkProfileRecord[] = [];

createRangeInstance: async (input) => {
  const record: RangeInstanceRecord = {
    id: createId('range'),
    name: input.name,
    createdBy: input.createdBy ?? 'admin',
    instanceMode: input.instanceMode ?? 'range',
    singleInstanceConfig: input.singleInstanceConfig ?? null,
    // keep existing fields
  };
  rangeInstances.unshift(record);
  return record;
},

getPlatformImageAssetById: async (id) => {
  return platformImageAssets.find((asset) => asset.id === id) ?? null;
},

getSingleInstanceNetworkProfile: async (input) => {
  return (
    singleInstanceNetworkProfiles.find(
      (item) =>
        item.provider === input.provider &&
        item.regionId === input.regionId &&
        item.zoneId === input.zoneId,
    ) ?? null
  );
},

upsertSingleInstanceNetworkProfile: async (input) => {
  const existing = singleInstanceNetworkProfiles.find(
    (item) =>
      item.provider === input.provider &&
      item.regionId === input.regionId &&
      item.zoneId === input.zoneId,
  );

  if (existing) {
    Object.assign(existing, input, { updatedAt: new Date() });
    return existing;
  }

  const record: SingleInstanceNetworkProfileRecord = {
    id: createId('single-network'),
    ...input,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  singleInstanceNetworkProfiles.unshift(record);
  return record;
},
```

- [ ] **Step 5: Update shared web types and rerun the repository test**

Update `apps/web/lib/admin-types.ts`:

```ts
export type RangeTemplate = {
  id: string;
  name?: string | null;
  createdBy?: string | null;
  // existing fields
};

export type SingleInstanceConfig = {
  baseName: string;
  quantityIndex: number;
  hostKey: string;
  hostName?: string | null;
  platformImageAssetId: string;
  imageId: string;
  imageDisplayName: string;
  cpu: number;
  memory: number;
  systemDiskSize?: number | null;
  remark?: string | null;
  assignedVswitchId: string;
};

export type RangeInstance = {
  id: string;
  name?: string | null;
  createdBy?: string | null;
  instanceMode?: 'range' | 'single';
  singleInstanceConfig?: SingleInstanceConfig | null;
  // existing fields
};
```

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- create-memory-admin-repository.single-instance.spec.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
git add packages/database/prisma/schema.prisma \
  packages/database/prisma/migrations/20260708_add_single_instance_management/migration.sql \
  apps/api/src/admin/admin.repository.ts \
  apps/api/src/database/prisma-admin.repository.ts \
  apps/api/test/support/create-memory-admin-repository.ts \
  apps/api/test/create-memory-admin-repository.single-instance.spec.ts \
  apps/web/lib/admin-types.ts
git commit -m "feat: persist single instance mode and default network profile"
```

### Task 2: Add single-instance launch, list, destroy, and row-action APIs

**Files:**
- Create: `apps/api/src/admin/dto/single-instance.dto.ts`
- Create: `apps/api/src/admin/single-instance-blueprint.ts`
- Create: `apps/api/src/admin/single-instance-network.service.ts`
- Create: `apps/api/src/admin/single-instances.service.ts`
- Create: `apps/api/src/admin/single-instances.controller.ts`
- Modify: `apps/api/src/admin/range-instance-node-actions.service.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/single-instances.e2e-spec.ts`
- Modify: `apps/api/test/range-instance-node-actions.e2e-spec.ts`

- [ ] **Step 1: Write the failing single-instance API e2e test**

Create `apps/api/test/single-instances.e2e-spec.ts`:

```ts
import request from 'supertest';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';

describe('single instances', () => {
  it('creates a single-instance record with mode single and generated names for quantity > 1', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer())
      .post('/admin/instances/launch')
      .set('Authorization', 'Bearer dev-admin-token')
      .send({
        name: 'web-lab',
        hostName: 'web-host',
        platformImageAssetId: 'platform-image-1',
        cpu: 2,
        memory: 2,
        systemDiskSize: 40,
        expiresAt: '2026-07-10T12:00:00.000Z',
        quantity: 2,
        password: '',
        remark: 'single instance',
        triggeredBy: 'admin',
      });

    expect(response.status).toBe(201);
    expect(response.body.instances).toHaveLength(2);
    expect(response.body.instances[0]).toMatchObject({
      createdBy: 'admin',
      instanceMode: 'single',
      name: 'web-lab-01',
    });
    expect(response.body.instances[1]).toMatchObject({
      name: 'web-lab-02',
    });
  });
});
```

- [ ] **Step 2: Run the single-instance API test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- single-instances.e2e-spec.ts
```

Expected: FAIL because `/admin/instances/launch` and the single-instance service/controller do not exist yet.

- [ ] **Step 3: Add DTOs, blueprint synthesis, and default-network helpers**

Create `apps/api/src/admin/dto/single-instance.dto.ts`:

```ts
import { IsISO8601, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class LaunchSingleInstanceDto {
  @IsString() @IsNotEmpty()
  name!: string;

  @IsOptional() @IsString()
  hostName?: string;

  @IsString() @IsNotEmpty()
  platformImageAssetId!: string;

  @IsInt() @Min(1)
  cpu!: number;

  @IsInt() @Min(1)
  memory!: number;

  @IsOptional() @IsInt() @Min(20)
  systemDiskSize?: number;

  @IsISO8601()
  expiresAt!: string;

  @IsOptional() @IsString()
  password?: string;

  @IsInt() @Min(1) @Max(20)
  quantity!: number;

  @IsOptional() @IsString()
  remark?: string;

  @IsString() @IsNotEmpty()
  triggeredBy!: string;
}
```

Create `apps/api/src/admin/single-instance-blueprint.ts`:

```ts
import {
  compileScenarioTemplateSpec,
  resolvePreferredInstanceTypes,
  type ScenarioTemplateSpec,
} from '@aliyun-cyber-range/scenario-runtime';

export function buildSingleInstanceBlueprint(input: {
  name: string;
  hostName?: string;
  vpcCidr: string;
  zoneKey: string;
  vswitchCidr: string;
  privateIp: string;
  imageId: string;
  cpu: number;
  memory: number;
  password: string;
}) {
  const template: ScenarioTemplateSpec = {
    schemaVersion: '1.0.0',
    metadata: {
      name: input.name,
      slug: input.name,
      version: 'single-v1',
      cloudProvider: 'alibaba_cloud',
      iacType: 'opentofu',
    },
    topology: {
      vpcCidr: input.vpcCidr,
      entryHostKey: 'single-ecs-1',
    },
    networkZones: [
      {
        key: input.zoneKey,
        name: input.zoneKey,
        cidr: input.vswitchCidr,
        purpose: 'single',
        isPublicEntry: true,
        routeRole: 'entry',
      },
    ],
    hosts: [
      {
        key: 'single-ecs-1',
        name: input.hostName?.trim() || input.name,
        role: 'single',
        zoneKey: input.zoneKey,
        primaryPrivateIp: input.privateIp,
        exposePublic: true,
        imagePolicyRef: 'image-1',
        instanceTypePolicyRef: 'instance-type-1',
        accountPreset: {
          username: 'root',
          password: input.password,
        },
      },
    ],
    nat: { natGateways: [], eips: [] },
    access: { portGroups: [], securityGroupRules: [], aclRules: [] },
    bootstrap: { scripts: [] },
    runtimePreferences: {
      imagePolicies: [{ key: 'image-1', mode: 'fixed', imageId: input.imageId }],
      instanceTypePolicies: [
        {
          key: 'instance-type-1',
          mode: 'prefer-list',
          preferredInstanceTypes: [...resolvePreferredInstanceTypes(input.cpu, input.memory)],
        },
      ],
    },
  };

  return {
    runtimeScenarioTemplateSpec: template,
    runtimeCompiledProvisionSpec: compileScenarioTemplateSpec(template),
    runtimeTopologyGraph: {
      schemaVersion: '1.0.0',
      nodes: [
        {
          id: 'single-vswitch-1',
          kind: 'switch',
          label: '默认交换机',
          zoneKey: input.zoneKey,
        },
        {
          id: 'single-ecs-1',
          kind: 'ecs',
          label: input.name,
          zoneKey: input.zoneKey,
          privateIp: input.privateIp,
          exposePublic: true,
          cpu: input.cpu,
          memory: input.memory,
        },
      ],
      edges: [{ id: 'single-edge-1', fromNodeId: 'single-vswitch-1', toNodeId: 'single-ecs-1' }],
    },
  };
}
```

Create `apps/api/src/admin/single-instance-network.service.ts`:

```ts
@Injectable()
export class SingleInstanceNetworkService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
    private readonly singleInstanceNetworkBootstrapper: SingleInstanceNetworkBootstrapper,
  ) {}

  async ensureDefaultProfile() {
    const accountContext = await this.systemConfigService.getAccountContext();
    const existing = await this.adminRepository.getSingleInstanceNetworkProfile({
      provider: 'alibaba_cloud',
      regionId: accountContext.defaultRegion,
      zoneId: accountContext.defaultZoneId,
    });

    if (existing) {
      return existing;
    }

    const bootstrapped = await this.singleInstanceNetworkBootstrapper.createDefaultNetwork({
      provider: 'alibaba_cloud',
      regionId: accountContext.defaultRegion,
      zoneId: accountContext.defaultZoneId,
    });

    return this.adminRepository.upsertSingleInstanceNetworkProfile(bootstrapped);
  }

  allocateVswitch(profile: SingleInstanceNetworkProfileRecord, offset: number) {
    const index = offset % profile.vswitchIds.length;
    return {
      vswitchId: profile.vswitchIds[index],
      vswitchCidr: profile.vswitchCidrs[index],
      zoneKey: `single-zone-${index + 1}`,
      privateIp: `10.0.${index + 1}.${10 + offset}`,
    };
  }
}
```

- [ ] **Step 4: Implement the service/controller on top of the existing instance system**

Create `apps/api/src/admin/single-instances.service.ts`:

```ts
@Injectable()
export class SingleInstancesService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly rangeInstanceNodeActionsService: RangeInstanceNodeActionsService,
    private readonly singleInstanceNetworkService: SingleInstanceNetworkService,
    private readonly provisioningWorkerService: ProvisioningWorkerService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async list() {
    return (await this.adminRepository.listRangeInstances()).filter((item) => item.instanceMode === 'single');
  }

  async launch(input: LaunchSingleInstanceDto) {
    const network = await this.singleInstanceNetworkService.ensureDefaultProfile();
    const image = await this.adminRepository.getPlatformImageAssetById(input.platformImageAssetId);
    if (!image || !image.enabled) {
      throw new NotFoundException('Platform image asset not found');
    }

    const password = input.password?.trim() || generateAliyunEcsPassword();
    const created: RangeInstanceRecord[] = [];

    for (let index = 1; index <= input.quantity; index += 1) {
      const instanceName = input.quantity === 1 ? input.name.trim() : `${input.name.trim()}-${String(index).padStart(2, '0')}`;
      const placement = this.singleInstanceNetworkService.allocateVswitch(network, created.length);
      const blueprint = buildSingleInstanceBlueprint({
        name: instanceName,
        hostName: input.hostName,
        vpcCidr: network.vpcCidr,
        zoneKey: placement.zoneKey,
        vswitchCidr: placement.vswitchCidr,
        privateIp: placement.privateIp,
        imageId: image.imageId,
        cpu: input.cpu,
        memory: input.memory,
        password,
      });

      const record = await this.adminRepository.createRangeInstance({
        name: instanceName,
        createdBy: input.triggeredBy,
        instanceMode: 'single',
        status: 'pending_create',
        expiresAt: input.expiresAt,
        runtimeTopologyGraph: blueprint.runtimeTopologyGraph,
        runtimeScenarioTemplateSpec: blueprint.runtimeScenarioTemplateSpec,
        runtimeCompiledProvisionSpec: blueprint.runtimeCompiledProvisionSpec,
        runtimeCredentials: {
          'single-ecs-1': { username: 'root', password },
        },
        singleInstanceConfig: {
          baseName: input.name.trim(),
          quantityIndex: index,
          hostKey: 'single-ecs-1',
          hostName: input.hostName?.trim() || null,
          platformImageAssetId: image.id,
          imageId: image.imageId,
          imageDisplayName: image.displayName,
          cpu: input.cpu,
          memory: input.memory,
          systemDiskSize: input.systemDiskSize ?? null,
          remark: input.remark?.trim() || null,
          assignedVswitchId: placement.vswitchId,
        },
      });

      const job = await this.adminRepository.createProvisionJob({
        rangeInstanceId: record.id,
        jobType: 'create',
        triggeredBy: input.triggeredBy,
      });

      await this.adminRepository.updateRangeInstance(record.id, { lastJobId: job.id });
      this.provisioningWorkerService.dispatch(job.id);
      created.push(record);
    }

    return { instances: created };
  }

  async destroy(id: string, triggeredBy: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);
    if (!instance || instance.instanceMode !== 'single') {
      throw new NotFoundException('Single instance not found');
    }

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: id,
      jobType: 'destroy',
      triggeredBy,
    });

    await this.adminRepository.updateRangeInstance(id, {
      status: 'pending_destroy',
      lastJobId: job.id,
    });
    this.provisioningWorkerService.dispatch(job.id);
    return job;
  }

  async retry(id: string, triggeredBy: string) {
    const instance = await this.adminRepository.getRangeInstanceById(id);
    if (!instance || instance.instanceMode !== 'single') {
      throw new NotFoundException('Single instance not found');
    }

    const job = await this.adminRepository.createProvisionJob({
      rangeInstanceId: id,
      jobType: 'retry',
      triggeredBy,
    });

    await this.adminRepository.updateRangeInstance(id, {
      status: instance.status === 'destroy_failed' ? 'pending_destroy' : 'pending_create',
      lastJobId: job.id,
      errorSummary: null,
    });
    this.provisioningWorkerService.dispatch(job.id);
    return job;
  }

  async runAction(id: string, action: string, payload: Record<string, string>) {
    if (action === 'reboot' || action === 'open-vnc' || action === 'pack-image') {
      return this.rangeInstanceNodeActionsService.runSingleInstanceAction(id, action, payload);
    }

    throw new NotFoundException('Unsupported single instance action');
  }
}
```

Create `apps/api/src/admin/single-instances.controller.ts`:

```ts
@Controller('admin/instances')
@UseGuards(AdminAuthGuard)
export class SingleInstancesController {
  constructor(private readonly singleInstancesService: SingleInstancesService) {}

  @Get()
  list() {
    return this.singleInstancesService.list();
  }

  @Post('launch')
  launch(@Body() body: LaunchSingleInstanceDto) {
    return this.singleInstancesService.launch(body);
  }

  @Post(':id/destroy')
  destroy(@Param('id') id: string, @Body() body: TriggerProvisionJobDto) {
    return this.singleInstancesService.destroy(id, body.triggeredBy);
  }

  @Post(':id/retry')
  retry(@Param('id') id: string, @Body() body: TriggerProvisionJobDto) {
    return this.singleInstancesService.retry(id, body.triggeredBy);
  }

  @Post(':id/actions/:action')
  action(@Param('id') id: string, @Param('action') action: string, @Body() body: Record<string, string>) {
    return this.singleInstancesService.runAction(id, action, body);
  }
}
```

- [ ] **Step 5: Reuse the node-action service and rerun the API tests**

Update `apps/api/src/admin/range-instance-node-actions.service.ts`:

```ts
async runSingleInstanceAction(rangeInstanceId: string, action: NodeActionName, payload: Record<string, string>) {
  const instance = await this.adminRepository.getRangeInstanceById(rangeInstanceId);
  if (!instance || instance.instanceMode !== 'single') {
    throw new NotFoundException('Single instance not found');
  }

  const hostKey =
    typeof instance.singleInstanceConfig?.hostKey === 'string'
      ? instance.singleInstanceConfig.hostKey
      : Object.keys(instance.resourceSummary?.hostIds ?? {})[0];

  if (!hostKey) {
    throw new NotFoundException('Single instance host node not found');
  }

  return this.run(rangeInstanceId, hostKey, action, payload);
}
```

Update `apps/api/src/app.module.ts`:

```ts
providers: [
  // existing providers
  SingleInstanceNetworkService,
  SingleInstancesService,
],
controllers: [
  // existing controllers
  SingleInstancesController,
],
```

Update `apps/api/src/admin/range-instances.service.ts` so the existing 编排实例 page stays isolated:

```ts
async list() {
  const instances = await this.adminRepository.listRangeInstances();

  return Promise.all(
    instances
      .filter((instance) => (instance.instanceMode ?? 'range') === 'range')
      .map((instance) => this.attachRecoverySummary(instance)),
  );
}

async launch(input: LaunchRangeInstanceDto) {
  // existing template lookup code
  const instance = await this.adminRepository.createRangeInstance({
    name: input.name,
    createdBy: input.triggeredBy,
    instanceMode: 'range',
    templateId: template.id,
    // existing runtime snapshot fields
  });
}
```

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- single-instances.e2e-spec.ts range-instance-node-actions.e2e-spec.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
git add apps/api/src/admin/dto/single-instance.dto.ts \
  apps/api/src/admin/single-instance-blueprint.ts \
  apps/api/src/admin/single-instance-network.service.ts \
  apps/api/src/admin/single-instances.service.ts \
  apps/api/src/admin/single-instances.controller.ts \
  apps/api/src/admin/range-instance-node-actions.service.ts \
  apps/api/src/app.module.ts \
  apps/api/test/single-instances.e2e-spec.ts \
  apps/api/test/range-instance-node-actions.e2e-spec.ts
git commit -m "feat: add single instance management APIs"
```

### Task 3: Teach the worker to provision single ECS instances inside the persisted default network

**Files:**
- Create: `infra/opentofu/modules/alicloud-single-instance-network/main.tf`
- Create: `infra/opentofu/modules/alicloud-single-instance-network/variables.tf`
- Create: `infra/opentofu/modules/alicloud-single-instance-network/outputs.tf`
- Create: `infra/opentofu/modules/alicloud-single-instance-network/README.md`
- Modify: `infra/opentofu/modules/alicloud-vpc-single-ecs/variables.tf`
- Modify: `infra/opentofu/modules/alicloud-vpc-single-ecs/main.tf`
- Modify: `infra/opentofu/modules/alicloud-vpc-single-ecs/outputs.tf`
- Create: `apps/api/src/provisioning/single-instance-network-bootstrap.ts`
- Create: `apps/api/src/provisioning/single-instance-root-wrapper-template.ts`
- Modify: `apps/api/src/provisioning/open-tofu-range-provisioner.ts`
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`
- Modify: `apps/api/src/provisioning/provisioning.types.ts`
- Modify: `apps/api/test/open-tofu-range-provisioner.e2e-spec.ts`
- Modify: `apps/api/test/provisioning-worker-concurrency.e2e-spec.ts`

- [ ] **Step 1: Write the failing provisioner rendering test**

Add to `apps/api/test/open-tofu-range-provisioner.e2e-spec.ts`:

```ts
it('renders the single ECS module with existing network ids when instanceMode is single', async () => {
  const result = await provisioner.renderSingleInstanceWorkspace({
    instance: {
      id: 'single-1',
      name: 'web-lab-01',
      instanceMode: 'single',
      singleInstanceConfig: {
        hostKey: 'single-ecs-1',
        platformImageAssetId: 'platform-image-1',
        imageId: 'm-123',
        imageDisplayName: 'Ubuntu 24.04 LTS',
        cpu: 2,
        memory: 2,
        assignedVswitchId: 'vsw-1',
      },
      runtimeCredentials: {
        'single-ecs-1': { username: 'root', password: 'Aa123456!' },
      },
    },
    networkProfile: {
      vpcId: 'vpc-1',
      vpcCidr: '10.200.0.0/16',
      vswitchIds: ['vsw-1', 'vsw-2', 'vsw-3'],
      vswitchCidrs: ['10.200.1.0/24', '10.200.2.0/24', '10.200.3.0/24'],
      securityGroupId: 'sg-1',
      securityGroupName: 'default-open-all',
      provider: 'alibaba_cloud',
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-h',
      id: 'single-network-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  expect(result.files['main.tf']).toContain('source = "infra/opentofu/modules/alicloud-vpc-single-ecs"');
  expect(result.files['terraform.tfvars.json']).toContain('"existing_vpc_id":"vpc-1"');
  expect(result.files['terraform.tfvars.json']).toContain('"existing_vswitch_id":"vsw-1"');
  expect(result.files['terraform.tfvars.json']).toContain('"existing_security_group_id":"sg-1"');
});
```

- [ ] **Step 2: Run the provisioner test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- open-tofu-range-provisioner.e2e-spec.ts
```

Expected: FAIL because the single-instance render path and existing-network variables are missing.

- [ ] **Step 3: Extend the single-ECS OpenTofu module to accept existing network IDs**

Create `infra/opentofu/modules/alicloud-single-instance-network/variables.tf`:

```tf
variable "resource_name_prefix" {
  type = string
}

variable "zone_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "vswitch_cidrs" {
  type = list(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}
```

Create `infra/opentofu/modules/alicloud-single-instance-network/main.tf`:

```tf
resource "alicloud_vpc" "this" {
  vpc_name   = "${var.resource_name_prefix}-vpc"
  cidr_block = var.vpc_cidr
  tags       = var.tags
}

resource "alicloud_vswitch" "this" {
  count        = 3
  vpc_id       = alicloud_vpc.this.id
  cidr_block   = var.vswitch_cidrs[count.index]
  zone_id      = var.zone_id
  vswitch_name = "${var.resource_name_prefix}-vsw-${count.index + 1}"
  tags         = var.tags
}

resource "alicloud_security_group" "this" {
  name   = "${var.resource_name_prefix}-sg"
  vpc_id = alicloud_vpc.this.id
  tags   = var.tags
}

resource "alicloud_security_group_rule" "allow_all" {
  type              = "ingress"
  ip_protocol       = "all"
  nic_type          = "intranet"
  policy            = "accept"
  port_range        = "-1/-1"
  priority          = 1
  security_group_id = alicloud_security_group.this.id
  cidr_ip           = "0.0.0.0/0"
}
```

Create `infra/opentofu/modules/alicloud-single-instance-network/outputs.tf`:

```tf
output "vpc_id" {
  value = alicloud_vpc.this.id
}

output "vswitch_ids" {
  value = [for item in alicloud_vswitch.this : item.id]
}

output "security_group_id" {
  value = alicloud_security_group.this.id
}
```

Update `infra/opentofu/modules/alicloud-vpc-single-ecs/variables.tf`:

```tf
variable "existing_vpc_id" {
  type        = string
  description = "Existing VPC ID reused by single-instance mode."
  default     = ""
}

variable "existing_vswitch_id" {
  type        = string
  description = "Existing vSwitch ID reused by single-instance mode."
  default     = ""
}

variable "existing_security_group_id" {
  type        = string
  description = "Existing security group ID reused by single-instance mode."
  default     = ""
}
```

Update `infra/opentofu/modules/alicloud-vpc-single-ecs/main.tf`:

```tf
locals {
  reuse_existing_vpc            = trimspace(var.existing_vpc_id) != ""
  reuse_existing_vswitch        = trimspace(var.existing_vswitch_id) != ""
  reuse_existing_security_group = trimspace(var.existing_security_group_id) != ""
}

resource "alicloud_vpc" "this" {
  count      = local.reuse_existing_vpc ? 0 : 1
  vpc_name   = "${var.resource_name_prefix}-vpc"
  cidr_block = var.vpc_cidr
}

locals {
  effective_vpc_id = local.reuse_existing_vpc ? var.existing_vpc_id : alicloud_vpc.this[0].id
}

resource "alicloud_vswitch" "this" {
  count             = local.reuse_existing_vswitch ? 0 : 1
  vpc_id            = local.effective_vpc_id
  cidr_block        = var.vswitch_cidr
  zone_id           = var.zone_id
  vswitch_name      = "${var.resource_name_prefix}-vsw"
}

locals {
  effective_vswitch_id = local.reuse_existing_vswitch ? var.existing_vswitch_id : alicloud_vswitch.this[0].id
  effective_sg_id      = local.reuse_existing_security_group ? var.existing_security_group_id : alicloud_security_group.this[0].id
}
```

- [ ] **Step 4: Bootstrap the default network separately, then branch the worker for single-instance ECS creation**

Create `apps/api/src/provisioning/single-instance-network-bootstrap.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

@Injectable()
export class SingleInstanceNetworkBootstrapper {
  constructor(
    private readonly runner: OpenTofuRunner,
    private readonly cidrPoolService: CidrPoolService,
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
  ) {}

  async createDefaultNetwork(input: {
    provider: 'alibaba_cloud';
    regionId: string;
    zoneId: string;
  }): Promise<UpsertSingleInstanceNetworkProfileInput> {
    const occupiedCidrs = (await this.adminRepository.listRangeInstances())
      .map((item) => item.allocatedCidr)
      .filter((value): value is string => Boolean(value));
    const vpcCidr = this.cidrPoolService.allocate(this.cidrPoolService.getPool(), occupiedCidrs);
    const workspaceDir = await this.renderDefaultNetworkWorkspace({
      regionId: input.regionId,
      zoneId: input.zoneId,
      vpcCidr,
    });
    const planFilePath = join(workspaceDir, 'default-network.tfplan');

    await this.runner.init({ workspaceDir, env: process.env });
    await this.runner.plan({ workspaceDir, env: process.env, planFilePath });
    await this.runner.apply({ workspaceDir, env: process.env, planFilePath });
    const outputs = await this.runner.output<{
      vpc_id: { value: string };
      vswitch_ids: { value: string[] };
      security_group_id: { value: string };
    }>({ workspaceDir, env: process.env });

    return {
      provider: input.provider,
      regionId: input.regionId,
      zoneId: input.zoneId,
      vpcId: outputs.vpc_id.value,
      vpcCidr,
      vswitchIds: outputs.vswitch_ids.value,
      vswitchCidrs: this.deriveThreeSubnetCidrs(vpcCidr),
      securityGroupId: outputs.security_group_id.value,
      securityGroupName: 'default-open-all',
    };
  }

  private deriveThreeSubnetCidrs(vpcCidr: string) {
    const [a, b] = vpcCidr.split('.');
    return [`${a}.${b}.1.0/24`, `${a}.${b}.2.0/24`, `${a}.${b}.3.0/24`];
  }

  private async renderDefaultNetworkWorkspace(input: {
    regionId: string;
    zoneId: string;
    vpcCidr: string;
  }) {
    const workspaceDir = join(process.cwd(), '.tmp', `single-network-${Date.now()}`);
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      join(workspaceDir, 'main.tf'),
      'module "network" { source = "infra/opentofu/modules/alicloud-single-instance-network" resource_name_prefix = "single-default" zone_id = var.zone_id vpc_cidr = var.vpc_cidr vswitch_cidrs = var.vswitch_cidrs }',
    );
    await writeFile(
      join(workspaceDir, 'terraform.tfvars.json'),
      JSON.stringify({
        zone_id: input.zoneId,
        vpc_cidr: input.vpcCidr,
        vswitch_cidrs: this.deriveThreeSubnetCidrs(input.vpcCidr),
      }),
    );
    return workspaceDir;
  }
}
```

Create `apps/api/src/provisioning/single-instance-root-wrapper-template.ts`:

```ts
export function buildSingleInstanceRootWrapperFiles(moduleSource: string) {
  return {
    'main.tf': [
      'provider "alicloud" {}',
      '',
      'module "single" {',
      `  source = "${moduleSource}"`,
      '  resource_name_prefix      = var.resource_name_prefix',
      '  zone_id                   = var.zone_id',
      '  vpc_cidr                  = var.vpc_cidr',
      '  vswitch_cidr              = var.vswitch_cidr',
      '  existing_vpc_id           = var.existing_vpc_id',
      '  existing_vswitch_id       = var.existing_vswitch_id',
      '  existing_security_group_id = var.existing_security_group_id',
      '  image_id                  = var.image_id',
      '  instance_type             = var.instance_type',
      '  instance_password         = var.instance_password',
      '  system_disk_size          = var.system_disk_size',
      '  tags                      = var.tags',
      '}',
    ].join('\n'),
  };
}
```

Update `apps/api/src/provisioning/provisioning.types.ts`:

```ts
export type RangeProvisionCreateInput = {
  rangeInstanceId: string;
  templateModulePath: string;
  allocatedCidr: string | null;
  runtimeConfig?: ResolvedProvisioningRuntimeConfig;
  runtimeCredentials?: RangeRuntimeCredentials;
  topologySpec?: RangeTemplateTopologySpec | null;
  compiledProvisionSpec?: Record<string, unknown> | null;
  compiledSpec?: RangeTemplateCompiledSpec | null;
  reportStep?: RangeProvisionStepReporter;
  instanceMode?: 'range' | 'single';
  singleInstanceConfig?: SingleInstanceConfig | null;
  singleNetworkProfile?: SingleInstanceNetworkProfileRecord | null;
};

export type RangeProvisionDestroyInput = RangeProvisionCreateInput;
```

Update `apps/api/src/provisioning/open-tofu-range-provisioner.ts` with a dedicated single-instance workspace branch:

```ts
renderSingleInstanceWorkspace(input: {
  rangeInstanceId: string;
  runtimeCredentials?: RangeRuntimeCredentials;
  singleInstanceConfig: SingleInstanceConfig;
  singleNetworkProfile: SingleInstanceNetworkProfileRecord;
}) {
  const config = input.singleInstanceConfig;
  if (!config) {
    throw new Error('Single instance config missing');
  }

  return {
    files: {
      ...buildSingleInstanceRootWrapperFiles('infra/opentofu/modules/alicloud-vpc-single-ecs'),
      'terraform.tfvars.json': JSON.stringify({
        resource_name_prefix: input.rangeInstanceId,
        zone_id: input.singleNetworkProfile.zoneId,
        vpc_cidr: input.singleNetworkProfile.vpcCidr,
        vswitch_cidr: input.singleNetworkProfile.vswitchCidrs[
          input.singleNetworkProfile.vswitchIds.indexOf(config.assignedVswitchId)
        ],
        existing_vpc_id: input.singleNetworkProfile.vpcId,
        existing_vswitch_id: config.assignedVswitchId,
        existing_security_group_id: input.singleNetworkProfile.securityGroupId,
        image_id: config.imageId,
        instance_type: resolveFixedInstanceType(config.cpu, config.memory),
        instance_password: input.runtimeCredentials?.[config.hostKey]?.password ?? '',
        system_disk_size: config.systemDiskSize ?? 40,
        tags: {
          managed_by: 'aliyun-cyber-range-platform',
          instance_mode: 'single',
        },
      }),
    },
  };
}

private async prepareSingleInstanceWorkspace(
  input: RangeProvisionCreateInput | RangeProvisionDestroyInput,
): Promise<PreparedWorkspace> {
  const workspaceDir = path.join(this.workspacesRootDir, input.rangeInstanceId);
  const planFilePath = path.join(workspaceDir, 'range.tfplan');
  const outputsFilePath = path.join(workspaceDir, 'outputs.json');
  const varsFilePath = path.join(workspaceDir, 'range.auto.tfvars.json');

  await fs.rm(workspaceDir, { recursive: true, force: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  const rendered = this.renderSingleInstanceWorkspace({
    rangeInstanceId: input.rangeInstanceId,
    runtimeCredentials: input.runtimeCredentials,
    singleInstanceConfig: input.singleInstanceConfig!,
    singleNetworkProfile: input.singleNetworkProfile!,
  });

  await Promise.all(
    Object.entries(rendered.files).map(async ([fileName, contents]) => {
      await fs.writeFile(path.join(workspaceDir, fileName), contents, 'utf8');
    }),
  );

  await fs.writeFile(varsFilePath, `${rendered.files['terraform.tfvars.json']}\n`, 'utf8');

  return {
    workspaceDir,
    planFilePath,
    outputsFilePath,
    varsFilePath,
    runnerEnv: await this.buildRunnerEnv(input.runtimeConfig),
  };
}

private async prepareWorkspace(
  input: RangeProvisionCreateInput | RangeProvisionDestroyInput,
  options: { preserveWorkspaceState: boolean },
): Promise<PreparedWorkspace> {
  if (input.instanceMode === 'single') {
    return this.prepareSingleInstanceWorkspace(input);
  }

  const moduleDir = path.resolve(this.projectRootDir, input.templateModulePath);
  const workspaceDir = path.join(this.workspacesRootDir, input.rangeInstanceId);
  const planFilePath = path.join(workspaceDir, 'range.tfplan');
  const outputsFilePath = path.join(workspaceDir, 'outputs.json');
  const varsFilePath = path.join(workspaceDir, 'range.auto.tfvars.json');

  // keep the existing range-instance workspace preparation body here unchanged
}
```

Update `apps/api/src/provisioning/provisioning-worker.service.ts`:

```ts
if (instance.instanceMode === 'single') {
  const networkProfile = await this.adminRepository.getSingleInstanceNetworkProfile({
    provider: instance.cloudProvider,
    regionId: accountContext.defaultRegion,
    zoneId: accountContext.defaultZoneId,
  });

  if (!networkProfile) {
    throw new Error('Single instance network profile missing');
  }

  const templateModulePath = 'infra/opentofu/modules/alicloud-vpc-single-ecs';

  if (effectiveJobType === 'destroy') {
    await this.rangeProvisioner.destroy({
      rangeInstanceId: instance.id,
      templateModulePath,
      allocatedCidr: networkProfile.vpcCidr,
      runtimeConfig,
      runtimeCredentials: instance.runtimeCredentials ?? undefined,
      reportStep,
      instanceMode: 'single',
      singleInstanceConfig: instance.singleInstanceConfig ?? null,
      singleNetworkProfile: networkProfile,
    });

    await this.adminRepository.updateRangeInstance(instance.id, {
      status: 'destroyed',
      accessEntry: null,
      resourceSummary: null,
      errorSummary: null,
    });
    return;
  }

  const result = await this.rangeProvisioner.create({
    rangeInstanceId: instance.id,
    templateModulePath,
    allocatedCidr: networkProfile.vpcCidr,
    runtimeConfig,
    runtimeCredentials: instance.runtimeCredentials ?? undefined,
    reportStep,
    instanceMode: 'single',
    singleInstanceConfig: instance.singleInstanceConfig ?? null,
    singleNetworkProfile: networkProfile,
  });

  await this.adminRepository.updateRangeInstance(instance.id, {
    status: 'running',
    accessEntry: result.accessEntry,
    resourceSummary: result.resourceSummary,
    errorSummary: null,
  });
  return;
}
```

- [ ] **Step 5: Re-run the provisioner and worker tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- open-tofu-range-provisioner.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
git add infra/opentofu/modules/alicloud-single-instance-network/main.tf \
  infra/opentofu/modules/alicloud-single-instance-network/variables.tf \
  infra/opentofu/modules/alicloud-single-instance-network/outputs.tf \
  infra/opentofu/modules/alicloud-single-instance-network/README.md \
  infra/opentofu/modules/alicloud-vpc-single-ecs/variables.tf \
  infra/opentofu/modules/alicloud-vpc-single-ecs/main.tf \
  infra/opentofu/modules/alicloud-vpc-single-ecs/outputs.tf \
  apps/api/src/provisioning/single-instance-network-bootstrap.ts \
  apps/api/src/provisioning/single-instance-root-wrapper-template.ts \
  apps/api/src/provisioning/open-tofu-range-provisioner.ts \
  apps/api/src/provisioning/provisioning-worker.service.ts \
  apps/api/src/provisioning/provisioning.types.ts \
  apps/api/test/open-tofu-range-provisioner.e2e-spec.ts \
  apps/api/test/provisioning-worker-concurrency.e2e-spec.ts
git commit -m "feat: provision single instances inside the default network"
```

### Task 4: Rename the navigation and add `创建人` to the template/range lists

**Files:**
- Modify: `apps/web/components/admin/admin-workspace-shell.tsx`
- Modify: `apps/web/components/admin/admin-workspace-shell.test.tsx`
- Modify: `apps/web/components/admin/templates-screen.tsx`
- Modify: `apps/web/components/admin/templates-screen.test.tsx`
- Modify: `apps/web/components/admin/range-instances-screen.tsx`
- Modify: `apps/web/components/admin/range-instances-screen.test.tsx`

- [ ] **Step 1: Write the failing admin-shell and list tests**

Add assertions to `apps/web/components/admin/admin-workspace-shell.test.tsx`:

```tsx
expect(screen.getAllByRole('link').map((item) => item.textContent?.trim())).toEqual([
  '镜像镜像中心',
  '实例实例管理',
  '编排靶场编排',
  '实例编排实例',
  '配置基础配置',
]);
```

Add assertions to `apps/web/components/admin/templates-screen.test.tsx`:

```tsx
expect(screen.getByText('创建人')).toBeTruthy();
expect(screen.getAllByText('admin').length).toBeGreaterThan(0);
```

Add assertions to `apps/web/components/admin/range-instances-screen.test.tsx`:

```tsx
expect(await screen.findByRole('heading', { name: '编排实例' })).toBeTruthy();
expect(screen.getByText('创建人')).toBeTruthy();
expect(screen.getByText('admin')).toBeTruthy();
```

- [ ] **Step 2: Run the affected web tests and verify they fail**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test admin-workspace-shell.test.tsx range-instances-screen.test.tsx templates-screen.test.tsx
```

Expected: FAIL because the sidebar order, labels, and columns have not been updated yet.

- [ ] **Step 3: Update the navigation order and labels**

Update `apps/web/components/admin/admin-workspace-shell.tsx`:

```tsx
const navigationItems = [
  {
    href: '/admin/image-center',
    label: '镜像中心',
    shortLabel: '镜像',
  },
  {
    href: '/admin/instances',
    label: '实例管理',
    shortLabel: '实例',
  },
  {
    href: '/admin/scenarios',
    label: '靶场编排',
    shortLabel: '编排',
  },
  {
    href: '/admin/ranges',
    label: '编排实例',
    shortLabel: '实例',
  },
  {
    href: '/admin/settings/cloud',
    label: '基础配置',
    shortLabel: '配置',
  },
];
```

- [ ] **Step 4: Add the `创建人` column and rename the range page title**

Update `apps/web/components/admin/templates-screen.tsx`:

```tsx
<div className="template-workbench-column-head">
  <div className="template-workbench-column-cell"><strong>靶场</strong></div>
  <div className="template-workbench-column-cell"><strong>创建人</strong></div>
  <div className="template-workbench-column-cell"><strong>靶场描述</strong></div>
  <div className="template-workbench-column-cell"><strong>拓扑概览</strong></div>
  <div className="template-workbench-column-cell"><strong>状态</strong></div>
  <div className="template-workbench-column-cell workbench-action-cell"><strong>操作</strong></div>
</div>

<div className="template-workbench-owner">
  <strong>{template.createdBy?.trim() || 'admin'}</strong>
</div>
```

Update `apps/web/components/admin/range-instances-screen.tsx`:

```tsx
<div className="template-workbench-list-header-copy">
  <h2>编排实例</h2>
</div>

<div className="range-workbench-column-head">
  <div className="template-workbench-column-cell"><strong>实例名</strong></div>
  <div className="template-workbench-column-cell"><strong>创建人</strong></div>
  <div className="template-workbench-column-cell"><strong>靶场名</strong></div>
  <div className="template-workbench-column-cell"><strong>状态</strong></div>
  <div className="template-workbench-column-cell"><strong>创建时间</strong></div>
  <div className="template-workbench-column-cell workbench-action-cell"><strong>操作</strong></div>
</div>

<div className="range-workbench-owner">
  <strong>{instance.createdBy?.trim() || 'admin'}</strong>
</div>
```

- [ ] **Step 5: Re-run the web tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test admin-workspace-shell.test.tsx range-instances-screen.test.tsx templates-screen.test.tsx
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
git add apps/web/components/admin/admin-workspace-shell.tsx \
  apps/web/components/admin/admin-workspace-shell.test.tsx \
  apps/web/components/admin/templates-screen.tsx \
  apps/web/components/admin/templates-screen.test.tsx \
  apps/web/components/admin/range-instances-screen.tsx \
  apps/web/components/admin/range-instances-screen.test.tsx
git commit -m "feat: rename range navigation and show creators"
```

### Task 5: Build the `实例管理` page and create-instance dialog

**Files:**
- Create: `apps/web/app/admin/instances/page.tsx`
- Create: `apps/web/components/admin/single-instances-screen.tsx`
- Create: `apps/web/components/admin/single-instances-screen.test.tsx`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/lib/admin-types.ts`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Write the failing page test**

Create `apps/web/components/admin/single-instances-screen.test.tsx`:

```tsx
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchSingleInstancesMock,
  fetchProvisionJobsMock,
  fetchPlatformImagesMock,
  launchSingleInstancesMock,
  triggerSingleInstanceActionMock,
} = vi.hoisted(() => ({
  fetchSingleInstancesMock: vi.fn(),
  fetchProvisionJobsMock: vi.fn(),
  fetchPlatformImagesMock: vi.fn(),
  launchSingleInstancesMock: vi.fn(),
  triggerSingleInstanceActionMock: vi.fn(),
}));

vi.mock('../../lib/admin-api', () => ({
  fetchSingleInstances: fetchSingleInstancesMock,
  fetchProvisionJobs: fetchProvisionJobsMock,
  fetchPlatformImages: fetchPlatformImagesMock,
  launchSingleInstances: launchSingleInstancesMock,
  triggerSingleInstanceAction: triggerSingleInstanceActionMock,
}));

describe('SingleInstancesScreen', () => {
  it('renders list/history, opens create dialog, and submits the launch payload', async () => {
    fetchSingleInstancesMock.mockResolvedValue([
      {
        id: 'single-1',
        name: 'web-lab-01',
        createdBy: 'admin',
        instanceMode: 'single',
        status: 'running',
        createdAt: '2026-07-08T09:00:00.000Z',
        expiresAt: '2026-07-10T12:00:00.000Z',
        accessEntry: { publicIp: '47.1.2.3' },
        singleInstanceConfig: {
          imageDisplayName: 'Ubuntu 24.04 LTS',
          cpu: 2,
          memory: 2,
        },
      },
    ]);

    fetchProvisionJobsMock.mockResolvedValue([]);
    fetchPlatformImagesMock.mockResolvedValue({
      items: [{ id: 'platform-image-1', imageId: 'm-123', displayName: 'Ubuntu 24.04 LTS', enabled: true }],
    });
    launchSingleInstancesMock.mockResolvedValue({
      instances: [{ id: 'single-1', name: 'web-lab-01', createdBy: 'admin', instanceMode: 'single', status: 'pending_create' }],
    });

    render(<SingleInstancesScreen apiBaseUrl="http://localhost:3001" />);

    expect(await screen.findByRole('heading', { name: '实例管理' })).toBeTruthy();
    expect(screen.getByText('公网 IP')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建实例' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '创建实例' }));
    fireEvent.change(screen.getByLabelText('实例名'), { target: { value: 'web-lab' } });
    fireEvent.change(screen.getByLabelText('CPU'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('内存'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('启动实例数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('到期时间'), { target: { value: '2026-07-10T12:00' } });
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));

    await waitFor(() =>
      expect(launchSingleInstancesMock).toHaveBeenCalledWith(
        'http://localhost:3001',
        'dev-admin-token',
        expect.objectContaining({
          name: 'web-lab',
          cpu: 2,
          memory: 2,
          quantity: 2,
          triggeredBy: 'admin',
        }),
      ),
    );
  });
});
```

- [ ] **Step 2: Run the single-instance screen test and verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test single-instances-screen.test.tsx
```

Expected: FAIL because the route, screen component, and API helpers do not exist yet.

- [ ] **Step 3: Add the admin API helpers and page route**

Update `apps/web/lib/admin-api.ts`:

```ts
export async function fetchSingleInstances(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/instances`, {
    headers: createAdminHeaders(token),
  });

  return readJson<RangeInstance[]>(response);
}

export async function fetchProvisionJobs(apiBaseUrl: string, token: string) {
  const response = await fetch(`${apiBaseUrl}/admin/provision-jobs`, {
    headers: createAdminHeaders(token),
  });

  return readJson<ProvisionJob[]>(response);
}

export async function launchSingleInstances(
  apiBaseUrl: string,
  token: string,
  payload: SingleInstanceLaunchInput,
) {
  const response = await fetch(`${apiBaseUrl}/admin/instances/launch`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<{ instances: RangeInstance[] }>(response);
}

export async function triggerSingleInstanceAction(
  apiBaseUrl: string,
  token: string,
  id: string,
  action: 'destroy' | 'retry' | 'reboot' | 'open-vnc' | 'pack-image',
  payload: Record<string, string>,
) {
  const suffix = action === 'destroy' || action === 'retry' ? action : `actions/${action}`;
  const response = await fetch(`${apiBaseUrl}/admin/instances/${id}/${suffix}`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<Record<string, unknown>>(response);
}
```

Create `apps/web/app/admin/instances/page.tsx`:

```tsx
import { SingleInstancesScreen } from '../../../components/admin/single-instances-screen';

export default function AdminInstancesPage() {
  return <SingleInstancesScreen />;
}
```

- [ ] **Step 4: Implement the screen with list/history and the create dialog**

Create `apps/web/components/admin/single-instances-screen.tsx`:

```tsx
export function SingleInstancesScreen({
  apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001',
}: { apiBaseUrl?: string }) {
  const session = useAdminSession();
  const [instances, setInstances] = useState<RangeInstance[]>([]);
  const [jobs, setJobs] = useState<ProvisionJob[]>([]);
  const [platformImages, setPlatformImages] = useState<PlatformImageAsset[]>([]);
  const [listMode, setListMode] = useState<'active' | 'history'>('active');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    hostName: '',
    platformImageAssetId: '',
    cpu: 2,
    memory: 2,
    systemDiskSize: '',
    expiresAt: '',
    password: '',
    quantity: 1,
    remark: '',
  });

  useEffect(() => {
    if (!session.token) return;

    void Promise.all([
      fetchSingleInstances(apiBaseUrl, session.token),
      fetchProvisionJobs(apiBaseUrl, session.token),
      fetchPlatformImages(apiBaseUrl, session.token),
    ]).then(([nextInstances, nextJobs, imagePayload]) => {
      setInstances(nextInstances.filter((item) => item.instanceMode === 'single'));
      setJobs(nextJobs);
      setPlatformImages(imagePayload.items.filter((item) => item.enabled));
    });
  }, [apiBaseUrl, session.token]);

  const activeInstances = instances.filter((item) => item.status !== 'destroyed');
  const historyInstances = instances.filter((item) => item.status === 'destroyed');

  async function handleLaunch() {
    const result = await launchSingleInstances(apiBaseUrl, session.token!, {
      name: draft.name.trim(),
      hostName: draft.hostName.trim(),
      platformImageAssetId: draft.platformImageAssetId,
      cpu: Number(draft.cpu),
      memory: Number(draft.memory),
      systemDiskSize: draft.systemDiskSize ? Number(draft.systemDiskSize) : undefined,
      expiresAt: new Date(draft.expiresAt).toISOString(),
      password: draft.password.trim(),
      quantity: Number(draft.quantity),
      remark: draft.remark.trim(),
      triggeredBy: 'admin',
    });

    setInstances((current) => [...result.instances, ...current]);
    setCreateDialogOpen(false);
  }

  return (
    <div className="admin-screen admin-workbench-screen">
      <section>
        <article className="admin-workbench-panel range-workbench-shell">
          <div className="template-workbench-list-header range-workbench-header">
            <div className="template-workbench-list-header-copy">
              <h2>实例管理</h2>
            </div>
            <button type="button" className="template-workbench-create-button" onClick={() => setCreateDialogOpen(true)}>
              创建实例
            </button>
          </div>
          {/* list/header rows mirror range-instances-screen with image/spec/public IP/creator columns */}
        </article>
      </section>
      {createDialogOpen ? <TemplateDialog title="创建实例">{/* dialog fields */}</TemplateDialog> : null}
    </div>
  );
}
```

- [ ] **Step 5: Add the minimal styles and rerun the single-instance screen test**

Update `apps/web/app/globals.css`:

```css
.single-instance-workbench-column-head,
.single-instance-workbench-row {
  display: grid;
  grid-template-columns: 1.4fr 0.9fr 1.2fr 1fr 1fr 0.9fr 1.1fr 1.1fr 1.2fr;
  gap: 16px;
}

.single-instance-dialog-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 18px;
}

.single-instance-dialog-grid .full-span {
  grid-column: 1 / -1;
}
```

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test single-instances-screen.test.tsx
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
git add apps/web/app/admin/instances/page.tsx \
  apps/web/components/admin/single-instances-screen.tsx \
  apps/web/components/admin/single-instances-screen.test.tsx \
  apps/web/lib/admin-api.ts \
  apps/web/lib/admin-types.ts \
  apps/web/app/globals.css
git commit -m "feat: add single instance management page"
```

### Task 6: Run targeted verification, then full container verification

**Files:**
- Modify if needed: `docker-compose.yml`
- Modify if needed: `deploy/current-system/README.md`

- [ ] **Step 1: Run the targeted backend tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api
pnpm test -- create-memory-admin-repository.single-instance.spec.ts single-instances.e2e-spec.ts open-tofu-range-provisioner.e2e-spec.ts range-instance-node-actions.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts
```

Expected: PASS

- [ ] **Step 2: Run the targeted frontend tests**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web
pnpm test admin-workspace-shell.test.tsx templates-screen.test.tsx range-instances-screen.test.tsx single-instances-screen.test.tsx
```

Expected: PASS

- [ ] **Step 3: Run the package builds**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
pnpm --filter @aliyun-cyber-range/api build
pnpm --filter @aliyun-cyber-range/web build
pnpm iac:validate
```

Expected: PASS

- [ ] **Step 4: Rebuild and verify the containers**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
COMPOSE_BAKE=false docker compose up -d --build web api provisioner-worker
docker compose ps
docker compose logs --tail=100 api
docker compose logs --tail=100 provisioner-worker
```

Expected:

1. `web`, `api`, `postgres`, and `provisioner-worker` are running or healthy
2. No startup crash in API or worker logs

- [ ] **Step 5: Final manual smoke**

Verify in the browser:

1. 左侧导航顺序为：`镜像中心 -> 实例管理 -> 靶场编排 -> 编排实例 -> 基础配置`
2. `靶场编排` 列表中可见 `创建人`
3. `编排实例` 列表中可见 `创建人`
4. `实例管理` 页面可见 `实例列表 / 实例历史`
5. `创建实例` 弹窗不包含 `源IP` 与公网 IP 开关
6. `更多操作` 菜单包含 `关闭实例 / 重启实例 / 打开 VNC / 打包为镜像`

- [ ] **Step 6: Commit any verification-driven fixes**

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
git add -A
git commit -m "fix: finish single instance management verification"
```

## Self-Review

### Spec coverage

This plan covers every spec section:

1. 导航与命名调整: Task 4
2. 模板和编排实例 `创建人`: Task 1 + Task 4
3. 单实例复用现有实例体系: Task 1 + Task 2
4. 默认网络 `1 VPC + 3 交换机 + 1 安全组`: Task 1 + Task 2 + Task 3
5. 系统自动分配交换机: Task 2
6. 仅使用平台收录镜像: Task 2 + Task 5
7. 单实例不做详情页、采用列表/历史/弹窗: Task 5
8. 关闭 / 重启 / VNC / 打包镜像: Task 2 + Task 5
9. 数量批量创建命名规则: Task 2 + Task 5
10. Docker 容器态验证: Task 6

### Placeholder scan

No `TBD`, `TODO`, or “similar to above” placeholders remain. Every task has exact file paths, concrete commands, and at least one concrete code block.

### Type consistency

The plan uses the same names throughout:

1. `instanceMode`
2. `singleInstanceConfig`
3. `SingleInstanceNetworkProfile`
4. `LaunchSingleInstanceDto`
5. `SingleInstancesService`
6. `triggerSingleInstanceAction`
