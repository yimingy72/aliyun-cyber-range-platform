import { RangeInstanceModeGuard } from '../src/admin/range-instance-mode.guard';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminAuthGuard } from '../src/admin/admin-auth.guard';
import { RangesController } from '../src/admin/ranges.controller';
import { SingleInstancesController } from '../src/admin/single-instances.controller';
import { RangeInstancesService } from '../src/admin/range-instances.service';
import { SingleInstancesService } from '../src/admin/single-instances.service';
import { SingleInstanceNetworkService } from '../src/admin/single-instance-network.service';
import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import { OperationControlService } from '../src/operations/operation-control.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe.each(['ranges', 'instances'])('Web %s launch durable intake', kind => {
  const workspace = { cloudWorkspaceId: 'workspace-a', provider: 'alibaba_cloud' as const, accountUid: 'account-a' };
  let app: any;
  let launch: jest.Mock;
  let repository: ReturnType<typeof createMemoryAdminRepository>;
  const payload = { name: 'same launch', templateId: 'template-a', quantity: 2 };
  const toolName = kind === 'ranges' ? 'web_range_instance_launch' : 'web_single_instance_batch_launch';
  beforeEach(async () => {
    repository = createMemoryAdminRepository();
    launch = jest.fn().mockResolvedValue(kind === 'ranges'
      ? { id: 'range-a', lastJobId: 'job-a', status: 'pending_create', runtimeCredentials: { host: { password: 'generated-secret' } } }
      : { batch: { id: 'batch-a' }, instances: [{ id: 'member-a', runtimeCredentials: { host: { password: 'generated-secret' } } }] });
    const module = await Test.createTestingModule({ controllers: [RangesController, SingleInstancesController], providers: [
      { provide: RangeInstancesService, useValue: { launch } }, { provide: SingleInstancesService, useValue: { launch } },
      { provide: RangeInstanceNodeActionsService, useValue: {} }, { provide: SingleInstanceNetworkService, useValue: {} },
      { provide: OperationControlService, useValue: new OperationControlService(repository) },
    ] }).overrideGuard(RangeInstanceModeGuard).useValue({ canActivate: () => true }).overrideGuard(AdminAuthGuard).useValue({ canActivate(context: any) {
      const req = context.switchToHttp().getRequest();
      req.adminUser = { id: req.headers['x-test-user'] ?? 'alice', role: 'user' };
      req.authContext = { user: req.adminUser, source: 'web', oauthClientId: 'platform-web' };
      return true;
    } }).compile();
    app = module.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => runInCloudWorkspace({ ...workspace, cloudWorkspaceId: req.headers['x-test-workspace'] ?? workspace.cloudWorkspaceId }, next));
    await app.init();
  });
  afterEach(async () => { await app.close(); });
  const post = (app: any, key = 'stable-request') => request(app.getHttpServer()).post(`/admin/${kind}/launch`).set('x-idempotency-key', key);

  it('replays the same accepted result after the original HTTP response is lost without retaining credentials', async () => {
    const accepted = await post(app).send(payload).expect(201);
    // The client discards the first response and submits the exact same logical request again.
    const retried = await post(app).send(payload).expect(201);
    expect(retried.body).toEqual(accepted.body);
    expect(launch).toHaveBeenCalledTimes(1);
    const saved = await runInCloudWorkspace(workspace, () => repository.getIdempotentOperation('alice', toolName, 'stable-request'));
    expect(saved?.result).toEqual(accepted.body);
    expect(JSON.stringify(saved)).not.toContain('generated-secret');
  });

  it('refuses missing keys and changed arguments before creating another resource', async () => {
    await request(app.getHttpServer()).post(`/admin/${kind}/launch`).send(payload).expect(400);
    await post(app).send(payload).expect(201);
    await post(app).send({ ...payload, quantity: 50 }).expect(409);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('reserves the key before execution and refuses a simultaneous duplicate', async () => {
    let finish!: (value: any) => void;
    let started!: () => void;
    const executing = new Promise<void>(resolve => { started = resolve; });
    launch.mockImplementationOnce(() => { started(); return new Promise(resolve => { finish = resolve; }); });
    const first = post(app).send(payload).then((response: any) => response);
    await executing;
    const concurrent = await post(app).send(payload).expect(409);
    expect(concurrent.body.code).toBe('OPERATION_IN_PROGRESS');
    finish({ id: 'accepted-a', status: 'pending_create' });
    expect((await first).status).toBe(201);
    await post(app).send(payload).expect(201);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('does not retry creation after a service exception with an unknown outcome', async () => {
    launch.mockRejectedValueOnce(new Error('response lost after intake'));
    await post(app).send(payload).expect(500);
    await post(app).send(payload).expect(409);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('replays the accepted receipt when the response fails after resource intake completed', async () => {
    const append = repository.appendOperationAuditEvent;
    jest.spyOn(repository, 'appendOperationAuditEvent').mockImplementationOnce(append)
      .mockRejectedValueOnce(new Error('audit persistence unavailable after intake'));
    await post(app).send(payload).expect(500);
    const response = await post(app).send(payload).expect(201);
    expect(kind === 'ranges' ? response.body.id : response.body.batch.id).toBe(kind === 'ranges' ? 'range-a' : 'batch-a');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('isolates identical keys across platform users and cloud workspaces', async () => {
    await post(app).send(payload).expect(201);
    await post(app).set('x-test-user', 'bob').send(payload).expect(201);
    await post(app).set('x-test-workspace', 'workspace-b').send(payload).expect(201);
    expect(launch).toHaveBeenCalledTimes(3);
  });
});
