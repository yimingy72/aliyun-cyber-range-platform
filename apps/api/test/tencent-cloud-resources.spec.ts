import { createHash } from 'node:crypto';
import { describeTencentInstances, describeTencentKnownResourcesWithEvidence, describeTencentResourceInventory, readTencentAttachedDiskInventory, resetTencentStoppedInstancePassword, terminateTencentInstances } from '../src/admin/tencent-cloud-resources';
import { requestTencentCloud, TencentCloudRequestError } from '../src/admin/tencent-cloud-client';
import { SingleInstanceBatchExecutionService } from '../src/admin/single-instance-batch-execution.service';
import { RangeInstanceNodeActionsService } from '../src/admin/range-instance-node-actions.service';
import { PlatformResourceReconciliationService } from '../src/provisioning/platform-resource-reconciliation.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

jest.mock('../src/admin/tencent-cloud-client', () => ({ ...jest.requireActual('../src/admin/tencent-cloud-client'), requestTencentCloud: jest.fn() }));
const request = requestTencentCloud as jest.Mock;
const account = { provider: 'tencent_cloud' as const, accountUid: 'uid-fixture', accountUidResolved: true,
  cloudAccountContextId: 'ctx-fixture', defaultRegion: 'ap-guangzhou', defaultZoneId: 'ap-guangzhou-3', imageImportBucket: '', accessKeyId: 'synthetic-ak', accessKeySecret: 'synthetic-sk' };
const encodeTags = (tags: Record<string, string>) => Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
const body = (set: string, rows: unknown[], total = rows.length) => ({ RequestId: 'fixture-request', TotalCount: total, [set]: rows });
const cvm = (id: string, tags: Record<string, string> = {}, state = 'RUNNING') => ({ InstanceId: id, InstanceState: state,
  InstanceChargeType: 'POSTPAID_BY_HOUR', HostName: 'host', PublicIpAddresses: ['192.0.2.10'], PrivateIpAddresses: ['10.0.0.10'], Tags: encodeTags(tags) });
const disk = (id = 'disk-owned', extra: Record<string, unknown> = {}) => ({ DiskId: id, InstanceId: 'ins-owned', DiskUsage: 'SYSTEM_DISK', DeleteWithInstance: true, Tags: [], ...extra });

beforeEach(() => request.mockReset());

