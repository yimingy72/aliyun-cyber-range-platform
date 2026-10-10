import { ConflictException } from '@nestjs/common';
import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import { RangesController } from '../src/admin/ranges.controller';
import { OperationControlService } from '../src/operations/operation-control.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('controlled DNS configuration action boundaries', () => {
 const user: any = { id: 'alice', username: 'alice', role: 'user' };
 function fixture() {
  const instance: any = { id: 'range-1', instanceMode: 'range', cloudProvider: 'tencent_cloud', status: 'running', ownerUserId: 'alice',
   resourceSummary: { mode: 'opentofu', hostIds: { win: 'ins-original' }, executionContext: { cloudAccountContextId: 'context-original', cloudAccountUid: '1234', regionId: 'ap-nanjing' } } };
  const repository: any = { getRangeInstanceById: jest.fn(async () => instance), listProvisionJobs: jest.fn(async () => []) };
  const config: any = { getAccountContextById: jest.fn(async () => ({ provider: 'tencent_cloud', cloudAccountContextId: 'context-original', accountUid: '1234', accountUidResolved: true, defaultRegion: 'ap-nanjing' })) };
  const dns: any = { verify: jest.fn(async () => ({ status: 'verified', action: 'apply-dns' })) };
  return { instance, repository, config, dns, service: new RangeInstanceNodeActionsService(repository, config, {} as any, dns) };
 }
 it('routes only to the fixed deployed policy service, preserving the original account', async () => {
  const t = fixture(); await expect(t.service.run('range-1', 'win', 'apply-dns', {}, user)).resolves.toMatchObject({ action: 'apply-dns' });
  expect(t.config.getAccountContextById).toHaveBeenCalledWith('context-original'); expect(t.dns.verify).toHaveBeenCalledWith('range-1', 'win', user, undefined, true);
 });
 const invalidPayloads: Array<Record<string, string>> = [{ command: 'whoami' }, { dns: '8.8.8.8' }, { instanceId: 'ins-other' }];
 it.each(invalidPayloads)('rejects custom payload %j', async payload => {
  const t = fixture(); await expect(t.service.run('range-1', 'win', 'apply-dns', payload, user)).rejects.toThrow('自定义'); expect(t.dns.verify).not.toHaveBeenCalled();
 });
 it('rejects wrong owner, active destroy and mismatched frozen account before guest mutation', async () => {
  const t = fixture(); await expect(t.service.run('range-1', 'win', 'apply-dns', {}, { ...user, id: 'other' })).rejects.toThrow('denied');
  t.repository.listProvisionJobs.mockResolvedValue([{ rangeInstanceId: 'range-1', status: 'pending' }]);
  await expect(t.service.run('range-1', 'win', 'apply-dns', {}, user)).rejects.toThrow('active operation');
  t.repository.listProvisionJobs.mockResolvedValue([]); t.config.getAccountContextById.mockResolvedValue({ provider: 'tencent_cloud', accountUid: 'foreign' });
  await expect(t.service.run('range-1', 'win', 'apply-dns', {}, user)).rejects.toThrow('绑定不符'); expect(t.dns.verify).not.toHaveBeenCalled();
 });
 it('preserves the two-stage confirmation with the precise apply DNS tool name', async () => runInCloudWorkspace({ cloudWorkspaceId: 'fixture-space', provider: 'tencent_cloud', accountUid: '1234' }, async () => {
  const prepare = jest.fn(async () => ({ targetId: 'range-1', targetSnapshot: null, summary: {} })); const run = jest.fn(async () => ({ action: 'apply-dns', status: 'verified' }));
  const controller = new RangesController({ prepareActionConfirmation: prepare } as any, { run } as any, new OperationControlService(createMemoryAdminRepository()));
  const req: any = { headers: {}, adminUser: user, authContext: { user, source: 'mcp', oauthClientId: 'fixture-mcp' } };
  let confirmationId: string | undefined;
  try { await controller.runNodeAction(req, 'range-1', 'win', 'apply-dns', {}); } catch (error) {
   expect(error).toBeInstanceOf(ConflictException); confirmationId = ((error as ConflictException).getResponse() as { confirmationId: string }).confirmationId;
  }
  expect(confirmationId).toEqual(expect.any(String)); expect(run).not.toHaveBeenCalled();
  await controller.runNodeAction({ ...req, headers: { 'x-confirmation-id': confirmationId } }, 'range-1', 'win', 'apply-dns', {});
  expect(prepare).toHaveBeenCalledWith('range-1', 'range_instance_node_apply_dns', user, false, { nodeId: 'win' });
  expect(run).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledWith('range-1', 'win', 'apply-dns', {}, user);
 }));
 it('rejects arbitrary parameters at the controller before confirmation or dispatch', () => {
  const run = jest.fn(); const controller = new RangesController({} as any, { run } as any, {} as any);
  expect(() => controller.runNodeAction({ adminUser: user, authContext: { source: 'mcp' } } as any, 'range-1', 'win', 'apply-dns', { command: 'private' })).toThrow('自定义');
  expect(run).not.toHaveBeenCalled();
 });
});
