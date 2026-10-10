import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { PrismaService } from '../src/database/prisma.service';
import { OidcJwtVerifier } from '../src/admin/oidc-jwt-verifier';
import { runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { encryptCloudCredential } from '../src/admin/cloud-credential-encryption';

const url = process.env.WORKSPACE_TEST_DATABASE_URL;
const isolated = url ? describe : describe.skip;
const issuer = 'https://workspace-fixture.invalid/realms/platform';
const authorization = (subject: string) => `Bearer ${subject}.fixture.jwt`;

isolated('Cloud workspace HTTP selection and authorization (isolated PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const previousEnforce = process.env.CLOUD_WORKSPACE_ENFORCE_TEST_SCOPE;
  const previousKey = process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.CLOUD_WORKSPACE_ENFORCE_TEST_SCOPE = '1';
    process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = 'ab'.repeat(32);
    prisma = new PrismaService({ datasources: { db: { url: url! } } });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(prisma)
      .overrideProvider(OidcJwtVerifier).useValue({ verifyAccessToken: async (token: string) => ({ issuer, subject: token.split('.')[0], authorizedParty: 'platform-web' }) })
      .compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
  });

  beforeEach(async () => runInSystemCloudWorkspaceScope(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "CloudWorkspace" CASCADE');
    await prisma.cloudWorkspace.createMany({ data: [
      { id: 'space-a', provider: 'alibaba_cloud', accountUid: '100001', displayName: 'Account A', activeCloudAccountContextId: 'context-a' },
      { id: 'space-b', provider: 'tencent_cloud', accountUid: '100002', displayName: 'Account B', activeCloudAccountContextId: 'context-b' },
      { id: 'legacy-unbound', provider: 'alibaba_cloud', accountUid: null, displayName: 'Unverified history', isReadOnly: true },
    ] });
    const binding = { provider: 'tencent_cloud' as const, accountUid: '100002', regionId: 'ap-nanjing', accessKeyId: 'synthetic-tencent-id' };
    await prisma.cloudAccountContext.createMany({ data: [
      { id: 'context-a', cloudWorkspaceId: 'space-a', provider: 'alibaba_cloud', accountUid: '100001', displayName: 'Ali A', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', accessKeyId: 'synthetic-ali-id', accessKeySecret: 'synthetic-ali-secret', status: 'ready', imageImportBucket: '', isActive: true },
      { id: 'context-b', cloudWorkspaceId: 'space-b', ...binding, displayName: 'Tencent B', zoneId: 'ap-nanjing-1', accessKeySecret: encryptCloudCredential('synthetic-tencent-secret', binding, Buffer.from('ab'.repeat(32), 'hex')), status: 'ready', imageImportBucket: '', isActive: false },
    ] });
    await prisma.platformUser.createMany({ data: [
      { id: 'manager', username: 'manager', loginUsername: 'manager', isPlatformManager: true, cloudWorkspaceId: null, selectedCloudWorkspaceId: 'space-a', oidcIssuer: issuer, oidcSubject: 'manager', passwordHash: 'synthetic-hash', role: 'admin' },
      { id: 'alice', username: 'alice', loginUsername: 'alice-a', cloudWorkspaceId: 'space-a', oidcIssuer: issuer, oidcSubject: 'alice', passwordHash: 'synthetic-hash', role: 'user' },
      { id: 'bob', username: 'bob', loginUsername: 'bob-b', cloudWorkspaceId: 'space-b', oidcIssuer: issuer, oidcSubject: 'bob', passwordHash: 'synthetic-hash', role: 'admin' },
    ] });
    for (const [id, provider] of [['space-a', 'alibaba_cloud'], ['space-b', 'tencent_cloud']] as const) {
      await prisma.rangeTemplate.create({ data: { id: `template-${id}`, cloudWorkspaceId: id, name: `Template ${id}`, slug: 'same-template', version: '1', cloudProvider: provider, modulePathOrRef: 'fixture', ownerUserId: 'manager', visibility: 'platform', variableSchema: {}, outputSchema: {} } });
    }
  }));

  afterAll(async () => {
    await app?.close(); await prisma?.$disconnect();
    if (previousEnforce === undefined) delete process.env.CLOUD_WORKSPACE_ENFORCE_TEST_SCOPE; else process.env.CLOUD_WORKSPACE_ENFORCE_TEST_SCOPE = previousEnforce;
    if (previousKey === undefined) delete process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY; else process.env.CLOUD_CREDENTIALS_ENCRYPTION_KEY = previousKey;
  });

  it('gets verified identity without depending on a stale selected workspace header', async () => {
    const profile = await request(app.getHttpServer()).get('/admin/session').set('authorization', authorization('manager')).set('x-cloud-workspace-id', 'missing-space').expect(200);
    expect(profile.body).toMatchObject({ id: 'manager', isPlatformManager: true, cloudWorkspaceId: null });
  });

  it('switches visible data and restores it without changing any cloud credentials or global active context', async () => {
    const auth = authorization('manager');
    const before = await runInSystemCloudWorkspaceScope(() => prisma.cloudAccountContext.findMany({ orderBy: { id: 'asc' } }));
    const first = await request(app.getHttpServer()).get('/admin/scenarios?view=platform').set('authorization', auth).expect(200);
    expect(first.body.map((item: { id: string }) => item.id)).toEqual(['template-space-a']);
    await request(app.getHttpServer()).post('/admin/cloud-workspaces/space-b/switch').set('authorization', auth).send({}).expect(201);
    const second = await request(app.getHttpServer()).get('/admin/scenarios?view=platform').set('authorization', auth).expect(200);
    expect(second.body.map((item: { id: string }) => item.id)).toEqual(['template-space-b']);
    await request(app.getHttpServer()).get('/admin/scenarios/template-space-a').set('authorization', auth).expect(404);
    await request(app.getHttpServer()).post('/admin/cloud-workspaces/space-a/switch').set('authorization', auth).send({}).expect(201);
    const restored = await request(app.getHttpServer()).get('/admin/scenarios?view=platform').set('authorization', auth).expect(200);
    expect(restored.body.map((item: { id: string }) => item.id)).toEqual(['template-space-a']);
    expect(await runInSystemCloudWorkspaceScope(() => prisma.cloudAccountContext.findMany({ orderBy: { id: 'asc' } }))).toEqual(before);
  });

  it('keeps explicit per-window selection independent from the user default preference', async () => {
    await request(app.getHttpServer()).post('/admin/cloud-workspaces/space-b/switch').set('authorization', authorization('manager')).send({}).expect(201);
    const current = await request(app.getHttpServer()).get('/admin/cloud-workspaces/current').set('authorization', authorization('manager')).set('x-cloud-workspace-id', 'space-a').expect(200);
    expect(current.body.id).toBe('space-a');
    expect((await request(app.getHttpServer()).get('/admin/cloud-workspaces/current').set('authorization', authorization('manager')).expect(200)).body.id).toBe('space-b');
  });

  it('does not silently fall back after an invalid selection', async () => {
    await request(app.getHttpServer()).get('/admin/cloud-workspaces/current').set('authorization', authorization('manager')).set('x-cloud-workspace-id', 'not-real').expect(404);
  });

  it('denies business users and business administrators foreign data or credentials', async () => {
    await request(app.getHttpServer()).post('/admin/cloud-workspaces/space-b/switch').set('authorization', authorization('alice')).send({}).expect(403);
    await request(app.getHttpServer()).get('/admin/scenarios?view=platform').set('authorization', authorization('alice')).set('x-cloud-workspace-id', 'space-b').expect(403);
    const list = await request(app.getHttpServer()).get('/admin/cloud-workspaces').set('authorization', authorization('bob')).expect(200);
    expect(list.body.map((space: { id: string }) => space.id)).toEqual(['space-b']);
    await request(app.getHttpServer()).get('/admin/cloud-contexts/context-a/instance-type-availability?cpu=2&memory=4').set('authorization', authorization('bob')).expect(404);
  });

  it('makes the legacy history read-only while allowing explicit registry selection', async () => {
    await request(app.getHttpServer()).get('/admin/users').set('authorization', authorization('manager')).set('x-cloud-workspace-id', 'legacy-unbound').expect(200);
    await request(app.getHttpServer()).post('/admin/users').set('authorization', authorization('manager')).set('x-cloud-workspace-id', 'legacy-unbound').send({ username: 'new-user', password: 'synthetic-password', role: 'user' }).expect(403);
    await request(app.getHttpServer()).post('/admin/cloud-workspaces/space-a/switch').set('authorization', authorization('manager')).set('x-cloud-workspace-id', 'legacy-unbound').send({}).expect(201);
  });
  it('restricts binding deletion to managers and preserves business history', async () => {
    await request(app.getHttpServer()).delete('/admin/cloud-workspaces/space-b').set('authorization', authorization('bob')).expect(403);
    await request(app.getHttpServer()).delete('/admin/cloud-workspaces/space-a').set('authorization', authorization('manager')).expect(409);
    const removed = await request(app.getHttpServer()).delete('/admin/cloud-workspaces/space-b').set('authorization', authorization('manager')).expect(200);
    expect(removed.body).toMatchObject({ id: 'space-b', retainedData: true });
    expect(JSON.stringify(removed.body)).not.toContain('synthetic-tencent');
    const listed = await request(app.getHttpServer()).get('/admin/cloud-workspaces').set('authorization', authorization('manager')).expect(200);
    expect(listed.body.map((space: { id: string }) => space.id)).not.toContain('space-b');
    await request(app.getHttpServer()).post('/admin/cloud-workspaces/space-b/switch').set('authorization', authorization('manager')).send({}).expect(409);
    expect(await runInSystemCloudWorkspaceScope(() => prisma.rangeTemplate.count({ where: { cloudWorkspaceId: 'space-b' } }))).toBe(1);
    const audit = await runInSystemCloudWorkspaceScope(() => prisma.operationAuditEvent.findMany({ where: { toolName: 'cloud_account_remove', targetId: 'space-b', phase: 'succeeded' } }));
    expect(audit).toHaveLength(1);
  });
});
