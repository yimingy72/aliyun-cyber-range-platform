import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/bootstrap/configure-app';
import { AdminAuthGuard } from '../src/admin/admin-auth.guard';
import { RangesController } from '../src/admin/ranges.controller';
import { RangeInstancesService } from '../src/admin/range-instances.service';
import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import { OperationControlService } from '../src/operations/operation-control.service';
describe('Range diagnostics REST query contract', () => {
  let app: any; const read = jest.fn(async () => ({ id: 'owned' })); const user = { id: 'alice', role: 'user' };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [RangesController], providers: [{ provide: RangeInstancesService, useValue: { getById: read } }, { provide: RangeInstanceNodeActionsService, useValue: {} }, { provide: OperationControlService, useValue: {} }] }).overrideGuard(AdminAuthGuard).useValue({ canActivate(context: any) { context.switchToHttp().getRequest().adminUser = user; return true; } }).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
  });
  beforeEach(() => read.mockClear()); afterAll(async () => app.close());
  it('keeps defaults and false unchanged, and forwards true', async () => {
    await request(app.getHttpServer()).get('/admin/ranges/owned').expect(200); expect(read).toHaveBeenLastCalledWith('owned', user);
    await request(app.getHttpServer()).get('/admin/ranges/owned?includeNetworkDiagnostics=false').expect(200); expect(read).toHaveBeenLastCalledWith('owned', user);
    await request(app.getHttpServer()).get('/admin/ranges/owned?includeNetworkDiagnostics=true').expect(200); expect(read).toHaveBeenLastCalledWith('owned', user, { includeNetworkDiagnostics: true });
  });
  it.each(['includeNetworkDiagnostics=1','includeNetworkDiagnostics=TRUE','includeNetworkDiagnostics=true&vpcId=foreign','includeNetworkDiagnostics=true&includeNetworkDiagnostics=false'])('rejects invalid or extra cloud target query: %s', async (query) => {
    await request(app.getHttpServer()).get(`/admin/ranges/owned?${query}`).expect(400); expect(read).not.toHaveBeenCalled();
  });
});
