import { RangeNetworkDiagnosticsService } from '../src/admin/range-network-diagnostics.service';

const account = { provider: 'tencent_cloud', cloudAccountContextId: 'context-a', accountUid: '100000000001', accountUidResolved: true,
  defaultRegion: 'ap-shanghai', defaultZoneId: 'ap-shanghai-2', accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret' };
const tags = { CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', ExecutionBackend: 'opentofu', CloudAccountUid: account.accountUid,
  CloudAccountContextId: account.cloudAccountContextId, RangeInstanceId: 'range-a', PlatformScope: 'user', PlatformUserId: 'owner-a' };
const tagSet = (extra = {}) => Object.entries({ ...tags, ...extra }).map(([Key, Value]) => ({ Key, Value }));
const range = { id: 'range-a', instanceMode: 'range', cloudProvider: 'tencent_cloud', ownerUserId: 'owner-a',
  runtimeScenarioTemplateSpec: { topology: { defaultRegion: account.defaultRegion } },
  resourceSummary: { mode: 'opentofu', executionContext: { provider: 'tencent_cloud', cloudAccountContextId: account.cloudAccountContextId,
    cloudAccountUid: account.accountUid, regionId: account.defaultRegion, zoneId: account.defaultZoneId }, vpcId: 'vpc-owned',
    hostIds: { entry: 'ins-owned' }, subnetIds: { entry: 'subnet-entry', inner: 'subnet-inner' }, routeTableIds: { zone: 'rtb-owned' },
    secondaryNetworkInterfaceIds: { inner: 'eni-secondary' }, securityGroupIds: { entry: 'sg-entry', inner: 'sg-inner' }, networkAclIds: { inner: 'acl-inner' },
    natGatewayIds: { shared: 'nat-owned' }, eipAllocationIds: { entry: 'eip-owned' },
    dnatEntryIds: { ssh: 'TCP://vpc-owned:nat-owned@192.0.2.1:2222' }, snatEntryIds: { inner: 'nat-owned#subnet-inner' } } };
const user = { id: 'owner-a', role: 'user' as const };
function fixture() {
  const db = { billingLedgerResource: { findMany: jest.fn().mockResolvedValue([{ rangeInstanceId: range.id, ownerUserId: user.id, cloudResourceId: 'ins-owned', cloudAccountUid: account.accountUid, regionId: account.defaultRegion }]) } };
  const config = { getExecutionAccountContext: jest.fn().mockResolvedValue(account) };
  const enis = [
    { NetworkInterfaceId: 'eni-primary', Primary: true, VpcId: 'vpc-owned', SubnetId: 'subnet-entry', GroupSet: ['sg-entry'],
      MacAddress: '20:90:6F:FC:9F:69', Zone: account.defaultZoneId, State: 'AVAILABLE', Attachment: { InstanceId: 'ins-owned', InstanceAccountId: account.accountUid, DeviceIndex: 0 }, PrivateIpAddressSet: [{ PrivateIpAddress: '10.0.1.10', Primary: true }] },
    { NetworkInterfaceId: 'eni-secondary', Primary: false, VpcId: 'vpc-owned', SubnetId: 'subnet-inner', GroupSet: ['sg-inner'],
      MacAddress: '20:90:6F:FC:9F:70', Zone: account.defaultZoneId, State: 'AVAILABLE', Attachment: { InstanceId: 'ins-owned', InstanceAccountId: account.accountUid, DeviceIndex: 3 }, PrivateIpAddressSet: [{ PrivateIpAddress: '10.0.2.10', Primary: true }, { PrivateIpAddress: '10.0.2.11', Primary: false }], TagSet: tagSet() },
  ];
  const subnets = [{ SubnetId: 'subnet-entry', VpcId: 'vpc-owned', Zone: account.defaultZoneId, CidrBlock: '10.0.1.0/24', RouteTableId: 'rtb-owned', NetworkAclId: '', TagSet: tagSet() },
    { SubnetId: 'subnet-inner', VpcId: 'vpc-owned', Zone: account.defaultZoneId, CidrBlock: '10.0.2.0/24', RouteTableId: 'rtb-owned', NetworkAclId: 'acl-inner', TagSet: tagSet() }];
  const list = (key: string, rows: any[]) => ({ [key]: rows, TotalCount: rows.length });
  const payload = (action: string, body: any) => {
    switch (action) {
      case 'GetCallerIdentity': return { AccountId: account.accountUid };
      case 'DescribeVpcs': return list('VpcSet', [{ VpcId: 'vpc-owned', TagSet: tagSet() }]);
      case 'DescribeInstances': return list('InstanceSet', [{ InstanceId: 'ins-owned', InstanceState: 'RUNNING', InstanceType: 'S5.MEDIUM4', Placement: { Zone: account.defaultZoneId }, PrivateIpAddresses: ['10.0.1.10'], SecurityGroupIds: ['sg-entry'], VirtualPrivateCloud: { VpcId: 'vpc-owned', SubnetId: 'subnet-entry' }, Tags: tagSet({ PlatformHostKey: 'entry', PlatformResourceType: 'ecs' }) }]);
      case 'DescribeNetworkInterfaces': return list('NetworkInterfaceSet', enis);
      case 'DescribeSubnets': return list('SubnetSet', subnets);
      case 'DescribeRouteTables': return list('RouteTableSet', [{ RouteTableId: 'rtb-owned', VpcId: 'vpc-owned', Main: false, AssociationSet: subnets.map(row => ({ SubnetId: row.SubnetId, RouteTableId: 'rtb-owned' })), TagSet: tagSet() }]);
      case 'DescribeRoutes': return list('RouteSet', [{ RouteTableId: 'rtb-owned', RouteItemId: 'rti-default', DestinationCidrBlock: '0.0.0.0/0', GatewayType: 'NAT', GatewayId: 'nat-owned', Enabled: true }]);
      case 'DescribeSecurityGroups': return list('SecurityGroupSet', ['sg-entry','sg-inner'].map(SecurityGroupId => ({ SecurityGroupId, TagSet: tagSet() })));
      case 'DescribeSecurityGroupPolicies': return { SecurityGroupPolicySet: { Version: '3', Ingress: [{ PolicyIndex: 0, Protocol: 'TCP', Port: '22', CidrBlock: '0.0.0.0/0', Action: 'ACCEPT' }], Egress: [{ PolicyIndex: 0, Protocol: 'ALL', Port: 'all', CidrBlock: '0.0.0.0/0', Action: 'DROP' }] } };
      case 'DescribeNetworkAcls': return list('NetworkAclSet', [{ NetworkAclId: 'acl-inner', VpcId: 'vpc-owned', NetworkAclType: 'TRIPLE', SubnetSet: [subnets[1]], IngressEntries: [{ Protocol: 'TCP', Port: '22', CidrBlock: '10.0.1.0/24', Action: 'ACCEPT', Priority: 1 }], EgressEntries: [{ Protocol: 'ALL', CidrBlock: '0.0.0.0/0', Action: 'DROP', Priority: 1 }], TagSet: tagSet() }]);
      case 'DescribeAddresses': return list('AddressSet', [{ AddressId: 'eip-owned', AddressIp: '192.0.2.1', AddressStatus: 'BIND', InstanceId: 'nat-owned', TagSet: tagSet() }]);
      case 'DescribeNatGateways': return list('NatGatewaySet', [{ NatGatewayId: 'nat-owned', VpcId: 'vpc-owned', State: 'AVAILABLE', NatProductVersion: 2, StrictSnatMode: true, PublicIpAddressSet: [{ AddressId: 'eip-owned', PublicIpAddress: '192.0.2.1' }], TagSet: tagSet() }]);
      case 'DescribeNatGatewayDestinationIpPortTranslationNatRules': return list('NatGatewayDestinationIpPortTranslationNatRuleSet', [{ NatGatewayId: 'nat-owned', VpcId: 'vpc-owned', IpProtocol: 'TCP', PublicIpAddress: '192.0.2.1', PublicPort: 2222, PrivateIpAddress: '10.0.1.10', PrivatePort: 22 }]);
      case 'DescribeNatGatewaySourceIpTranslationNatRules': return list('SourceIpTranslationNatRuleSet', [{ NatGatewaySnatId: 'snat-rule', NatGatewayId: 'nat-owned', VpcId: 'vpc-owned', ResourceId: 'subnet-inner', ResourceType: 'SUBNET', PrivateIpAddress: '10.0.2.0/24', PublicIpAddresses: ['192.0.2.1'] }]);
      default: throw new Error(`unexpected action ${action}`);
    }
  };
  const changes = new Map<string, (value: any, body: any) => any>(), calls: Array<{ action: string; body: any; headers: Record<string,string>; url: string }> = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const headers = init!.headers as Record<string,string>, action = headers['X-TC-Action'], body = JSON.parse(String(init!.body));
    calls.push({ action, body, headers, url: String(url) });
    const original = structuredClone(payload(action, body)), value = changes.get(action)?.(original, body) ?? original;
    return new Response(JSON.stringify({ Response: { RequestId: `request-${calls.length}`, ...value, AccessKeySecret: account.accessKeySecret, Password: 'must-not-return', Arbitrary: 'not-returned' } }));
  });
  return { db, config, enis, subnets, calls, changes, service: new RangeNetworkDiagnosticsService(db as never, config as never) };
}
afterEach(() => jest.restoreAllMocks());
it.each(['missing', 'null', 'empty'])('accepts a tagless automatic primary NIC with %s optional zone only through its proven CVM and subnet', async zone => {
  const s = fixture();
  s.changes.set('DescribeNetworkInterfaces', value => {
    for (const row of value.NetworkInterfaceSet) {
      if (zone === 'missing') delete row.Zone; else row.Zone = zone === 'null' ? null : '';
      if (row.Primary) delete row.TagSet;
    }
    return value;
  });
  const result = await s.service.get(range as never, user);
  expect(result.networkInterfaces[0]).toMatchObject({ type: 'Primary', instanceId: 'ins-owned', deviceIndex: 0, vswitchId: 'subnet-entry', vpcId: 'vpc-owned' });
  expect(s.calls.findIndex(call => call.action === 'DescribeSubnets')).toBeLessThan(s.calls.findIndex(call => call.action === 'DescribeNetworkInterfaces'));
});
it.each(['missing', 'null', 'empty'])('accepts %s optional attachment owner only after frozen caller, owned CVM and exact subnet proofs', async owner => {
  const s = fixture();
  s.changes.set('DescribeNetworkInterfaces', value => {
    for (const row of value.NetworkInterfaceSet) {
      delete row.Zone;
      if (owner === 'missing') delete row.Attachment.InstanceAccountId; else row.Attachment.InstanceAccountId = owner === 'null' ? null : '';
      if (row.Primary) delete row.TagSet;
    }
    return value;
  });
  const result = await s.service.get(range as never, user);
  expect(result.networkInterfaces).toHaveLength(2);
  expect(result.networkInterfaces[0]).toMatchObject({ type:'Primary',instanceId:'ins-owned',deviceIndex:0,vswitchId:'subnet-entry' });
  expect(s.calls.map(call => call.action).slice(0,4)).toEqual(['GetCallerIdentity','DescribeVpcs','DescribeInstances','DescribeSubnets']);
});
it.each(['caller','cvm-owner','subnet-owner','foreign-host','device-index'])('rejects missing attachment owner when %s authoritative proof fails', async proof => {
  const s = fixture();
  s.changes.set('DescribeNetworkInterfaces', value => { for (const row of value.NetworkInterfaceSet) delete row.Attachment.InstanceAccountId;
    if (proof === 'foreign-host') value.NetworkInterfaceSet[0].Attachment.InstanceId = 'ins-foreign';
    if (proof === 'device-index') value.NetworkInterfaceSet[0].Attachment.DeviceIndex = '0';
    return value; });
  if (proof === 'caller') s.changes.set('GetCallerIdentity', value => ({...value,AccountId:'foreign'}));
  if (proof === 'cvm-owner') s.changes.set('DescribeInstances', value => { value.InstanceSet[0].Tags = []; return value; });
  if (proof === 'subnet-owner') s.changes.set('DescribeSubnets', value => { value.SubnetSet[0].TagSet = []; return value; });
  await expect(s.service.get(range as never,user)).rejects.toThrow('diagnostics');
});
it.each(['subnet-zone','eni-zone','account','host','subnet','private-ip','device-type','secondary-owner'])('rejects %s mismatches despite a valid automatic primary NIC', async mismatch => {
  const s = fixture();
  if (mismatch === 'subnet-zone') s.changes.set('DescribeSubnets', value => { value.SubnetSet[0].Zone = 'ap-shanghai-3'; return value; });
  else s.changes.set('DescribeNetworkInterfaces', value => {
    const primary = value.NetworkInterfaceSet[0]; delete primary.TagSet;
    if (mismatch === 'eni-zone') primary.Zone = 'ap-shanghai-3'; else delete primary.Zone;
    if (mismatch === 'account') primary.Attachment.InstanceAccountId = 'foreign';
    if (mismatch === 'host') primary.Attachment.InstanceId = 'ins-foreign';
    if (mismatch === 'subnet') primary.SubnetId = 'subnet-inner';
    if (mismatch === 'private-ip') primary.PrivateIpAddressSet[0].PrivateIpAddress = '10.0.1.99';
    if (mismatch === 'device-type') primary.Attachment.DeviceIndex = '0';
    if (mismatch === 'secondary-owner') value.NetworkInterfaceSet[1].TagSet = [];
    return value;
  });
  await expect(s.service.get(range as never, user)).rejects.toThrow('diagnostics');
});
it('returns only safe check flags when the attachment owner does not match the frozen UID', async () => {
  const s = fixture(); s.changes.set('DescribeNetworkInterfaces', value => { delete value.NetworkInterfaceSet[0].Zone; value.NetworkInterfaceSet[0].Attachment.InstanceAccountId = 'private-owner-must-not-return'; return value; });
  const error = await s.service.get(range as never, user).catch(value => value);
  expect(String(error)).toContain('check=attachment_owner_uid;present=true;type=string;matches=false');
  expect(String(error)).not.toContain('private-owner-must-not-return');
  expect(String(error)).not.toContain(account.accountUid);
  expect(String(error)).not.toContain(account.accessKeySecret);
});
it('dispatches only Tencent read APIs and projects bound cloud facts with actual NIC index and request evidence', async () => {
  const s = fixture(), result = await s.service.get(range as never, user);
  expect(result).toMatchObject({ status: 'succeeded', provider: 'tencent_cloud', cloudAccountContextId: 'context-a', guestConfigurationVerified: false });
  expect(result.networkInterfaces[1]).toMatchObject({ deviceIndex: 3, type: 'Secondary', privateIp: '10.0.2.10', macAddress: '20:90:6F:FC:9F:70' });
  expect(result.forwardEntries[0]).toMatchObject({ forwardEntryId: range.resourceSummary.dnatEntryIds.ssh });
  expect(result.snatEntries[0]).toMatchObject({ snatEntryId: range.resourceSummary.snatEntryIds.inner, providerRuleId: 'snat-rule' });
  expect(result.routeTables[0].routeEntries[0].nextHops[0]).toMatchObject({ nextHopId: 'nat-owned', knownTarget: true });
  expect(JSON.stringify(result)).not.toMatch(/synthetic|AccessKey|Password|must-not-return|not-returned/);
  expect(s.config.getExecutionAccountContext).toHaveBeenCalledWith({ cloudAccountContextId: 'context-a' });
  for (const call of s.calls) { expect(call.action).toMatch(/^(Describe|GetCallerIdentity)/); expect(call.url).toMatch(/\.tencentcloudapi\.com/); expect(call.headers['X-TC-Region']).toBe(account.defaultRegion); }
  expect((result as any).evidence).toHaveLength(s.calls.length);
});
it.each(['provider','accountUid','cloudAccountContextId','defaultRegion','defaultZoneId'])('rejects changed frozen %s before any cloud request', async field => {
  const s = fixture(); s.config.getExecutionAccountContext.mockResolvedValue({ ...account, [field]: 'other' });
  await expect(s.service.get(range as never, user)).rejects.toThrow(); expect(s.calls).toHaveLength(0);
});
it('rejects foreign owner and missing or mismatched ledger before any cloud request', async () => {
  const s = fixture(); await expect(s.service.get(range as never, { id: 'other', role: 'user' })).rejects.toThrow('access denied');
  s.db.billingLedgerResource.findMany.mockResolvedValue([]); await expect(s.service.get(range as never, user)).rejects.toThrow('incomplete'); expect(s.calls).toHaveLength(0);
});
it.each([
  ['GetCallerIdentity', (value: any) => ({ ...value, AccountId: 'foreign' })],
  ['DescribeInstances', (value: any) => { value.InstanceSet[0].Tags = tagSet({ PlatformUserId: 'foreign' }); return value; }],
  ['DescribeNetworkInterfaces', (value: any) => { value.NetworkInterfaceSet[1].Attachment.InstanceAccountId = 'foreign'; return value; }],
  ['DescribeNetworkInterfaces', (value: any) => { value.NetworkInterfaceSet[1].NetworkInterfaceId = 'eni-external'; return value; }],
  ['DescribeNetworkInterfaces', (value: any) => { value.NetworkInterfaceSet[1].GroupSet = ['sg-foreign']; return value; }],
  ['DescribeSubnets', (value: any) => { value.SubnetSet[0].RouteTableId = 'rtb-foreign'; return value; }],
  ['DescribeRouteTables', (value: any) => { value.RouteTableSet[0].AssociationSet.push({ SubnetId: 'subnet-foreign', RouteTableId: 'rtb-owned' }); return value; }],
  ['DescribeSecurityGroupPolicies', (value: any) => { delete value.SecurityGroupPolicySet.Egress; return value; }],
  ['DescribeSecurityGroupPolicies', (value: any) => { value.SecurityGroupPolicySet.PolicyStatistics = { IngressIPv4TotalCount: 2, IngressIPv6TotalCount: 0, EgressIPv4TotalCount: 1, EgressIPv6TotalCount: 0 }; return value; }],
  ['DescribeSecurityGroupPolicies', (value: any) => { value.SecurityGroupPolicySet.Ingress[0].ServiceTemplate = { ServiceId: 'ppm-external' }; return value; }],
  ['DescribeNetworkAcls', (value: any) => { value.NetworkAclSet[0].SubnetSet[0].SubnetId = 'subnet-foreign'; return value; }],
  ['DescribeNetworkAcls', (value: any) => { value.NetworkAclSet[0].NetworkAclType = 'QUINTUPLE'; return value; }],
  ['DescribeAddresses', (value: any) => { value.AddressSet[0].InstanceId = 'nat-foreign'; return value; }],
  ['DescribeNatGateways', (value: any) => { value.NatGatewaySet[0].PublicIpAddressSet[0].AddressId = 'eip-foreign'; return value; }],
  ['DescribeNatGateways', (value: any) => { value.NatGatewaySet[0].SecurityGroupSet = ['sg-foreign']; return value; }],
  ['DescribeNatGatewayDestinationIpPortTranslationNatRules', (value: any) => { value.NatGatewayDestinationIpPortTranslationNatRuleSet[0].PrivateIpAddress = '10.99.1.1'; return value; }],
  ['DescribeNatGatewaySourceIpTranslationNatRules', (value: any) => { value.SourceIpTranslationNatRuleSet[0].ResourceId = 'subnet-foreign'; return value; }],
] as const)('fails closed for malformed or external %s evidence', async (action, change) => {
  const s = fixture(); s.changes.set(action, change); await expect(s.service.get(range as never, user)).rejects.toThrow('diagnostics');
});
it('rejects changing attachment between discovery and exact-ID read', async () => {
  const s = fixture(); s.changes.set('DescribeNetworkInterfaces', (value, body) => { if (body.NetworkInterfaceIds) value.NetworkInterfaceSet[1].Attachment.DeviceIndex = 2; return value; });
  await expect(s.service.get(range as never, user)).rejects.toThrow('attachment mismatch');
});
it('follows complete documented route pagination with exact frozen filters', async () => {
  const s = fixture(); s.changes.set('DescribeRoutes', (value, body) => ({ ...value, TotalCount: 2, RouteSet: [{ ...value.RouteSet[0], RouteItemId: `rti-${body.Offset}` }] }));
  const result = await s.service.get(range as never, user); expect(result.routeTables[0].routeEntries).toHaveLength(2);
  expect(s.calls.filter(call => call.action === 'DescribeRoutes').map(call => call.body)).toEqual([0,1].map(Offset => ({ Offset, Limit: 100, Filters: [{ Name: 'route-table-id', Values: ['rtb-owned'] }, { Name: 'vpc-id', Values: ['vpc-owned'] }] })));
});
it.each(['duplicate','changing','empty','missing'])('rejects %s route pages without returning a successful partial diagnosis', async fault => {
  const s = fixture(); s.changes.set('DescribeRoutes', (value, body) => {
    if (fault === 'missing') return { TotalCount: 1 };
    return { ...value, TotalCount: fault === 'changing' && body.Offset ? 3 : 2,
      RouteSet: fault === 'empty' ? [] : [{ ...value.RouteSet[0], RouteItemId: fault === 'duplicate' ? 'rti-same' : `rti-${body.Offset}` }] };
  });
  await expect(s.service.get(range as never, user)).rejects.toThrow('diagnostics');
});
it('sanitizes cloud business errors and never dispatches any Aliyun or write API', async () => {
  const s = fixture(); s.changes.set('DescribeInstances', () => ({ Error: { Code: 'UnauthorizedOperation', Message: account.accessKeySecret } }));
  try { await s.service.get(range as never, user); throw new Error('expected failure'); } catch (error) { expect(String(error)).not.toContain(account.accessKeySecret); expect(String(error)).toContain('DescribeInstances: cloud query rejected (UnauthorizedOperation)'); }
  expect(s.calls.every(call => /^(Describe|GetCallerIdentity)/.test(call.action) && !call.url.includes('aliyun'))).toBe(true);
});
it('accepts empty SDK template structs and refuses to infer missing ACL priority from array position', async () => {
  const s = fixture(); s.changes.set('DescribeSecurityGroupPolicies', value => {
    value.SecurityGroupPolicySet.Ingress[0].ServiceTemplate = { ServiceId: '', ServiceGroupId: null };
    value.SecurityGroupPolicySet.Ingress[0].AddressTemplate = {}; return value;
  });
  s.changes.set('DescribeNetworkAcls', value => { delete value.NetworkAclSet[0].IngressEntries[0].Priority; return value; });
  const result = await s.service.get(range as never, user);
  expect(result.networkAcls[0].inboundRules[0]).toMatchObject({ evaluationOrder: null, responsePosition: 1 });
});
