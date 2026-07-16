# Platform MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不绕过现有平台 API、资源归属和任务状态机的前提下，交付基于 Keycloak OAuth 用户委托的远程 MCP Server，并开放设计文档确认的 19 个首期工具。

**Architecture:** 新增独立 `apps/mcp` Streamable HTTP Gateway，使用 Keycloak 验证 `aud=mcp` Token，再通过 Token Exchange 获取 `aud=platform-api` 的用户委托 Token。平台 API 继续作为唯一业务入口，并新增 OIDC 身份映射、详情/凭据 DTO、确认、幂等和统一审计；Worker 继续处理异步云资源任务。

**Tech Stack:** Node.js 22、TypeScript 5.9、NestJS 11、Next.js 15、Prisma 6、PostgreSQL 16、Keycloak 26.7.0、`@modelcontextprotocol/sdk` 1.29.0、Express 5、Zod 4、JOSE 6、Docker Compose

---

## Execution Rules

1. 所有测试、构建、启动和回归都在 Docker 容器中执行。
2. 每次修改 API、Web、Worker 或 MCP 行为后，先重建对应镜像再运行测试。
3. 计划中的 Commit 步骤只是建议检查点；只有用户明确要求提交时才执行。
4. 不执行真实阿里云 Smoke Test，除非容器 dry-run 和模拟 RPC 全部通过且用户再次确认。
5. 不把账号密码、VNC URL、OAuth Token、Keycloak Secret 或阿里云密钥写入测试快照和日志。
6. `apps/mcp` 只依赖平台 API Client 和协议 DTO，不导入数据库、Worker、OpenTofu 或阿里云 SDK，也不持有云凭据。

## File Map

### Database and API

- `packages/database/prisma/schema.prisma`：OIDC 身份、确认、审计和幂等模型
- `packages/database/prisma/migrations/20260714_add_oidc_and_mcp_operations/migration.sql`：数据库迁移
- `apps/api/src/auth/request-auth-context.ts`：统一请求身份上下文
- `apps/api/src/auth/oidc-access-token-verifier.ts`：API Audience JWT 验证
- `apps/api/src/auth/composite-token-authenticator.ts`：OIDC 与开发期本地会话兼容
- `apps/api/src/auth/keycloak-admin.client.ts`：平台用户与 Keycloak 同步
- `apps/api/src/operations/operation-control.service.ts`：确认、幂等和审计编排
- `apps/api/src/operations/operation-audit.service.ts`：只追加审计事件
- `apps/api/src/operations/operation-confirmation.service.ts`：确认记录生成与消费
- `apps/api/src/operations/idempotent-operation.service.ts`：数据库幂等
- `apps/api/src/admin/admin-session.controller.ts`：当前 OIDC 用户 Profile 入口
- `apps/api/src/admin/*`：现有模板、镜像、实例和任务服务的最小扩展

### Web

- `apps/web/lib/keycloak-client.ts`：Keycloak JS 配置
- `apps/web/components/admin/use-admin-session.ts`：OIDC Token/Profile 生命周期
- `apps/web/components/auth/admin-login-screen.tsx`：重定向 Keycloak 登录
- `apps/web/lib/admin-auth-storage.ts`：迁移期会话存储兼容

### MCP

- `packages/platform-api-client/`：服务端平台 API Client 和稳定 DTO
- `apps/mcp/src/auth/`：MCP Token 验证与 Token Exchange
- `apps/mcp/src/server.ts`：MCP Server 和会话工厂
- `apps/mcp/src/http-app.ts`：OAuth 元数据、Streamable HTTP 和健康检查
- `apps/mcp/src/tools/`：19 个首期工具，按模板、镜像、综合靶场、单实例和任务分文件
- `apps/mcp/Dockerfile`：MCP 容器镜像

### Deployment and Validation

- `infra/keycloak/cyber-range-realm.json`：开发/测试 Realm
- `scripts/docker/init-keycloak-db.sh`：开发 PostgreSQL 中初始化独立 Keycloak 数据库
- `docker-compose.yml`：Keycloak、MCP 和容器验收服务
- `.env.example`：无生产秘密的配置清单
- `test/mcp-container-smoke.test.mjs`：容器态协议与审计 Smoke Test

---

### Task 1: Add OIDC and MCP operation database models

**Files:**
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/database/test/schema-config.test.mjs`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/database/prisma/schema.prisma`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/database/prisma/migrations/20260714_add_oidc_and_mcp_operations/migration.sql`

- [ ] **Step 1: Extend the schema contract test first**

Add model extraction and concrete assertions:

```javascript
const operationConfirmation = extractSchemaBlock(schema, 'model', 'OperationConfirmation');
const idempotentOperation = extractSchemaBlock(schema, 'model', 'IdempotentOperation');
const operationAuditEvent = extractSchemaBlock(schema, 'model', 'OperationAuditEvent');

assert.match(platformUser, /oidcIssuer\s+String\?/);
assert.match(platformUser, /oidcSubject\s+String\?/);
assert.match(platformUser, /@@unique\(\[oidcIssuer,\s*oidcSubject\]\)/);
assert.match(operationConfirmation, /argumentsHash\s+String/);
assert.match(operationConfirmation, /consumedAt\s+DateTime\?/);
assert.match(idempotentOperation, /@@unique\(\[actorUserId,\s*toolName,\s*idempotencyKey\]\)/);
assert.match(operationAuditEvent, /source\s+OperationSource/);
assert.match(operationAuditEvent, /phase\s+OperationAuditPhase/);
assert.match(operationAuditEvent, /sanitizedInput\s+Json\?/);
```

- [ ] **Step 2: Build the API image and run the database contract test to verify failure**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/database test"
```

Expected:

```text
FAIL expected model OperationConfirmation block
```

- [ ] **Step 3: Add Prisma enums and models**

Add these enums:

```prisma
enum OperationSource {
  web
  mcp
  system
}

enum OperationAuditPhase {
  requested
  confirmation_required
  confirmed
  dispatched
  succeeded
  failed
}

enum IdempotentOperationStatus {
  accepted
  succeeded
  failed
}
```

Extend `PlatformUser`:

```prisma
model PlatformUser {
  id                    String                  @id
  username              String                  @unique
  passwordHash          String
  oidcIssuer            String?
  oidcSubject           String?
  role                  UserRole                @default(user)
  status                UserStatus              @default(active)
  createdAt             DateTime                @default(now())
  updatedAt             DateTime                @updatedAt
  platformImageAssets   PlatformImageAsset[]
  rangeTemplates        RangeTemplate[]
  rangeInstances        RangeInstance[]
  singleInstanceBatches SingleInstanceBatch[]

  @@unique([oidcIssuer, oidcSubject])
  @@index([oidcSubject])
}
```

Add the operation models:

```prisma
model OperationConfirmation {
  id             String   @id @default(cuid())
  actorUserId    String
  oauthClientId  String
  toolName       String
  argumentsHash  String
  targetSnapshot Json?
  idempotencyKey String
  expiresAt      DateTime
  consumedAt     DateTime?
  createdAt      DateTime @default(now())

  @@index([actorUserId, createdAt])
  @@index([expiresAt])
}

model IdempotentOperation {
  id             String                    @id @default(cuid())
  actorUserId    String
  toolName       String
  idempotencyKey String
  argumentsHash  String
  operationId    String                    @unique
  status         IdempotentOperationStatus @default(accepted)
  result         Json?
  errorCode      String?
  createdAt      DateTime                  @default(now())
  updatedAt      DateTime                  @updatedAt

  @@unique([actorUserId, toolName, idempotencyKey])
  @@index([status, updatedAt])
}

model OperationAuditEvent {
  id             String              @id @default(cuid())
  operationId    String
  requestId      String
  actorUserId    String
  source         OperationSource
  oauthClientId  String?
  toolName       String
  phase          OperationAuditPhase
  targetType     String?
  targetId       String?
  sanitizedInput Json?
  jobId          String?
  errorCode      String?
  durationMs     Int?
  createdAt      DateTime            @default(now())

  @@index([operationId, createdAt])
  @@index([actorUserId, createdAt])
  @@index([source, createdAt])
  @@index([targetType, targetId, createdAt])
}
```

- [ ] **Step 4: Add the SQL migration with database-enforced uniqueness**

Create `migration.sql` with matching enum/table/index statements. The migration must include:

```sql
ALTER TABLE "PlatformUser"
ADD COLUMN "oidcIssuer" TEXT,
ADD COLUMN "oidcSubject" TEXT;

CREATE UNIQUE INDEX "PlatformUser_oidcIssuer_oidcSubject_key"
ON "PlatformUser"("oidcIssuer", "oidcSubject");

CREATE UNIQUE INDEX "IdempotentOperation_actorUserId_toolName_idempotencyKey_key"
ON "IdempotentOperation"("actorUserId", "toolName", "idempotencyKey");
```

Create all three operation tables and all indexes declared in Prisma. Do not add cascading foreign keys from audit records to mutable business records; history must survive resource deletion.

- [ ] **Step 5: Rebuild and validate Prisma inside the API container**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/database prisma:generate && pnpm --filter @aliyun-cyber-range/database test"
```

Expected:

```text
prisma validate succeeds
database schema tests pass
```

- [ ] **Step 6: Commit checkpoint if explicitly requested**

```bash
git add packages/database/prisma packages/database/test/schema-config.test.mjs
git commit -m "feat: add oidc and mcp operation models"
```

### Task 2: Extend repository contracts for identity and operation persistence

**Files:**
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/admin.repository.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/database/prisma-admin.repository.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/support/create-memory-admin-repository.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/operation-repository.spec.ts`

- [ ] **Step 1: Write repository behavior tests**

Cover OIDC lookup, one-time confirmations, idempotency conflicts, and append-only audit ordering:

```typescript
it('consumes an operation confirmation only once', async () => {
  const repository = createMemoryAdminRepository();
  const confirmation = await repository.createOperationConfirmation({
    actorUserId: 'alice',
    oauthClientId: 'codex',
    toolName: 'range_instance_destroy',
    argumentsHash: 'hash-1',
    targetSnapshot: { rangeInstanceId: 'range-1', status: 'running' },
    idempotencyKey: 'idem-1',
    expiresAt: new Date('2026-07-14T12:05:00.000Z'),
  });

  expect(await repository.consumeOperationConfirmation(confirmation.id, new Date('2026-07-14T12:00:00.000Z'))).toMatchObject({
    id: confirmation.id,
    consumedAt: expect.any(Date),
  });
  expect(await repository.consumeOperationConfirmation(confirmation.id, new Date('2026-07-14T12:00:01.000Z'))).toBeNull();
});

it('returns the existing idempotent operation for the same actor tool and key', async () => {
  const repository = createMemoryAdminRepository();
  const first = await repository.createIdempotentOperation({
    actorUserId: 'alice',
    toolName: 'range_instance_launch',
    idempotencyKey: 'idem-1',
    argumentsHash: 'hash-1',
    operationId: 'op-1',
  });

  expect(await repository.getIdempotentOperation('alice', 'range_instance_launch', 'idem-1')).toEqual(first);
});
```

