import { renderTencentRangeVariables, tencentNicCapacity } from '../src/provisioning/renderers/tencent-cloud-range-renderer';
import type { EnterpriseProvisionPlan } from '../src/provisioning/enterprise-provision-plan';
import { selectTencentHostInstanceTypes, assertTencentImagesAvailable } from '../src/provisioning/tencent-cloud-zone-instance-scheduler';
import * as rpc from '../src/admin/tencent-cloud-client';

const account = { provider: 'tencent_cloud' as const, accountUid: '100000000001', cloudAccountContextId: 'context-a', defaultRegion: 'ap-shanghai', defaultZoneId: 'ap-shanghai-2', accessKeyId: 'fake', accessKeySecret: 'fake' };
function input() {
  const plan = { resourceNamePrefix: 'range-fixture', network: { vpcCidr: '10.0.0.0/16', secondaryVpcCidrs: ['172.16.0.0/16','192.168.0.0/16'] }, entryHostKey: 'entry',
    networkZones: [{ key: 'dmz', name: 'DMZ', cidr: '10.0.1.0/24' }], hostDefinitions: [{ key: 'entry', name: 'Entry', hostName: 'entry', zoneKey: 'dmz', privateIp: '10.0.1.10' }],
    hostNetworkInterfaces: [{ hostKey: 'entry', interfaces: [{ deviceIndex: 0, zoneKey: 'dmz', privateIp: '10.0.1.10' },{ deviceIndex: 1, zoneKey: 'dmz', privateIp: '10.0.1.20', secondaryIps: ['10.0.1.21'] }] }],
    natGateways: [{ key: 'nat', name: 'NAT', zoneKey: 'dmz' }], eipDefinitions: [{ key: 'eip', name: 'EIP', bindTargetType: 'nat_gateway', bindTargetKey: 'nat', bandwidthMbps: 10 }],
    snatEntries: [{ key: 'snat', natGatewayKey: 'nat', sourceZoneKey: 'dmz', eipKey: 'eip' }], dnatEntries: [{ key: 'http', natGatewayKey: 'nat', eipKey: 'eip', backendHostKey: 'entry', externalPort: 80, internalPort: 80, protocol: 'tcp' }],
    securityGroupRules: [{ key: 'http', name: 'HTTP', targetHostKey: 'entry', direction: 'ingress', policy: 'accept', protocol: 'tcp', portRange: '80/80', sourceCidr: '0.0.0.0/0', priority: 10 }], aclDefinitions: [], bootstrapScripts: [] } as unknown as EnterpriseProvisionPlan;
  return { plan, rangeInstanceId: 'range-a', account, hostInstanceTypes: { entry: { instanceType: 'S5.MEDIUM4', cpu: 2 } }, hostImageIds: { entry: 'img-fixture' }, hostPasswords: { entry: 'FixturePassword123!' }, tags: { PlatformCreateJobId: 'job-a', PlatformScope: 'user', PlatformUserId: 'owner-a' }, expiresAt: '2100-01-01T00:00:00Z' };
}
afterEach(() => jest.restoreAllMocks());
it('retains frozen range identity, deterministic intent, NIC rules and atomic expiry', () => {
  const request = input(); const vars = renderTencentRangeVariables(request);
  expect(vars.hosts[0]).toMatchObject({ terminate_at: '2100-01-01T00:05:00Z', private_ip: '10.0.1.10', creation_intent_id: expect.stringMatching(/^[0-9a-f]{32}$/) });
  expect(vars.network_interfaces[1]).toMatchObject({ device_index: 1, secondary_ips: ['10.0.1.21'] });
  expect(vars.security_group_rules[0]).toMatchObject({ action: 'ACCEPT', protocol: 'TCP', port: '80', host_key: 'entry' });
  expect(vars.tags).toMatchObject({ CloudProvider: 'tencent_cloud', CloudAccountUid: '100000000001', CloudAccountContextId: 'context-a' });
  expect(renderTencentRangeVariables(request)).toEqual(vars);
  expect(JSON.stringify(vars.hosts)).not.toContain('FixturePassword');
  const changed = { ...request, hostImageIds: { entry: 'img-other' } };
  expect(renderTencentRangeVariables(changed).hosts[0].creation_intent_id).not.toBe(vars.hosts[0].creation_intent_id);
  expect(renderTencentRangeVariables({ ...request, tags: { ...request.tags, PlatformCreateJobId: 'new-generation' } }).hosts[0].creation_intent_id)
    .not.toBe(vars.hosts[0].creation_intent_id);
});
it.each([1,2,4,6,8,12,14,64])('uses documented ENI capacity for %d vCPUs', cpu => expect(tencentNicCapacity(cpu).nics).toBeGreaterThanOrEqual(2));
it.each(['tcp', 'udp', 'TcP'])('renders a single numeric %s port without a same-endpoint interval for SG and ACL', protocol => {
  const request = input();
  request.plan.securityGroupRules[0].protocol = protocol;
  request.plan.securityGroupRules[0].portRange = '8080/8080';
  const { targetHostKey: _host, targetDeviceIndex: _device, ...rule } = request.plan.securityGroupRules[0];
  request.plan.aclDefinitions = [{ ...rule, zoneKey: 'dmz', direction: 'inbound' }];
  const vars = renderTencentRangeVariables(request);
  expect(vars.security_group_rules[0]).toMatchObject({ protocol: protocol.toUpperCase(), port: '8080' });
  expect(vars.acls[0]).toMatchObject({ protocol: protocol.toUpperCase(), port: '8080' });
  request.plan.securityGroupRules[0].portRange = '8080/8090';
  expect(renderTencentRangeVariables(request).security_group_rules[0].port).toBe('8080-8090');
});
it.each(['0/0', '65536/65536', '8081/8080'])('rejects invalid port interval %s before rendering network resources', portRange => {
  const request = input(); request.plan.securityGroupRules[0].portRange = portRange;
  expect(() => renderTencentRangeVariables(request)).toThrow('invalid port range');
});
it.each(['all', 'icmp', 'tcp'])('renders provider-compatible ACL all ports and stable descriptions for %s', protocol => {
  const request = input();
  const rule = { key: 'all-out', name: 'allow all egress', direction: 'egress' as const, policy: 'accept' as const, protocol, portRange: '-1/-1', sourceCidr: '0.0.0.0/0', priority: 10 };
  request.plan.aclDefinitions = [{ ...rule, direction: 'outbound', zoneKey: 'dmz' }];
  request.plan.securityGroupRules = [{ ...rule, targetHostKey: 'entry' }];
  const vars = renderTencentRangeVariables(request);
  expect(vars.acls[0]).toMatchObject({ port: 'ALL', protocol: protocol.toUpperCase(), description: 'ALLOW ALL EGRESS' });
  expect(vars.security_group_rules[0]).toMatchObject({ port: 'all', protocol: protocol.toUpperCase(), description: 'allow all egress' });
});
it('rejects excessive NICs, unknown quota, mixed bootstrap and missing expiry before rendering', () => {
  const request = input(); request.plan.hostNetworkInterfaces[0].interfaces = Array.from({ length: 5 },(_,index) => ({ deviceIndex: index, zoneKey: 'dmz', privateIp: `10.0.1.${10+index}` }));
  expect(() => renderTencentRangeVariables(request)).toThrow('capacity');
  expect(() => tencentNicCapacity(5)).toThrow('not documented');
  expect(() => renderTencentRangeVariables({ ...input(), expiresAt: '' })).toThrow('expiry');
  const scripts = input(); scripts.plan.bootstrapScripts = [{ key: 'one', name: '', type: 'shell', content: '#!/bin/sh', targetHostKeys: ['entry'] },{ key: 'two', name: '', type: 'cloud-init', content: '#cloud-config', targetHostKeys: ['entry'] }];
  expect(() => renderTencentRangeVariables(scripts)).toThrow('mix');
});
it('selects only exact saleable CPU/RAM in the frozen zone and validates image completeness', async () => {
  const request = jest.spyOn(rpc,'requestTencentCloud').mockResolvedValueOnce({ InstanceTypeQuotaSet: [{ Zone: account.defaultZoneId, InstanceChargeType: 'POSTPAID_BY_HOUR', InstanceType: 'S5.MEDIUM4', Cpu: 2, Memory: 4, CpuType: 'Intel', Status: 'SELL' },{ Zone: account.defaultZoneId, InstanceChargeType: 'POSTPAID_BY_HOUR', InstanceType: 'S5.LARGE8', Cpu: 4, Memory: 8, CpuType: 'Intel', Status: 'SELL' }] } as any);
  expect(await selectTencentHostInstanceTypes(account,[{ key: 'entry', cpu: 2, memory: 4 }])).toEqual({ entry: { instanceType: 'S5.MEDIUM4', cpu: 2 } });
  expect(request.mock.calls[0][0]).toMatchObject({ parameters: { Filters: [{ Name: 'zone', Values: ['ap-shanghai-2'] },{ Name: 'instance-charge-type', Values: ['POSTPAID_BY_HOUR'] }] } });
  request.mockResolvedValueOnce({ TotalCount: 0, ImageSet: [] } as any);
  await expect(assertTencentImagesAvailable(account,['img-fixture'])).rejects.toThrow('disk metadata');
});

