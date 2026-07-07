# ECS Per-Node Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-ECS custom passwords to template orchestration, generate random per-instance passwords when left blank, persist final passwords on range instances, and pass node-level passwords through the OpenTofu provisioning chain.

**Architecture:** Keep template-time password intent in the topology graph as `customPassword`, convert it into host-level password data during template compilation and instance launch, and persist instance-final credentials separately from template data. Frontend and backend both share the same Aliyun ECS password validation semantics, while random password generation stays backend-only and is resolved during instance launch before OpenTofu rendering.

**Tech Stack:** Next.js App Router, React 19, Vitest, NestJS 11, Prisma/PostgreSQL, shared `@aliyun-cyber-range/scenario-runtime`, OpenTofu worker, Docker Compose.

---

## File Structure

### Shared password semantics

- Modify: `packages/scenario-runtime/src/scenario-graph.ts`
  - Add `customPassword?: string` to `EcsTemplateNode`.
- Modify: `packages/scenario-runtime/src/scenario-template-spec.ts`
  - Extend `ScenarioTemplateAccountPreset` to carry plain password data for internal admin use.
- Modify: `packages/scenario-runtime/src/compiled-provision-spec.ts`
  - Extend compiled host shape with per-host password payload.
- Modify: `packages/scenario-runtime/src/scenario-template-compiler.ts`
  - Copy host password intent from `scenarioTemplateSpec` into compiled spec.
- Create: `packages/scenario-runtime/src/password-policy.ts`
  - Shared Aliyun ECS password validation helpers used by web and api.
- Modify: `packages/scenario-runtime/src/index.ts`
  - Export password policy helpers.

### Template editor and template conversion

- Modify: `apps/web/components/admin/template-editor/template-property-panel.tsx`
  - Add `自定义密码` field, visibility toggle, inline validation, and leave-empty helper text.
- Modify: `apps/web/components/admin/template-editor/template-property-panel.test.tsx`
  - Cover valid, invalid, hidden, and visible password interactions.
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
  - Reject invalid ECS passwords during save/publish and keep node state synchronized.
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
  - Cover save/publish blocking when a password is invalid.
- Modify: `apps/web/lib/scenario-graph.ts`
  - Mirror the shared `customPassword` field in web-side graph typing.
- Modify: `apps/web/lib/template-topology-sync.ts`
  - Keep topology syncing intact while ignoring `customPassword` for legacy topologySpec shape.
- Modify: `packages/scenario-runtime/src/topology-graph-to-scenario-template.ts`
  - Carry node `customPassword` into `host.accountPreset.password`.

### Instance persistence and launch

- Modify: `packages/database/prisma/schema.prisma`
  - Add `runtimeCredentials Json?` to `RangeInstance`.
- Create: `packages/database/prisma/migrations/20260707_add_range_instance_runtime_credentials/migration.sql`
  - Persist `runtimeCredentials`.
- Modify: `apps/api/src/admin/admin.repository.ts`
  - Extend repository records and update payloads for `runtimeCredentials`.
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
  - Read and write `runtimeCredentials`.
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
  - Mirror `runtimeCredentials` support in the in-memory repository.
- Create: `apps/api/src/admin/ecs-password-generator.ts`
  - Backend-only random password generator that always satisfies Aliyun rules.
- Modify: `apps/api/src/admin/range-instances.service.ts`
  - Resolve per-host final passwords during `launch`, store `runtimeCredentials`, and return them on detail payloads.
- Modify: `apps/api/test/range-instance-launch.e2e-spec.ts`
  - Verify custom-password reuse and random-password generation behavior.

### OpenTofu rendering and instance creation

- Modify: `apps/api/src/provisioning/renderers/alibaba-cloud-opentofu-renderer.ts`
  - Accept host-level password map and emit it into rendered variables.
- Modify: `apps/api/src/provisioning/open-tofu-range-provisioner.ts`
  - Pass resolved host-level passwords into the renderer.
- Modify: `apps/api/src/provisioning/root-wrapper-template.ts`
  - Replace single `instance_password` variable with per-host password map variables.
- Modify: `apps/api/src/provisioning/provisioning.types.ts`
  - Thread the host-level password map through provisioner input types.
- Modify: `apps/api/test/open-tofu-range-provisioner.e2e-spec.ts`
  - Assert rendered tfvars contain per-host password values instead of a single global value.