- [ ] **Step 2: Rebuild the API image and verify the new tests fail**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/operation-repository.spec.ts"
```

Expected:

```text
FAIL createOperationConfirmation is not defined
```

- [ ] **Step 3: Add repository record/input types and methods**

Add concrete contracts to `AdminRepository`:

```typescript
export type OperationConfirmationRecord = {
  id: string;
  actorUserId: string;
  oauthClientId: string;
  toolName: string;
  argumentsHash: string;
  targetSnapshot: Record<string, unknown> | null;
  idempotencyKey: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

export type OperationAuditEventInput = {
  operationId: string;
  requestId: string;
  actorUserId: string;
  source: 'web' | 'mcp' | 'system';
  oauthClientId?: string | null;
  toolName: string;
  phase: 'requested' | 'confirmation_required' | 'confirmed' | 'dispatched' | 'succeeded' | 'failed';
  targetType?: string | null;
  targetId?: string | null;
  sanitizedInput?: Record<string, unknown> | null;
  jobId?: string | null;
  errorCode?: string | null;
  durationMs?: number | null;
};

export type ListOperationAuditHistoryInput = {
  actorUserId?: string;
  operationId?: string;
  targetType?: 'range_instance' | 'single_instance';
  targetId?: string;
  cursor?: string;
  limit: number;
};
```

Add methods for:

```typescript
getPlatformUserByOidcIdentity(issuer: string, subject: string): Promise<PlatformUserRecord | null>;
linkPlatformUserOidcIdentity(userId: string, issuer: string, subject: string): Promise<PlatformUserRecord>;
createOperationConfirmation(input: CreateOperationConfirmationInput): Promise<OperationConfirmationRecord>;
getOperationConfirmationById(id: string): Promise<OperationConfirmationRecord | null>;
consumeOperationConfirmation(id: string, consumedAt: Date): Promise<OperationConfirmationRecord | null>;
createIdempotentOperation(input: CreateIdempotentOperationInput): Promise<IdempotentOperationRecord>;
getIdempotentOperation(actorUserId: string, toolName: string, idempotencyKey: string): Promise<IdempotentOperationRecord | null>;
updateIdempotentOperation(id: string, input: UpdateIdempotentOperationInput): Promise<IdempotentOperationRecord>;
appendOperationAuditEvent(input: OperationAuditEventInput): Promise<OperationAuditEventRecord>;
listOperationAuditEvents(operationId: string): Promise<OperationAuditEventRecord[]>;
listOperationAuditEventsByTarget(targetType: string, targetId: string): Promise<OperationAuditEventRecord[]>;
listOperationAuditHistory(input: ListOperationAuditHistoryInput): Promise<OperationAuditEventRecord[]>;
getDispatchedOperationByJobId(jobId: string): Promise<OperationAuditEventRecord | null>;
```

- [ ] **Step 4: Implement Prisma and memory repositories**

Use an atomic `updateMany` for confirmation consumption:

```typescript
const result = await this.prisma.operationConfirmation.updateMany({
  where: {
    id,
    consumedAt: null,
    expiresAt: { gt: consumedAt },
  },
  data: { consumedAt },
});

if (result.count !== 1) {
  return null;
}

return this.prisma.operationConfirmation.findUnique({ where: { id } });
```

Convert Prisma JSON values at the repository boundary; services must receive plain `Record<string, unknown> | null` values.

Implement `listOperationAuditHistory()` with descending `createdAt, id` ordering, a maximum page size of 100, and an opaque cursor based on the unique event ID. Apply every supplied actor, operation and target filter in the database query rather than filtering after pagination.

- [ ] **Step 5: Run repository and existing multi-user tests**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/operation-repository.spec.ts test/create-memory-admin-repository.multi-user.spec.ts test/prisma-admin-repository.multi-user.e2e-spec.ts"
```

Expected:

```text
PASS operation-repository.spec.ts
PASS create-memory-admin-repository.multi-user.spec.ts
PASS prisma-admin-repository.multi-user.e2e-spec.ts
```

- [ ] **Step 6: Commit checkpoint if explicitly requested**

```bash
git add apps/api/src/admin/admin.repository.ts apps/api/src/database/prisma-admin.repository.ts apps/api/test/support/create-memory-admin-repository.ts apps/api/test/operation-repository.spec.ts
git commit -m "feat: persist mcp operation state"
```

### Task 3: Add API OIDC authentication with development local-session fallback

**Files:**
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/package.json`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/auth/request-auth-context.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/auth/oidc-access-token-verifier.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/auth/composite-token-authenticator.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/admin-auth.guard.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/admin-session.controller.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/platform-images.controller.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/app.module.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/oidc-auth.e2e-spec.ts`

- [ ] **Step 1: Write OIDC guard tests using a local test JWKS**

Create tests for valid API Audience, wrong Audience, expired Token, unknown Subject, disabled user, and MCP source derivation:

```typescript
it('authenticates a delegated mcp token and attaches the platform user', async () => {
  const token = await issueTestToken({
    issuer: testIssuer,
    audience: 'platform-api',
    subject: 'keycloak-alice',
    authorizedParty: 'mcp-gateway',
    scope: 'ranges:read ranges:create',
  });

  const response = await request(app.getHttpServer())
    .get('/admin/ranges')
    .set('authorization', `Bearer ${token}`)
    .expect(200);

  expect(response.headers['x-request-id']).toEqual(expect.any(String));
});

it('rejects an mcp audience token at the platform api', async () => {
  const token = await issueTestToken({ issuer: testIssuer, audience: 'mcp', subject: 'keycloak-alice' });

  await request(app.getHttpServer())
    .get('/admin/ranges')
    .set('authorization', `Bearer ${token}`)
    .expect(401);
});

it('returns the platform profile from the oidc identity', async () => {
  const response = await request(app.getHttpServer())
    .get('/admin/session/me')
    .set('authorization', `Bearer ${aliceToken}`)
    .expect(200);

  expect(response.body).toEqual({ id: 'alice', username: 'alice', role: 'user' });
});
```

- [ ] **Step 2: Rebuild and run the OIDC test to verify failure**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/oidc-auth.e2e-spec.ts"
```

Expected:

```text
FAIL OIDC token is rejected by the local-session-only guard
```

- [ ] **Step 3: Add `jose` and define the request auth context**

Add `jose` to API dependencies and define:

```typescript
export type RequestAuthContext = {
  user: SessionUserProfile;
  source: 'web' | 'mcp';
  oauthClientId: string | null;
  scopes: string[];
  issuer: string | null;
  subject: string;
};

export type AuthenticatedPlatformRequest = {
  headers: Record<string, string | undefined>;
  originalUrl?: string;
  url?: string;
  method?: string;
  adminUser: SessionUserProfile;
  authContext: RequestAuthContext;
};
```

- [ ] **Step 4: Implement strict OIDC verification**

Use `createRemoteJWKSet` and `jwtVerify`:

```typescript
const result = await jwtVerify(token, this.jwks, {
  issuer: this.issuer,
  audience: 'platform-api',
  algorithms: ['RS256'],
});

const subject = result.payload.sub;
const oauthClientId = readAuthorizedParty(result.payload);
const scopes = readScopes(result.payload.scope);

if (!subject || !oauthClientId) {
  throw new UnauthorizedException('Missing or invalid access token');
}
```

Resolve the platform user by `iss + sub`, require `status === 'active'`, and derive `source='mcp'` only when `azp === MCP_GATEWAY_CLIENT_ID`. Other OIDC clients are `source='web'`.

- [ ] **Step 5: Implement the composite authenticator and simplify the guard**

Production behavior:

```typescript
if (looksLikeJwt(token)) {
  return this.oidcVerifier.verify(token);
}

if (process.env.ALLOW_LOCAL_AUTH !== 'true') {
  throw new UnauthorizedException('Missing or invalid access token');
}

return this.verifyLocalSession(token);
```

`AdminAuthGuard` must attach both `request.adminUser` and `request.authContext`. Keep existing route-level admin/user rules unchanged.

Remove `PlatformImagesController.authenticateUser()` and use `request.adminUser` from the guard for every protected image route.

Add a protected profile endpoint for Web bootstrap:

```typescript
@Get('me')
@UseGuards(AdminAuthGuard)
getCurrent(@Req() request: AuthenticatedPlatformRequest) {
  return request.adminUser;
}
```

- [ ] **Step 6: Run focused auth and image tests**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/oidc-auth.e2e-spec.ts test/admin-auth.guard.spec.ts test/admin-session.e2e-spec.ts test/admin-image-catalog.e2e-spec.ts"
```

Expected:

```text
all focused auth and image tests pass
```

- [ ] **Step 7: Commit checkpoint if explicitly requested**

```bash
git add apps/api/package.json apps/api/src/auth apps/api/src/admin/admin-auth.guard.ts apps/api/src/admin/admin-session.controller.ts apps/api/src/admin/platform-images.controller.ts apps/api/src/app.module.ts apps/api/test/oidc-auth.e2e-spec.ts pnpm-lock.yaml
git commit -m "feat: accept oidc platform api tokens"
```

### Task 4: Synchronize platform users with Keycloak

**Files:**
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/auth/keycloak-admin.client.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/auth/oidc-identity-bootstrap.service.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/admin-users.service.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/app.module.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/admin-users.e2e-spec.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/keycloak-admin.client.spec.ts`

- [ ] **Step 1: Add failing tests for create, disable, and password reset synchronization**

```typescript
it('creates the keycloak identity before persisting a platform user', async () => {
  keycloakAdmin.createUser.mockResolvedValue({ subject: 'kc-alice' });

  const user = await service.create({ username: 'alice', password: 'Temp-Password-123!' });

  expect(keycloakAdmin.createUser).toHaveBeenCalledWith({
    username: 'alice',
    temporaryPassword: 'Temp-Password-123!',
  });
  expect(user).toMatchObject({ username: 'alice', oidcSubject: 'kc-alice' });
});

it('disables the keycloak user when the platform user is disabled', async () => {
  await service.updateStatus('alice-id', { status: 'disabled' });
  expect(keycloakAdmin.setUserEnabled).toHaveBeenCalledWith('kc-alice', false);
});
```

- [ ] **Step 2: Rebuild and verify the tests fail**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/keycloak-admin.client.spec.ts test/admin-users.e2e-spec.ts"
```

Expected:

```text
FAIL KeycloakAdminClient provider is missing
```

- [ ] **Step 3: Implement the Keycloak Admin REST client**

The client obtains a client-credentials token and supports only the operations required by existing user management:

```typescript
export type KeycloakIdentity = { subject: string };

export interface KeycloakAdminClientLike {
  createUser(input: { username: string; temporaryPassword: string }): Promise<KeycloakIdentity>;
  findUserByUsername(username: string): Promise<KeycloakIdentity | null>;
  setUserEnabled(subject: string, enabled: boolean): Promise<void>;
  resetPassword(subject: string, temporaryPassword: string): Promise<void>;
}
```

Use the Keycloak endpoints:

```text
POST /realms/{realm}/protocol/openid-connect/token
POST /admin/realms/{realm}/users
PUT  /admin/realms/{realm}/users/{subject}
PUT  /admin/realms/{realm}/users/{subject}/reset-password
```

Never log request bodies or Admin API tokens.

- [ ] **Step 4: Integrate synchronization with compensation**

For user creation:

1. Create Keycloak identity.
2. Persist `PlatformUser` and OIDC mapping.
3. If platform persistence fails, disable the newly created Keycloak identity and rethrow.

For status and password changes, update Keycloak first, then persist the local transition. Role remains platform-only.

When password reset targets a legacy user without `oidcSubject`, create the Keycloak identity with the requested temporary password and atomically link `oidcIssuer + oidcSubject` before completing the reset. Do not auto-link arbitrary existing users by username during normal login.

Add `OidcIdentityBootstrapService` to ensure the seeded admin has a Keycloak identity at application bootstrap. It may link only the configured seeded admin ID; all other legacy users migrate through explicit password reset.

- [ ] **Step 5: Run focused user tests**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/keycloak-admin.client.spec.ts test/admin-users.e2e-spec.ts"
```

Expected:

```text
all Keycloak synchronization tests pass
```

- [ ] **Step 6: Commit checkpoint if explicitly requested**

```bash
git add apps/api/src/auth/keycloak-admin.client.ts apps/api/src/auth/oidc-identity-bootstrap.service.ts apps/api/src/admin/admin-users.service.ts apps/api/src/app.module.ts apps/api/test/admin-users.e2e-spec.ts apps/api/test/keycloak-admin.client.spec.ts
git commit -m "feat: synchronize users with keycloak"
```

### Task 5: Add safe template, range, image, single-instance, and job read APIs

**Files:**
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/scenarios.controller.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/range-templates.service.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/ranges.controller.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/range-instances.service.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/single-instances.controller.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/single-instances.service.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/platform-images.controller.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/mcp-read-apis.e2e-spec.ts`

- [ ] **Step 1: Write failing read API tests**

The test must prove:

```typescript
it('returns a readable template detail without mutation endpoints', async () => {
  const response = await request(app.getHttpServer())
    .get(`/admin/scenarios/${template.id}`)
    .set('authorization', `Bearer ${aliceToken}`)
    .expect(200);

  expect(response.body).toMatchObject({ id: template.id, name: template.name });
});

it('omits credentials from ordinary range and single-instance responses', async () => {
  const range = await request(app.getHttpServer())
    .get(`/admin/ranges/${rangeId}`)
    .set('authorization', `Bearer ${aliceToken}`)
    .expect(200);
  const single = await request(app.getHttpServer())
    .get(`/admin/instances/${singleId}`)
    .set('authorization', `Bearer ${aliceToken}`)
    .expect(200);

  expect(range.body.runtimeCredentials).toBeUndefined();
  expect(single.body.runtimeCredentials).toBeUndefined();
});

it('returns credentials only from owner-scoped access endpoints', async () => {
  await request(app.getHttpServer())
    .get(`/admin/instances/${singleId}/access`)
    .set('authorization', `Bearer ${bobToken}`)
    .expect(403);

  const response = await request(app.getHttpServer())
    .get(`/admin/instances/${singleId}/access`)
    .set('authorization', `Bearer ${aliceToken}`)
    .expect(200);

  expect(response.body.credentials).toEqual({ root: expect.any(Object) });
});
```

- [ ] **Step 2: Rebuild and run the test to verify missing routes and leaked credentials**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/mcp-read-apis.e2e-spec.ts"
```

Expected:

```text
FAIL GET /admin/scenarios/:id returns 404
FAIL ordinary single-instance response still contains runtimeCredentials
```

- [ ] **Step 3: Add owner-aware detail methods**

Add:

```typescript
@Get(':id')
getById(@Req() request: AuthenticatedPlatformRequest, @Param('id') id: string) {
  return this.rangeTemplatesService.getById(id, request.adminUser);
}
```

and:

```typescript
@Get(':id')
getById(@Req() request: AuthenticatedPlatformRequest, @Param('id') id: string) {
  return this.singleInstancesService.getById(id, request.adminUser);
}
```

Both services must enforce existing owner/visibility rules before mapping DTOs.

- [ ] **Step 4: Split ordinary DTOs from credential DTOs**

Add explicit access endpoints:

```typescript
@Get(':id/access')
getAccess(@Req() request: AuthenticatedPlatformRequest, @Param('id') id: string) {
  return this.singleInstancesService.getAccess(id, request.adminUser);
}
```

and:

```typescript
@Get(':id/access')
getAccess(@Req() request: AuthenticatedPlatformRequest, @Param('id') id: string) {
  return this.rangeInstancesService.getAccess(id, request.adminUser);
}
```

The ordinary range/single list/detail mappers must omit `runtimeCredentials`. Access DTOs may contain credentials, IPs and SSH fields but no unrelated topology JSON.

- [ ] **Step 5: Preserve Web behavior through explicit access fetches**

Update Web API functions and screens only where they previously depended on credentials embedded in list/detail responses. Fetch access data when the user opens credential details, rather than restoring credentials to ordinary responses.

- [ ] **Step 6: Run read API and adjacent visibility tests**

Run:

```bash
COMPOSE_BAKE=false docker compose build api web
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/mcp-read-apis.e2e-spec.ts test/admin-resource-visibility.e2e-spec.ts test/range-instance-launch.e2e-spec.ts test/single-instances.e2e-spec.ts test/admin-image-catalog.e2e-spec.ts"
docker compose run --rm --entrypoint sh web -lc \
  "pnpm --filter @aliyun-cyber-range/web test"
```

Expected:

```text
all selected API and Web tests pass
```

- [ ] **Step 7: Commit checkpoint if explicitly requested**

```bash
git add apps/api/src/admin apps/api/test/mcp-read-apis.e2e-spec.ts apps/web
git commit -m "feat: add safe mcp read apis"
```

### Task 6: Implement confirmation, idempotency, and append-only audit services

**Files:**
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/operations/operation-types.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/operations/operation-hash.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/operations/operation-audit.service.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/operations/operation-confirmation.service.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/operations/idempotent-operation.service.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/operations/operation-control.service.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/app.module.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/operation-control.spec.ts`

- [ ] **Step 1: Write failing confirmation and audit tests**

```typescript
it('returns confirmation_required and binds the exact normalized arguments', async () => {
  await expect(operationControl.executeConfirmed({
    context: aliceMcpContext,
    metadata: { requestId: 'req-1', idempotencyKey: 'idem-1', confirmationId: null },
    toolName: 'range_instance_destroy',
    arguments: { rangeInstanceId: range.id },
    targetType: 'range_instance',
    resolveConfirmation: async () => ({
      targetId: range.id,
      targetSnapshot: { status: 'running' },
      summary: { targetName: range.name, destructive: true },
    }),
    execute: vi.fn(),
  })).rejects.toMatchObject({
    response: {
      code: 'CONFIRMATION_REQUIRED',
      confirmationId: expect.any(String),
      summary: { targetName: range.name, destructive: true },
    },
  });
});

it('does not persist credentials or vnc urls in audit events', async () => {
  await auditService.append({
    operationId: 'op-1',
    requestId: 'req-1',
    actorUserId: 'alice',
    source: 'mcp',
    oauthClientId: 'mcp-gateway',
    toolName: 'single_instance_open_vnc',
    phase: 'succeeded',
    targetType: 'single_instance',
    targetId: 'single-1',
    sanitizedInput: { vncUrl: 'https://must-not-be-stored.example' },
  });

  expect(await repository.listOperationAuditEvents('op-1')).toEqual([
    expect.objectContaining({ sanitizedInput: {} }),
  ]);
});
```

- [ ] **Step 2: Rebuild and verify the operation tests fail**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/operation-control.spec.ts"
```

Expected:

```text
FAIL OperationControlService is not implemented
```

- [ ] **Step 3: Implement deterministic hashing and redaction**

Normalize object keys recursively, hash with SHA-256, and redact by key before persistence:

```typescript
const SENSITIVE_KEYS = new Set([
  'password',
  'defaultPassword',
  'token',
  'accessToken',
  'refreshToken',
  'vncUrl',
  'webTerminalUrl',
  'accessKeyId',
  'accessKeySecret',
]);

export function hashOperationArguments(value: unknown) {
  return createHash('sha256').update(JSON.stringify(normalizeForHash(value))).digest('base64url');
}

export function sanitizeOperationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeOperationValue);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_KEYS.has(key))
      .map(([key, child]) => [key, sanitizeOperationValue(child)]),
  );
}
```

- [ ] **Step 4: Implement confirmation creation and one-time consumption**

The preparation service must resolve a server-side target snapshot and user-facing summary for every supported mutation. Use a five-minute expiry. Store only the argument hash and sanitized target snapshot.

Consumption checks:

```typescript
if (
  confirmation.actorUserId !== context.user.id ||
  confirmation.oauthClientId !== context.oauthClientId ||
  confirmation.toolName !== toolName ||
  confirmation.argumentsHash !== hashOperationArguments(args) ||
  confirmation.idempotencyKey !== idempotencyKey
) {
  throw new ConflictException('Operation confirmation does not match this request');
}
```

- [ ] **Step 5: Implement database-backed idempotency**

`begin()` returns one of:

```typescript
type BeginIdempotentOperationResult =
  | { kind: 'created'; operationId: string }
  | { kind: 'existing'; operation: IdempotentOperationRecord };