describe('Tencent frozen inventory and complete pagination', () => {
  it('normalizes CVM detail without leaking unrelated tags or provider credentials', async () => {
    request.mockResolvedValue(body('InstanceSet', [cvm('ins-owned', { RangeInstanceId: 'member', secret: 'never-return' })]));
    const [detail] = await describeTencentInstances(account, { instanceIds: ['ins-owned'] });
    expect(detail).toEqual({ instanceId: 'ins-owned', instanceName: '', hostName: 'host', status: 'Running',
      publicIp: '192.0.2.10', privateIp: '10.0.0.10', tags: { RangeInstanceId: 'member' } });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ service: 'cvm', action: 'DescribeInstances', regionId: 'ap-guangzhou',
      parameters: { InstanceIds: ['ins-owned'], Offset: 0, Limit: 100 } }));
  });
  it('reads every known-ID page even when TotalCount exceeds the first page', async () => {
    request.mockResolvedValueOnce(body('InstanceSet', [cvm('ins-first')], 2)).mockResolvedValueOnce(body('InstanceSet', [cvm('ins-second')], 2));
    expect((await describeTencentInstances(account, { instanceIds: ['ins-first', 'ins-second'] })).map(row => row.instanceId)).toEqual(['ins-first', 'ins-second']);
    expect(request.mock.calls[1][0].parameters.Offset).toBe(1);
  });
  it('treats documented exact single security-group ResourceNotFound as absence with its original RequestId', async () => {
    request.mockRejectedValue(new TencentCloudRequestError('ResourceNotFound', 'request-absent-group'));
    const result = await describeTencentKnownResourcesWithEvidence(account, 'security_group', ['sg-gone']);
    expect(result.resources).toEqual([]); expect(result.evidence).toMatchObject([{ action: 'DescribeSecurityGroups', requestIds: ['request-absent-group'], errorCode: 'ResourceNotFound' }]);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('splits a multi-ID missing-group error so a retained group cannot be marked absent', async () => {
    request.mockRejectedValueOnce(new TencentCloudRequestError('ResourceNotFound', 'request-batch'))
      .mockRejectedValueOnce(new TencentCloudRequestError('ResourceNotFound', 'request-gone'))
      .mockResolvedValueOnce(body('SecurityGroupSet', [{ SecurityGroupId: 'sg-kept', TagSet: [] }]));
    const result = await describeTencentKnownResourcesWithEvidence(account, 'security_group', ['sg-gone','sg-kept']);
    expect(result.resources.map(row => row.id)).toEqual(['sg-kept']); expect(result.evidence).toHaveLength(3);
    expect(request.mock.calls.map(([input]) => input.parameters.SecurityGroupIds)).toEqual([['sg-gone','sg-kept'],['sg-gone'],['sg-kept']]);
  });
  it.each(['UnauthorizedOperation','ResourceNotFound.SecurityGroup','InvalidParameterValue.Malformed','InternalError'])('never turns undocumented %s into security-group absence', async code => {
    request.mockRejectedValue(new TencentCloudRequestError(code, 'request-error'));
    await expect(describeTencentResourceInventory(account,'security_group',{ids:['sg-gone']})).rejects.toMatchObject({ code });
  });
  it('requires a real request ID and rejects ResourceNotFound for tag, VPC-filter and other resource reads', async () => {
    request.mockRejectedValue(new TencentCloudRequestError('ResourceNotFound'));
    await expect(describeTencentResourceInventory(account,'security_group',{ids:['sg-gone']})).rejects.toThrow();
    request.mockRejectedValue(new TencentCloudRequestError('ResourceNotFound','request-error'));
    await expect(describeTencentResourceInventory(account,'security_group',{tags:{CreatedBy:'cyber-range-platform'}})).rejects.toThrow();
    await expect(describeTencentResourceInventory(account,'disk',{ids:['disk-gone']})).rejects.toThrow();
    await expect(describeTencentResourceInventory(account,'network_acl',{vpcId:'vpc-owned'})).rejects.toThrow();
  });
  it.each([
    body('InstanceSet', [], 2), body('InstanceSet', [cvm('ins-other')]),
    { RequestId: 'fixture', TotalCount: 0 }, body('InstanceSet', [cvm('ins-owned'), cvm('ins-owned')]),
    body('InstanceSet', [{ ...cvm('ins-owned'), Tags: [{ Key: 'x', Value: 'one' }, { Key: 'x', Value: 'two' }] }]),
  ])('rejects incomplete or conflicting evidence %#', async response => {
    request.mockResolvedValue(response);
    await expect(describeTencentInstances(account, { instanceIds: ['ins-owned'] })).rejects.toThrow();
  });
  it('rejects pagination whose declared total changes rather than reporting absence', async () => {
    request.mockResolvedValueOnce(body('InstanceSet', [cvm('ins-first')], 2)).mockResolvedValueOnce(body('InstanceSet', [], 1));
    await expect(describeTencentInstances(account, { instanceIds: ['ins-first', 'ins-second'] })).rejects.toThrow('changed');
  });
  it.each([{ ...account, provider: 'alibaba_cloud' }, { ...account, accountUidResolved: false }, { ...account, accountUid: null }, { ...account, cloudAccountContextId: null }])('rejects unverified or foreign-provider contexts %# before any cloud API', async context => {
    await expect(describeTencentInstances(context as never, { instanceIds: ['ins-owned'] })).rejects.toThrow('verified frozen');
    expect(request).not.toHaveBeenCalled();
  });
  it('does not invent a tag filter for ACL or a tag-value filter for NAT', async () => {
    await expect(describeTencentResourceInventory(account, 'network_acl', { tags: { CreatedBy: 'cyber-range-platform' } })).rejects.toThrow('no tag filter');
    request.mockResolvedValue(body('NatGatewaySet', [{ NatGatewayId: 'nat-owned', TagSet: encodeTags({ CreatedBy: 'cyber-range-platform' }) },
      { NatGatewayId: 'nat-external', TagSet: encodeTags({ CreatedBy: 'external' }) }]));
    expect((await describeTencentResourceInventory(account, 'nat', { tags: { CreatedBy: 'cyber-range-platform' } })).map(row => row.id)).toEqual(['nat-owned']);
    expect(request.mock.calls[0][0].parameters.Filters).toEqual([{ Name: 'tag-key', Values: ['CreatedBy'] }]);
  });
  it.each([
    ['disk', 'cbs', 'DescribeDisks', 'DiskSet', 'DiskId', 'disk-owned', 'DiskIds'],
    ['snapshot', 'cbs', 'DescribeSnapshots', 'SnapshotSet', 'SnapshotId', 'snap-owned', 'SnapshotIds'],
    ['vpc', 'vpc', 'DescribeVpcs', 'VpcSet', 'VpcId', 'vpc-owned', 'VpcIds'],
    ['vswitch', 'vpc', 'DescribeSubnets', 'SubnetSet', 'SubnetId', 'subnet-owned', 'SubnetIds'],
    ['security_group', 'vpc', 'DescribeSecurityGroups', 'SecurityGroupSet', 'SecurityGroupId', 'sg-owned', 'SecurityGroupIds'],
    ['network_acl', 'vpc', 'DescribeNetworkAcls', 'NetworkAclSet', 'NetworkAclId', 'acl-owned', 'NetworkAclIds'],
    ['eni', 'vpc', 'DescribeNetworkInterfaces', 'NetworkInterfaceSet', 'NetworkInterfaceId', 'eni-owned', 'NetworkInterfaceIds'],
    ['eip', 'vpc', 'DescribeAddresses', 'AddressSet', 'AddressId', 'eip-owned', 'AddressIds'],
  ])('provides traceable %s evidence with the documented service and IDs', async (kind, service, action, set, idKey, id, idsKey) => {
    request.mockResolvedValue(body(set, [{ [idKey]: id, TagSet: [] }]));
    const [resource] = await describeTencentResourceInventory(account, kind as never, { ids: [id] });
    expect(resource.evidence).toMatchObject({ provider: 'tencent_cloud', accountUid: 'uid-fixture', cloudAccountContextId: 'ctx-fixture', regionId: 'ap-guangzhou', requestIds: ['fixture-request'], action });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ service, action, parameters: expect.objectContaining({ [idsKey]: [id] }) }));
    expect(JSON.stringify(resource)).not.toContain('synthetic-sk');
  });
  it('queries snapshots by known source disks and refuses undocumented snapshot tag filters', async () => {
    await expect(describeTencentResourceInventory(account, 'snapshot', { tags: { CreatedBy: 'cyber-range-platform' } })).rejects.toThrow('no tag filter');
    request.mockResolvedValue(body('SnapshotSet', [{ SnapshotId: 'snap-owned', DiskId: 'disk-owned', Tags: [] }]));
    expect((await describeTencentResourceInventory(account, 'snapshot', { diskIds: ['disk-owned'] })).map(row => row.id)).toEqual(['snap-owned']);
    expect(request.mock.calls[0][0].parameters.Filters).toEqual([{ Name: 'disk-id', Values: ['disk-owned'] }]);
  });
  it('keeps only fenced known CBS IDs and refuses to adopt tag-only or shared disks', async () => {
    const expected = { CreatedBy: 'cyber-range-platform', RangeInstanceId: 'member', PlatformScope: 'user', PlatformUserId: 'alice' };
    request.mockResolvedValue(body('DiskSet', [disk(), disk('disk-external', { Tags: encodeTags(expected), DiskUsage: 'DATA_DISK', DeleteWithInstance: false }),
      disk('disk-shared', { Shareable: true, InstanceIdList: ['ins-owned', 'ins-other'] })]));
    const result = await readTencentAttachedDiskInventory(account, 'ins-owned', { systemDiskIds: ['disk-owned', 'disk-shared'] }, expected);
    expect(result.systemDiskIds).toEqual(['disk-owned']);
    expect(result.proofs).toEqual({ 'disk-owned': { instanceId: 'ins-owned', method: 'persisted' } });
    expect(result.unverifiedDisks.map(row => row.id)).toEqual(['disk-external', 'disk-shared']);
  });
  it('does not retry a write whose cloud submission is unknown', async () => {
    request.mockRejectedValue(new TencentCloudRequestError('NETWORK_OR_TIMEOUT'));
    await expect(terminateTencentInstances(account, ['ins-owned'])).rejects.toThrow('NETWORK_OR_TIMEOUT');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('requires stopped status for password reset and does not force-shutdown a running instance', async () => {
    const f = await fixture();
    request.mockResolvedValueOnce(body('InstanceSet', [cvm('ins-owned', f.tags)]));
    await expect(resetTencentStoppedInstancePassword(account, f.instance, 'host', 'synthetic-password')).rejects.toThrow('stopped');
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce(body('InstanceSet', [cvm('ins-owned', f.tags, 'STOPPED')])).mockResolvedValueOnce({ RequestId: 'fixture-reset' });
    await resetTencentStoppedInstancePassword(account, f.instance, 'host', 'synthetic-password', 'ubuntu');
    expect(request.mock.calls[2][0].parameters).toEqual({ InstanceIds: ['ins-owned'], Password: 'synthetic-password', UserName: 'ubuntu', ForceStop: false });
  });
});