### Instance detail display

- Modify: `apps/web/lib/admin-types.ts`
  - Add `runtimeCredentials` to range instance detail typing.
- Modify: `apps/web/components/admin/range-instance-detail-screen.tsx`
  - Prefer `runtimeCredentials[hostKey].password` when showing node passwords.
- Modify: `apps/web/components/admin/range-instance-detail-screen.test.tsx`
  - Verify detail view uses runtime credentials for custom and random password cases.
- Modify: `apps/web/components/admin/range-instance-node-directory.tsx`
  - Keep account/password rendering aligned with the new detail payload.

### Container verification

- Modify: `README.md`
  - Document template custom-password behavior and random-password fallback.

---

### Task 1: Add Shared Password Policy and Host Password Fields

**Files:**
- Create: `packages/scenario-runtime/src/password-policy.ts`
- Modify: `packages/scenario-runtime/src/scenario-graph.ts`
- Modify: `packages/scenario-runtime/src/scenario-template-spec.ts`
- Modify: `packages/scenario-runtime/src/compiled-provision-spec.ts`
- Modify: `packages/scenario-runtime/src/scenario-template-compiler.ts`
- Modify: `packages/scenario-runtime/src/index.ts`
- Test: `packages/scenario-runtime/src/password-policy.test.ts`

- [ ] **Step 1: Write the failing shared password policy test**

```ts
import { describe, expect, it } from 'vitest';

import { validateAliyunEcsPassword } from './password-policy';

describe('validateAliyunEcsPassword', () => {
  it('accepts passwords with three character classes and valid length', () => {
    expect(validateAliyunEcsPassword('ChangeMe123!')).toEqual({
      valid: true,
      message: null,
    });
  });

  it('rejects passwords that are too short', () => {
    expect(validateAliyunEcsPassword('Ab1!')).toEqual({
      valid: false,
      message: '密码长度需为 8 到 30 位',
    });
  });

  it('rejects passwords with fewer than three character classes', () => {
    expect(validateAliyunEcsPassword('abcdefgh')).toEqual({
      valid: false,
      message: '密码必须至少包含大写字母、小写字母、数字、特殊字符中的三类',
    });
  });
});
```