```

If an existing record has a different `argumentsHash`, throw `ConflictException`. Never rely on process memory.

- [ ] **Step 6: Implement append-only audit and operation orchestration**

`OperationControlService.executeConfirmed()` must:

1. append `requested`
2. consume confirmation
3. append `confirmed`
4. start or recover idempotent operation
5. call the provided business callback once
6. append `dispatched` for async jobs or `succeeded` for synchronous operations
7. append `failed` with a stable error code on failure

It must not write tool results to audit events.

- [ ] **Step 7: Run operation tests**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/operation-control.spec.ts test/operation-repository.spec.ts"
```

Expected:

```text
all operation control and persistence tests pass
```

- [ ] **Step 8: Commit checkpoint if explicitly requested**

```bash
git add apps/api/src/operations apps/api/src/app.module.ts apps/api/test/operation-control.spec.ts
git commit -m "feat: add confirmed idempotent operations"
```

### Task 7: Wire operation control into selected platform actions

**Files:**
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/operations/operation-request.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/ranges.controller.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/single-instances.controller.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/range-instances.service.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/single-instances.service.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/admin/range-instance-node-actions.service.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/provisioning/provisioning-worker.service.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/mcp-operation-actions.e2e-spec.ts`

- [ ] **Step 1: Write failing tests for confirmation, idempotency, and source audit**

Cover range launch/destroy, single launch/destroy/batch destroy/retry/reboot/pack-image, plus access/VNC metadata-only audit:

```typescript
it('does not dispatch a range launch until the mcp confirmation is consumed', async () => {
  await request(app.getHttpServer())
    .post('/admin/ranges/launch')
    .set('authorization', `Bearer ${aliceDelegatedToken}`)
    .set('idempotency-key', 'idem-range-launch')
    .send({ templateId: template.id, name: 'range-via-mcp', expiresAt: '2026-07-15T12:00:00.000Z' })
    .expect(409)
    .expect(({ body }) => {
      expect(body.code).toBe('CONFIRMATION_REQUIRED');
      expect(body.confirmationId).toEqual(expect.any(String));
    });

  expect(dispatchMock).not.toHaveBeenCalled();
});

