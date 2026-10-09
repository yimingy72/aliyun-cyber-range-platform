import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/bootstrap/configure-app';
import { AdminAuthGuard } from '../src/admin/admin-auth.guard';
import { SystemConfigController } from '../src/admin/system-config.controller';
import { SystemConfigService } from '../src/admin/system-config.service';
import { OperationControlService } from '../src/operations/operation-control.service';

const snapshot = { provider: 'alibaba_cloud', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'synthetic-access-key', accessKeySecret: 'synthetic-secret', imageImportBucket: '' };
describe('System cloud config HTTP validation', () => {
  let app: INestApplication;
  let isPlatformManager = true;
  const save = jest.fn(async () => snapshot);
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [SystemConfigController], providers: [
      { provide: SystemConfigService, useValue: { updateSnapshot: save } },
      { provide: OperationControlService, useValue: {} },
    ] }).overrideGuard(AdminAuthGuard).useValue({ canActivate(context: any) { const req = context.switchToHttp().getRequest(); req.authContext = { source: 'web' }; req.adminUser = { id: 'fixture-user', role: 'admin', isPlatformManager }; return true; } }).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
  });
  beforeEach(() => { save.mockClear(); isPlatformManager = true; });
  afterAll(async () => app.close());
  it('rejects a workspace administrator attempting a credential update before the config service runs', async () => {
    isPlatformManager = false;
    await request(app.getHttpServer()).patch('/admin/system-config').send({ defaultRegion: 'cn-hangzhou' }).expect(403);
    expect(save).not.toHaveBeenCalled();
  });
  it.each(['defaultRegion', 'defaultZoneId', 'accessKeyId', 'accessKeySecret', 'imageImportBucket', 'provider'])('rejects numeric and null %s without passing a write downstream', async (field) => {
    for (const value of [123, null]) { await request(app.getHttpServer()).patch('/admin/system-config').send({ [field]: value }).expect(400); }
    expect(save).not.toHaveBeenCalled();
  });
  it.each([{}, [], null, { provider: 'alibaba_cloud' }, { unknownField: 'value' }, { defaultRegion: ' ' }, { accessKeyId: '********' }])('rejects invalid or empty update bodies before writes: %j', async (body) => {
    await request(app.getHttpServer()).patch('/admin/system-config').set('Content-Type', 'application/json').send(JSON.stringify(body)).expect(400); expect(save).not.toHaveBeenCalled();
  });
  it.each([{ defaultZoneId: 'cn-hangzhou-h' }, { accessKeySecret: '' }, { accessKeySecret: '********' }, { imageImportBucket: '' }])('preserves valid partial updates and web Secret retention: %j', async (body) => {
    await request(app.getHttpServer()).patch('/admin/system-config').send(body).expect(200);
    expect(save).toHaveBeenCalledWith(expect.objectContaining(body));
  });
});