- [ ] **Step 2: Run the shared test to verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
pnpm exec vitest run packages/scenario-runtime/src/password-policy.test.ts
```

Expected: FAIL because `password-policy.ts` does not exist.

- [ ] **Step 3: Write the shared validation helpers and host password fields**

Create `packages/scenario-runtime/src/password-policy.ts`:

```ts
const SPECIAL_CHARACTER_PATTERN = /[()~!@#$%^&*\-_=+\[\]{}\\|;:'",<.>/?`]/;

export function validateAliyunEcsPassword(value: string) {
  if (value.length < 8 || value.length > 30) {
    return { valid: false as const, message: '密码长度需为 8 到 30 位' };
  }

  if (/\s/.test(value)) {
    return { valid: false as const, message: '密码不能包含空格' };
  }

  const classes = [
    /[A-Z]/.test(value),
    /[a-z]/.test(value),
    /\d/.test(value),
    SPECIAL_CHARACTER_PATTERN.test(value),
  ].filter(Boolean).length;

  if (classes < 3) {
    return {
      valid: false as const,
      message: '密码必须至少包含大写字母、小写字母、数字、特殊字符中的三类',
    };
  }

  return { valid: true as const, message: null };
}
```

Modify `packages/scenario-runtime/src/scenario-graph.ts`:

```ts
export type EcsTemplateNode = TemplateNodeBase & {
  kind: 'ecs';
  zoneKey: string;
  role: string;
  privateIp: string;
  exposePublic: boolean;
  image: string;
  customPassword?: string;
  instanceName?: string;
  hostName?: string;
  // ...keep existing fields unchanged
};
```

Modify `packages/scenario-runtime/src/scenario-template-spec.ts`:

```ts
export type ScenarioTemplateAccountPreset = {
  username?: string;
  password?: string;
  passwordSecretRef?: string;
};
```

Modify `packages/scenario-runtime/src/compiled-provision-spec.ts`:

```ts
export type CompiledHost = {
  key: string;
  name: string;
  role: string;
  zoneKey: string;
  primaryPrivateIp: string;
  exposePublic: boolean;
  accountPreset?: {
    username?: string;
    password?: string;
  };
  networkInterfaces: Array<{
    deviceIndex: number;
    zoneKey: string;
    privateIp: string;
    description?: string;
  }>;
  // ...keep existing fields unchanged
};
```

Modify `packages/scenario-runtime/src/scenario-template-compiler.ts`:

```ts
hosts: template.hosts.map((host) => ({
  key: host.key,
  name: host.name,
  role: host.role,
  zoneKey: host.zoneKey,
  primaryPrivateIp: host.primaryPrivateIp,
  exposePublic: Boolean(host.exposePublic),
  accountPreset: host.accountPreset
    ? {
        username: host.accountPreset.username,
        password: host.accountPreset.password,
      }
    : undefined,
  networkInterfaces:
    host.networkInterfaces?.map((networkInterface) => ({
      deviceIndex: networkInterface.deviceIndex,
      zoneKey: networkInterface.zoneKey,
      privateIp: networkInterface.privateIp,
      description: networkInterface.description,
    })) ?? [{ deviceIndex: 0, zoneKey: host.zoneKey, privateIp: host.primaryPrivateIp }],
  bootstrapScriptKey: host.bootstrapRef,
  imagePolicyKey: host.imagePolicyRef,
  instanceTypePolicyKey: host.instanceTypePolicyRef,
  tags: host.tags,
})),
```

Modify `packages/scenario-runtime/src/index.ts`:

```ts
export * from './password-policy';
```

- [ ] **Step 4: Run the shared test to verify it passes**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
pnpm exec vitest run packages/scenario-runtime/src/password-policy.test.ts
```

Expected: PASS with `3 passed`.

- [ ] **Step 5: Commit the shared password policy layer**

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
git add packages/scenario-runtime/src/password-policy.ts packages/scenario-runtime/src/scenario-graph.ts packages/scenario-runtime/src/scenario-template-spec.ts packages/scenario-runtime/src/compiled-provision-spec.ts packages/scenario-runtime/src/scenario-template-compiler.ts packages/scenario-runtime/src/index.ts packages/scenario-runtime/src/password-policy.test.ts
git commit -m "feat: add shared ecs password policy primitives"
```

### Task 2: Add Template ECS Custom Password UI and Validation

**Files:**
- Modify: `apps/web/lib/scenario-graph.ts`
- Modify: `apps/web/components/admin/template-editor/template-property-panel.tsx`
- Modify: `apps/web/components/admin/template-editor/template-property-panel.test.tsx`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- Modify: `packages/scenario-runtime/src/topology-graph-to-scenario-template.ts`

- [ ] **Step 1: Write the failing template property panel tests**

Add to `apps/web/components/admin/template-editor/template-property-panel.test.tsx`:

```tsx
it('renders the ecs custom password field with show and hide toggle', () => {
  renderPropertyPanel({
    selectedNode: buildEcsNode({ customPassword: 'ChangeMe123!' }),
  });

  expect(screen.getByLabelText('自定义密码')).toHaveAttribute('type', 'password');
  fireEvent.click(screen.getByRole('button', { name: '显示密码' }));
  expect(screen.getByLabelText('自定义密码')).toHaveAttribute('type', 'text');
});

it('shows validation feedback for an invalid ecs custom password', () => {
  renderPropertyPanel({
    selectedNode: buildEcsNode({ customPassword: 'abc' }),
  });

  expect(screen.getByText('密码长度需为 8 到 30 位')).toBeTruthy();
});
```

- [ ] **Step 2: Run the template property panel test to verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
apps/web/node_modules/.bin/vitest run --environment jsdom apps/web/components/admin/template-editor/template-property-panel.test.tsx
```

Expected: FAIL because the custom password field does not exist.

- [ ] **Step 3: Implement the custom password field and validation**

Modify `apps/web/lib/scenario-graph.ts`:

```ts
export type EcsTemplateNode = TemplateNodeBase & {
  kind: 'ecs';
  zoneKey: string;
  role: string;
  privateIp: string;
  exposePublic: boolean;
  image: string;
  customPassword?: string;
  instanceName?: string;
  hostName?: string;
  // ...keep the rest unchanged
};
```

Modify `packages/scenario-runtime/src/topology-graph-to-scenario-template.ts` host mapping:

```ts
accountPreset:
  node.customPassword && node.customPassword.trim().length > 0
    ? { username: 'root', password: node.customPassword.trim() }
    : undefined,
```

Modify `apps/web/components/admin/template-editor/template-property-panel.tsx` inside `renderHostFields(...)`:

```tsx
const [showPassword, setShowPassword] = useState(false);
const passwordValidation = selectedNode.customPassword
  ? validateAliyunEcsPassword(selectedNode.customPassword)
  : { valid: true, message: null };

<PropertyField
  label="自定义密码"
  hint={passwordValidation.message ?? '留空时，生成实例会为当前 ECS 自动生成随机密码'}
  className="template-property-field-full"
>
  <div className="template-password-field">
    <input
      aria-label="自定义密码"
      type={showPassword ? 'text' : 'password'}
      value={selectedNode.customPassword ?? ''}
      onChange={(event) =>
        onUpdateNode(selectedNode.id, {
          ...selectedNode,
          customPassword: event.target.value,
        })
      }
    />
    <button
      type="button"
      className="template-property-inline-button"
      aria-label={showPassword ? '隐藏密码' : '显示密码'}
      onClick={() => setShowPassword((current) => !current)}
    >
      {showPassword ? '隐藏' : '显示'}
    </button>
  </div>
</PropertyField>
{!passwordValidation.valid ? (
  <div className="template-property-warning-note" role="alert">
    {passwordValidation.message}
  </div>
) : null}
```

Modify `apps/web/components/admin/template-editor/template-editor-screen.tsx` before save/publish:

```ts
function findInvalidPasswordNode(nodes: TemplateNode[]) {
  return nodes.find((node) => {
    if (node.kind !== 'ecs' || !node.customPassword?.trim()) {
      return false;
    }

    return !validateAliyunEcsPassword(node.customPassword.trim()).valid;
  });
}

const invalidPasswordNode = findInvalidPasswordNode(draftTopologyGraph.nodes);

if (invalidPasswordNode) {
  setErrorMessage(`节点 ${invalidPasswordNode.label} 的自定义密码不符合阿里云 ECS 规则`);
  return;
}
```

- [ ] **Step 4: Run the template editor tests to verify they pass**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
apps/web/node_modules/.bin/vitest run --environment jsdom apps/web/components/admin/template-editor/template-property-panel.test.tsx apps/web/components/admin/template-editor/template-editor-screen.test.tsx
```

Expected: PASS with the new custom password assertions green.

- [ ] **Step 5: Commit the template-side password UI**

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
git add apps/web/lib/scenario-graph.ts apps/web/components/admin/template-editor/template-property-panel.tsx apps/web/components/admin/template-editor/template-property-panel.test.tsx apps/web/components/admin/template-editor/template-editor-screen.tsx apps/web/components/admin/template-editor/template-editor-screen.test.tsx packages/scenario-runtime/src/topology-graph-to-scenario-template.ts
git commit -m "feat: add template ecs custom password field"
```

### Task 3: Persist Instance Runtime Credentials and Return Them on Detail APIs

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260707_add_range_instance_runtime_credentials/migration.sql`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Modify: `apps/web/lib/admin-types.ts`
- Test: `apps/api/test/range-instance-launch.e2e-spec.ts`

- [ ] **Step 1: Write the failing backend detail test for runtime credentials**

Add to `apps/api/test/range-instance-launch.e2e-spec.ts`:

```ts
it('returns runtimeCredentials on the detail endpoint', async () => {
  const launchResponse = await request(app.getHttpServer())
    .post('/admin/ranges/launch')
    .set('authorization', 'Bearer dev-admin-token')
    .send({
      templateId,
      name: '带密码实例',
      expiresAt: '2026-07-10T12:00:00.000Z',
      triggeredBy: 'admin',
    })
    .expect(201);

  const detailResponse = await request(app.getHttpServer())
    .get(`/admin/ranges/${launchResponse.body.id}`)
    .set('authorization', 'Bearer dev-admin-token')
    .expect(200);

  expect(detailResponse.body.runtimeCredentials).toBeDefined();
});
```

- [ ] **Step 2: Run the backend test to verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
pnpm --filter @aliyun-cyber-range/api test -- --runInBand apps/api/test/range-instance-launch.e2e-spec.ts
```

Expected: FAIL because `runtimeCredentials` is not in the schema or response.

- [ ] **Step 3: Add runtime credentials persistence**

Modify `packages/database/prisma/schema.prisma`:

```prisma
model RangeInstance {
  id                         String   @id @default(cuid())
  name                       String
  // ...keep existing fields unchanged
  runtimeCredentials         Json?
  runtimeTopologyGraph       Json?
  runtimeScenarioTemplateSpec Json?
  runtimeCompiledProvisionSpec Json?
}
```

Create `packages/database/prisma/migrations/20260707_add_range_instance_runtime_credentials/migration.sql`:

```sql
ALTER TABLE "RangeInstance"
ADD COLUMN "runtimeCredentials" JSONB;
```

Modify `apps/api/src/admin/admin.repository.ts`:

```ts
export type RangeInstanceRecord = {
  // ...keep existing fields unchanged
  runtimeCredentials: Record<string, { username: string; password: string }> | null;
};

export type CreateRangeInstanceInput = {
  // ...keep existing fields unchanged
  runtimeCredentials?: Record<string, { username: string; password: string }> | null;
};

export type UpdateRangeInstanceInput = Partial<{
  runtimeCredentials: Record<string, { username: string; password: string }> | null;
}>;
```

Modify `apps/api/src/database/prisma-admin.repository.ts` create/update mapping:

```ts
runtimeCredentials: (input.runtimeCredentials ?? null) as Prisma.InputJsonValue | null,
```

Modify `apps/web/lib/admin-types.ts`:

```ts
export type RangeInstance = {
  id: string;
  // ...keep existing fields unchanged
  runtimeCredentials?: Record<string, { username: string; password: string }> | null;
};
```

- [ ] **Step 4: Run the backend test to verify it passes**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
pnpm --filter @aliyun-cyber-range/api test -- --runInBand apps/api/test/range-instance-launch.e2e-spec.ts
```

Expected: PASS with the detail endpoint now returning `runtimeCredentials`.

- [ ] **Step 5: Commit the runtime credentials persistence**

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260707_add_range_instance_runtime_credentials/migration.sql apps/api/src/admin/admin.repository.ts apps/api/src/database/prisma-admin.repository.ts apps/api/test/support/create-memory-admin-repository.ts apps/web/lib/admin-types.ts apps/api/test/range-instance-launch.e2e-spec.ts
git commit -m "feat: persist range instance runtime credentials"
```

### Task 4: Resolve Final Host Passwords During Launch

**Files:**
- Create: `apps/api/src/admin/ecs-password-generator.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Test: `apps/api/test/range-instance-launch.e2e-spec.ts`

- [ ] **Step 1: Write the failing launch test for custom and random passwords**

Add to `apps/api/test/range-instance-launch.e2e-spec.ts`:

```ts
it('reuses custom passwords and generates random passwords for blank nodes', async () => {
  const detailResponse = await request(app.getHttpServer())
    .post('/admin/ranges/launch')
    .set('authorization', 'Bearer dev-admin-token')
    .send({
      templateId: mixedPasswordTemplateId,
      name: '混合密码实例',
      expiresAt: '2026-07-11T12:00:00.000Z',
      triggeredBy: 'admin',
    })
    .expect(201);

  expect(detailResponse.body.runtimeCredentials['ecs-custom'].password).toBe('ChangeMe123!');
  expect(detailResponse.body.runtimeCredentials['ecs-random'].password).toMatch(/[A-Z]/);
  expect(detailResponse.body.runtimeCredentials['ecs-random'].password).not.toBe('ChangeMe123!');
});
```

- [ ] **Step 2: Run the launch test to verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
pnpm --filter @aliyun-cyber-range/api test -- --runInBand apps/api/test/range-instance-launch.e2e-spec.ts
```

Expected: FAIL because `launch` still uses the single global password path.

- [ ] **Step 3: Implement password resolution and random generation**

Create `apps/api/src/admin/ecs-password-generator.ts`:

```ts
import { randomInt } from 'node:crypto';

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SPECIAL = '!@#$%^&*()-_=+';

function pick(source: string) {
  return source[randomInt(0, source.length)]!;
}

export function generateAliyunEcsPassword() {
  const seed = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SPECIAL)];
  const full = UPPER + LOWER + DIGITS + SPECIAL;

  while (seed.length < 16) {
    seed.push(pick(full));
  }

  return seed.sort(() => randomInt(0, 2) - 0.5).join('');
}
```

Modify `apps/api/src/admin/range-instances.service.ts`:

```ts
function readHostPasswordTemplateValue(host: Record<string, unknown>) {
  const accountPreset =
    host.accountPreset && typeof host.accountPreset === 'object'
      ? (host.accountPreset as Record<string, unknown>)
      : null;

  return typeof accountPreset?.password === 'string' && accountPreset.password.trim()
    ? accountPreset.password.trim()
    : null;
}

function buildRuntimeCredentials(spec: Record<string, unknown> | null) {
  const hosts = Array.isArray(spec?.hosts) ? (spec?.hosts as Array<Record<string, unknown>>) : [];

  return Object.fromEntries(
    hosts.map((host) => {
      const key = String(host.key);
      const resolvedPassword = readHostPasswordTemplateValue(host) ?? generateAliyunEcsPassword();

      return [
        key,
        {
          username: 'root',
          password: resolvedPassword,
        },
      ];
    }),
  );
}

const runtimeCredentials = buildRuntimeCredentials(
  (sourceTemplateVersion.scenarioTemplateSpec ?? template.scenarioTemplateSpec ?? null) as Record<string, unknown> | null,
);

const instance = await this.adminRepository.createRangeInstance({
  name: input.name,
  createdBy: input.triggeredBy,
  templateId: template.id,
  sourceTemplateVersionId: sourceTemplateVersion.id,
  runtimeCredentials,
  runtimeTopologyGraph: sourceTemplateVersion.topologyGraph ?? template.topologyGraph ?? null,
  runtimeScenarioTemplateSpec: sourceTemplateVersion.scenarioTemplateSpec ?? template.scenarioTemplateSpec ?? null,
  runtimeCompiledProvisionSpec:
    sourceTemplateVersion.compiledProvisionSpec ?? template.compiledProvisionSpec ?? null,
  status: 'pending_create',
  expiresAt: input.expiresAt,
});
```

- [ ] **Step 4: Run the launch test to verify it passes**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
pnpm --filter @aliyun-cyber-range/api test -- --runInBand apps/api/test/range-instance-launch.e2e-spec.ts
```

Expected: PASS with runtime credentials created for both custom and random cases.

- [ ] **Step 5: Commit the launch password resolution**

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
git add apps/api/src/admin/ecs-password-generator.ts apps/api/src/admin/range-instances.service.ts apps/api/test/range-instance-launch.e2e-spec.ts
git commit -m "feat: resolve per-host passwords during launch"
```

### Task 5: Pass Per-Host Passwords Into OpenTofu Rendering

**Files:**
- Modify: `apps/api/src/provisioning/provisioning.types.ts`
- Modify: `apps/api/src/provisioning/open-tofu-range-provisioner.ts`
- Modify: `apps/api/src/provisioning/renderers/alibaba-cloud-opentofu-renderer.ts`
- Modify: `apps/api/src/provisioning/root-wrapper-template.ts`
- Test: `apps/api/test/open-tofu-range-provisioner.e2e-spec.ts`

- [ ] **Step 1: Write the failing provisioner render test**

Add to `apps/api/test/open-tofu-range-provisioner.e2e-spec.ts`:

```ts
it('renders host-level passwords into the generated tfvars payload', async () => {
  const result = await provisioner.create({
    rangeInstanceId: 'range-1',
    compiledProvisionSpec,
    runtimeCredentials: {
      'ecs-1': { username: 'root', password: 'ChangeMe123!' },
      'ecs-2': { username: 'root', password: 'SecondPass123!' },
    },
  });

  expect(result.renderedVariables.host_passwords).toEqual({
    'ecs-1': 'ChangeMe123!',
    'ecs-2': 'SecondPass123!',
  });
});
```

- [ ] **Step 2: Run the provisioner test to verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
pnpm --filter @aliyun-cyber-range/api test -- --runInBand apps/api/test/open-tofu-range-provisioner.e2e-spec.ts
```

Expected: FAIL because the renderer only accepts a single `instance_password`.

- [ ] **Step 3: Implement host-level password rendering**

Modify `apps/api/src/provisioning/provisioning.types.ts`:

```ts
export type RangeProvisionCreateInput = {
  rangeInstanceId: string;
  compiledProvisionSpec: Record<string, unknown>;
  runtimeCredentials: Record<string, { username: string; password: string }>;
  // ...keep existing fields unchanged
};
```

Modify `apps/api/src/provisioning/open-tofu-range-provisioner.ts`:

```ts
const hostPasswords = Object.fromEntries(
  Object.entries(input.runtimeCredentials).map(([hostKey, credential]) => [hostKey, credential.password]),
);

return this.renderer.render({
  plan,
  rangeInstanceId: input.rangeInstanceId,
  zoneId,
  instanceType,
  hostInstanceTypes,
  imageId,
  hostImageIds,
  hostPasswords,
  allowedIngressCidr: this.env.OPENTOFU_ALLOWED_INGRESS_CIDR ?? '0.0.0.0/0',
});
```

Modify `apps/api/src/provisioning/renderers/alibaba-cloud-opentofu-renderer.ts`:

```ts
type AlibabaCloudRendererInput = {
  // ...keep existing fields unchanged
  hostPasswords: Record<string, string>;
};

host_passwords: input.hostPasswords,
```

Modify `apps/api/src/provisioning/root-wrapper-template.ts`:

```ts
'  host_passwords          = var.host_passwords',

variable "host_passwords" {
  type        = map(string)
  description = "Per-host instance passwords."
}
```

- [ ] **Step 4: Run the provisioner render test to verify it passes**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
pnpm --filter @aliyun-cyber-range/api test -- --runInBand apps/api/test/open-tofu-range-provisioner.e2e-spec.ts
```

Expected: PASS with host-level password data present in rendered variables.

- [ ] **Step 5: Commit the OpenTofu password rendering changes**

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
git add apps/api/src/provisioning/provisioning.types.ts apps/api/src/provisioning/open-tofu-range-provisioner.ts apps/api/src/provisioning/renderers/alibaba-cloud-opentofu-renderer.ts apps/api/src/provisioning/root-wrapper-template.ts apps/api/test/open-tofu-range-provisioner.e2e-spec.ts
git commit -m "feat: render per-host ecs passwords for opentofu"
```

### Task 6: Show Instance-Final Passwords in the Detail Workbench

**Files:**
- Modify: `apps/web/components/admin/range-instance-detail-screen.tsx`
- Modify: `apps/web/components/admin/range-instance-node-directory.tsx`
- Modify: `apps/web/components/admin/range-instance-detail-screen.test.tsx`

- [ ] **Step 1: Write the failing detail-view password tests**

Add to `apps/web/components/admin/range-instance-detail-screen.test.tsx`:

```tsx
it('uses runtimeCredentials over global fallback values in node directory and property panel', async () => {
  fetchRangeInstanceDetailMock.mockResolvedValue({
    id: 'range-1',
    name: '攻防实例',
    status: 'running',
    createdBy: 'admin',
    runtimeCredentials: {
      'host-1': { username: 'root', password: 'ChangeMe123!' },
    },
    runtimeTopologyGraph: {
      schemaVersion: '1',
      nodes: [{ id: 'host-1', kind: 'ecs', data: { label: 'ECS 1' } }],
      edges: [],
    },
  });

  render(<RangeInstanceDetailScreen rangeId="range-1" apiBaseUrl="http://localhost:3001" />);

  expect(await screen.findByText('root/ChangeMe123!')).toBeTruthy();
});
```

- [ ] **Step 2: Run the detail screen test to verify it fails**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
apps/web/node_modules/.bin/vitest run --environment jsdom apps/web/components/admin/range-instance-detail-screen.test.tsx
```

Expected: FAIL because `runtimeCredentials` is not used yet.

- [ ] **Step 3: Implement runtime credential display**

Modify `apps/web/components/admin/range-instance-detail-screen.tsx`:

```tsx
function readRuntimeCredential(
  detail: RangeInstanceDetail | null,
  nodeId: string,
) {
  const candidate = detail?.runtimeCredentials?.[nodeId];

  if (!candidate) {
    return null;
  }

  return {
    username: candidate.username?.trim() || 'root',
    password: candidate.password?.trim() || '待回填',
  };
}

const runtimeCredential = kind === 'ecs' ? readRuntimeCredential(detail, id) : null;

account: kind === 'ecs' ? runtimeCredential?.username ?? detectDefaultAccount(node) : '-',
password: kind === 'ecs' ? runtimeCredential?.password ?? readNodeCredential(node, detail) : '-',
```

Modify `apps/web/components/admin/range-instance-node-directory.tsx` only if needed to keep rendering as:

```tsx
<strong>
  {node.account ?? '暂无'}/{node.password ?? '暂无'}
</strong>
```

- [ ] **Step 4: Run the detail screen test to verify it passes**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
apps/web/node_modules/.bin/vitest run --environment jsdom apps/web/components/admin/range-instance-detail-screen.test.tsx apps/web/components/admin/range-instances-screen.test.tsx
```

Expected: PASS with runtime credential display assertions green.

- [ ] **Step 5: Commit the detail password display changes**

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
git add apps/web/components/admin/range-instance-detail-screen.tsx apps/web/components/admin/range-instance-node-directory.tsx apps/web/components/admin/range-instance-detail-screen.test.tsx
git commit -m "feat: show instance-final ecs passwords in detail workbench"
```

### Task 7: Container-First End-to-End Verification and Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the final behavior**

Add to `README.md`:

```md
### ECS 密码策略

- 模板编排页中，每台 ECS 都可以配置“自定义密码”
- 若留空，生成实例时会为该 ECS 自动生成随机密码
- 若填写，则该密码会保存在模板中，并在后续实例创建时复用
- 实例详情页始终展示该实例真实使用的节点密码
```

- [ ] **Step 2: Run focused frontend and backend tests before container rebuild**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
apps/web/node_modules/.bin/vitest run --environment jsdom apps/web/components/admin/template-editor/template-property-panel.test.tsx apps/web/components/admin/template-editor/template-editor-screen.test.tsx apps/web/components/admin/range-instance-detail-screen.test.tsx apps/web/components/admin/range-instances-screen.test.tsx
pnpm --filter @aliyun-cyber-range/api test -- --runInBand apps/api/test/range-instance-launch.e2e-spec.ts apps/api/test/open-tofu-range-provisioner.e2e-spec.ts
```

Expected: PASS with all targeted tests green.

- [ ] **Step 3: Rebuild api and web containers for container-first validation**

Run:

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
COMPOSE_BAKE=false docker compose up -d --build api web
docker compose ps api web provisioner-worker
```

Expected: `for-api-1` healthy, `for-web-1` up, `for-provisioner-worker-1` up.

- [ ] **Step 4: Verify the containerized UI and API behavior**

Run:

```bash
TOKEN=$(python - <<'PY'
from pathlib import Path
for line in Path('/Users/yym/Documents/阿里云For综合靶场竞赛平台/.env').read_text().splitlines():
    if line.startswith('ADMIN_TOKEN='):
        print(line.split('=', 1)[1].strip())
        break
PY
)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3001/admin/ranges/<range-id>
```

Expected API facts:

```json
{
  "runtimeCredentials": {
    "ecs-1": {
      "username": "root",
      "password": "<custom-or-random-password>"
    }
  }
}
```

Manual UI expectations on `http://127.0.0.1:3000/admin/scenarios/<scenarioId>` and `http://127.0.0.1:3000/admin/ranges/<rangeId>`:

1. 编排页 ECS 属性面板出现 `自定义密码`
2. 非法密码立即显示错误
3. 留空提示“会随机生成”
4. 实例详情页 `账号信息` 显示真实实例密码

- [ ] **Step 5: Commit documentation and verification touch-ups**

```bash
cd /Users/yym/Documents/阿里云For综合靶场竞赛平台
git add README.md
git commit -m "docs: describe ecs custom password behavior"
```

---

## Self-Review

### Spec coverage

1. 模板编排页 `自定义密码` 字段：Task 2
2. 实时校验与显示/隐藏：Task 1 + Task 2
3. 留空时实例创建随机密码：Task 4
4. 自定义密码保存在模板中并复用：Task 1 + Task 2 + Task 4
5. 实例级最终密码持久化：Task 3 + Task 4
6. 实例详情展示真实密码：Task 6
7. OpenTofu 从单密码切到多密码：Task 5
8. 容器态验证：Task 7

### Placeholder scan

1. No `TODO` / `TBD`
2. All commands use exact file paths
3. All code-changing steps include concrete code snippets

### Type consistency

1. Template graph field name: `customPassword`
2. Scenario template / compiled host field name: `accountPreset.password`
3. Instance-final persisted field name: `runtimeCredentials`
4. Renderer input field name: `hostPasswords`

