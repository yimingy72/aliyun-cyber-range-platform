import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminAuthGuard } from '../src/admin/admin-auth.guard';
import { PackedImagesController } from '../src/admin/packed-images.controller';
import { PackedImagesService } from '../src/admin/packed-images.service';
import { assertDelegatedApiScopes } from '../src/auth/delegated-api-scopes';

describe('Packed image task HTTP contract', () => {
  it('offers scoped reads and original-task verification, not a retry-create endpoint', async () => {
    const user = { id: 'owner', username: 'owner', role: 'user' };
    const service = { listTasks: jest.fn().mockResolvedValue([]), getTask: jest.fn().mockResolvedValue({ id: 'original' }), verifyTask: jest.fn().mockResolvedValue({ id: 'original', state: 'unconfirmed' }) };
    const module = await Test.createTestingModule({ controllers: [PackedImagesController], providers: [{ provide: PackedImagesService, useValue: service }] })
      .overrideGuard(AdminAuthGuard).useValue({ canActivate: (context: any) => { context.switchToHttp().getRequest().adminUser = user; return true; } }).compile();
    const app = module.createNestApplication(); await app.init();
    try {
      await request(app.getHttpServer()).get('/admin/packed-images?sourceRangeInstanceId=source').expect(200, []);
      expect(service.listTasks).toHaveBeenCalledWith(user, 'source');
      await request(app.getHttpServer()).get('/admin/packed-images/original').expect(200, { id: 'original' });
      await request(app.getHttpServer()).post('/admin/packed-images/original/verify').send({}).expect(201, { id: 'original', state: 'unconfirmed' });
      expect(service.verifyTask).toHaveBeenCalledWith('original', user);
      await request(app.getHttpServer()).post('/admin/packed-images/original/retry').send({}).expect(404);
    } finally { await app.close(); }
  });

  it('requires image read permission and requires write permission for reconciliation', () => {
    expect(() => assertDelegatedApiScopes('GET', '/admin/packed-images', new Set(['images:read']))).not.toThrow();
    expect(() => assertDelegatedApiScopes('GET', '/admin/packed-images/task', new Set(['ranges:read']))).toThrow();
    expect(() => assertDelegatedApiScopes('POST', '/admin/packed-images/task/verify', new Set(['images:read']))).toThrow();
    expect(() => assertDelegatedApiScopes('POST', '/admin/packed-images/task/verify', new Set(['images:read', 'images:write']))).not.toThrow();
  });

  it.each(['GET', 'POST'])('lets ordinary authenticated owners reach task %s routes', async method => {
    const guard = new AdminAuthGuard({ verifyAccessToken: async () => ({ issuer: 'issuer', subject: 'subject', authorizedParty: 'web', scopes: ['openid'] }) } as never,
      { resolve: async () => ({ id: 'owner', username: 'owner', role: 'user' }) } as never);
    expect(await guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer a.b.c' }, method,
      originalUrl: method === 'GET' ? '/admin/packed-images' : '/admin/packed-images/original/verify' }) }) } as never)).toBe(true);
  });
});