it.each([
  { ImageSize: 50, Architecture: 'x86_64', SnapshotSet: [] },
  { ImageSize: 20, Architecture: 'x86_64', SnapshotSet: null },
  { ImageSize: 20, Architecture: 'x86_64' },
  { ImageSize: 80, Architecture: 'x86_64', SnapshotSet: [{ DiskUsage: 'SYSTEM_DISK' }] },
])('uses official image size and snapshot fields for system-only images (%j)', async metadata => {
  jest.spyOn(rpc,'requestTencentCloud').mockResolvedValue({ TotalCount: 1, ImageSet: [{ ImageId: 'img-fixture', ImageState: 'NORMAL', ImageType: 'PUBLIC_IMAGE', ...metadata }] } as any);
  expect(await assertTencentImagesAvailable(account,['img-fixture'])).toEqual({ 'img-fixture': { minimumSystemDiskSize: metadata.ImageSize, architecture: 'x86_64' } });
});
it.each([
  { ImageSize: 50, Architecture: 'arm64', SnapshotSet: [] },
  { ImageSize: 80, Architecture: 'x86_64', SnapshotSet: [{ DiskUsage: 'SYSTEM_DISK' },{ DiskUsage: 'DATA_DISK' }] },
  { Architecture: 'x86_64', SnapshotSet: [] },
])('rejects unproven image architecture, minimum disk or implicit data disks (%j)', async metadata => {
  jest.spyOn(rpc,'requestTencentCloud').mockResolvedValue({ TotalCount: 1, ImageSet: [{ ImageId: 'img-fixture', ImageState: 'NORMAL', ImageType: 'PUBLIC_IMAGE', ...metadata }] } as any);
  await expect(assertTencentImagesAvailable(account,['img-fixture'])).rejects.toThrow('disk metadata');
});

