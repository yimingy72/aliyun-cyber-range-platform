import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { RangeInstancesService } from '../src/admin/range-instances.service';

const actor = { id:'owner-a', role:'user' } as any;
const expiration = new Date(Date.now()+3600_000).toISOString();
const originalFlag = process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED;
afterEach(() => { if(originalFlag===undefined) delete process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED; else process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED=originalFlag; });
function fixture(status='running') {
  const instance: any = { id:'range-a', cloudProvider:'tencent_cloud', ownerUserId:actor.id, status, templateId:'template-a', expiresAt:new Date(expiration), lastJobId:'prior-job', resourceSummary:{ executionContext:{ provider:'tencent_cloud', cloudAccountContextId:'original-context', cloudAccountUid:'100000000001', regionId:'ap-shanghai', zoneId:'ap-shanghai-2' } } };
  const repository = { getRangeInstanceById:jest.fn().mockResolvedValue(instance), getRangeTemplateById:jest.fn().mockResolvedValue({ id:'template-a', cloudProvider:'tencent_cloud' }), createRangeInstance:jest.fn(), applyRangeInstanceDraft:jest.fn(), queueRangeInstanceJob:jest.fn().mockResolvedValue({id:'queued-job'}), getProvisionJobById:jest.fn().mockResolvedValue({retryCount:0}) };
  const worker = { dispatch:jest.fn() };
  const service = new RangeInstancesService(repository as any, {} as any, {} as any, { serialize:async (work:any)=>work() } as any,worker as any);
  return { service,repository,worker,instance };
}
it('blocks Tencent launch before persisting an instance or queuing a job when the recovery flag is off', async () => {
  process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED='0';
  const test=fixture();
  await expect(test.service.launch({templateId:'template-a',name:'test',expiresAt:expiration},actor)).rejects.toThrow('受控验证');
  expect(test.repository.createRangeInstance).not.toHaveBeenCalled(); expect(test.worker.dispatch).not.toHaveBeenCalled();
});
it.each(['apply','create','retry-create'])('blocks %s admission before job submission regardless of current account selection', async operation => {
  process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED='0';
  const test=fixture(operation==='apply'?'running':'create_failed');
  const call=operation==='apply'?test.service.applyDraft(test.instance.id,{expectedDraftRevision:1,previewToken:'not-authorized'},actor):operation==='create'?test.service.triggerCreate(test.instance.id,actor):test.service.triggerRetry(test.instance.id,actor);
  await expect(call).rejects.toThrow('受控验证');
  expect(test.repository.applyRangeInstanceDraft).not.toHaveBeenCalled(); expect(test.repository.queueRangeInstanceJob).not.toHaveBeenCalled(); expect(test.worker.dispatch).not.toHaveBeenCalled();
});
it.each(['destroy','retry-destroy'])('keeps %s enabled while new Tencent NAT execution is off', async operation => {
  process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED='0';
  const test=fixture('destroy_failed');
  const call=operation==='destroy'?test.service.triggerDestroy(test.instance.id,actor):test.service.triggerRetry(test.instance.id,actor);
  await expect(call).resolves.toMatchObject({id:'queued-job'});
  expect(test.repository.queueRangeInstanceJob).toHaveBeenCalledWith(expect.objectContaining({nextStatus:'pending_destroy'}));
});
it('permits controlled Tencent admission when the explicit flag is on', () => {
  process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED='1';
  const test=fixture(); expect(()=> (test.service as any).assertRangeProvisioningEnabled('tencent_cloud')).not.toThrow();
});
it('preserves Alibaba admission while the Tencent NAT flag is off', () => {
  process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED='0';
  const test=fixture(); expect(()=> (test.service as any).assertRangeProvisioningEnabled('alibaba_cloud')).not.toThrow();
});

function legacyCreateFixture(provider: 'alibaba_cloud' | 'tencent_cloud') {
  const template = { id: 'template-a', cloudProvider: provider, name: 'template', slug: 'template' };
  const repository = { getRangeTemplateById: jest.fn().mockResolvedValue(template),
    createRangeInstance: jest.fn(async value => ({ id: 'range-new', ...value })), getPlatformUserById: jest.fn().mockResolvedValue(null) };
  const templates = { resolveTemplateConsumptionVersion: jest.fn().mockResolvedValue({ id: 'version-a', version: '1', modulePathOrRef: `infra/opentofu/modules/${provider === 'tencent_cloud' ? 'tencentcloud' : 'alicloud'}-enterprise-range` }) };
  const service = new RangeInstancesService(repository as any, templates as any, {} as any, {} as any, { dispatch: jest.fn() } as any);
  return { service, repository, templates };
}
it('blocks the legacy Tencent range-create endpoint before it persists an Alibaba-defaulted record', async () => {
  process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED = '0';
  const test = legacyCreateFixture('tencent_cloud');
  await expect(test.service.create({ templateId: 'template-a', name: 'legacy-create' }, actor)).rejects.toThrow('受控验证');
  expect(test.repository.createRangeInstance).not.toHaveBeenCalled();
});
it.each(['alibaba_cloud', 'tencent_cloud'] as const)('binds legacy range-create records to their %s template instead of client/default provider', async provider => {
  process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED = '1';
  const test = legacyCreateFixture(provider);
  await expect(test.service.create({ templateId: 'template-a', name: 'legacy-create', cloudProvider: provider === 'tencent_cloud' ? 'alibaba_cloud' : 'tencent_cloud' }, actor)).resolves.toMatchObject({ cloudProvider: provider });
  expect(test.repository.createRangeInstance).toHaveBeenCalledWith(expect.objectContaining({ cloudProvider: provider, sourceTemplateVersionId: 'version-a' }));
});
it('rejects a mismatched workspace template before legacy range-create persistence', async () => {
  process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED = '1';
  const test = legacyCreateFixture('alibaba_cloud');
  await expect(runInCloudWorkspace({ cloudWorkspaceId: 'workspace-tencent', provider: 'tencent_cloud', accountUid: '100001', isReadOnly: false },
    () => test.service.create({ templateId: 'template-a', name: 'stale-selection' }, actor))).rejects.toThrow('工作空间');
  expect(test.repository.createRangeInstance).not.toHaveBeenCalled();
});
