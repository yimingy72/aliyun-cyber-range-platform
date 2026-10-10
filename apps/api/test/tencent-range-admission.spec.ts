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