it('rejects DNAT entry networks with SNAT disabled instead of silently enabling Tencent default egress', () => {
  const request = input(); request.plan.snatEntries = [];
  expect(() => renderTencentRangeVariables(request)).toThrow('explicitly enable SNAT');
});
it.each([
  [{ ImageType: 'PRIVATE_IMAGE', SnapshotSet: null }, 'SnapshotSet:private-null'],
  [{ ImageType: 'PRIVATE_IMAGE' }, 'SnapshotSet:missing'],
  [{ SnapshotSet: { private: 'never-include-this-value' } }, 'SnapshotSet:shape'],
  [{ SnapshotSet: [null] }, 'SnapshotSet:entry-shape'],
  [{ SnapshotSet: [{}] }, 'SnapshotSet:unknown-disk-usage'],
  [{ SnapshotSet: [{ DiskUsage: 'DATA_DISK' }] }, 'SnapshotSet:data-disk'],
  [{ ImageType: 'PRIVATE_IMAGE', SnapshotSet: [{ DiskUsage: 'SYSTEM_DISK' }, { DiskUsage: 'DATA_DISK' }] }, 'SnapshotSet:data-disk'],
  [{ ImageType: 'SHARED_IMAGE', SnapshotSet: null }, 'ImageType:unsupported'],
  [{ Architecture: null, SnapshotSet: null }, 'Architecture:unsupported'],
  [{ ImageSize: '20', SnapshotSet: null }, 'ImageSize:missing-or-invalid'],
  [{ ImageState: 'CREATING', SnapshotSet: null }, 'ImageState:not-normal'],
])('rejects unproven image fields with safe preflight classifications (%j)', async (fields, reason) => {
  jest.spyOn(rpc, 'requestTencentCloud').mockResolvedValue({ TotalCount: 1, ImageSet: [{ ImageId: 'img-fixture', ImageType: 'PUBLIC_IMAGE', ImageState: 'NORMAL', Architecture: 'x86_64', ImageSize: 20, ...fields }] } as any);
  const error = await assertTencentImagesAvailable(account, ['img-fixture']).catch(value => value);
  expect(error.getStatus()).toBe(409);
  expect(error.message).toContain(reason);
  expect(error.message).not.toContain('never-include-this-value');
});
it('requires explicit system-only snapshot usage for private images', async () => {
  jest.spyOn(rpc, 'requestTencentCloud').mockResolvedValue({ TotalCount: 1, ImageSet: [{ ImageId: 'img-fixture', ImageType: 'PRIVATE_IMAGE', ImageState: 'NORMAL', Architecture: 'x86_64', ImageSize: 40, SnapshotSet: [{ DiskUsage: 'SYSTEM_DISK' }] }] } as any);
  expect(await assertTencentImagesAvailable(account, ['img-fixture'])).toEqual({ 'img-fixture': { minimumSystemDiskSize: 40, architecture: 'x86_64' } });
});

