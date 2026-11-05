import { rangeLaunchBatches } from '../src/admin/range-launch-batches';
import type { RangeLaunchReceipt, RangeInstanceRecord } from '../src/admin/admin.repository';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { RangeInstancesService } from '../src/admin/range-instances.service';

const batch = '6c305d42-78f1-4f81-bdef-040c31f44586';
const scope = { cloudWorkspaceId: 'workspace-a', provider: 'alibaba_cloud' as const, accountUid: 'fixture-account' };
function instance(index: number, overrides: Partial<RangeInstanceRecord> = {}): RangeInstanceRecord {
  return { id: `range-${index}`, cloudWorkspaceId: scope.cloudWorkspaceId, ownerUserId: 'owner-a', instanceMode: 'range',
    name: `批量靶场-${index}`, templateId: 'template-a', status: 'running', ...overrides } as RangeInstanceRecord;
}
function receipt(index: number, overrides: Partial<RangeLaunchReceipt> = {}): RangeLaunchReceipt {
  return { cloudWorkspaceId: scope.cloudWorkspaceId, actorUserId: 'owner-a', rangeInstanceId: `range-${index}`,
    idempotencyKey: `${batch}-${index}`, ...overrides };
}

describe('range batch membership from durable launch receipts', () => {
  it('recognizes existing batches across active/history views without grouping by time', () => {
    const result = rangeLaunchBatches([instance(1), instance(2, { status: 'destroyed' })], [receipt(2), receipt(1)]);
    expect(result.get('range-1')).toMatchObject({ name: '批量靶场', index: 1, quantity: 2 });
    expect(result.get('range-2')).toMatchObject({ id: result.get('range-1')!.id, index: 2, quantity: 2 });
  });
  it('does not infer membership from names or standalone request keys', () => {
    expect(rangeLaunchBatches([instance(1), instance(2)], []).size).toBe(0);
    expect(rangeLaunchBatches([instance(1)], [receipt(1, { idempotencyKey: batch })]).size).toBe(0);
  });
  it.each([
    { actorUserId: 'other-owner' }, { cloudWorkspaceId: 'other-space' },
    { idempotencyKey: `${batch}-0` }, { idempotencyKey: `${batch}-100` }, { idempotencyKey: 'arbitrary-key-1' },
  ])('rejects unproven receipt identity: %p', changes => {
    expect(rangeLaunchBatches([instance(1)], [receipt(1, changes)]).size).toBe(0);
  });
  it.each([{ name: '另一个名字-2' }, { templateId: 'other-template' }, { name: '批量靶场-1' }])('leaves inconsistent groups standalone: %p', changes => {
    const records = [instance(1), instance(2, changes)];
    const receipts = changes.name === '批量靶场-1' ? [receipt(1), receipt(2, { idempotencyKey: `${batch}-1` })] : [receipt(1), receipt(2)];
    expect(rangeLaunchBatches(records, receipts).size).toBe(0);
  });
  it('keeps two owners with the same request prefix in separate batches', () => {
    const result = rangeLaunchBatches([instance(1), instance(2, { ownerUserId: 'owner-b' })], [receipt(1), receipt(2, { actorUserId: 'owner-b' })]);
    expect(result.get('range-1')!.id).not.toBe(result.get('range-2')!.id);
    expect(result.get('range-1')!.quantity).toBe(1);
  });
  it('does not count unsubmitted members or accept two receipts for the same instance', () => {
    expect(rangeLaunchBatches([instance(1)], [receipt(1)]).get('range-1')!.quantity).toBe(1);
    const other = receipt(1, { idempotencyKey: '7c305d42-78f1-4f81-bdef-040c31f44586-1' });
    expect(rangeLaunchBatches([instance(1)], [receipt(1), other]).size).toBe(0);
  });
  it('does not create range batches for single instances', () => {
    expect(rangeLaunchBatches([instance(1, { instanceMode: 'single' })], [receipt(1)]).size).toBe(0);
  });
});

describe('batch list integration and receipt visibility', () => {
  it('projects batch membership but never exposes keys or saved credentials, and preserves owner/view isolation', async () => {
    const repository = createMemoryAdminRepository();
    await runInCloudWorkspace(scope, async () => {
      const first = await repository.createRangeInstance({ name: '批量靶场-1', ownerUserId: 'owner-a', instanceMode: 'range', status: 'running', expiresAt: '2099-01-01T00:00:00Z' });
      const second = await repository.createRangeInstance({ name: '批量靶场-2', ownerUserId: 'owner-a', instanceMode: 'range', status: 'destroyed' });
      const foreign = await repository.createRangeInstance({ name: '他人的靶场', ownerUserId: 'owner-b', instanceMode: 'range', status: 'running' });
      for (const [index, record] of [first, second].entries()) {
        const operation = await repository.createIdempotentOperation({ actorUserId: 'owner-a', toolName: 'web_range_instance_launch',
          idempotencyKey: `${batch}-${index + 1}`, argumentsHash: 'fixture', operationId: `launch-${index}` });
        await repository.updateIdempotentOperation(operation.id, { status: 'succeeded', result: { id: record.id, runtimeCredentials: { host: { password: 'fixture-secret-not-public' } } } });
      }
      const service = new RangeInstancesService(repository, {} as never, {} as never, {} as never, {} as never);
      const active = await service.list({ id: 'owner-a', role: 'user' });
      expect(active.map(record => record.id)).toEqual([first.id]);
      expect(active[0].launchBatch).toMatchObject({ name: '批量靶场', quantity: 2, index: 1 });
      expect(active[0].expiresAt).toEqual(new Date('2099-01-01T00:00:00Z'));
      expect(JSON.stringify(active)).not.toContain('fixture-secret-not-public');
      expect(JSON.stringify(active)).not.toContain('idempotencyKey');
      const history = await service.list({ id: 'owner-a', role: 'user' }, 'history');
      expect(history[0].launchBatch!.id).toEqual(active[0].launchBatch!.id);
      expect((await service.list({ id: 'owner-b', role: 'user' })).map(record => record.id)).toEqual([foreign.id]);
    });
    expect(await runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'workspace-b' }, () => repository.listRangeLaunchReceipts(['any-id']))).toEqual([]);
  });
  it('ignores failed intakes and receipts from other operations', async () => runInCloudWorkspace(scope, async () => {
    const repository = createMemoryAdminRepository();
    for (const toolName of ['web_range_instance_launch', 'web_single_instance_batch_launch']) {
      const op = await repository.createIdempotentOperation({ actorUserId: 'owner-a', toolName, idempotencyKey: `${batch}-1`, argumentsHash: 'fixture', operationId: toolName });
      await repository.updateIdempotentOperation(op.id, { status: toolName === 'web_range_instance_launch' ? 'failed' : 'succeeded', result: { id: 'range-1' } });
    }
    expect(await repository.listRangeLaunchReceipts(['range-1'])).toEqual([]);
  }));
});