it('returns the original operation when the same idempotency key is repeated', async () => {
  const first = await executeConfirmedRangeLaunch('idem-range-launch');
  const second = await executeConfirmedRangeLaunch('idem-range-launch');

  expect(second.body.operationId).toBe(first.body.operationId);
  expect(second.body.jobId).toBe(first.body.jobId);
  expect(dispatchMock).toHaveBeenCalledTimes(1);
});

it('audits vnc access without persisting the returned url', async () => {
  const response = await request(app.getHttpServer())
    .post(`/admin/instances/${single.id}/actions/open-vnc`)
    .set('authorization', `Bearer ${aliceDelegatedToken}`)
    .send({})
    .expect(201);

  expect(response.body.webTerminalUrl).toEqual(expect.any(String));
  expect(JSON.stringify(await repository.listOperationAuditEventsByTarget('single_instance', single.id)))
    .not.toContain(response.body.webTerminalUrl);
});
```

- [ ] **Step 2: Rebuild and run the focused action tests to verify failure**

Run:

```bash
COMPOSE_BAKE=false docker compose build api provisioner-worker
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/mcp-operation-actions.e2e-spec.ts"
```

Expected:

```text
FAIL mutation dispatches without MCP confirmation
FAIL no operation audit event exists
```

- [ ] **Step 3: Parse operation headers into a typed request**

Define:

```typescript
export type OperationRequestMetadata = {
  requestId: string;
  idempotencyKey: string | null;
  confirmationId: string | null;
};

export function readOperationRequestMetadata(request: AuthenticatedPlatformRequest): OperationRequestMetadata {
  return {
    requestId: request.headers['x-request-id']?.trim() || randomUUID(),
    idempotencyKey: request.headers['idempotency-key']?.trim() || null,
    confirmationId: request.headers['x-operation-confirmation-id']?.trim() || null,
  };
}
```

Do not trust an `x-operation-source` header. Source comes only from `request.authContext`.

- [ ] **Step 4: Require operation control only for delegated MCP mutations**

Wrap selected controller actions with:

```typescript
if (request.authContext.source !== 'mcp') {
  return this.rangeInstancesService.launch(body, request.adminUser);
}

return this.operationControl.executeConfirmed({
  context: request.authContext,
  metadata: readOperationRequestMetadata(request),
  toolName: 'range_instance_launch',
  arguments: body,
  targetType: 'range_instance',
  execute: () => this.rangeInstancesService.launch(body, request.adminUser),
});
```

Apply the same pattern to all confirmed tools. Each tool must use its exact approved MCP name.

- [ ] **Step 5: Audit sensitive reads and non-confirmed VNC access**

Wrap access and VNC responses with a metadata-only audit helper:

```typescript
return this.operationControl.auditRead({
  context: request.authContext,
  requestId: readOperationRequestMetadata(request).requestId,
  toolName: 'single_instance_open_vnc',
  targetType: 'single_instance',
  targetId: id,
  execute: () => this.singleInstancesService.runAction(id, 'open-vnc', request.adminUser, {}),
});
```

`auditRead()` must not accept or persist the result object.

- [ ] **Step 6: Append final async audit events from the Worker**

When a job reaches `succeeded` or `failed`, find dispatched audit events by `jobId` and append a final event with the same `operationId`:

```typescript
await this.operationAudit.completeJob({
  jobId: job.id,
  phase: 'succeeded',
  durationMs: finishedAt.getTime() - startedAt.getTime(),
});
```

System auto-expire jobs keep `source=system` and do not require MCP confirmation.

- [ ] **Step 7: Run selected lifecycle and worker tests**

Run:

```bash
COMPOSE_BAKE=false docker compose build api provisioner-worker
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/mcp-operation-actions.e2e-spec.ts test/range-instance-launch.e2e-spec.ts test/range-instance-auto-expire.e2e-spec.ts test/single-instances.e2e-spec.ts test/provisioning-worker-concurrency.e2e-spec.ts"
```

Expected:

```text
all selected operation and worker tests pass
```

- [ ] **Step 8: Commit checkpoint if explicitly requested**

```bash
git add apps/api/src/operations apps/api/src/admin/ranges.controller.ts apps/api/src/admin/single-instances.controller.ts apps/api/src/admin/range-instances.service.ts apps/api/src/admin/single-instances.service.ts apps/api/src/admin/range-instance-node-actions.service.ts apps/api/src/provisioning/provisioning-worker.service.ts apps/api/test/mcp-operation-actions.e2e-spec.ts
git commit -m "feat: audit confirmed instance operations"
```

### Task 8: Add Keycloak development infrastructure and realm configuration

**Files:**
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/infra/keycloak/cyber-range-realm.json`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/scripts/docker/init-keycloak-db.sh`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/docker-compose.yml`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/.env.example`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/test/keycloak-compose.test.mjs`

- [ ] **Step 1: Write a static Compose/realm contract test**

```javascript
test('compose defines isolated keycloak and mcp oauth clients', () => {
  const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const realm = JSON.parse(fs.readFileSync(new URL('../infra/keycloak/cyber-range-realm.json', import.meta.url), 'utf8'));

  assert.match(compose, /keycloak:\n/);
  assert.match(compose, /quay\.io\/keycloak\/keycloak:26\.7\.0/);
  assert.match(compose, /KC_DB:\s*postgres/);
  assert.equal(realm.realm, 'cyber-range');
  assert.deepEqual(
    realm.clients.map((client) => client.clientId).sort(),
    ['mcp', 'mcp-gateway', 'mcp-smoke-client', 'platform-api', 'platform-web'].sort(),
  );
});
```

- [ ] **Step 2: Run the root container contract test to verify failure**

Run:

```bash
docker run --rm -v "$PWD:/workspace" -w /workspace node:22-alpine \
  node --test test/keycloak-compose.test.mjs
```

Expected:

```text
FAIL docker-compose.yml does not define keycloak
```

- [ ] **Step 3: Add an idempotent Keycloak database initializer**

The script must create a separate database and role without exposing the password in output:

```sh
#!/bin/sh
set -eu

export PGPASSWORD="$POSTGRES_PASSWORD"

if ! psql -h postgres -U "$POSTGRES_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname = '$KEYCLOAK_DB_USER'" | grep -q 1; then
  psql -h postgres -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE \"$KEYCLOAK_DB_USER\" LOGIN PASSWORD '$KEYCLOAK_DB_PASSWORD'"
fi

if ! psql -h postgres -U "$POSTGRES_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$KEYCLOAK_DB_NAME'" | grep -q 1; then
  psql -h postgres -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$KEYCLOAK_DB_NAME\" OWNER \"$KEYCLOAK_DB_USER\""
fi
```

Use development-only values from `.env.example`; production deployment must inject real secrets.

- [ ] **Step 4: Add a deterministic Realm import**

The realm must enable Authorization Code flow and define:

```json
{
  "realm": "cyber-range",
  "enabled": true,
  "registrationAllowed": false,
  "clients": [
    {
      "clientId": "platform-web",
      "publicClient": true,
      "standardFlowEnabled": true,
      "redirectUris": ["http://localhost:3000/*"],
      "webOrigins": ["http://localhost:3000"]
    },
    {
      "clientId": "platform-api",
      "bearerOnly": true
    },
    {
      "clientId": "mcp",
      "bearerOnly": true
    },
    {
      "clientId": "mcp-gateway",
      "publicClient": false,
      "serviceAccountsEnabled": true,
      "standardFlowEnabled": false,
      "secret": "${MCP_GATEWAY_CLIENT_SECRET}"
    },
    {
      "clientId": "mcp-smoke-client",
      "publicClient": true,
      "directAccessGrantsEnabled": true,
      "standardFlowEnabled": false
    }
  ]
}
```

`mcp-smoke-client` is development/test-only and must not appear in the production deployment snapshot. Add the approved MCP Scopes as Realm client scopes. Add Audience and Scope protocol mappers so user Tokens include `aud=mcp`, while exchanged API Tokens include `aud=platform-api`, `azp=mcp-gateway`, `sub`, and Scope claims. Grant Token Exchange only to `mcp-gateway`; do not enable unrestricted client registration.

- [ ] **Step 5: Add Compose services and health checks**

Add:

```yaml
  keycloak-db-init:
    image: postgres:16-alpine
    depends_on:
      postgres:
        condition: service_healthy
    entrypoint: ["/scripts/init-keycloak-db.sh"]
    volumes:
      - ./scripts/docker/init-keycloak-db.sh:/scripts/init-keycloak-db.sh:ro

  keycloak:
    image: quay.io/keycloak/keycloak:26.7.0
    command: ["start-dev", "--import-realm"]
    depends_on:
      keycloak-db-init:
        condition: service_completed_successfully
    environment:
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://postgres:5432/${KEYCLOAK_DB_NAME}
      KC_DB_USERNAME: ${KEYCLOAK_DB_USER}
      KC_DB_PASSWORD: ${KEYCLOAK_DB_PASSWORD}
      KC_BOOTSTRAP_ADMIN_USERNAME: ${KEYCLOAK_ADMIN_USERNAME}
      KC_BOOTSTRAP_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD}
      KC_HEALTH_ENABLED: "true"
      KC_HOSTNAME: ${OIDC_PUBLIC_BASE_URL:-http://localhost:8080}
      MCP_GATEWAY_CLIENT_SECRET: ${MCP_GATEWAY_CLIENT_SECRET}
    volumes:
      - ./infra/keycloak/cyber-range-realm.json:/opt/keycloak/data/import/cyber-range-realm.json:ro
    ports:
      - "${KEYCLOAK_PORT:-8080}:8080"
    healthcheck:
      test: ["CMD-SHELL", "bash -c 'exec 3<>/dev/tcp/127.0.0.1/9000'"]
      interval: 10s
      timeout: 5s
      retries: 20
```

Also add API environment variables:

```yaml
      ALLOW_LOCAL_AUTH: ${ALLOW_LOCAL_AUTH:-true}
      OIDC_ISSUER: ${OIDC_PUBLIC_BASE_URL:-http://localhost:8080}/realms/cyber-range
      OIDC_JWKS_URL: http://keycloak:8080/realms/cyber-range/protocol/openid-connect/certs
      MCP_GATEWAY_CLIENT_ID: mcp-gateway
      KEYCLOAK_ADMIN_BASE_URL: http://keycloak:8080
      KEYCLOAK_REALM: cyber-range
      KEYCLOAK_ADMIN_CLIENT_ID: mcp-gateway
      KEYCLOAK_ADMIN_CLIENT_SECRET: ${MCP_GATEWAY_CLIENT_SECRET}
```

Add development-only entries to the root `.env.example`:

```dotenv
KEYCLOAK_DB_NAME=keycloak
KEYCLOAK_DB_USER=keycloak
KEYCLOAK_DB_PASSWORD=keycloak-dev-only
KEYCLOAK_ADMIN_USERNAME=admin
KEYCLOAK_ADMIN_PASSWORD=keycloak-admin-dev-only
KEYCLOAK_PORT=8080
OIDC_PUBLIC_BASE_URL=http://localhost:8080
MCP_GATEWAY_CLIENT_SECRET=mcp-gateway-dev-only
ALLOW_LOCAL_AUTH=true
```

These values are for local container development only. Production examples list the same variable names with empty values or secret references and must not provide reusable credentials.

- [ ] **Step 6: Validate Compose and OIDC discovery in containers**

Run:

```bash
docker run --rm -v "$PWD:/workspace" -w /workspace node:22-alpine \
  node --test test/keycloak-compose.test.mjs
docker compose config
docker compose up -d postgres keycloak-db-init keycloak
docker run --rm --add-host=host.docker.internal:host-gateway curlimages/curl:8.12.1 \
  --fail http://host.docker.internal:${KEYCLOAK_PORT:-8080}/realms/cyber-range/.well-known/openid-configuration
```

Expected:

```text
Keycloak discovery returns issuer, authorization_endpoint, token_endpoint and jwks_uri
```

- [ ] **Step 7: Commit checkpoint if explicitly requested**

```bash
git add infra/keycloak scripts/docker/init-keycloak-db.sh docker-compose.yml .env.example test/keycloak-compose.test.mjs
git commit -m "feat: add keycloak development stack"
```

### Task 9: Migrate the Web session to Keycloak while preserving the API client contract

**Files:**
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/package.json`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/lib/keycloak-client.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/components/admin/use-admin-session.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/components/auth/admin-login-screen.tsx`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/lib/admin-auth-storage.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/app/admin/login/page.test.tsx`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/lib/keycloak-client.test.ts`

- [ ] **Step 1: Replace local-login test expectations with Keycloak redirect expectations**

```tsx
it('starts the keycloak login flow instead of posting a password to the api', async () => {
  const login = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(keycloakClientModule, 'getKeycloakClient').mockReturnValue({ login } as never);

  render(<AdminLoginScreen />);
  fireEvent.click(screen.getByRole('button', { name: '使用统一身份登录' }));

  await waitFor(() => {
    expect(login).toHaveBeenCalledWith({ redirectUri: `${window.location.origin}/admin/scenarios` });
  });
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/admin/session'), expect.anything());
});
```

- [ ] **Step 2: Rebuild Web and verify the login test fails**

Run:

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --entrypoint sh web -lc \
  "pnpm --filter @aliyun-cyber-range/web test -- app/admin/login/page.test.tsx lib/keycloak-client.test.ts"
```

Expected:

```text
FAIL login form still posts username and password
```

- [ ] **Step 3: Add `keycloak-js` and a single client factory**

Use `keycloak-js` 26.2.4:

```typescript
import Keycloak from 'keycloak-js';

let client: Keycloak | null = null;

export function getKeycloakClient() {
  if (!client) {
    client = new Keycloak({
      url: process.env.NEXT_PUBLIC_KEYCLOAK_URL ?? 'http://localhost:8080',
      realm: process.env.NEXT_PUBLIC_KEYCLOAK_REALM ?? 'cyber-range',
      clientId: process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID ?? 'platform-web',
    });
  }

  return client;
}
```

- [ ] **Step 4: Adapt `useAdminSession()` to Keycloak Tokens**

Keep the public hook shape used by screens:

```typescript
return {
  token,
  profile,
  isReady,
  login: startKeycloakLogin,
  logout: logoutFromKeycloak,
  refresh: refreshKeycloakToken,
};
```

Initialize with `onLoad: 'check-sso'` and `pkceMethod: 'S256'`. Refresh before API calls when the Token has less than 30 seconds remaining. Continue passing the access Token into existing `admin-api.ts` Bearer headers.

After Keycloak initialization, fetch `/admin/session/me` with the current Access Token and use that platform response as `profile`. Do not derive the platform `admin / user` role from Keycloak Realm roles.

- [ ] **Step 5: Remove password collection from the production login UI**

Render a single button:

```tsx
<button type="button" disabled={isSubmitting} onClick={handleLogin}>
  {isSubmitting ? '正在跳转...' : '使用统一身份登录'}
</button>
```

Keep local login code only behind `NEXT_PUBLIC_ALLOW_LOCAL_AUTH === 'true'` for container development fallback.

- [ ] **Step 6: Run Web auth and full Web tests**

Run:

```bash
COMPOSE_BAKE=false docker compose build web
docker compose run --rm --entrypoint sh web -lc \
  "pnpm --filter @aliyun-cyber-range/web test"
```

Expected:

```text
all Web tests pass
```

- [ ] **Step 7: Commit checkpoint if explicitly requested**

```bash
git add apps/web/package.json apps/web/lib/keycloak-client.ts apps/web/lib/keycloak-client.test.ts apps/web/components/admin/use-admin-session.ts apps/web/components/auth/admin-login-screen.tsx apps/web/lib/admin-auth-storage.ts apps/web/app/admin/login/page.test.tsx pnpm-lock.yaml
git commit -m "feat: use keycloak for web sessions"
```

### Task 10: Create the typed server-side platform API client package

**Files:**
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/platform-api-client/package.json`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/platform-api-client/tsconfig.json`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/platform-api-client/src/types.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/platform-api-client/src/client.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/platform-api-client/src/index.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/packages/platform-api-client/test/client.test.ts`

- [ ] **Step 1: Write a failing client test for auth headers, request IDs, and error mapping**

```typescript
it('sends delegated bearer auth without logging or persisting the token', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: 'range-1' }]), { status: 200 }));
  const client = new PlatformApiClient({ baseUrl: 'http://api:3001', fetch: fetchMock });

  await client.listRangeInstances({ token: 'delegated-token', requestId: 'req-1', view: 'active' });

  expect(fetchMock).toHaveBeenCalledWith(
    'http://api:3001/admin/ranges?view=active',
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer delegated-token', 'x-request-id': 'req-1' }),
    }),
  );
});

it('maps platform confirmation responses without throwing away the confirmation id', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirm-1', summary: {} }), { status: 409 }),
  );
  const client = new PlatformApiClient({ baseUrl: 'http://api:3001', fetch: fetchMock });

  await expect(client.launchRange({ token: 'token', requestId: 'req-1', idempotencyKey: 'idem-1', input: launchInput }))
    .rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirm-1' });
});
```

- [ ] **Step 2: Run the package test in a Node container to verify failure**

Run:

```bash
docker run --rm -v "$PWD:/workspace" -w /workspace node:22-alpine sh -lc \
  "corepack enable && pnpm install --frozen-lockfile && pnpm --filter @aliyun-cyber-range/platform-api-client test"
```

Expected:

```text
FAIL package or PlatformApiClient does not exist
```

- [ ] **Step 3: Add the package with focused DTOs**

Use this package contract:

```json
{
  "name": "@aliyun-cyber-range/platform-api-client",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
```

Define only the approved MCP data shapes. Ordinary instance DTOs must not contain credentials. Access DTOs are separate:

```typescript
export type InstanceAccess = {
  publicIp: string | null;
  privateIp: string | null;
  ssh: string | null;
  credentials: Record<string, { username: string; password: string }>;
};

export type PlatformApiRequestContext = {
  token: string;
  requestId: string;
};
```

- [ ] **Step 4: Implement one request helper and explicit domain methods**

```typescript
private async request<T>(path: string, options: PlatformApiRequestContext & RequestInit): Promise<T> {
  const response = await this.fetch(new URL(path, this.baseUrl), {
    ...options,
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json',
      'x-request-id': options.requestId,
      ...options.headers,
    },
  });

  const body = await readJson(response);
  if (!response.ok) throw PlatformApiError.fromResponse(response.status, body);
  return body as T;
}
```

Expose one method for every approved tool and no generic public `request()` escape hatch.

