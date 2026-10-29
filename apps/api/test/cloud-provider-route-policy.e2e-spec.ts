import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AdminAuthGuard } from '../src/admin/admin-auth.guard';
import { CloudWorkspaceInterceptor } from '../src/auth/cloud-workspace.interceptor';
import { ImageCatalogController } from '../src/admin/image-catalog.controller';
import { ImageCatalogService } from '../src/admin/image-catalog.service';
import { PlatformContainerImagesService } from '../src/admin/platform-container-images.service';
import { BillingOssBindingController } from '../src/admin/billing-oss-binding.controller';
import { BillingOssBindingService } from '../src/admin/billing-oss-binding.service';
import { AliyunOssManagedBucketService } from '../src/admin/aliyun-oss-managed-bucket.service';
import { SystemConfigController } from '../src/admin/system-config.controller';
import { SystemConfigService } from '../src/admin/system-config.service';
import { OperationControlService } from '../src/operations/operation-control.service';

describe('provider-specific routes reject web and MCP before side effects', () => {
  let app: INestApplication;
  const touched = jest.fn(async () => []);
  let fetch: jest.SpyInstance;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ImageCatalogController, BillingOssBindingController, SystemConfigController],
      providers: [
        { provide: ImageCatalogService, useValue: { listCustom: touched, collectPlatformAsset: touched } },
        { provide: PlatformContainerImagesService, useValue: { preview: touched, collectAll: touched, collectOne: touched } },
        { provide: BillingOssBindingService, useValue: { list: touched, bind: touched, end: touched, confirmation: touched, endConfirmation: touched } },
        { provide: AliyunOssManagedBucketService, useValue: { confirmation: touched, create: touched } },
        { provide: SystemConfigService, useValue: { updateSnapshot: touched } },
        { provide: OperationControlService, useValue: { audit: touched, executeConfirmed: touched } },
      ],
    }).overrideGuard(AdminAuthGuard).useValue({ canActivate(context: any) {
      const req = context.switchToHttp().getRequest();
      req.adminUser = { id: 'manager', role: 'admin', isPlatformManager: true };
      req.authContext = { source: req.headers['x-test-source'], user: req.adminUser };
      req.cloudWorkspaceScope = { cloudWorkspaceId: 'selected-space', provider: req.headers['x-test-provider'] ?? 'tencent_cloud',
        accountUid: '123', actorUserId: 'manager', isPlatformManager: true };
      return true;
    } }).compile();
    app = module.createNestApplication();
    app.useGlobalInterceptors(new CloudWorkspaceInterceptor());
    await app.init();
  });
  beforeEach(() => { touched.mockClear(); fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected cloud request')); });
  afterEach(() => fetch.mockRestore());
  afterAll(async () => { await app.close(); });

  it.each(['web', 'mcp'])('rejects unsupported %s routes repeatedly without confirmations, jobs, audit writes or cloud requests', async source => {
    const routes = [
      ['get', '/admin/image-catalog/mogong', 'mogongCatalog'],
      ['get', '/admin/image-catalog/mogong/containers/preview', 'mogongCatalog'],
      ['post', '/admin/image-catalog/mogong/containers/collect-all', 'mogongCatalog'],
      ['post', '/admin/image-catalog/mogong/42/collect', 'mogongCatalog'],
      ['get', '/admin/billing/oss-binding', 'ossBillingBinding'],
      ['post', '/admin/billing/oss-binding', 'ossBillingBinding'],
      ['post', '/admin/billing/oss-binding/create', 'ossBillingBinding'],
      ['post', '/admin/billing/oss-binding/ledger/end', 'ossBillingBinding'],
      ['patch', '/admin/system-config', 'legacyCloudConfig'],
    ] as const;
    for (let repeat = 0; repeat < 2; repeat += 1) for (const [method, path, feature] of routes) {
      const result = await request(app.getHttpServer())[method](path).set('x-test-source', source).send({});
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ code: 'CLOUD_PROVIDER_UNSUPPORTED', provider: 'tencent_cloud', feature });
    }
    expect(touched).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('evaluates every selected workspace afresh rather than caching the previous provider', async () => {
    for (const provider of ['alibaba_cloud', 'tencent_cloud', 'alibaba_cloud']) {
      const result = await request(app.getHttpServer()).get('/admin/billing/oss-binding').set('x-test-source', 'web').set('x-test-provider', provider);
      expect(result.status).toBe(provider === 'alibaba_cloud' ? 200 : 400);
    }
    expect(touched).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