async function fixture(status = 'running') {
  const repository = createMemoryAdminRepository();
  const instance = await repository.createRangeInstance({ cloudProvider: 'tencent_cloud', name: 'fixture', status: status as never, ownerUserId: 'alice', instanceMode: 'single', singleInstanceBatchId: 'batch-fixture',
    singleInstanceConfig: { executionBackend: 'opentofu', cloudAccountContextId: account.cloudAccountContextId, cloudAccountUid: account.accountUid,
      regionId: account.defaultRegion, zoneId: account.defaultZoneId, hostKey: 'host' } as never,
    resourceSummary: { mode: 'opentofu', hostIds: { host: 'ins-owned' }, systemDiskIds: { host: 'disk-owned' }, diskInventoryHostIds: { host: 'ins-owned' } } });
  const createJob = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'alice' });
  await repository.updateProvisionJob(createJob.id, { status: 'succeeded' });
  await repository.updateRangeInstance(instance.id, { lastJobId: createJob.id, singleInstanceConfig: { ...instance.singleInstanceConfig!, opentofuCreateJobId: createJob.id } });
  const updated = (await repository.getRangeInstanceById(instance.id))!;
  const intent = createHash('sha256').update(JSON.stringify(['tencent_cloud', account.cloudAccountContextId, account.accountUid, account.defaultRegion, account.defaultZoneId, 'batch-fixture', instance.id, createJob.id])).digest('hex').slice(0, 32);
  const tags = { CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', ExecutionBackend: 'opentofu', CloudAccountUid: account.accountUid,
    CloudAccountContextId: account.cloudAccountContextId, RangeInstanceId: instance.id, SingleInstanceBatchId: 'batch-fixture', PlatformUserId: 'alice', PlatformScope: 'user', PlatformHostKey: 'host', PlatformResourceType: 'ecs', PlatformCreateJobId: createJob.id, CreationIntentId: intent };
  const config = { getAccountContextById: jest.fn(async () => account), getAccountContext: jest.fn(async () => { throw new Error('current-account-fallback'); }) };
  return { repository, instance: updated, tags, config, createJob };
}

