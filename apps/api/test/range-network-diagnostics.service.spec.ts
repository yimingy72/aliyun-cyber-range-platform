import { RangeNetworkDiagnosticsService } from '../src/admin/range-network-diagnostics.service';
import { RangeInstancesService } from '../src/admin/range-instances.service';
import { RangeTemplatesService } from '../src/admin/range-templates.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { signAliyunRpcQuery } from '../src/admin/image-catalog-rpc-signer';

const accountUid = '1234567890123456';
const user = { id: 'alice', role: 'user' as const };
const range = { id: 'range-owned', ownerUserId: user.id, instanceMode: 'range', cloudProvider: 'alibaba_cloud', runtimeScenarioTemplateSpec: { topology: { defaultRegion: 'cn-hangzhou' } }, resourceSummary: { mode: 'opentofu', vpcId: 'vpc-owned', hostIds: { entry: 'i-entry', internal: 'i-internal' }, subnetIds: { entry: 'vsw-entry', internal: 'vsw-internal' }, secondaryNetworkInterfaceIds: { secondary: 'eni-secondary' }, securityGroupIds: { entry: 'sg-entry', internal: 'sg-internal' }, networkAclIds: { entry: 'nacl-owned' }, natGatewayIds: { shared: 'ngw-owned' }, dnatEntryIds: { ssh: 'ftb-owned:fwd-owned', http: 'ftb-owned:fwd-http', udp: 'ftb-owned:fwd-udp' }, snatEntryIds: { internal: 'stb-owned:snat-owned' }, eipAllocationIds: { dnat: 'eip-dnat', snat: 'eip-snat' } } };
const privateIps = (value: string) => ({ PrivateIpSets: { PrivateIpSet: [{ PrivateIpAddress: value, Primary: true }] }, PrivateIpAddress: value });
const list = (field: string, item: string, rows: unknown[]) => ({ RequestId: 'safe-request-id', PageNumber: 1, PageSize: 50, TotalCount: rows.length, [field]: { [item]: rows } });
function fixture() {
  const ledgers = ['i-entry','i-internal'].map((id) => ({ cloudResourceId: id, cloudAccountUid: accountUid, regionId: 'cn-hangzhou', ownerUserId: user.id, rangeInstanceId: range.id }));
  const context = { accountUid, regionId: 'cn-hangzhou', accessKeyId: 'synthetic-bound-key', accessKeySecret: 'synthetic-bound-secret' };
  const db = { billingLedgerResource: { findMany: jest.fn(async () => ledgers) }, cloudAccountContext: { findUnique: jest.fn(async () => context) } };
  const sg = (id: string) => ({ SecurityGroupIds: { SecurityGroupId: [id] } });
  const eniRows = [
    { NetworkInterfaceId: 'eni-entry', Type: 'Primary', InstanceId: 'i-entry', VpcId: 'vpc-owned', VSwitchId: 'vsw-entry', OwnerId: accountUid, Attachment: { DeviceIndex: 0 }, MacAddress: '00:16:3e:00:00:01', ...privateIps('10.0.40.10'), ...sg('sg-entry') },
    { NetworkInterfaceId: 'eni-secondary', Type: 'Secondary', InstanceId: 'i-entry', VpcId: 'vpc-owned', VSwitchId: 'vsw-internal', OwnerId: accountUid, Attachment: { DeviceIndex: 1 }, MacAddress: '00:16:3e:00:00:02', ...privateIps('172.16.40.10'), ...sg('sg-secondary') },
    { NetworkInterfaceId: 'eni-internal', Type: 'Primary', InstanceId: 'i-internal', VpcId: 'vpc-owned', VSwitchId: 'vsw-internal', OwnerId: accountUid, Attachment: { DeviceIndex: 0 }, MacAddress: '00:16:3e:00:00:03', ...privateIps('172.16.40.20'), ...sg('sg-internal') },
  ];
  const instanceRows = [
    { InstanceId: 'i-entry', RegionId: 'cn-hangzhou', Status: 'Running', InstanceType: 'ecs.u1-c1m2.large', VpcAttributes: { VpcId: 'vpc-owned', VSwitchId: 'vsw-entry', PrivateIpAddress: { IpAddress: ['10.0.40.10'] } }, NetworkInterfaces: { NetworkInterface: [{ NetworkInterfaceId: 'eni-entry' }, { NetworkInterfaceId: 'eni-secondary' }] }, ...sg('sg-entry') },
    { InstanceId: 'i-internal', RegionId: 'cn-hangzhou', Status: 'Running', InstanceType: 'ecs.u1-c1m2.large', VpcAttributes: { VpcId: 'vpc-owned', VSwitchId: 'vsw-internal', PrivateIpAddress: { IpAddress: ['172.16.40.20'] } }, NetworkInterfaces: { NetworkInterface: [{ NetworkInterfaceId: 'eni-internal' }] }, ...sg('sg-internal') },
  ];
  const payload = (query: URLSearchParams): any => {
    const action = query.get('Action');
    if (action === 'GetCallerIdentity') return { RequestId: 'request', AccountId: accountUid };
    if (action === 'DescribeInstances') return list('Instances','Instance',instanceRows);
    if (action === 'DescribeNetworkInterfaces') return { RequestId: 'request', NextToken: '', NetworkInterfaceSets: { NetworkInterfaceSet: eniRows } };
    if (action === 'DescribeVSwitchAttributes') return { RequestId: 'request', VSwitchId: query.get('VSwitchId'), VpcId: 'vpc-owned', RouteTable: { RouteTableId: 'vtb-owned', RouteTableType: 'System' } };
    if (action === 'DescribeRouteEntryList') return { RequestId: 'request', NextToken: '', RouteEntrys: { RouteEntry: [{ RouteTableId: 'vtb-owned', DestinationCidrBlock: '0.0.0.0/0', Status: 'Available', NextHops: { NextHop: [{ NextHopId: 'ngw-owned', NextHopType: 'NatGateway' }] } }] } };
    if (action === 'DescribeSecurityGroupAttribute') return { RequestId: 'request', SecurityGroupId: query.get('SecurityGroupId'), VpcId: 'vpc-owned', RegionId: 'cn-hangzhou', InnerAccessPolicy: 'Drop', NextToken: '', Permissions: { Permission: [{ Direction: 'ingress', IpProtocol: 'tcp', PortRange: '22/22', SourceCidrIp: '0.0.0.0/0', Policy: 'Accept', Priority: '10' }] } };
    if (action === 'DescribeNetworkAclAttributes') return { RequestId: 'request', NetworkAclAttribute: { NetworkAclId: 'nacl-owned', VpcId: 'vpc-owned', OwnerId: accountUid, RegionId: 'cn-hangzhou', Status: 'Available', Resources: { Resource: [{ ResourceId: 'vsw-entry', ResourceType: 'VSwitch', Status: 'BINDED' }] }, IngressAclEntries: { IngressAclEntry: [{ NetworkAclEntryName: 'allow-ssh', EntryType: 'custom', Policy: 'accept', Protocol: 'tcp', Port: '22/22', SourceCidrIp: '0.0.0.0/0' }, { NetworkAclEntryName: 'default-drop', EntryType: 'system', Policy: 'drop', Protocol: 'all', Port: '-1/-1', SourceCidrIp: '0.0.0.0/0' }] }, EgressAclEntries: { EgressAclEntry: [{ NetworkAclEntryName: 'return', EntryType: 'custom', Policy: 'accept', Protocol: 'all', Port: '-1/-1', DestinationCidrIp: '0.0.0.0/0' }] } } };
    if (action === 'DescribeNatGateways') return list('NatGateways','NatGateway',[{ NatGatewayId: 'ngw-owned', VpcId: 'vpc-owned', RegionId: 'cn-hangzhou', Status: 'Available', NatType: 'Enhanced', NatGatewayPrivateInfo: { VswitchId: 'vsw-entry', PrivateIpAddress: '10.0.40.253' }, IpLists: { IpList: [{ AllocationId: 'eip-dnat', IpAddress: '192.0.2.1', UsingStatus: 'UsedByForwardTable' }, { AllocationId: 'eip-snat', IpAddress: '192.0.2.2', UsingStatus: 'UsedBySnatTable' }] }, ForwardTableIds: { ForwardTableId: ['ftb-owned'] }, SnatTableIds: { SnatTableId: ['stb-owned'] } }]);
    if (action === 'DescribeForwardTableEntries') return list('ForwardTableEntries','ForwardTableEntry',[
      { ForwardEntryId: 'fwd-owned', ForwardTableId: 'ftb-owned', ExternalIp: '192.0.2.1', ExternalPort: '2222', InternalIp: '10.0.40.10', InternalPort: '22', IpProtocol: 'TCP', Status: 'Available' },
      ...['TCP','UDP'].map((protocol) => ({ ForwardEntryId: protocol === 'TCP' ? 'fwd-http' : 'fwd-udp', ForwardTableId: 'ftb-owned', ExternalIp: '192.0.2.1', ExternalPort: '8080', InternalIp: '10.0.40.10', InternalPort: '80', IpProtocol: protocol, Status: 'Available' })),
    ]);
    if (action === 'DescribeSnatTableEntries') return list('SnatTableEntries','SnatTableEntry',[{ SnatEntryId: 'snat-owned', SnatTableId: 'stb-owned', SourceVSwitchId: 'vsw-internal', SourceCIDR: '172.16.40.0/24', SnatIp: '192.0.2.2', Status: 'Available' }]);
    throw new Error('Unexpected cloud action');
  };
  const changes = new Map<string, (value: any, query: URLSearchParams) => any>();
  const requests: URL[] = [];
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const parsed = new URL(String(url)); requests.push(parsed); expect(init?.signal).toBeInstanceOf(AbortSignal);
    const original = structuredClone(payload(parsed.searchParams)); const action = parsed.searchParams.get('Action')!;
    const value = changes.get(action)?.(original, parsed.searchParams) ?? original;
    return new Response(JSON.stringify({ ...value, Password: context.accessKeySecret, AccessKeySecret: context.accessKeySecret, RawState: 'must-not-return' }), { status: 200 });
  });
  return { db, context, ledgers, eniRows, instanceRows, requests, changes, fetchMock, service: new RangeNetworkDiagnosticsService(db as never) };
}