- [ ] **Step 5: Run package tests and TypeScript build**

Run:

```bash
docker run --rm -v "$PWD:/workspace" -w /workspace node:22-alpine sh -lc \
  "corepack enable && pnpm install --frozen-lockfile && pnpm --filter @aliyun-cyber-range/platform-api-client test && pnpm --filter @aliyun-cyber-range/platform-api-client build"
```

Expected:

```text
package tests pass and tsc exits 0
```

- [ ] **Step 6: Commit checkpoint if explicitly requested**

```bash
git add packages/platform-api-client pnpm-lock.yaml
git commit -m "feat: add typed platform api client"
```

### Task 11: Scaffold the authenticated Streamable HTTP MCP Gateway

**Files:**
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/package.json`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/tsconfig.json`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/tsconfig.build.json`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/config.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/auth/mcp-token-verifier.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/auth/token-exchange-client.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/server.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/http-app.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/main.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/Dockerfile`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/test/auth.spec.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/test/http-app.spec.ts`

- [ ] **Step 1: Add the MCP package manifest and compile-only shell**

Use exact production dependencies:

```json
{
  "name": "@aliyun-cyber-range/mcp",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@aliyun-cyber-range/platform-api-client": "workspace:*",
    "@modelcontextprotocol/sdk": "1.29.0",
    "express": "5.2.1",
    "jose": "6.2.3",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/express": "^5.0.6",
    "@types/node": "^24.3.0",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
```

Override `module` and `moduleResolution` to `NodeNext` in the MCP tsconfig so `.js` SDK imports remain valid.

- [ ] **Step 2: Write failing token verification and Token Exchange tests**

```typescript
it('accepts only aud=mcp tokens and keeps subject in AuthInfo.extra', async () => {
  const verifier = createVerifier({ issuer, audience: 'mcp', jwks });
  const token = await issueToken({ issuer, audience: 'mcp', subject: 'alice-sub', authorizedParty: 'codex' });

  await expect(verifier.verifyAccessToken(token)).resolves.toMatchObject({
    clientId: 'codex',
    extra: { subject: 'alice-sub', issuer },
  });
});

it('exchanges the subject token for a platform-api audience token', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ access_token: 'api-token', token_type: 'Bearer', expires_in: 60 }), { status: 200 }),
  );
  const client = new TokenExchangeClient(config, fetchMock);

  await expect(client.exchange('mcp-token')).resolves.toBe('api-token');
  expect(fetchMock).toHaveBeenCalledWith(
    config.tokenEndpoint,
    expect.objectContaining({ body: expect.stringContaining('audience=platform-api') }),
  );
});
```

- [ ] **Step 3: Write a failing HTTP authorization test**

```typescript
it('returns OAuth protected resource metadata in the unauthorized challenge', async () => {
  const response = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  expect(response.status).toBe(401);
  expect(response.headers['www-authenticate']).toContain('resource_metadata=');
});
```

- [ ] **Step 4: Install dependencies in a container and run tests to verify failure**

Run:

```bash
docker run --rm -v "$PWD:/workspace" -w /workspace node:22-alpine sh -lc \
  "corepack enable && pnpm install --frozen-lockfile && pnpm --filter @aliyun-cyber-range/mcp test"
```

Expected:

```text
FAIL McpTokenVerifier and HTTP app are not implemented
```

- [ ] **Step 5: Implement MCP Token verification**

Configuration must keep claim validation and container networking separate:

```typescript
const oidcIssuer = requireUrl('OIDC_ISSUER');
const oidcJwksUrl = requireUrl('OIDC_JWKS_URL');
const oidcTokenEndpoint = requireUrl('OIDC_TOKEN_ENDPOINT');
```

Validate the public issuer from `OIDC_ISSUER`, fetch keys from the internal `OIDC_JWKS_URL`, and perform Token Exchange through the internal `OIDC_TOKEN_ENDPOINT`.

Return SDK `AuthInfo` with subject and issuer in `extra`:

```typescript
return {
  token,
  clientId: readAuthorizedParty(payload),
  scopes: readScopes(payload.scope),
  expiresAt: payload.exp,
  resource: new URL(config.resourceUrl),
  extra: {
    subject: payload.sub,
    issuer: payload.iss,
  },
};
```

Verify issuer, `aud=mcp`, expiry, RS256 signature, `sub`, `azp/client_id`, and resource URL.

- [ ] **Step 6: Implement RFC 8693 Token Exchange without token logging**

```typescript
const body = new URLSearchParams({
  grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
  subject_token: mcpToken,
  subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  audience: 'platform-api',
  client_id: this.clientId,
  client_secret: this.clientSecret,
});
```

Reject responses without `access_token`; return a stable `UPSTREAM_ERROR` without including response bodies.

- [ ] **Step 7: Implement authenticated stateful Streamable HTTP sessions**

Use SDK v1.29 imports:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
```

Store sessions as:

```typescript
type McpSession = {
  transport: StreamableHTTPServerTransport;
  subject: string;
  clientId: string;
};
```

Bind the session to the subject and client on initialize. Reject later POST/GET/DELETE requests when the current Token subject or client does not match the session record.

Do not log request bodies or `req.auth.token`.

- [ ] **Step 8: Add health, graceful shutdown, and Dockerfile**

`GET /health` returns:

```json
{ "status": "ok", "service": "mcp" }
```

On SIGTERM/SIGINT, close every transport before exiting.

The Dockerfile must install the workspace with `--frozen-lockfile`, build `platform-api-client` and MCP, expose port 3002, and run `pnpm --filter @aliyun-cyber-range/mcp start`.

- [ ] **Step 9: Build the MCP image and run focused tests**

Run:

```bash
COMPOSE_BAKE=false docker build -f apps/mcp/Dockerfile -t aliyun-cyber-range-mcp:test .
docker run --rm aliyun-cyber-range-mcp:test pnpm --filter @aliyun-cyber-range/mcp test
```

Expected:

```text
MCP auth and HTTP tests pass
```

- [ ] **Step 10: Commit checkpoint if explicitly requested**

```bash
git add apps/mcp pnpm-lock.yaml
git commit -m "feat: scaffold authenticated mcp gateway"
```

### Task 12: Register the eleven approved non-confirmed tools with Scope filtering

**Files:**
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/tools/tool-result.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/tools/tool-context.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/tools/templates.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/tools/images.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/tools/ranges.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/tools/single-instances.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/tools/jobs.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/server.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/test/read-tools.spec.ts`

- [ ] **Step 1: Write a failing tool-list and credential-separation test**

```typescript
it('registers only read tools allowed by the authenticated scopes', async () => {
  const client = await connectTestClient({ scopes: ['templates:read', 'ranges:read'] });
  const tools = await client.listTools();

  expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
    'range_instance_get',
    'range_instance_list',
    'range_template_get',
    'range_template_list',
  ]);
});

it('does not return credentials from range_instance_get', async () => {
  platformApi.getRangeInstance.mockResolvedValue({ id: 'range-1', name: 'range', status: 'running' });
  const result = await callTool('range_instance_get', { rangeInstanceId: 'range-1' });

  expect(JSON.stringify(result)).not.toContain('password');
});
```

- [ ] **Step 2: Rebuild MCP and verify the read-tool test fails**

Run:

```bash
COMPOSE_BAKE=false docker build -f apps/mcp/Dockerfile -t aliyun-cyber-range-mcp:test .
docker run --rm aliyun-cyber-range-mcp:test pnpm --filter @aliyun-cyber-range/mcp test -- read-tools.spec.ts
```

Expected:

```text
FAIL no approved tools are registered
```

- [ ] **Step 3: Define a per-call authenticated tool context**

```typescript
export type McpToolContext = {
  subjectToken: string;
  subject: string;
  clientId: string;
  scopes: Set<string>;
  requestId: string;
  exchangeToken(): Promise<string>;
};
```

Create a new `requestId` for every tool call. Exchange a fresh API Token for every call; do not persist exchanged Tokens in session state.

- [ ] **Step 4: Implement stable tool results and error mapping**

```typescript
export function jsonToolResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function toolError(error: unknown): CallToolResult {
  const mapped = mapPlatformApiError(error);
  return {
    isError: true,
    content: [{ type: 'text', text: mapped.message }],
    structuredContent: { error: mapped },
  };
}
```

Never stringify platform error details that might contain upstream responses.

- [ ] **Step 5: Register exactly eleven non-confirmed tools**

Register:

```text
range_template_list
range_template_get
platform_image_list
range_instance_list
range_instance_get
range_instance_get_access
single_instance_list
single_instance_get
single_instance_get_access
single_instance_open_vnc
provision_job_get
```

Use strict Zod schemas, `.strict()`, pagination bounds, ISO date output, and `readOnlyHint: true`. Access and VNC tools require their credential-read Scopes and return no extra topology or raw database fields. `single_instance_open_vnc` is audited by the API but does not require confirmation.

- [ ] **Step 6: Build the server per authenticated session**

`createServer(authInfo)` registers only tools whose required Scope is present. Always re-check Scope inside the handler before calling the API Client.

- [ ] **Step 7: Run read-tool and transport tests**

Run:

```bash
COMPOSE_BAKE=false docker build -f apps/mcp/Dockerfile -t aliyun-cyber-range-mcp:test .
docker run --rm aliyun-cyber-range-mcp:test pnpm --filter @aliyun-cyber-range/mcp test
```

Expected:

```text
all MCP read-tool, auth, and transport tests pass
```

- [ ] **Step 8: Commit checkpoint if explicitly requested**

```bash
git add apps/mcp/src/tools apps/mcp/src/server.ts apps/mcp/test/read-tools.spec.ts
git commit -m "feat: expose mcp read tools"
```

### Task 13: Register confirmed range and single-instance mutation tools

**Files:**
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/tools/ranges.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/tools/single-instances.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/src/tools/confirmation.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/mcp/test/mutation-tools.spec.ts`

- [ ] **Step 1: Write failing confirmation flow tests**

