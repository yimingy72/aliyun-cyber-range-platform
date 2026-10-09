import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/bootstrap/configure-app';
import { AdminAuthGuard } from '../src/admin/admin-auth.guard';
import { CloudAccountContextsController } from '../src/admin/cloud-account-contexts.controller';
import { CloudAccountContextsService } from '../src/admin/cloud-account-contexts.service';
import { SystemConfigService } from '../src/admin/system-config.service';
import { OperationControlService } from '../src/operations/operation-control.service';

const input = { provider: 'tencent_cloud', regionId: 'ap-shanghai', zoneId: 'ap-shanghai-2', accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret' };
describe('Cloud contexts HTTP trust boundaries', () => {
  let app: INestApplication;
  let role = 'admin';
  const save = jest.fn().mockResolvedValue({ id: 'tencent-context', provider: 'tencent_cloud', isActive: false });
  const list = jest.fn().mockResolvedValue([]);
  const getAccountContextById = jest.fn().mockResolvedValue({ provider: 'tencent_cloud' });
  const getInstanceTypeAvailabilityInContext = jest.fn().mockResolvedValue({ matches: [] });
  const audit = jest.fn().mockResolvedValue(undefined);
  const executeConfirmed = jest.fn();
  let source = 'web';
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [CloudAccountContextsController], providers: [
      { provide: CloudAccountContextsService, useValue: { saveTencentCloudContext: save, list } },
      { provide: SystemConfigService, useValue: { getAccountContextById, getInstanceTypeAvailabilityInContext } },
      { provide: OperationControlService, useValue: { audit, executeConfirmed } },
    ] }).overrideGuard(AdminAuthGuard).useValue({ canActivate(context: any) {
      const req = context.switchToHttp().getRequest(); req.adminUser = { id: 'admin-fixture', role }; req.authContext = { user: { id: 'admin-fixture', role }, source, oauthClientId: 'fixture' }; return true;
    } }).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
  });
  beforeEach(() => { jest.clearAllMocks(); role = 'admin'; source = 'web'; });
  afterAll(async () => app.close());
  it('accepts only explicit Tencent account inputs at the independent save endpoint', async () => {
    const response = await request(app.getHttpServer()).post('/admin/cloud-contexts').send(input).expect(201);
    expect(response.body).toEqual({ id: 'tencent-context', provider: 'tencent_cloud', isActive: false });
    expect(save).toHaveBeenCalledWith(expect.objectContaining(input));
    expect(audit.mock.calls.map(([event]) => event.phase)).toEqual(['requested', 'succeeded']);
  });
  it('requires MCP confirmation before credentials are verified or persisted', async () => {
    source = 'mcp';
    executeConfirmed.mockResolvedValue({ confirmationRequired: true });
    await request(app.getHttpServer()).post('/admin/cloud-contexts').set('x-idempotency-key', 'fixture-idempotency').send(input).expect(201);
    expect(save).not.toHaveBeenCalled();
    const control = executeConfirmed.mock.calls[0][0];
    expect(control.toolName).toBe('tencent_cloud_account_save');
    expect(control.metadata.idempotencyKey).toBe('fixture-idempotency');
    const confirmation = await control.resolveConfirmation();
    expect(confirmation.summary.activatesResourceCreation).toBe(false);
    expect(JSON.stringify(confirmation)).not.toContain(input.accessKeySecret);
    await control.execute();
    expect(save).toHaveBeenCalledWith(expect.objectContaining(input));
  });
  it.each([{}, { ...input, provider: 'alibaba_cloud' }, { ...input, accessKeyId: null }, { ...input, accessKeySecret: 123 }, { ...input, accessKeySecret: '********' }, { ...input, imageImportBucket: 'alibaba-bucket' }, { ...input, isActive: true }])('rejects incomplete or unsupported writes before service %j', async (payload) => {
    await request(app.getHttpServer()).post('/admin/cloud-contexts').send(payload).expect(400);
    expect(save).not.toHaveBeenCalled();
  });
  it('keeps ordinary listings active-only and allows inactive catalog only for administrators', async () => {
    await request(app.getHttpServer()).get('/admin/cloud-contexts').expect(200);
    expect(list).toHaveBeenLastCalledWith({ includeInactive: false });
    await request(app.getHttpServer()).get('/admin/cloud-contexts?includeInactive=true').expect(200);
    expect(list).toHaveBeenLastCalledWith({ includeInactive: true });
    role = 'user'; list.mockClear();
    await request(app.getHttpServer()).get('/admin/cloud-contexts?includeInactive=true').expect(403);
    await request(app.getHttpServer()).get('/admin/cloud-contexts?includeInactive=1').expect(400);
    expect(list).not.toHaveBeenCalled();
  });
  it.each(['cpu=2x&memory=4', 'cpu=0&memory=4', 'cpu=2&memory=-1', 'cpu=2&memory=4.5', 'cpu=2'])('rejects malformed bound-context shapes before reading credentials %s', async (query) => {
    await request(app.getHttpServer()).get(`/admin/cloud-contexts/tencent-context/instance-type-availability?${query}`).expect(400);
    expect(getAccountContextById).not.toHaveBeenCalled();
  });
  it('uses the explicitly selected context for the exact shape query', async () => {
    await request(app.getHttpServer()).get('/admin/cloud-contexts/tencent-context/instance-type-availability?cpu=2&memory=4').expect(200);
    expect(getAccountContextById).toHaveBeenCalledWith('tencent-context');
    expect(getInstanceTypeAvailabilityInContext).toHaveBeenCalledWith({ cpu: 2, memory: 4 }, { provider: 'tencent_cloud' });
  });
});
