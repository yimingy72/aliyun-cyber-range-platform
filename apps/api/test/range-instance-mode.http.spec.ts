import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RangesController } from '../src/admin/ranges.controller';
import { RangeInstanceModeGuard } from '../src/admin/range-instance-mode.guard';
import { AdminAuthGuard } from '../src/admin/admin-auth.guard';
import { ADMIN_REPOSITORY } from '../src/admin/admin.repository';
import { RangeInstancesService } from '../src/admin/range-instances.service';
import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import { OperationControlService } from '../src/operations/operation-control.service';
import { assertDelegatedApiScopes } from '../src/auth/delegated-api-scopes';
import { getCurrentCloudWorkspaceId } from '../src/auth/cloud-workspace-scope';

const routes = [
  ['get', '/single'], ['get', '/single/access'], ['get', '/single/recovery/retry'],
  ['patch', '/single/draft'], ['delete', '/single/draft'], ['post', '/single/destroy'],
  ['post', '/single/retry'], ['post', '/single/preview'], ['post', '/single/apply'],
  ['post', '/single/templates'], ['post', '/single/sync-template'],
  ...['start', 'stop', 'reboot', 'open-vnc', 'apply-dns', 'verify-dns', 'pack-image'].map(action => ['post', `/single/nodes/host/actions/${action}`]),
  ['post', '/single/nodes/host/pack-image-validation'],
];

describe.each(['alibaba_cloud', 'tencent_cloud'] as const)('range route mode boundary: %s', provider => {
  it('denies range-scoped requests for a standalone ID before any action/queue/access side effect', async () => {
    const sideEffect = jest.fn();
    const repository = { getRangeInstanceById: jest.fn(async (id: string) => {
      expect(getCurrentCloudWorkspaceId()).toBe('workspace');
      return id === 'missing' ? null : { id, instanceMode: id === 'range' ? 'range' : 'single', cloudProvider: provider };
    }) };
    const scopes = ['ranges:read', 'ranges:write', 'ranges:control', 'ranges:destroy', 'templates:write', 'images:write', 'images:read', 'instances:credentials:read'];
    const module = await Test.createTestingModule({ controllers: [RangesController], providers: [
      RangeInstanceModeGuard, { provide: ADMIN_REPOSITORY, useValue: repository },
      { provide: RangeInstancesService, useValue: { getById: sideEffect, list: jest.fn().mockResolvedValue([]) } },
      { provide: RangeInstanceNodeActionsService, useValue: { run: sideEffect } },
      { provide: OperationControlService, useValue: { executeConfirmed: sideEffect, executeRangeRecoveryIntake: sideEffect, audit: sideEffect } },
    ] }).overrideGuard(AdminAuthGuard).useValue({ canActivate(context: any) {
      const req = context.switchToHttp().getRequest();
      assertDelegatedApiScopes(req.method, req.url.split('?')[0], new Set(scopes));
      req.adminUser = { id: 'owner', role: 'user' };
      req.authContext = { user: req.adminUser, source: 'mcp', delegatedScopes: scopes };
      req.cloudWorkspaceScope = { cloudWorkspaceId: 'workspace', provider, accountUid: '100001' };
      return true;
    } }).compile();
    const app = module.createNestApplication(); await app.init();
    try {
      for (const [method, suffix] of routes) {
        const call = request(app.getHttpServer())[method as 'get'](`/admin/ranges${suffix}`);
        await call.send({}).expect(404);
      }
      await request(app.getHttpServer()).get('/admin/ranges/missing').expect(404);
      expect(sideEffect).not.toHaveBeenCalled();
      sideEffect.mockResolvedValueOnce({ id: 'range' });
      await request(app.getHttpServer()).get('/admin/ranges/range').expect(200, { id: 'range' });
      await request(app.getHttpServer()).get('/admin/ranges').expect(200, []);
    } finally { await app.close(); }
  });
});