```typescript
it('returns confirmation_required without dispatching when the client cannot elicit', async () => {
  platformApi.launchRange.mockRejectedValue(
    new PlatformApiError(409, 'CONFIRMATION_REQUIRED', 'Confirmation required', {
      confirmationId: 'confirm-1',
      summary: { targetName: 'range-a', resourceCount: 3 },
    }),
  );

  const result = await callTool('range_instance_launch', {
    templateId: 'template-1',
    name: 'range-a',
    expiresAt: '2026-07-15T12:00:00.000Z',
    idempotencyKey: 'idem-1',
  });

  expect(result.structuredContent).toMatchObject({
    status: 'confirmation_required',
    confirmationId: 'confirm-1',
  });
  expect(platformApi.launchRange).toHaveBeenCalledTimes(1);
});

it('executes once after native elicitation accepts the confirmation', async () => {
  platformApi.launchSingleBatch
    .mockRejectedValueOnce(confirmationRequired('confirm-1'))
    .mockResolvedValueOnce({ operationId: 'op-1', batchId: 'batch-1', jobIds: ['job-1'] });

  const result = await callToolWithElicitation('single_instance_batch_launch', launchArgs, { action: 'accept' });

  expect(result.structuredContent).toMatchObject({ status: 'accepted', operationId: 'op-1' });
  expect(platformApi.launchSingleBatch).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ confirmationId: 'confirm-1' }),
  );
});
```

- [ ] **Step 2: Rebuild and verify mutation tests fail**

Run:

```bash
COMPOSE_BAKE=false docker build -f apps/mcp/Dockerfile -t aliyun-cyber-range-mcp:test .
docker run --rm aliyun-cyber-range-mcp:test pnpm --filter @aliyun-cyber-range/mcp test -- mutation-tools.spec.ts
```

Expected:

```text
FAIL mutation tools are not registered
```

- [ ] **Step 3: Implement the reusable confirmation helper**

The helper calls once, handles `CONFIRMATION_REQUIRED`, and optionally uses MCP Elicitation:

```typescript
const elicitation = await extra.sendRequest(
  {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: formatConfirmationMessage(summary),
      requestedSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean', title: '确认执行', default: false },
        },
        required: ['confirmed'],
      },
    },
  },
  ElicitResultSchema,
);
```

If the client rejects/does not support Elicitation, return `confirmation_required`. If accepted with `confirmed=true`, call the same action again with the confirmation ID. Never change arguments between calls.

- [ ] **Step 4: Register exactly eight confirmed mutation tools**

Register:

```text
range_instance_launch
range_instance_destroy
single_instance_batch_launch
single_instance_destroy
single_instance_batch_destroy
single_instance_retry
single_instance_reboot
single_instance_pack_image
```

Every schema requires `idempotencyKey` and accepts optional `confirmationId`. Add MCP annotations:

```typescript
annotations: {
  readOnlyHint: false,
  destructiveHint: toolName.includes('destroy'),
  idempotentHint: true,
  openWorldHint: true,
}
```

Do not expose range-node actions.

- [ ] **Step 5: Ensure summaries never include secrets**

Launch summaries may include template/image name, quantity, CPU, memory, disk, expiry and target count. They must not include passwords. Destroy summaries may include IDs, names and permanent-destruction wording, but not instance credentials.

- [ ] **Step 6: Run full MCP tests**

Run:

```bash
COMPOSE_BAKE=false docker build -f apps/mcp/Dockerfile -t aliyun-cyber-range-mcp:test .
docker run --rm aliyun-cyber-range-mcp:test pnpm --filter @aliyun-cyber-range/mcp test
```

Expected:

```text
19 approved tools are covered and all MCP tests pass
```

- [ ] **Step 7: Commit checkpoint if explicitly requested**

```bash
git add apps/mcp/src/tools apps/mcp/test/mutation-tools.spec.ts
git commit -m "feat: expose confirmed mcp mutation tools"
```

### Task 14: Surface unified Web, MCP, and system audit history

**Files:**
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/operations/operation-history.service.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/operations/operation-history.controller.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/src/app.module.ts`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/api/test/operation-history.e2e-spec.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/lib/admin-types.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/lib/admin-api.ts`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/components/admin/range-instances-screen.tsx`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/components/admin/range-instances-screen.test.tsx`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/components/admin/single-instances-screen.tsx`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/components/admin/single-instances-screen.test.tsx`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/apps/web/app/globals.css`

- [ ] **Step 1: Write failing visibility and redaction tests for operation history**

Cover user isolation, administrator filtering, pagination and persisted sanitized metadata:

```typescript
it('returns only the current user operation history to a normal user', async () => {
  await repository.appendOperationAuditEvent(aliceAuditEvent);
  await repository.appendOperationAuditEvent(bobAuditEvent);

  const response = await request(app.getHttpServer())
    .get('/admin/operation-history?targetType=single_instance&limit=50')
    .set('authorization', `Bearer ${aliceToken}`)
    .expect(200);

  expect(response.body.items).toEqual([
    expect.objectContaining({ actorUserId: 'alice', source: 'mcp', targetType: 'single_instance' }),
  ]);
  expect(JSON.stringify(response.body)).not.toContain('must-not-be-stored');
});

it('allows an administrator to filter history by actor for smoke verification', async () => {
  const response = await request(app.getHttpServer())
    .get('/admin/operation-history?actorUserId=alice&operationId=op-1&limit=50')
    .set('authorization', `Bearer ${adminToken}`)
    .expect(200);

  expect(response.body.items.every((item: { actorUserId: string }) => item.actorUserId === 'alice')).toBe(true);
});
```

- [ ] **Step 2: Rebuild the API image and verify the history tests fail**

Run:

```bash
COMPOSE_BAKE=false docker compose build api
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/operation-history.e2e-spec.ts"
```

Expected:

```text
FAIL GET /admin/operation-history is not defined
```

- [ ] **Step 3: Add the guarded operation-history API**

Expose only audit metadata already persisted by `OperationAuditService`:

```typescript
export type OperationHistoryItem = {
  id: string;
  operationId: string;
  requestId: string;
  actorUserId: string;
  source: 'web' | 'mcp' | 'system';
  oauthClientId: string | null;
  toolName: string;
  phase: 'requested' | 'confirmation_required' | 'confirmed' | 'dispatched' | 'succeeded' | 'failed';
  targetType: string | null;
  targetId: string | null;
  sanitizedInput: Record<string, unknown> | null;
  jobId: string | null;
  errorCode: string | null;
  durationMs: number | null;
  createdAt: string;
};

export type OperationHistoryPage = {
  items: OperationHistoryItem[];
  nextCursor: string | null;
};
```

Add `GET /admin/operation-history` behind `AdminAuthGuard`. Accept `actorUserId`, `operationId`, `targetType`, `targetId`, `cursor` and `limit`; allow `targetType` only for `range_instance` or `single_instance` and clamp `limit` to `1..100`.

For a normal user, always query with `actorUserId=currentUser.id` and ignore any attempt to select another actor. For an administrator, apply the optional `actorUserId` filter. Return repository rows without adding tool results, credentials or VNC URLs. Use the last returned event ID as `nextCursor` only when a full page is returned.

- [ ] **Step 4: Write failing Web tests for source-aware instance history**

```tsx
fetchOperationHistoryMock.mockResolvedValue({
  items: [
    {
      id: 'audit-1',
      operationId: 'op-1',
      requestId: 'req-1',
      actorUserId: 'alice',
      source: 'mcp',
      oauthClientId: 'codex',
      toolName: 'single_instance_reboot',
      phase: 'succeeded',
      targetType: 'single_instance',
      targetId: 'single-1',
      sanitizedInput: {},
      jobId: null,
      errorCode: null,
      durationMs: 1200,
      createdAt: '2026-07-14T12:00:00.000Z',
    },
  ],
  nextCursor: null,
});

expect(await screen.findByText('MCP')).toBeTruthy();
expect(screen.getByText('重启单实例')).toBeTruthy();
```

Add equivalent coverage for a range launch in `range-instances-screen.test.tsx`, plus Web and System source labels.

- [ ] **Step 5: Integrate operation events into the existing history views**

Add `fetchOperationHistory()` to `admin-api.ts`. When the user selects the existing history view:

1. the comprehensive range screen requests `targetType=range_instance`
2. the single-instance screen requests `targetType=single_instance`
3. each screen groups events by `targetId` and renders an operation timeline within the matching history row
4. source badges display `Web`, `MCP`, or `系统`
5. tool names map to stable Chinese action labels; unknown names fall back to the literal tool name
6. phases display requested, waiting for confirmation, dispatched, succeeded, or failed without rendering `sanitizedInput`

Do not create a separate MCP log page. The existing platform history views remain the only operator-facing history experience.

- [ ] **Step 6: Rebuild API and Web images and run focused tests**

Run:

```bash
COMPOSE_BAKE=false docker compose build api web
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/api exec jest --runInBand test/operation-history.e2e-spec.ts test/mcp-operation-actions.e2e-spec.ts"
docker compose run --rm --entrypoint sh web -lc \
  "pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx components/admin/single-instances-screen.test.tsx"
```

Expected:

```text
operation history isolation, redaction, pagination and Web source badges pass
```

- [ ] **Step 7: Commit checkpoint if explicitly requested**

```bash
git add apps/api/src/operations/operation-history.service.ts apps/api/src/operations/operation-history.controller.ts apps/api/src/app.module.ts apps/api/test/operation-history.e2e-spec.ts apps/web/lib/admin-types.ts apps/web/lib/admin-api.ts apps/web/components/admin/range-instances-screen.tsx apps/web/components/admin/range-instances-screen.test.tsx apps/web/components/admin/single-instances-screen.tsx apps/web/components/admin/single-instances-screen.test.tsx apps/web/app/globals.css
git commit -m "feat: show unified operation history"
```

### Task 15: Add MCP to Compose and run an authenticated container smoke flow

**Files:**
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/docker-compose.yml`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/package.json`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/.env.example`
- Create: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/test/mcp-container-smoke.test.mjs`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/test/workspace-smoke.test.mjs`

- [ ] **Step 1: Extend the workspace contract test for the MCP app**

```javascript
assert.equal(fs.existsSync(new URL('../apps/mcp/package.json', import.meta.url)), true);
assert.equal(fs.existsSync(new URL('../apps/mcp/Dockerfile', import.meta.url)), true);
assert.match(composeSource, /\n  mcp:\n/);
assert.match(composeSource, /\n  mcp-smoke:\n/);
assert.match(rootPackage.scripts['compose:logs'], /mcp/);
```

- [ ] **Step 2: Add the Compose MCP and test-only smoke services**

