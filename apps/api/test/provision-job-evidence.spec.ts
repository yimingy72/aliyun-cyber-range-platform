import { ProvisionJobsController } from '../src/admin/provision-jobs.controller';
import { ProvisionJobsService } from '../src/admin/provision-jobs.service';
import { buildProvisionJobEvidence } from '../src/admin/provision-job-evidence';
import { retiredResourceInventory } from '../src/provisioning/retired-resource-inventory';

const now = new Date('2026-10-10T00:00:00Z');
const job: any = { id: 'job-1', cloudWorkspaceId: 'workspace-1', rangeInstanceId: 'range-1', jobType: 'destroy', status: 'succeeded', createdAt: now, startedAt: now, finishedAt: now,
  retryCount: 0, errorSummary: 'raw secret', topologySnapshot: { command: 'secret script', runtimeCredentials: { host: { password: 'private password' } } } };
const context = { provider: 'alibaba_cloud', cloudAccountContextId: 'context-1', cloudAccountUid: '1234', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', accessKeySecret: 'private key' };
const inventory = { version: 1, rangeInstanceId: 'range-1', executionContext: context, resources: { hostIds: { win: 'i-win' }, systemDiskIds: { win: 'd-system' },
  secondaryNetworkInterfaceIds: { 'win:nic-2': 'eni-secondary' }, vpcId: 'vpc-owned', securityGroupIds: { win: 'sg-owned' },
  workspaceDir: '/private/state', userData: 'private script' }, password: 'private password' };
const step = (stepName: string, message: string | null = null): any => ({ id: 'step-1', jobId: 'job-1', cloudWorkspaceId: 'workspace-1', stepName, status: 'succeeded',
  message, stdoutExcerpt: 'private stdout', stderrExcerpt: 'private stderr', startedAt: now, finishedAt: now, createdAt: now });
const ledger: any = { cloudWorkspaceId: 'workspace-1', rangeInstanceId: 'range-1', cloudProvider: 'alibaba_cloud', cloudAccountUid: '1234', regionId: 'cn-hangzhou',
  cloudResourceId: 'i-win', cloudResourceType: 'ecs', sourceProvisionJobId: 'job-create', billingStartAt: now, releasedAt: now, tagsSnapshot: { password: 'private password' } };

function repository() {
  return { getProvisionJobById: jest.fn(async () => job), getRangeInstanceById: jest.fn(async () => ({ id: 'range-1', ownerUserId: 'alice', createdBy: 'alice' })),
    listProvisionJobStepLogs: jest.fn(async () => [step('range_resource_inventory', JSON.stringify(inventory)), step('verify_destroy', 'private message')]),
    listProvisionJobs: jest.fn(async () => [job]), listBillingLedgerResources: jest.fn(async () => [ledger]) };
}

describe('controlled provisioning evidence', () => {
  it('projects resource identities and fixed descriptions while dropping raw text, snapshots and secrets', async () => {
    const repo = repository(); const result = await new ProvisionJobsService(repo as any).getById('job-1', { id: 'alice', role: 'user' } as any, true);
    expect(result).toMatchObject({ id: 'job-1', evidence: { coverage: 'platform_recorded_job_evidence', invalidInventoryCount: 0,
      inventories: [{ executionContext: { provider: 'alibaba_cloud', cloudAccountUid: '1234' }, resources: { hostIds: { win: 'i-win' }, secondaryNetworkInterfaceIds: { 'win:nic-2': 'eni-secondary' } } }],
      steps: [{ stepName: 'range_resource_inventory' }, { stepName: 'verify_destroy', status: 'succeeded', description: 'Platform cloud absence verification' }],
      relatedJobs: [{ id: 'job-1' }], billingResources: [{ cloudResourceId: 'i-win', sourceProvisionJobId: 'job-create', releasedAt: now }] } });
    const text = JSON.stringify(result);
    for (const forbidden of ['private', 'secret', 'topologySnapshot', 'stdoutExcerpt', 'stderrExcerpt', 'workspaceDir', 'userData', 'password']) expect(text).not.toContain(forbidden);
    expect(repo.listBillingLedgerResources).toHaveBeenCalledWith({ rangeInstanceId: 'range-1' });
  });
  it('preserves the default response and does not load evidence unless requested', async () => {
    const repo = repository(); const result = await new ProvisionJobsService(repo as any).getById('job-1', { id: 'admin', role: 'admin' } as any);
    expect(result).toHaveProperty('topologySnapshot.command'); expect(result).not.toHaveProperty('evidence');
    expect(repo.listProvisionJobStepLogs).not.toHaveBeenCalled(); expect(repo.listBillingLedgerResources).not.toHaveBeenCalled();
  });
  it('checks ownership before reading any evidence', async () => {
    const repo = repository(); await expect(new ProvisionJobsService(repo as any).getById('job-1', { id: 'other', role: 'user' } as any, true)).rejects.toThrow('denied');
    expect(repo.listProvisionJobStepLogs).not.toHaveBeenCalled(); expect(repo.listProvisionJobs).not.toHaveBeenCalled(); expect(repo.listBillingLedgerResources).not.toHaveBeenCalled();
  });
  it('filters foreign jobs, steps and ledgers even if a repository returns a wider collection', () => {
    const evidence = buildProvisionJobEvidence(job, [step('verify_destroy'), { ...step('verify_destroy'), cloudWorkspaceId: 'foreign' }, { ...step('verify_destroy'), jobId: 'foreign' }],
      [job, { ...job, id: 'wrong-range', rangeInstanceId: 'foreign' }, { ...job, id: 'wrong-workspace', cloudWorkspaceId: 'foreign' }],
      [ledger, { ...ledger, cloudWorkspaceId: 'foreign' }, { ...ledger, rangeInstanceId: 'foreign' }]);
    expect(evidence.steps).toHaveLength(1); expect(evidence.relatedJobs).toHaveLength(1); expect(evidence.billingResources).toHaveLength(1);
  });
  it.each(['not-json', JSON.stringify({ ...inventory, rangeInstanceId: 'foreign' }), JSON.stringify({ ...inventory, executionContext: { ...context, provider: 'unknown' } }),
    JSON.stringify({ ...inventory, resources: { hostIds: { win: 'invalid id\nprivate token' } } })])('rejects incomplete or untrusted inventory without disclosing its text', message => {
    const evidence = buildProvisionJobEvidence(job, [step('range_resource_inventory', message)], [], []);
    expect(evidence.inventories).toEqual([]); expect(evidence.invalidInventoryCount).toBe(1); expect(JSON.stringify(evidence)).not.toContain('private');
  });
  it('does not interpret a raw log as a phase or independent cloud receipt', () => {
    const evidence = buildProvisionJobEvidence(job, [step('untrusted phase', 'verified all cloud resources')], [], []);
    expect(evidence.steps).toEqual([]); expect(evidence).not.toHaveProperty('allKnownAbsent'); expect(evidence).not.toHaveProperty('requestId');
  });
  it('preserves legitimate Tencent SNAT/DNAT provider IDs alongside all paid and network resource inventories', () => {
    const resources = { vpcId: 'vpc-owned', hostIds: { win: 'ins-win' }, systemDiskIds: { win: 'disk-system' }, secondaryNetworkInterfaceIds: { 'win-1': 'eni-secondary' },
      subnetIds: { main: 'subnet-main' }, routeTableIds: { main: 'rtb-main' }, securityGroupIds: { 'win-0': 'sg-owned' }, natGatewayIds: { shared: 'nat-owned' },
      eipAllocationIds: { ingress: 'eip-ingress', egress: 'eip-egress' }, snatEntryIds: { main: 'nat-owned#subnet-main' },
      dnatEntryIds: { rdp: 'TCP://vpc-owned:nat-owned@203.0.113.10:33899', dns: 'UDP://vpc-owned:nat-owned@203.0.113.10:53' }, userData: 'private script', tags: { accessKeySecret: 'private key' } };
    const value = { ...inventory, executionContext: { ...context, provider: 'tencent_cloud', regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1' }, resources };
    const evidence = buildProvisionJobEvidence(job, [step('range_resource_inventory', JSON.stringify(value)), step('range_resource_inventory', JSON.stringify(value))], [], []);
    expect(evidence.invalidInventoryCount).toBe(0); expect(evidence.inventories).toHaveLength(2);
    expect(evidence.inventories[0].resources).toMatchObject({ hostIds: resources.hostIds, systemDiskIds: resources.systemDiskIds, secondaryNetworkInterfaceIds: resources.secondaryNetworkInterfaceIds,
      natGatewayIds: resources.natGatewayIds, eipAllocationIds: resources.eipAllocationIds, snatEntryIds: resources.snatEntryIds, dnatEntryIds: resources.dnatEntryIds });
    expect(JSON.stringify(evidence)).not.toContain('private'); expect(evidence.inventories[0].resources).not.toHaveProperty('userData'); expect(evidence.inventories[0].resources).not.toHaveProperty('tags');
  });
  it('preserves exact OpenTofu address collision keys generated by persisted resource inspection', () => {
    const value = { ...inventory, resources: { hostIds: { 'module.range.alicloud_instance.hosts["win"]#1': 'i-owned',
      'observed:module.range.alicloud_instance.hosts["win"]#2': 'i-old' }, securityGroupIds: { 'module.range.alicloud_security_group.default': 'sg-owned' } } };
    const evidence = buildProvisionJobEvidence(job, [step('range_resource_inventory', JSON.stringify(value))], [], []);
    expect(evidence.invalidInventoryCount).toBe(0); expect(evidence.inventories[0].resources).toEqual(value.resources);
  });
  it('recovers historical birth inventories containing native-keyed retired Tencent NAT relations through the job evidence service', async () => {
    const snat = 'nat-owned#subnet-main', dnat = 'TCP://vpc-owned:nat-owned@203.0.113.10:3389';
    const retired = retiredResourceInventory({ mode: 'opentofu', snatEntryIds: { main: snat }, dnatEntryIds: { rdp: dnat } }, { mode: 'opentofu' })!;
    expect(retired.snatEntryIds).toEqual({ [snat]: snat }); expect(retired.dnatEntryIds).toEqual({ [dnat]: dnat });
    const value = { ...inventory, executionContext: { ...context, provider: 'tencent_cloud', regionId: 'ap-nanjing', zoneId: 'ap-nanjing-1' },
      resources: { hostIds: { win: 'ins-current' }, systemDiskIds: { win: 'disk-current' }, retiredResources: retired, userData: 'private script' } };
    const repo = repository();
    repo.getProvisionJobById.mockResolvedValue({ ...job, jobType: 'update' });
    repo.listProvisionJobStepLogs.mockResolvedValue([step('range_resource_inventory', JSON.stringify(value))]);
    repo.listBillingLedgerResources.mockResolvedValue([{ ...ledger, cloudProvider: 'tencent_cloud', regionId: 'ap-nanjing', cloudResourceId: 'ins-current', sourceProvisionJobId: job.id }]);
    const result = await new ProvisionJobsService(repo as any).getById('job-1', { id: 'alice', role: 'user' } as any, true);
    expect(result).toMatchObject({ evidence: { invalidInventoryCount: 0, inventories: [{ resources: {
      hostIds: { win: 'ins-current' }, systemDiskIds: { win: 'disk-current' }, retiredResources: { snatEntryIds: { [snat]: snat }, dnatEntryIds: { [dnat]: dnat } },
    } }], billingResources: [{ cloudResourceId: 'ins-current', sourceProvisionJobId: job.id }] } });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|password|userData/);
  });
  it.each([
    { provider: 'alibaba_cloud', field: 'dnatEntryIds', key: 'TCP://vpc-owned:nat-owned@203.0.113.10:3389' },
    { provider: 'alibaba_cloud', field: 'snatEntryIds', key: 'nat-owned#subnet-main' },
    ...['hostIds', 'systemDiskIds', 'dataDiskIds', 'eipAllocationIds', 'securityGroupIds'].map(field => ({ provider: 'tencent_cloud', field, key: 'TCP://vpc-owned:nat-owned@203.0.113.10:3389' })),
    { provider: 'tencent_cloud', field: 'dnatEntryIds', key: 'TCP://vpc-owned:nat-owned@203.0.113.10:3389', id: 'TCP://vpc-owned:nat-owned@203.0.113.10:3390' },
    { provider: 'tencent_cloud', field: 'dnatEntryIds', key: 'TCP://vpc-owned:nat-owned@999.0.0.1:3389' },
    { provider: 'tencent_cloud', field: 'dnatEntryIds', key: 'TCP://vpc-owned:nat-owned@203.0.113.10:65536' },
    { provider: 'tencent_cloud', field: 'dnatEntryIds', key: 'https://private.example/?token=private' },
    { provider: 'tencent_cloud', field: 'dnatEntryIds', key: 'TCP://vpc-owned:nat-owned@203.0.113.10:3389?token=private' },
    { provider: 'tencent_cloud', field: 'snatEntryIds', key: 'nat-owned#subnet-main\nprivate secret' },
  ])('keeps native key exceptions bounded to the exact Tencent NAT relation field and value: %j', ({ provider, field, key, id }: { provider: string; field: string; key: string; id?: string }) => {
    const value = { ...inventory, executionContext: { ...context, provider }, resources: { retiredResources: { [field]: { [key]: id ?? key } } } };
    const evidence = buildProvisionJobEvidence(job, [step('range_resource_inventory', JSON.stringify(value))], [], []);
    expect(evidence.invalidInventoryCount).toBe(1); expect(evidence.inventories).toEqual([]); expect(JSON.stringify(evidence)).not.toContain('private');
  });
  it.each([
    { provider: 'alibaba_cloud', field: 'dnatEntryIds', id: 'TCP://vpc-owned:nat-owned@203.0.113.10:3389' },
    { provider: 'tencent_cloud', field: 'hostIds', id: 'nat-owned#subnet-main' },
    { provider: 'tencent_cloud', field: 'dnatEntryIds', id: 'TCP://vpc-owned:nat-owned@999.0.0.1:3389' },
    { provider: 'tencent_cloud', field: 'dnatEntryIds', id: 'TCP://vpc-owned:nat-owned@203.0.113.10:65536' },
    { provider: 'tencent_cloud', field: 'dnatEntryIds', id: 'TCP://vpc-owned:nat-owned@203.0.113.10:0' },
    { provider: 'tencent_cloud', field: 'dnatEntryIds', id: 'TCP://private:password@203.0.113.10:3389' },
    { provider: 'tencent_cloud', field: 'dnatEntryIds', id: 'TCP://vpc-owned:nat-owned@203.0.113.10:3389?token=private' },
    { provider: 'tencent_cloud', field: 'snatEntryIds', id: 'nat-owned#subnet-main\nprivate secret' },
  ])('does not broaden the safe identity boundary for %j', ({ provider, field, id }) => {
    const value = { ...inventory, executionContext: { ...context, provider }, resources: { [field]: { native: id } } };
    const evidence = buildProvisionJobEvidence(job, [step('range_resource_inventory', JSON.stringify(value))], [], []);
    expect(evidence.invalidInventoryCount).toBe(1); expect(evidence.inventories).toEqual([]); expect(JSON.stringify(evidence)).not.toContain('private');
  });
  it('still rejects arbitrary or injected inventory keys', () => {
    const value = { ...inventory, resources: { hostIds: { 'module.private.command["secret"]': 'i-owned' } } };
    expect(buildProvisionJobEvidence(job, [step('range_resource_inventory', JSON.stringify(value))], [], []).invalidInventoryCount).toBe(1);
  });
  it('accepts only boolean query strings', () => {
    const service: any = { getById: jest.fn() }; const controller = new ProvisionJobsController(service); const req: any = { adminUser: { id: 'alice' } };
    controller.getById(req, 'job-1', 'true'); expect(service.getById).toHaveBeenLastCalledWith('job-1', req.adminUser, true);
    controller.getById(req, 'job-1', 'false'); expect(service.getById).toHaveBeenLastCalledWith('job-1', req.adminUser, false);
    expect(() => controller.getById(req, 'job-1', 'yes')).toThrow('must be');
  });
});
