import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { RangesController } from '../src/admin/ranges.controller';
import { AdminAuthGuard } from '../src/admin/admin-auth.guard';
import { RangeInstancesService } from '../src/admin/range-instances.service';
import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import { OperationControlService } from '../src/operations/operation-control.service';

it('accepts only portable copy metadata and requires a stable creation key at the HTTP boundary', async () => {
 const save = jest.fn().mockResolvedValue({ id: 'copy', templateId: 'copy', visibility: 'private' });
 const module = await Test.createTestingModule({ controllers: [RangesController], providers: [
  { provide: RangeInstancesService, useValue: { saveAsNewTemplate: save } }, { provide: RangeInstanceNodeActionsService, useValue: {} }, { provide: OperationControlService, useValue: {} },
 ] }).overrideGuard(AdminAuthGuard).useValue({ canActivate: (context: any) => { const req = context.switchToHttp().getRequest(); req.adminUser = { id: 'owner', role: 'user' }; req.authContext = { user: req.adminUser, source: 'web' }; return true; } }).compile();
 const app = module.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.init();
 try {
  const payload = { name: ' Copy ', expectedDraftRevision: 3 };
  await request(app.getHttpServer()).post('/admin/ranges/range/templates').send(payload).expect(400);
  for (const extra of [{ topologyGraph: {} }, { cloudProvider: 'tencent_cloud' }, { visibility: 'platform' }, { defaultPassword: 'secret' }]) await request(app.getHttpServer()).post('/admin/ranges/range/templates').set('x-idempotency-key', 'copy').send({ ...payload, ...extra }).expect(400);
  await request(app.getHttpServer()).post('/admin/ranges/range/templates').set('x-idempotency-key', 'copy').send(payload).expect(201);
  expect(save).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledWith('range', expect.objectContaining({ name: 'Copy', expectedDraftRevision: 3 }), { id: 'owner', role: 'user' }, 'copy');
 } finally { await app.close(); }
});