it('renders exact secondary NIC DNAT and per-host system disk overrides', () => {
  const request = input();
  request.plan.dnatEntries[0] = { ...request.plan.dnatEntries[0], backendPrivateIp: '10.0.1.20', backendZoneKey: 'dmz' };
  const vars = renderTencentRangeVariables({ ...request, systemDiskSize: 50, hostSystemDiskSizes: { entry: 80 } });
  expect(vars.hosts[0].system_disk_size).toBe(80);
  expect(vars.dnat_entries[0]).toMatchObject({ host_key: 'entry', private_ip: '10.0.1.20' });
});
it('permits pure private topology without manufacturing a public entry or NAT resource', () => {
  const request = input();
  request.plan.natGateways = []; request.plan.eipDefinitions = []; request.plan.snatEntries = []; request.plan.dnatEntries = [];
  const vars = renderTencentRangeVariables(request);
  expect(vars.entry_host_key).toBe('entry');
  expect(vars.nat_gateways).toEqual([]); expect(vars.eips).toEqual([]); expect(vars.dnat_entries).toEqual([]);
});
it('checks SNAT on the mapped NIC zone rather than the primary NIC zone', () => {
  const request = input();
  request.plan.networkZones.push({ key: 'secondary', name: 'Secondary', cidr: '172.16.1.0/24', purpose: 'internal', isPublicEntry: true });
  request.plan.hostNetworkInterfaces[0].interfaces[1] = { deviceIndex: 1, zoneKey: 'secondary', privateIp: '172.16.1.20' };
  request.plan.dnatEntries[0] = { ...request.plan.dnatEntries[0], backendPrivateIp: '172.16.1.20', backendZoneKey: 'secondary' };
  expect(() => renderTencentRangeVariables(request)).toThrow('explicitly enable SNAT');
  request.plan.snatEntries[0].sourceZoneKey = 'secondary';
  expect(renderTencentRangeVariables(request).dnat_entries[0].private_ip).toBe('172.16.1.20');
});

it('rejects DNAT addresses that do not belong to the selected host NIC', () => {
  const request = input();
  request.plan.dnatEntries[0].backendPrivateIp = '10.0.1.99';
  expect(() => renderTencentRangeVariables(request)).toThrow('owned host NIC');
});