```yaml
  mcp:
    build:
      context: .
      dockerfile: apps/mcp/Dockerfile
    restart: unless-stopped
    depends_on:
      api:
        condition: service_healthy
      keycloak:
        condition: service_healthy
    environment:
      NODE_ENV: production
      MCP_PORT: 3002
      MCP_PUBLIC_URL: ${MCP_PUBLIC_URL:-http://localhost:3002/mcp}
      PLATFORM_API_BASE_URL: http://api:3001
      OIDC_ISSUER: ${OIDC_PUBLIC_BASE_URL:-http://localhost:8080}/realms/cyber-range
      OIDC_JWKS_URL: http://keycloak:8080/realms/cyber-range/protocol/openid-connect/certs
      OIDC_TOKEN_ENDPOINT: http://keycloak:8080/realms/cyber-range/protocol/openid-connect/token
      MCP_OAUTH_CLIENT_ID: mcp-gateway
      MCP_OAUTH_CLIENT_SECRET: ${MCP_GATEWAY_CLIENT_SECRET}
      PLATFORM_API_AUDIENCE: platform-api
    ports:
      - "${MCP_PORT:-3002}:3002"
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3002/health >/dev/null || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10

  mcp-smoke:
    image: node:22-alpine
    profiles: ["test"]
    depends_on:
      api:
        condition: service_healthy
      keycloak:
        condition: service_healthy
      mcp:
        condition: service_healthy
    working_dir: /workspace
    volumes:
      - .:/workspace:ro
    environment:
      PLATFORM_API_BASE_URL: http://api:3001
      MCP_ENDPOINT: http://mcp:3002/mcp
      KEYCLOAK_TOKEN_ENDPOINT: http://keycloak:8080/realms/cyber-range/protocol/openid-connect/token
      ADMIN_USERNAME: ${ADMIN_USERNAME:-admin}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:-change-me}
      MCP_SMOKE_CLIENT_ID: mcp-smoke-client
      MCP_SMOKE_USERNAME: ${MCP_SMOKE_USERNAME:-mcp-smoke}
      MCP_SMOKE_PASSWORD: ${MCP_SMOKE_PASSWORD:-mcp-smoke-change-me}
    command: ["node", "--test", "test/mcp-container-smoke.test.mjs"]
```

If the final MCP image does not include `wget`, install `curl` in the Dockerfile and use `curl -fsS` instead.

`OIDC_ISSUER` is always the externally visible issuer embedded in Tokens. `OIDC_JWKS_URL` and `OIDC_TOKEN_ENDPOINT` use the internal Compose hostname so container-to-container calls do not depend on host networking. `mcp-smoke` and its default credentials are development/test-only and must not be copied into the production deployment snapshot.

Add the remaining development/test entries to the root `.env.example`:

```dotenv
MCP_PORT=3002
MCP_PUBLIC_URL=http://localhost:3002/mcp
MCP_SMOKE_USERNAME=mcp-smoke
MCP_SMOKE_PASSWORD=mcp-smoke-change-me
```

- [ ] **Step 3: Implement the container smoke test**

The test must prepare its user through the platform's existing user-management path before using Keycloak's test-only Direct Access Grant:

1. `POST /admin/session` with `ADMIN_USERNAME` and `ADMIN_PASSWORD` to obtain a local development admin session.
2. `POST /admin/users` with `{ "username": MCP_SMOKE_USERNAME, "password": MCP_SMOKE_PASSWORD, "role": "user" }`. This invokes `AdminUsersService` and the Keycloak synchronization added in Task 4.
3. If the user already exists, locate it through `GET /admin/users`, ensure it is active through `PATCH /admin/users/{id}/status`, and reset its password through `POST /admin/users/{id}/reset-password`; do not create or modify the user directly through the Keycloak Admin API.
4. Request the MCP user Token from `KEYCLOAK_TOKEN_ENDPOINT` with `client_id=mcp-smoke-client`, `grant_type=password`, and the smoke username/password. Direct Access Grant is allowed only for this test client in the development Realm.

Using the Token obtained during setup, the test must:

1. initialize an MCP session
2. call `tools/list`
3. assert exactly the approved tools allowed by test Scopes
4. call template/image/range/single/job read tools
5. call range launch without confirmation and observe `confirmation_required`
6. call the same launch with confirmation and verify one job is created
7. poll `provision_job_get` in dry-run mode
8. destroy the range with confirmation
9. query `/admin/operation-history` with the retained local admin session and `actorUserId` set to the smoke user's platform ID
10. scan the serialized persisted audit rows for passwords, Tokens and VNC URLs

Use Node's built-in test runner and JSON-RPC HTTP requests; do not require a host-installed MCP CLI.

- [ ] **Step 4: Build all changed images**

Run:

```bash
COMPOSE_BAKE=false docker compose build api provisioner-worker web mcp
```

Expected:

```text
all four images build successfully
```

- [ ] **Step 5: Start the full stack and run the smoke test in a container**

Run:

```bash
docker compose up -d postgres keycloak-db-init keycloak api provisioner-worker web mcp
docker compose run --rm mcp-smoke
```

Expected:

```text
MCP authenticated read, confirmed launch, job polling, audit redaction and confirmed destroy all pass
```

- [ ] **Step 6: Stop and clean test state**

Run:

```bash
docker compose down --remove-orphans
```

Expected:

```text
no project containers remain running
```

- [ ] **Step 7: Commit checkpoint if explicitly requested**

```bash
git add docker-compose.yml package.json .env.example test/mcp-container-smoke.test.mjs test/workspace-smoke.test.mjs
git commit -m "feat: run mcp in the container stack"
```

### Task 16: Run full container regression and update operator documentation

**Files:**
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/README.md`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/deploy/current-system/README.md`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/deploy/current-system/.env.example`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/deploy/current-system/docker-compose.yml`
- Modify: `/Users/yym/Documents/阿里云For综合靶场竞赛平台/PRODUCT.md`

- [ ] **Step 1: Document the exact operator flow**

README must include:

```text
1. Configure Keycloak database/admin/MCP client secrets.
2. Start the full Docker stack.
3. Open Keycloak and reset migrated user passwords.
4. Configure an MCP Client with the public HTTPS MCP URL.
5. Complete OAuth login.
6. Verify tools/list contains only the approved v1 tool set for that user.
7. Use operation IDs and job IDs to inspect long-running actions.
8. Never paste platform credentials into logs or support tickets.
```

Document that production requires HTTPS and that unrestricted DCR is disabled.

- [ ] **Step 2: Mirror MCP and Keycloak deployment settings into `deploy/current-system`**

The deployment snapshot must include the same production service names, image build contexts, health checks, network boundaries and environment variable names as the root Compose file. Configure `OIDC_ISSUER` with the public HTTPS issuer and configure `OIDC_JWKS_URL` plus `OIDC_TOKEN_ENDPOINT` with the internal Keycloak service URL. Do not add development default secrets, the `mcp-smoke` service, or the `mcp-smoke-client` Direct Access Grant client.

- [ ] **Step 3: Run database, API, Web, MCP, and root tests in containers**

Run:

```bash
COMPOSE_BAKE=false docker compose build api provisioner-worker web mcp
docker compose up -d postgres keycloak-db-init keycloak
docker compose run --rm --entrypoint sh api -lc \
  "pnpm --filter @aliyun-cyber-range/database test && pnpm --filter @aliyun-cyber-range/api test"
docker compose run --rm --entrypoint sh web -lc \
  "pnpm --filter @aliyun-cyber-range/web test && pnpm --filter @aliyun-cyber-range/web build"
docker compose run --rm --entrypoint sh mcp -lc \
  "pnpm --filter @aliyun-cyber-range/platform-api-client test && pnpm --filter @aliyun-cyber-range/mcp test && pnpm --filter @aliyun-cyber-range/mcp build"
docker run --rm -v "$PWD:/workspace:ro" -w /workspace node:22-alpine \
  node --test test/*.test.mjs
```

Expected:

```text
all database, API, Web, MCP and root tests pass
all TypeScript/Next builds pass
```

- [ ] **Step 4: Run the final full-stack container smoke**

Run:

```bash
docker compose up -d postgres keycloak-db-init keycloak api provisioner-worker web mcp
docker compose run --rm mcp-smoke
docker compose ps
```

Expected:

```text
postgres, keycloak, api, provisioner-worker, web and mcp are healthy
MCP smoke passes
```

- [ ] **Step 5: Perform a final secret and scope scan**

Run:

```bash
rg -n "change-me|dev-admin-token|MCP_GATEWAY_CLIENT_SECRET=.*[^}]$|access_token|refresh_token|webTerminalUrl|defaultPassword" \
  apps/mcp infra/keycloak deploy/current-system docker-compose.yml .env.example \
  -g '!*.test.*' -g '!*.example'
```

Expected:

```text
no committed production secret or sensitive-result logging path is found
```

Review `tools/list` and confirm it contains only these 19 names:

```text
range_template_list
range_template_get
platform_image_list
range_instance_list
range_instance_get
range_instance_get_access
range_instance_launch
range_instance_destroy
single_instance_list
single_instance_get
single_instance_get_access
single_instance_batch_launch
single_instance_destroy
single_instance_batch_destroy
single_instance_retry
single_instance_reboot
single_instance_open_vnc
single_instance_pack_image
provision_job_get
```

- [ ] **Step 6: Stop the stack after verification**

Run:

```bash
docker compose down --remove-orphans
```

Do not remove persistent user data volumes unless the user explicitly requests destructive cleanup.

- [ ] **Step 7: Commit checkpoint if explicitly requested**

```bash
git add README.md PRODUCT.md deploy/current-system
git commit -m "docs: document platform mcp operations"
```

---

## Completion Checklist

- [ ] Keycloak login and Token Exchange work through containers
- [ ] Public OIDC issuer validation is separated from internal JWKS and Token Exchange networking
- [ ] API rejects wrong Audience and disabled users
- [ ] Web uses Keycloak while local auth remains development-only
- [ ] The test-only Direct Access Grant client and `mcp-smoke` service are absent from production deployment
- [ ] Ordinary instance DTOs omit credentials
- [ ] Access/VNC tools return sensitive data only to owner/admin with the correct Scope
- [ ] All eight mutation tools require confirmation
- [ ] Database idempotency prevents duplicate dispatch
- [ ] Worker appends final async audit events
- [ ] Audit records contain no passwords, VNC URLs, OAuth Tokens, Keycloak Secrets or cloud keys
- [ ] Existing range and single-instance history views show Web, MCP and System audit sources
- [ ] `tools/list` exposes only the approved tools allowed by current Scopes
- [ ] Comprehensive range node actions remain unavailable through MCP
- [ ] All changed images are rebuilt
- [ ] All container tests and builds pass
- [ ] No test containers or temporary cloud resources remain