describe('Range network diagnostics scope and data', () => {
  afterEach(() => jest.restoreAllMocks());
  it('resolves encrypted Alibaba credentials and signs every read with the decrypted secret',async()=>{
    const s=fixture();Object.assign(s.context,{id:'bound-context',accessKeySecret:'cloud-credential:v1:synthetic-envelope'});
    const resolved={provider:'alibaba_cloud',accountUid,defaultRegion:'cn-hangzhou',cloudAccountContextId:'bound-context',
      accessKeyId:s.context.accessKeyId,accessKeySecret:'synthetic-decrypted-secret'};
    const config={getExecutionAccountContext:jest.fn(async()=>resolved)};
    const service=new RangeNetworkDiagnosticsService(s.db as never,config as never);
    const result=await service.get(range as never,user);
    expect(config.getExecutionAccountContext).toHaveBeenCalledWith({cloudAccountContextId:'bound-context'});
    for(const request of s.requests){
      const parameters=Object.fromEntries(request.searchParams);delete parameters.Signature;
      const expected=new URLSearchParams(signAliyunRpcQuery(parameters,resolved.accessKeySecret));
      expect(request.searchParams.get('Signature')).toBe(expected.get('Signature'));
    }
    expect(JSON.stringify(result)).not.toMatch(/synthetic-envelope|synthetic-decrypted-secret/);
  });
  it.each(['provider','account','region','context'] as const)('rejects a mismatched decrypted %s identity before cloud reads',async mismatch=>{
    const s=fixture();Object.assign(s.context,{id:'bound-context',accessKeySecret:'cloud-credential:v1:synthetic-envelope'});
    const resolved={provider:mismatch==='provider'?'tencent_cloud':'alibaba_cloud',accountUid:mismatch==='account'?'foreign':accountUid,
      defaultRegion:mismatch==='region'?'cn-beijing':'cn-hangzhou',cloudAccountContextId:mismatch==='context'?'foreign':'bound-context',
      accessKeyId:'synthetic-bound-key',accessKeySecret:'synthetic-decrypted-secret'};
    const service=new RangeNetworkDiagnosticsService(s.db as never,{getExecutionAccountContext:async()=>resolved} as never);
    await expect(service.get(range as never,user)).rejects.toThrow('resolved frozen account identity mismatch');
    expect(s.fetchMock).not.toHaveBeenCalled();
  });
  it('never signs an encrypted credential without the resolver',async()=>{
    const s=fixture();s.context.accessKeySecret='cloud-credential:v1:synthetic-envelope';
    await expect(s.service.get(range as never,user)).rejects.toThrow('encrypted account credential resolver unavailable');
    expect(s.fetchMock).not.toHaveBeenCalled();
  });
  it('returns only checked range facts including primary/secondary identities, routes, ACL order and gateway bindings', async () => {
    const s = fixture(); const result = await s.service.get(range as never, user);
    expect(result).toMatchObject({ status: 'succeeded', regionId: 'cn-hangzhou', vpcId: 'vpc-owned', cloudAccountUid: accountUid });
    expect(result.networkInterfaces.find((nic) => nic.type === 'Secondary')).toMatchObject({ deviceIndex: 1, vswitchId: 'vsw-internal', securityGroupIds: ['sg-secondary'] });
    expect(result.forwardEntries[0]).toMatchObject({ externalPort: '2222', internalPort: '22', internalIp: '10.0.40.10' });
    expect(result.forwardEntries.map((entry) => [entry.forwardEntryId, entry.protocol, entry.externalPort])).toEqual([['fwd-owned','TCP','2222'],['fwd-http','TCP','8080'],['fwd-udp','UDP','8080']]);
    expect(result.snatEntries[0]).toMatchObject({ snatEntryId: 'snat-owned', natGatewayId: 'ngw-owned' });
    expect(result.networkAcls[0].inboundRules.map((rule) => [rule.name, rule.evaluationOrder])).toEqual([['allow-ssh',1],['default-drop',2]]);
    expect(result.natGateways[0].ipAssociations).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-bound|must-not-return|Password|AccessKeySecret|RawState/);
    expect(s.db.billingLedgerResource.findMany).toHaveBeenCalledWith({ where: { rangeInstanceId: range.id, cloudProvider: 'alibaba_cloud', cloudResourceType: 'ecs', releasedAt: null } });
    for (const request of s.requests) { expect(request.searchParams.get('Action')).toMatch(/^(Describe|GetCallerIdentity)/); if (request.hostname !== 'sts.aliyuncs.com') expect(request.searchParams.get('RegionId')).toBe('cn-hangzhou'); }
  });
  it('accepts legacy child-only IDs only inside the tables of the checked range NAT', async () => {
    const s = fixture(); const legacy = structuredClone(range);
    legacy.resourceSummary.dnatEntryIds = { ssh: 'fwd-owned', http: 'fwd-http', udp: 'fwd-udp' }; legacy.resourceSummary.snatEntryIds.internal = 'snat-owned';
    await expect(s.service.get(legacy as never, user)).resolves.toMatchObject({ status: 'succeeded' });
    expect(s.requests.filter((request) => request.searchParams.get('Action') === 'DescribeForwardTableEntries').map((request) => request.searchParams.get('ForwardTableId'))).toEqual(['ftb-owned']);
    expect(s.requests.filter((request) => request.searchParams.get('Action') === 'DescribeSnatTableEntries').map((request) => request.searchParams.get('SnatTableId'))).toEqual(['stb-owned']);
  });
  it.each([
    ['dnatEntryIds','ssh','ftb-foreign:fwd-owned'],
    ['snatEntryIds','internal','stb-foreign:snat-owned'],
  ] as const)('rejects a foreign persisted parent in %s before querying any NAT entries', async (field, key, id) => {
    const s = fixture(); const invalid = structuredClone(range); (invalid.resourceSummary[field] as Record<string,string>)[key] = id;
    await expect(s.service.get(invalid as never, user)).rejects.toThrow('persisted parent table outside range NAT');
    expect(s.requests.some((request) => ['DescribeForwardTableEntries','DescribeSnatTableEntries'].includes(request.searchParams.get('Action')!))).toBe(false);
  });
  it.each([
    ['dnatEntryIds','ssh',':fwd-owned'], ['dnatEntryIds','ssh','ftb-owned:'], ['dnatEntryIds','ssh','ftb-owned:fwd-owned:extra'], ['dnatEntryIds','ssh','stb-owned:fwd-owned'], ['dnatEntryIds','ssh','ftb-owned:snat-owned'],
    ['snatEntryIds','internal',':snat-owned'], ['snatEntryIds','internal','stb-owned:'], ['snatEntryIds','internal','stb-owned:snat-owned:extra'], ['snatEntryIds','internal','ftb-owned:snat-owned'], ['snatEntryIds','internal','stb-owned:fwd-owned'],
  ] as const)('rejects malformed or cross-namespace persisted %s identity %s before cloud access', async (field, key, id) => {
    const s = fixture(); const invalid = structuredClone(range); (invalid.resourceSummary[field] as Record<string,string>)[key] = id;
    await expect(s.service.get(invalid as never, user)).rejects.toThrow('invalid persisted NAT entry identity'); expect(s.fetchMock).not.toHaveBeenCalled();
  });
  it('rejects a child listed under different persisted parents before cloud access', async () => {
    const s = fixture(); const invalid = structuredClone(range); invalid.resourceSummary.dnatEntryIds.http = 'ftb-other:fwd-owned';
    await expect(s.service.get(invalid as never, user)).rejects.toThrow('duplicate identity'); expect(s.fetchMock).not.toHaveBeenCalled();
  });
  it('rejects a legacy and compound ID referring to the same child before cloud access', async () => {
    const s = fixture(); const invalid = structuredClone(range); invalid.resourceSummary.dnatEntryIds.http = 'fwd-owned';
    await expect(s.service.get(invalid as never, user)).rejects.toThrow('duplicate identity'); expect(s.fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    ['ForwardTableIds','ForwardTableId','ftb-owned','duplicate identity'],
    ['SnatTableIds','SnatTableId','stb-owned','duplicate identity'],
    ['ForwardTableIds','ForwardTableId','stb-wrong','invalid NAT parent table identity'],
    ['SnatTableIds','SnatTableId','ftb-wrong','invalid NAT parent table identity'],
  ] as const)('rejects duplicate or cross-namespace NAT table in %s before querying entries', async (field, item, id, reason) => {
    const s = fixture(); s.changes.set('DescribeNatGateways', (value) => { value.NatGateways.NatGateway[0][field][item].push(id); return value; });
    await expect(s.service.get(range as never, user)).rejects.toThrow(reason);
    expect(s.requests.some((request) => ['DescribeForwardTableEntries','DescribeSnatTableEntries'].includes(request.searchParams.get('Action')!))).toBe(false);
  });
  it.each([
    ['DescribeForwardTableEntries','ForwardTableEntries','ForwardTableEntry','ForwardTableId','ftb-foreign'],
    ['DescribeSnatTableEntries','SnatTableEntries','SnatTableEntry','SnatTableId','stb-foreign'],
  ] as const)('rejects a provider row claiming another parent at %s', async (action, field, item, key, id) => {
    const s = fixture(); s.changes.set(action, (value) => { value[field][item][0][key] = id; return value; });
    await expect(s.service.get(range as never, user)).rejects.toThrow('resource identity mismatch');
  });
  it('rejects a matching child returned by the wrong owned table even when the provider omits its parent field', async () => {
    const s = fixture(); s.changes.set('DescribeNatGateways', (value) => { value.NatGateways.NatGateway[0].ForwardTableIds.ForwardTableId.push('ftb-other'); return value; });
    s.changes.set('DescribeForwardTableEntries', (value, query) => {
      if (query.get('ForwardTableId') === 'ftb-owned') return { ...value, TotalCount: 0, ForwardTableEntries: { ForwardTableEntry: [] } };
      for (const row of value.ForwardTableEntries.ForwardTableEntry) delete row.ForwardTableId;
      return value;
    });
    await expect(s.service.get(range as never, user)).rejects.toThrow('resource identity mismatch');
  });
  it('rejects another owner before any DB or cloud access', async () => {
    const s = fixture(); await expect(s.service.get(range as never, { id: 'bob', role: 'user' })).rejects.toThrow('access denied'); expect(s.db.billingLedgerResource.findMany).not.toHaveBeenCalled(); expect(s.fetchMock).not.toHaveBeenCalled();
  });
  it('allows an administrator while still enforcing the same ledger and VPC scope', async () => { const s = fixture(); await expect(s.service.get(range as never, { id: 'admin', role: 'admin' })).resolves.toMatchObject({ vpcId: 'vpc-owned' }); });
  it.each(['cloudAccountUid','regionId','ownerUserId','cloudResourceId'] as const)('rejects inconsistent %s ledger before any cloud request', async (field) => {
    const s = fixture(); s.ledgers[0][field] = 'mismatch'; await expect(s.service.get(range as never, user)).rejects.toThrow('Network diagnostics failed'); expect(s.fetchMock).not.toHaveBeenCalled();
  });
  it('rejects credentials resolving to another account before querying any resources', async () => {
    const s = fixture(); s.changes.set('GetCallerIdentity', (value) => ({ ...value, AccountId: 'different-account' })); await expect(s.service.get(range as never, user)).rejects.toThrow('resource identity mismatch'); expect(s.requests.map((request) => request.searchParams.get('Action'))).toEqual(['GetCallerIdentity']);
  });
  it.each([
    ['DescribeInstances', (value: any) => { value.Instances.Instance[0].VpcAttributes.VpcId = 'foreign-vpc'; return value; }],
    ['DescribeInstances', (value: any) => { value.Instances.Instance[0].InstanceId = 'i-foreign'; return value; }],
    ['DescribeNetworkInterfaces', (value: any) => { value.NetworkInterfaceSets.NetworkInterfaceSet[0].InstanceId = 'i-foreign'; return value; }],
    ['DescribeNetworkInterfaces', (value: any) => { value.NetworkInterfaceSets.NetworkInterfaceSet[0].OwnerId = 'foreign-account'; return value; }],
    ['DescribeSecurityGroupAttribute', (value: any) => ({ ...value, VpcId: 'foreign-vpc' })],
    ['DescribeNetworkAclAttributes', (value: any) => { value.NetworkAclAttribute.Resources.Resource[0].ResourceId = 'vsw-foreign'; return value; }],
    ['DescribeNatGateways', (value: any) => { value.NatGateways.NatGateway[0].VpcId = 'foreign-vpc'; return value; }],
    ['DescribeForwardTableEntries', (value: any) => { value.ForwardTableEntries.ForwardTableEntry[0].ForwardEntryId = 'fwd-foreign'; return value; }],
    ['DescribeRouteEntryList', (value: any) => { value.RouteEntrys.RouteEntry[0].RouteTableId = 'vtb-foreign'; return value; }],
  ])('fails explicitly on mismatched identity at %s', async (action, mutate) => {
    const s = fixture(); s.changes.set(action as string, mutate as never); await expect(s.service.get(range as never, user)).rejects.toThrow('Network diagnostics failed');
  });
  it('rejects nested provider content in a supposedly scalar CIDR field', async () => {
    const s = fixture(); s.changes.set('DescribeSecurityGroupAttribute', (value) => { value.Permissions.Permission[0].SourceCidrIp = { Password: s.context.accessKeySecret }; return value; });
    await expect(s.service.get(range as never, user)).rejects.toThrow('missing or invalid identity field');
    try { await s.service.get(range as never, user); } catch (error) { expect(String(error)).not.toContain(s.context.accessKeySecret); }
  });
  it('rejects truncated page-number responses instead of silently returning a subset', async () => {
    const s = fixture(); s.changes.set('DescribeInstances', (value) => ({ ...value, TotalCount: 3 })); await expect(s.service.get(range as never, user)).rejects.toThrow('incomplete pagination'); expect(s.requests.some((request) => request.searchParams.get('Action') === 'DescribeNetworkInterfaces')).toBe(false);
  });
  it('accepts the real route token shape without TotalCount and follows MaxResult/NextToken', async () => {
    const s = fixture(); s.changes.set('DescribeRouteEntryList', (value, query) => {
      expect(query.get('MaxResult')).toBe('100'); expect(query.has('PageNumber')).toBe(false);
      return { ...value, NextToken: query.has('NextToken') ? '' : 'next-page', RouteEntrys: { RouteEntry: [{ ...value.RouteEntrys.RouteEntry[0], DestinationCidrBlock: query.has('NextToken') ? '10.0.0.0/16' : '0.0.0.0/0' }] } };
    });
    const result = await s.service.get(range as never, user); expect(result.routeTables[0].routeEntries).toHaveLength(2);
    expect(s.requests.filter((request) => request.searchParams.get('Action') === 'DescribeRouteEntryList').map((request) => request.searchParams.get('NextToken'))).toEqual([null,'next-page']);
  });
  it.each([17, {}, ['unexpected-token']])('rejects malformed route pagination token without returning provider values', async (token) => {
    const s = fixture(); s.changes.set('DescribeRouteEntryList', (value) => ({ ...value, NextToken: token }));
    await expect(s.service.get(range as never, user)).rejects.toThrow('missing or invalid identity field');
  });
  it('rejects an empty route page with a continuation token', async () => {
    const s = fixture(); s.changes.set('DescribeRouteEntryList', (value) => ({ ...value, NextToken: 'next-page', RouteEntrys: { RouteEntry: [] } }));
    await expect(s.service.get(range as never, user)).rejects.toThrow('invalid repeated pagination token');
  });
  it('limits route token pagination even if the provider never terminates', async () => {
    const s = fixture(); let page = 0; s.changes.set('DescribeRouteEntryList', (value) => ({ ...value, NextToken: `page-${++page}` }));
    await expect(s.service.get(range as never, user)).rejects.toThrow('pagination bound exceeded'); expect(page).toBe(20);
  });
  it('rejects repeated NextToken without unbounded paging', async () => {
    const s = fixture(); s.changes.set('DescribeRouteEntryList', (value) => ({ ...value, NextToken: 'repeated-token' })); await expect(s.service.get(range as never, user)).rejects.toThrow('repeated pagination'); expect(s.requests.filter((request) => request.searchParams.get('Action') === 'DescribeRouteEntryList')).toHaveLength(2);
  });
  it('never leaks a vendor business error message', async () => {
    const s = fixture(); s.changes.set('GetCallerIdentity', () => ({ RequestId: 'request', Code: 'Denied', Message: s.context.accessKeySecret })); await expect(s.service.get(range as never, user)).rejects.toThrow('cloud business failure');
    try { await s.service.get(range as never, user); } catch (error) { expect(String(error)).not.toContain(s.context.accessKeySecret); }
  });
});

describe('Range details diagnostic opt-in', () => {
  afterEach(() => jest.restoreAllMocks());
  it('default reads never invoke diagnostics, while opt-in uses only the already authorized instance', async () => {
    const repository = createMemoryAdminRepository(); const instance = await repository.createRangeInstance({ ownerUserId: user.id, name: 'owned-range' });
    const diagnostics = { get: jest.fn().mockResolvedValue({ status: 'succeeded', instances: [{ nodeId: 'entry', status: 'Running' }] }) };
    const service = new RangeInstancesService(repository, new RangeTemplatesService(repository), {} as never, {} as never, {} as never, diagnostics as never);
    await service.getById(instance.id, user); expect(diagnostics.get).not.toHaveBeenCalled();
    await service.getById(instance.id, user, { includeNetworkDiagnostics: true }); expect(diagnostics.get).toHaveBeenCalledTimes(1);
    await expect(service.getById(instance.id, { id: 'bob', role: 'user' }, { includeNetworkDiagnostics: true })).rejects.toThrow(); expect(diagnostics.get).toHaveBeenCalledTimes(1);
  });
});