describe('Tencent node action provider routing', () => {
  it.each([['start', 'STOPPED', 'StartInstances'], ['stop', 'RUNNING', 'StopInstances'], ['reboot', 'RUNNING', 'RebootInstances']])('controls exactly the frozen %s CVM and returns acceptance', async (action, state, cloudAction) => {
    const f = await fixture();
    request.mockResolvedValueOnce(body('InstanceSet', [cvm('ins-owned', f.tags, state)])).mockResolvedValueOnce({ RequestId: 'fixture-control' });
    const service = new RangeInstanceNodeActionsService(f.repository, f.config as never, {} as never);
    expect(await service.run(f.instance.id, 'host', action, {}, { id: 'alice', role: 'user' })).toMatchObject({ status: 'accepted', action, response: { RequestId: 'fixture-control' } });
    expect(request.mock.calls[1][0]).toMatchObject({ action: cloudAction, parameters: { InstanceIds: ['ins-owned'] }, regionId: 'ap-guangzhou' });
    expect(f.config.getAccountContext).not.toHaveBeenCalled();
  });
  it('returns official VNC console URL through the access response only', async () => {
    const f = await fixture(), raw = encodeURIComponent('wss://gzvnc.qcloud.com:26789/vnc?s=synthetic-session');
    request.mockResolvedValueOnce(body('InstanceSet', [cvm('ins-owned', f.tags)])).mockResolvedValueOnce({ RequestId: 'fixture-vnc', InstanceVncUrl: raw });
    const service = new RangeInstanceNodeActionsService(f.repository, f.config as never, {} as never);
    const result = await service.run(f.instance.id, 'host', 'open-vnc', {}, { id: 'alice', role: 'user' });
    expect(result).toMatchObject({ vncUrl: raw, webTerminalUrl: `https://img.qcloud.com/qcloud/app/active_vnc/index.html?InstanceVncUrl=${raw}` });
  });
  it('blocks a provider/context mismatch and a foreign owner before mutations', async () => {
    const f = await fixture(), service = new RangeInstanceNodeActionsService(f.repository, f.config as never, {} as never);
    f.config.getAccountContextById.mockResolvedValueOnce({ ...account, provider: 'alibaba_cloud' } as never);
    await expect(service.run(f.instance.id, 'host', 'reboot', {}, { id: 'alice', role: 'user' })).rejects.toThrow('厂商');
    request.mockResolvedValue(body('InstanceSet', [cvm('ins-owned', { ...f.tags, PlatformUserId: 'bob' })]));
    await expect(service.run(f.instance.id, 'host', 'reboot', {}, { id: 'alice', role: 'user' })).rejects.toThrow('ownership');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('Tencent strict fallback cleanup and retained billing evidence', () => {
  async function cleanupFixture() {
    const f = await fixture('destroy_failed');
    const job = await f.repository.createProvisionJob({ rangeInstanceId: f.instance.id, jobType: 'destroy', triggeredBy: 'alice' });
    const startedAt = new Date(); await f.repository.updateProvisionJob(job.id, { status: 'running', startedAt });
    await f.repository.updateRangeInstance(f.instance.id, { lastJobId: job.id });
    const service = new SingleInstanceBatchExecutionService(f.repository, f.config as never);
    return { ...f, item: { instance: (await f.repository.getRangeInstanceById(f.instance.id))!, job: { ...job, startedAt } }, service };
  }
  it('rejects tags for a different creation intent without issuing TerminateInstances', async () => {
    const f = await cleanupFixture(); request.mockResolvedValue(body('InstanceSet', [cvm('ins-owned', { ...f.tags, CreationIntentId: 'foreign-intent' })]));
    await expect(f.service.deleteOwnedUntrackedOpenTofuInstances(f.item, ['ins-owned'], async () => {})).rejects.toThrow('intent');
    expect(request).toHaveBeenCalledTimes(1);
    expect((await f.repository.getRangeInstanceById(f.instance.id))?.status).toBe('destroy_failed');
  });
  it('keeps retained CBS as a cleanup failure even after CVM disappeared', async () => {
    const f = await cleanupFixture(); request.mockImplementation(async input => input.action === 'DescribeDisks' ? body('DiskSet', [disk('disk-owned', { Tags: encodeTags({ RangeInstanceId: f.instance.id }) })]) : body('InstanceSet', []));
    await expect(f.service.assertInstanceDisksAbsent(f.instance, account)).rejects.toThrow('retain billing');
  });
  it.each([['eip', 'eip-owned', 'AddressSet', 'AddressId'], ['nat_gateway', 'nat-owned', 'NatGatewaySet', 'NatGatewayId']])('does not close a member with a surviving %s ledger resource', async (type, id, set, key) => {
    const f = await cleanupFixture();
    const ledger = await f.repository.createBillingLedgerResource({ cloudProvider: 'tencent_cloud', cloudAccountUid: account.accountUid,
      regionId: account.defaultRegion, cloudResourceId: id, cloudResourceType: type as never, billingScope: 'user', ownerUserId: 'alice',
      rangeInstanceId: f.instance.id, billingStartAt: new Date() });
    request.mockImplementation(async input => input.action === 'DescribeDisks' ? body('DiskSet', []) : body(set, [{ [key]: id }]));
    await expect(f.service.assertInstanceDisksAbsent(f.instance, account)).rejects.toThrow('billing resources remain');
    expect((await f.repository.listBillingLedgerResources()).find(row => row.id === ledger.id)?.releasedAt).toBeNull();
  });
  it('does not query or release a ledger bound to a different provider/account', async () => {
    const f = await cleanupFixture();
    await f.repository.createBillingLedgerResource({ cloudProvider: 'alibaba_cloud', cloudAccountUid: 'foreign-account', regionId: 'cn-hangzhou',
      cloudResourceId: 'eip-foreign', cloudResourceType: 'eip', billingScope: 'user', ownerUserId: 'alice', rangeInstanceId: f.instance.id, billingStartAt: new Date() });
    request.mockResolvedValue(body('DiskSet', []));
    await expect(f.service.assertInstanceDisksAbsent(f.instance, account)).rejects.toThrow('conflicts');
    expect(request.mock.calls.some(([input]) => input.action === 'DescribeAddresses')).toBe(false);
  });
  it('accepts only deletion followed by two complete empty CVM rounds and empty CBS evidence', async () => {
    const f = await cleanupFixture(); let terminated = false;
    process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS = '0';
    request.mockImplementation(async input => {
      if (input.action === 'TerminateInstances') { terminated = true; return { RequestId: 'fixture-terminate' }; }
      if (input.action === 'DescribeInstances') return body('InstanceSet', terminated ? [] : [cvm('ins-owned', f.tags)]);
      return body('DiskSet', terminated ? [] : [disk()]);
    });
    try { await expect(f.service.deleteOwnedUntrackedOpenTofuInstances(f.item, ['ins-owned'], async () => {})).resolves.toBeUndefined(); }
    finally { delete process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS; }
    expect(request.mock.calls.filter(([input]) => input.action === 'DescribeInstances')).toHaveLength(5);
    expect(request.mock.calls.filter(([input]) => input.action === 'TerminateInstances')).toHaveLength(1);
  });
  it('does not terminate known retained disks through an instance-only fallback', async () => {
    const f = await cleanupFixture();
    request.mockImplementation(async input => input.action === 'DescribeInstances' ? body('InstanceSet', [cvm('ins-owned', f.tags)]) : body('DiskSet', [disk('disk-owned', { DeleteWithInstance: false })]));
    await expect(f.service.deleteOwnedUntrackedOpenTofuInstances(f.item, ['ins-owned'], async () => {})).rejects.toThrow('automatic CBS deletion');
    expect(request.mock.calls.some(([input]) => input.action === 'TerminateInstances')).toBe(false);
  });
  it('does not retry unknown termination and keeps the active recovery record', async () => {
    const f = await cleanupFixture(); request.mockImplementation(async input => {
      if (input.action === 'DescribeInstances') return body('InstanceSet', [cvm('ins-owned', f.tags)]);
      if (input.action === 'DescribeDisks') return body('DiskSet', [disk()]);
      throw new TencentCloudRequestError('NETWORK_OR_TIMEOUT');
    });
    await expect(f.service.deleteOwnedUntrackedOpenTofuInstances(f.item, ['ins-owned'], async () => {})).rejects.toThrow('NETWORK_OR_TIMEOUT');
    expect(request.mock.calls.filter(([input]) => input.action === 'TerminateInstances')).toHaveLength(1);
    expect((await f.repository.getRangeInstanceById(f.instance.id))?.status).toBe('destroy_failed');
  });
});

describe('Tencent reconciliation never adopts tagged external costs', () => {
  it('stores provider/UID/request evidence for all supported resource types without assigning a bill', async () => {
    const repository = createMemoryAdminRepository();
    const sets: Record<string, [string, string, string]> = { DescribeInstances: ['InstanceSet', 'InstanceId', 'ins-external'], DescribeDisks: ['DiskSet', 'DiskId', 'disk-external'],
      DescribeSnapshots: ['SnapshotSet', 'SnapshotId', 'snap-external'], DescribeVpcs: ['VpcSet', 'VpcId', 'vpc-external'], DescribeSubnets: ['SubnetSet', 'SubnetId', 'subnet-external'],
      DescribeSecurityGroups: ['SecurityGroupSet', 'SecurityGroupId', 'sg-external'], DescribeNetworkInterfaces: ['NetworkInterfaceSet', 'NetworkInterfaceId', 'eni-external'],
      DescribeNatGateways: ['NatGatewaySet', 'NatGatewayId', 'nat-external'], DescribeAddresses: ['AddressSet', 'AddressId', 'eip-external'] };
    request.mockImplementation(async input => {
      const [set, key, id] = sets[input.action]; return body(set, [{ [key]: id, InstanceState: 'RUNNING', Tags: encodeTags({ CreatedBy: 'cyber-range-platform', RangeInstanceId: 'missing-member' }) }]);
    });
    const upsert = jest.spyOn(repository, 'upsertCloudResourceDrift');
    const service = new PlatformResourceReconciliationService(repository, { getDefaultCredentials: async () => ({ ...account, regionId: account.defaultRegion }) } as never);
    expect(await service.reconcile()).toEqual({ recovered: 0, drifts: 8, skipped: false });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ cloudProvider: 'tencent_cloud', cloudResourceType: 'disk', tagsSnapshot: expect.objectContaining({ providerEvidence: expect.objectContaining({ accountUid: 'uid-fixture', cloudAccountContextId: 'ctx-fixture', requestIds: ['fixture-request'] }) }) }));
    expect(await repository.listBillingLedgerResources()).toEqual([]);
    expect(request.mock.calls.every(([input]) => input.action.startsWith('Describe'))).toBe(true);
  });
});
