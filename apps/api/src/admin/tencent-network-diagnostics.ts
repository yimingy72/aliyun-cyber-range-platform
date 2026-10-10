import { isIP } from 'node:net';
import { BadGatewayException } from '@nestjs/common';
import type { RangeInstanceRecord } from './admin.repository';
import type { SystemCloudAccountContext } from './system-config.service';
import { assertTencentAccount, assertTencentOwnedInstance } from './tencent-cloud-resources';
import { requestTencentCloud, TencentCloudRequestError } from './tencent-cloud-client';

type Row = Record<string, any>;
const PAGE_SIZE = 100;
const PAGE_LIMIT = 20;
function fail(phase: string, reason: string): never { throw new BadGatewayException(`Tencent network diagnostics failed at ${phase}: ${reason}`); }
function object(value: unknown, phase: string): Row { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(phase, 'malformed object'); return value as Row; }
function text(value: unknown, phase: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\r\n]/.test(value)) fail(phase, `malformed field;${flags(value)}`); return value; }
function list(value: unknown, phase: string): Row[] { if (!Array.isArray(value)) fail(phase, 'missing complete array'); return value.map(row => object(row, phase)); }
function strings(value: unknown, phase: string): string[] { if (!Array.isArray(value)) fail(phase, 'missing identity array'); const result = value.map(item => text(item, phase)); if (new Set(result).size !== result.length) fail(phase, 'duplicate identity'); return result; }
type FrozenCheck = 'frozen_scope' | 'subnet_zone' | 'eni_vpc' | 'attachment_owner_uid' | 'eni_zone' | 'attachment_host_snapshot' | 'attachment_device_index_snapshot' | 'attachment_device_index_type' | 'primary_subnet' | 'primary_private_ip';
function flags(value: unknown) { return `present=${value !== undefined && value !== null && value !== ''};type=${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`; }
function numeric(value: unknown, phase: string, check: FrozenCheck = 'frozen_scope'): number { if (!Number.isSafeInteger(value) || Number(value) < 0) fail(phase, `malformed numeric field;check=${check};${flags(value)};integer=false`); return Number(value); }
// Normalize both representations before pagination deduplication and projection.
function routeIdentity(value: unknown, phase = 'DescribeRoutes.RouteItemId'): string { return typeof value === 'number' ? String(numeric(value, phase)) : text(value, phase); }
const ROUTE_GATEWAY_TYPES = new Set(['LOCAL','CVM','VPN','DIRECTCONNECT','PEERCONNECTION','HAVIP','NAT','NORMAL_CVM','EIP','CCN','LOCAL_GATEWAY','INTRANAT','USER_CCN','GWLB_ENDPOINT','SSLVPN','PVGW']);
function gatewayType(value: unknown, phase: string): string { const type = text(value,phase); if (!ROUTE_GATEWAY_TYPES.has(type)) fail(phase,'unsupported gateway enum'); return type; }
function verifiedGatewayType(route: Row, table: Row): string {
  if (typeof route.GatewayType !== 'number') return gatewayType(route.GatewayType,'DescribeRoutes.GatewayType');
  numeric(route.GatewayType,'DescribeRoutes.GatewayType');
  // No published numeric enum exists: require the other owned-table API to identify this exact route.
  const matching = list(table.RouteSet,'DescribeRouteTables.RouteSet').filter(candidate =>
    candidate.RouteTableId === table.RouteTableId && candidate.RouteTableId === route.RouteTableId
    && routeIdentity(candidate.RouteItemId,'DescribeRouteTables.RouteSet.RouteItemId') === routeIdentity(route.RouteItemId)
    && cidr(candidate.DestinationCidrBlock,'DescribeRouteTables.RouteSet.DestinationCidrBlock') === cidr(route.DestinationCidrBlock,'DescribeRoutes.DestinationCidrBlock')
    && cidr(candidate.DestinationIpv6CidrBlock,'DescribeRouteTables.RouteSet.DestinationIpv6CidrBlock') === cidr(route.DestinationIpv6CidrBlock,'DescribeRoutes.DestinationIpv6CidrBlock')
    && candidate.GatewayId === route.GatewayId && bool(candidate.Enabled,'DescribeRouteTables.RouteSet.Enabled') === bool(route.Enabled,'DescribeRoutes.Enabled'));
  if (matching.length !== 1) fail('DescribeRoutes.GatewayType','numeric enum has no unique independently matching owned-table route');
  return gatewayType(matching[0].GatewayType,'DescribeRouteTables.RouteSet.GatewayType');
}
function bool(value: unknown, phase: string): boolean { if (typeof value !== 'boolean') fail(phase, 'missing boolean field'); return value; }
function same(actual: unknown, expected: unknown, phase: string, check: FrozenCheck = 'frozen_scope') { if (actual !== expected) fail(phase, `frozen scope or attachment mismatch;check=${check};${flags(actual)};matches=false`); }
function within(id: unknown, expected: string[], phase: string): string { const result = text(id, phase); if (!expected.includes(result)) fail(phase, 'resource outside persisted scope'); return result; }
function exact(actual: string[], expected: string[], phase: string) { if (new Set(actual).size !== actual.length || actual.length !== expected.length || actual.some(id => !expected.includes(id))) fail(phase, 'incomplete or unrequested identities'); }
function identity(id: unknown, prefix: string, phase: string): string { const result = text(id, phase); if (!new RegExp(`^${prefix}-[a-zA-Z0-9]+$`).test(result)) fail(phase, 'invalid provider identity'); return result; }
function persisted(value: unknown, prefix: string, required = false): string[] { if (value == null && !required) return []; const values = strings(Object.values(object(value, 'scope')), 'scope').map(id => identity(id, prefix, 'scope')); if (values.length > 100 || required && !values.length) fail('scope', 'missing or oversized persisted identities'); return values; }
function ip(value: unknown, phase: string): string { const result = text(value, phase); if (!isIP(result)) fail(phase, 'malformed IP'); return result; }
function cidr(value: unknown, phase: string): string | null { if (value == null || value === '') return null; const result = text(value, phase), [address, bits, ...extra] = result.split('/'); const version = isIP(address); if (!version || extra.length || bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) > (version === 4 ? 32 : 128))) fail(phase, 'malformed CIDR'); return result; }
function tags(value: unknown, phase: string): Record<string, string> { const result: Record<string, string> = {}; for (const row of list(value, phase)) { const key = text(row.Key, phase); if (Object.hasOwn(result, key) || typeof row.Value !== 'string') fail(phase, 'malformed ownership tags'); result[key] = row.Value; } return result; }

/** Read-only, bounded APIs. Rules never cause reads of referenced external resources. */
export async function readTencentRangeNetworkDiagnostics(instance: RangeInstanceRecord, account: SystemCloudAccountContext) {
  assertTencentAccount(account);
  const summary = instance.resourceSummary, frozen = summary?.executionContext;
  if (!summary || summary.mode !== 'opentofu' || instance.instanceMode !== 'range' || instance.cloudProvider !== 'tencent_cloud'
    || !frozen || frozen.provider !== account.provider || frozen.cloudAccountContextId !== account.cloudAccountContextId
    || frozen.cloudAccountUid !== account.accountUid || frozen.regionId !== account.defaultRegion || frozen.zoneId !== account.defaultZoneId) fail('context', 'frozen provider/account/context/region/zone mismatch');
  const vpcId = identity(summary.vpcId, 'vpc', 'scope');
  const hostIds = persisted(summary.hostIds, 'ins', true), subnetIds = persisted(summary.subnetIds, 'subnet', true);
  const secondaryIds = persisted(summary.secondaryNetworkInterfaceIds, 'eni'), sgIds = persisted(summary.securityGroupIds, 'sg', true);
  const aclIds = persisted(summary.networkAclIds, 'acl'), natIds = persisted(summary.natGatewayIds, 'nat');
  const routeIds = persisted(summary.routeTableIds, 'rtb', true);
  const eipIds = [...new Set([...persisted(summary.eipAllocationIds, 'eip'), ...(summary.eipAllocationId ? [identity(summary.eipAllocationId, 'eip', 'scope')] : [])])];
  same(object(object(instance.runtimeScenarioTemplateSpec, 'snapshot').topology, 'snapshot').defaultRegion, frozen.regionId, 'snapshot');
  const evidence: Array<{ action: string; requestId: string }> = [];
  const rpc = async (service: 'cvm' | 'vpc' | 'sts', action: string, parameters: Row): Promise<Row> => {
    if (!action.startsWith('Describe') && action !== 'GetCallerIdentity') fail('request', 'write action prohibited');
    let response: Row;
    try { response = object(await requestTencentCloud({ service, version: service === 'sts' ? '2018-08-13' : '2017-03-12', action,
      regionId: frozen.regionId, accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret, parameters }), action); }
    catch (error) { if (error instanceof TencentCloudRequestError) fail(action, `cloud query rejected (${error.code})`); throw error; }
    if (response.Error || response.NextToken) fail(action, 'business failure or undocumented continuation');
    evidence.push({ action, requestId: text(response.RequestId, action) }); return response;
  };
  const pages = async (action: string, set: string, parameters: Row, key: (row: Row) => string, stringPaging = false, service: 'cvm' | 'vpc' = 'vpc'): Promise<Row[]> => {
    const rows: Row[] = [], seen = new Set<string>(); let expected: number | undefined;
    for (let page = 0; page < PAGE_LIMIT; page++) {
      const response = await rpc(service, action, { ...parameters, Offset: stringPaging ? String(rows.length) : rows.length, Limit: stringPaging ? String(PAGE_SIZE) : PAGE_SIZE });
      const total = numeric(response.TotalCount, action), batch = list(response[set], action);
      if (expected !== undefined && expected !== total || batch.length > PAGE_SIZE || rows.length + batch.length > total) fail(action, 'pagination changed or oversized');
      expected = total;
      for (const row of batch) { const id = key(row); if (seen.has(id)) fail(action, 'duplicate identity across pages'); seen.add(id); rows.push(row); }
      if (rows.length === total) return rows;
      if (!batch.length) fail(action, 'pagination ended before total');
    }
    fail(action, 'pagination bound exceeded');
  };
  const known = async (action: string, set: string, parameter: string, key: string, ids: string[], stringPaging = false, service: 'cvm' | 'vpc' = 'vpc') => {
    if (!ids.length) return [];
    const rows = await pages(action, set, { [parameter]: ids }, row => text(row[key], action), stringPaging, service);
    exact(rows.map(row => row[key]), ids, action); return rows;
  };
  const ownership = (row: Row, phase: string) => {
    const actual = tags(row.TagSet ?? row.Tags, phase);
    const expected = { CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', ExecutionBackend: 'opentofu', CloudAccountUid: frozen.cloudAccountUid,
      CloudAccountContextId: frozen.cloudAccountContextId, RangeInstanceId: instance.id, PlatformScope: instance.ownerUserId ? 'user' : 'platform',
      ...(instance.ownerUserId ? { PlatformUserId: instance.ownerUserId } : {}) };
    if (Object.entries(expected).some(([key, value]) => actual[key] !== value) || !instance.ownerUserId && actual.PlatformUserId) fail(phase, 'resource ownership not verified');
    return actual;
  };
  const caller = await rpc('sts', 'GetCallerIdentity', {}); same(caller.AccountId, frozen.cloudAccountUid, 'GetCallerIdentity');
  const [vpc] = await known('DescribeVpcs', 'VpcSet', 'VpcIds', 'VpcId', [vpcId], true); ownership(vpc, 'DescribeVpcs');
  const cvms = await known('DescribeInstances', 'InstanceSet', 'InstanceIds', 'InstanceId', hostIds, false, 'cvm');
  const instances = cvms.map(row => {
    const phase = 'DescribeInstances', placement = object(row.VirtualPrivateCloud, phase), nodeId = Object.entries(summary.hostIds!).find(([, id]) => id === row.InstanceId)![0];
    same(placement.VpcId, vpcId, phase); within(placement.SubnetId, subnetIds, phase); same(object(row.Placement, phase).Zone, frozen.zoneId, phase);
    const resourceTags = ownership(row, phase);
    assertTencentOwnedInstance(instance, account, { instanceId: row.InstanceId, tags: resourceTags } as never, nodeId);
    const groups = strings(row.SecurityGroupIds, phase); for (const id of groups) within(id, sgIds, phase);
    return { nodeId, instanceId: row.InstanceId as string, status: ({ RUNNING: 'Running', STOPPED: 'Stopped' } as Row)[row.InstanceState] ?? text(row.InstanceState, phase),
      instanceType: text(row.InstanceType, phase), privateIp: ip(strings(row.PrivateIpAddresses, phase)[0], phase), vswitchId: placement.SubnetId as string,
      securityGroupIds: groups, networkInterfaceIds: [] as string[] };
  });
  const subnets = await known('DescribeSubnets', 'SubnetSet', 'SubnetIds', 'SubnetId', subnetIds, true);
  for (const row of subnets) { same(row.VpcId, vpcId, 'DescribeSubnets'); same(row.Zone, frozen.zoneId, 'DescribeSubnets','subnet_zone'); ownership(row, 'DescribeSubnets'); within(row.RouteTableId, routeIds, 'DescribeSubnets'); if (row.NetworkAclId) within(row.NetworkAclId, aclIds, 'DescribeSubnets'); }
  // CVM-created primary ENIs have no OpenTofu resource ID. Discover only through each proven host attachment;
  // every auxiliary ENI must already have a persisted identity. Then re-read the complete exact-ID set.
  const attached: Row[] = [];
  for (const hostId of hostIds) attached.push(...await pages('DescribeNetworkInterfaces', 'NetworkInterfaceSet', { Filters: [{ Name: 'attachment.instance-id', Values: [hostId] }, { Name: 'vpc-id', Values: [vpcId] }] }, row => identity(row.NetworkInterfaceId, 'eni', 'DescribeNetworkInterfaces')));
  const attachedIds = strings(attached.map(row => row.NetworkInterfaceId), 'DescribeNetworkInterfaces');
  if (attachedIds.length > 100 || secondaryIds.some(id => !attachedIds.includes(id))) fail('DescribeNetworkInterfaces', 'missing persisted attachment');
  const enis = await known('DescribeNetworkInterfaces', 'NetworkInterfaceSet', 'NetworkInterfaceIds', 'NetworkInterfaceId', attachedIds);
  const networkInterfaces = enis.map(row => {
    const phase = 'DescribeNetworkInterfaces', attachment = object(row.Attachment, phase), primary = bool(row.Primary, phase);
    same(row.VpcId, vpcId, phase,'eni_vpc');
    if (attachment.InstanceAccountId !== undefined && attachment.InstanceAccountId !== null && attachment.InstanceAccountId !== '') same(attachment.InstanceAccountId, frozen.cloudAccountUid, phase,'attachment_owner_uid');
    if (row.Zone !== undefined && row.Zone !== null && row.Zone !== '') same(row.Zone, frozen.zoneId, phase,'eni_zone');
    const instanceId = within(attachment.InstanceId, hostIds, phase), vswitchId = within(row.SubnetId, subnetIds, phase);
    const subnet = subnets.find(value => value.SubnetId === vswitchId)!;
    same(subnet.Zone, frozen.zoneId, phase,'subnet_zone');
    const initial = attached.find(value => value.NetworkInterfaceId === row.NetworkInterfaceId)!;
    for (const key of ['VpcId','SubnetId','Primary','MacAddress']) same(row[key], initial[key], phase);
    same(attachment.InstanceId, object(initial.Attachment, phase).InstanceId, phase,'attachment_host_snapshot');
    same(attachment.DeviceIndex, initial.Attachment.DeviceIndex, phase,'attachment_device_index_snapshot');
    if (!primary) { within(row.NetworkInterfaceId, secondaryIds, phase); ownership(row, phase); }
    else if (secondaryIds.includes(row.NetworkInterfaceId)) fail(phase, 'persisted auxiliary became primary');
    const privateIps = list(row.PrivateIpAddressSet, phase).map(item => ({ privateIp: ip(item.PrivateIpAddress, phase), primary: bool(item.Primary, phase) }));
    if (!privateIps.length || privateIps.filter(item => item.primary).length !== 1 || new Set(privateIps.map(item => item.privateIp)).size !== privateIps.length) fail(phase, 'invalid private IP set');
    const host = instances.find(item => item.instanceId === instanceId)!;
    if (primary) { same(vswitchId, host.vswitchId, phase,'primary_subnet'); same(privateIps.find(item => item.primary)!.privateIp, host.privateIp, phase,'primary_private_ip'); }
    const securityGroupIds = strings(row.GroupSet, phase); for (const id of securityGroupIds) within(id, sgIds, phase);
    if (primary) exact(securityGroupIds, host.securityGroupIds, phase);
    const macAddress = text(row.MacAddress, phase); if (!/^(?:[a-fA-F0-9]{2}:){5}[a-fA-F0-9]{2}$/.test(macAddress)) fail(phase, 'invalid MAC');
    host.networkInterfaceIds.push(row.NetworkInterfaceId);
    return { networkInterfaceId: row.NetworkInterfaceId as string, type: primary ? 'Primary' : 'Secondary', instanceId, deviceIndex: numeric(attachment.DeviceIndex, phase,'attachment_device_index_type'),
      privateIp: privateIps.find(item => item.primary)!.privateIp, privateIps, vswitchId, vpcId, securityGroupIds, macAddress, sourceDestCheck: null,
      status: text(row.NetworkInterfaceState ?? row.State, phase), guestConfigurationVerified: false };
  });
  for (const hostId of hostIds) {
    const nics = networkInterfaces.filter(nic => nic.instanceId === hostId);
    if (nics.filter(nic => nic.type === 'Primary').length !== 1 || new Set(nics.map(nic => nic.deviceIndex)).size !== nics.length) fail('DescribeNetworkInterfaces', 'ambiguous primary or actual device index');
  }
  exact([...new Set(networkInterfaces.flatMap(nic => nic.securityGroupIds))], sgIds, 'security groups');
  const routeRows = await known('DescribeRouteTables', 'RouteTableSet', 'RouteTableIds', 'RouteTableId', routeIds, true);
  const routeTables = [];
  for (const row of routeRows) {
    const phase = 'DescribeRouteTables'; same(row.VpcId, vpcId, phase); ownership(row, phase);
    const associations = list(row.AssociationSet, phase).map(item => { same(item.RouteTableId, row.RouteTableId, phase); return within(item.SubnetId, subnetIds, phase); });
    exact(associations, subnets.filter(subnet => subnet.RouteTableId === row.RouteTableId).map(subnet => subnet.SubnetId), phase);
    const routes = await pages('DescribeRoutes', 'RouteSet', { Filters: [{ Name: 'route-table-id', Values: [row.RouteTableId] }, { Name: 'vpc-id', Values: [vpcId] }] }, route => routeIdentity(route.RouteItemId));
    routeTables.push({ routeTableId: row.RouteTableId as string, vpcId, type: bool(row.Main, phase) ? 'System' : 'Custom', vswitchIds: associations, routeEntries: routes.map(route => {
      same(route.RouteTableId, row.RouteTableId, 'DescribeRoutes.RouteTableId'); const enabled = bool(route.Enabled, 'DescribeRoutes.Enabled'), type = verifiedGatewayType(route,row);
      const gatewayId = typeof route.GatewayId === 'string' && route.GatewayId ? text(route.GatewayId, 'DescribeRoutes.GatewayId') : null;
      return { routeEntryId: routeIdentity(route.RouteItemId), destinationCidrBlock: cidr(route.DestinationCidrBlock, 'DescribeRoutes.DestinationCidrBlock'), destinationIpv6CidrBlock: cidr(route.DestinationIpv6CidrBlock, 'DescribeRoutes.DestinationIpv6CidrBlock'), status: enabled ? 'Available' : 'Disabled', enabled, nextHops: [{ nextHopType: type, ...(typeof route.GatewayType === 'number' ? {providerNumericType:route.GatewayType} : {}), nextHopId: gatewayId, knownTarget: gatewayId !== null && [...natIds, ...hostIds, ...instances.map(host => host.privateIp)].includes(gatewayId) }] };
    }) });
  }
  const groups = await known('DescribeSecurityGroups', 'SecurityGroupSet', 'SecurityGroupIds', 'SecurityGroupId', sgIds, true);
  const securityGroups = [];
  for (const row of groups) {
    ownership(row, 'DescribeSecurityGroups'); const phase = 'DescribeSecurityGroupPolicies';
    const policies = object((await rpc('vpc', phase, { SecurityGroupId: row.SecurityGroupId })).SecurityGroupPolicySet, phase);
    const rules = ['Ingress','Egress'].flatMap(direction => {
      const entries = list(policies[direction], phase), indexes = entries.map(entry => numeric(entry.PolicyIndex, phase));
      if (new Set(indexes).size !== indexes.length) fail(phase, 'duplicate rule order');
      if (policies.PolicyStatistics != null) {
        const statistics = object(policies.PolicyStatistics, phase);
        if (entries.length !== numeric(statistics[`${direction}IPv4TotalCount`], phase) + numeric(statistics[`${direction}IPv6TotalCount`], phase)) fail(phase, 'incomplete policy statistics');
      }
      return entries.map(entry => {
        for (const template of [entry.ServiceTemplate, entry.AddressTemplate]) {
          if (template != null && Object.values(object(template, phase)).some(value => value !== null && value !== '')) fail(phase, 'external template expansion not verified');
        }
        const reference = entry.SecurityGroupId ? within(entry.SecurityGroupId, sgIds, phase) : null;
        const policy = text(entry.Action, phase).toUpperCase(); if (!['ACCEPT','DROP'].includes(policy)) fail(phase, 'invalid rule action');
        return { direction: direction === 'Ingress' ? 'ingress' : 'egress', protocol: text(entry.Protocol, phase), portRange: text(entry.Port, phase), cidr: cidr(entry.CidrBlock, phase), ipv6Cidr: cidr(entry.Ipv6CidrBlock, phase), securityGroupReferenceId: reference, policy, priority: numeric(entry.PolicyIndex, phase), providerPriority: entry.Priority == null ? null : numeric(entry.Priority, phase) };
      });
    });
    securityGroups.push({ securityGroupId: row.SecurityGroupId as string, innerAccessPolicy: null, version: text(policies.Version, phase), rules });
  }
  const acls = await known('DescribeNetworkAcls', 'NetworkAclSet', 'NetworkAclIds', 'NetworkAclId', aclIds);
  const networkAcls = acls.map(row => {
    const phase = 'DescribeNetworkAcls'; ownership(row, phase);
    const hasVpc = row.VpcId !== undefined && row.VpcId !== null && row.VpcId !== '';
    if (hasVpc) same(row.VpcId, vpcId, `${phase}.VpcId`);
    if (row.NetworkAclType !== 'TRIPLE') fail(`${phase}.NetworkAclType`, 'unsupported ACL tuple type');
    const associations = list(row.SubnetSet, `${phase}.SubnetSet`).map(subnet => {
      const id = within(subnet.SubnetId, subnetIds, `${phase}.SubnetSet.SubnetId`);
      // ACL association structs can omit VpcId; use the independently proven full subnet.
      const proven = subnets.find(candidate => candidate.SubnetId === id)!;
      same(proven.VpcId, vpcId, `${phase}.SubnetSet.verifiedVpcId`);
      same(proven.NetworkAclId, row.NetworkAclId, `${phase}.SubnetSet.verifiedNetworkAclId`);
      if (subnet.VpcId !== undefined && subnet.VpcId !== null && subnet.VpcId !== '') same(subnet.VpcId, vpcId, `${phase}.SubnetSet.VpcId`);
      return id;
    });
    exact(associations, subnets.filter(subnet => subnet.NetworkAclId === row.NetworkAclId).map(subnet => subnet.SubnetId), `${phase}.SubnetSet`);
    if (!hasVpc && !associations.length) fail(`${phase}.VpcId`, 'missing VPC identity has no independently verified subnet association');
    const rules = (value: unknown, direction: string) => list(value, `${phase}.${direction}`).map((entry, index) => {
      const path = `${phase}.${direction}`;
      const action = text(entry.Action, `${path}.Action`).toUpperCase(); if (!['ACCEPT','DROP'].includes(action)) fail(`${path}.Action`, 'invalid ACL action');
      return { name: null, entryType: 'TRIPLE', evaluationOrder: entry.Priority == null ? null : numeric(entry.Priority, `${path}.Priority`), responsePosition: index + 1, policy: action, protocol: text(entry.Protocol, `${path}.Protocol`), portRange: entry.Port ? text(entry.Port, `${path}.Port`) : 'all', cidr: cidr(entry.CidrBlock, `${path}.CidrBlock`), ipv6Cidr: cidr(entry.Ipv6CidrBlock, `${path}.Ipv6CidrBlock`) };
    });
    return { networkAclId: row.NetworkAclId as string, status: 'Observed', vswitchIds: associations, inboundRules: rules(row.IngressEntries,'IngressEntries'), outboundRules: rules(row.EgressEntries,'EgressEntries') };
  });
  const addresses = await known('DescribeAddresses', 'AddressSet', 'AddressIds', 'AddressId', eipIds);
  for (const row of addresses) { ownership(row, 'DescribeAddresses'); if (row.InstanceId) within(row.InstanceId, [...hostIds, ...natIds], 'DescribeAddresses'); if (row.NetworkInterfaceId) within(row.NetworkInterfaceId, attachedIds, 'DescribeAddresses'); }
  const gateways = await known('DescribeNatGateways', 'NatGatewaySet', 'NatGatewayIds', 'NatGatewayId', natIds);
  const natGateways = gateways.map(row => {
    const phase = 'DescribeNatGateways'; same(row.VpcId, vpcId, phase); ownership(row, phase);
    if (row.SubnetId) within(row.SubnetId, subnetIds, phase);
    const securityGroupIds = strings(row.SecurityGroupSet ?? [], phase); for (const id of securityGroupIds) within(id, sgIds, phase);
    if (strings(row.DirectConnectGatewayIds ?? [], phase).length) fail(phase, 'external direct-connect association');
    const ipAssociations = list(row.PublicIpAddressSet, phase).map(item => { const allocationId = within(item.AddressId, eipIds, phase), address = addresses.find(value => value.AddressId === allocationId)!;
      same(address.AddressIp, item.PublicIpAddress, phase); same(address.InstanceId, row.NatGatewayId, phase); return { allocationId, ipAddress: ip(item.PublicIpAddress, phase), usingStatus: text(address.AddressStatus, phase) }; });
    return { natGatewayId: row.NatGatewayId as string, status: text(row.State, phase), natType: numeric(row.NatProductVersion, phase) === 2 ? 'Standard' : 'Traditional', vswitchId: row.SubnetId || null, privateIp: null, ipAssociations, forwardTableIds: [] as string[], snatTableIds: [] as string[], securityGroupIds, strictSnatMode: bool(row.StrictSnatMode, phase) };
  });
  const forwardRows = natIds.length ? await pages('DescribeNatGatewayDestinationIpPortTranslationNatRules', 'NatGatewayDestinationIpPortTranslationNatRuleSet', { NatGatewayIds: natIds }, row => `${row.IpProtocol}://${row.VpcId}:${row.NatGatewayId}@${row.PublicIpAddress}:${row.PublicPort}`) : [];
  const forwardEntries = forwardRows.map(row => {
    const phase = 'DescribeNatGatewayDestinationIpPortTranslationNatRules'; same(row.VpcId, vpcId, phase); const natGatewayId = within(row.NatGatewayId, natIds, phase), protocol = text(row.IpProtocol, phase).toUpperCase();
    if (!['TCP','UDP'].includes(protocol)) fail(phase, 'invalid NAT protocol');
    const externalIp = ip(row.PublicIpAddress, phase), externalPort = numeric(row.PublicPort, phase), internalIp = ip(row.PrivateIpAddress, phase), internalPort = numeric(row.PrivatePort, phase);
    if (externalPort < 1 || externalPort > 65535 || internalPort < 1 || internalPort > 65535 || !natGateways.find(nat => nat.natGatewayId === natGatewayId)!.ipAssociations.some(item => item.ipAddress === externalIp) || !networkInterfaces.some(nic => nic.privateIps.some(item => item.privateIp === internalIp))) fail(phase, 'rule outside known addresses');
    return { forwardEntryId: `${protocol}://${vpcId}:${natGatewayId}@${externalIp}:${externalPort}`, natGatewayId, protocol, externalIp, externalPort: String(externalPort), internalIp, internalPort: String(internalPort), status: 'Observed' };
  });
  exact(forwardEntries.map(row => row.forwardEntryId), summary.dnatEntryIds ? strings(Object.values(summary.dnatEntryIds), 'scope') : [], 'persisted DNAT');
  const snatEntries = [];
  for (const natGatewayId of natIds) {
    const phase = 'DescribeNatGatewaySourceIpTranslationNatRules';
    const rows = await pages(phase, 'SourceIpTranslationNatRuleSet', { NatGatewayId: natGatewayId }, row => text(row.NatGatewaySnatId, phase));
    for (const row of rows) {
      same(row.NatGatewayId, natGatewayId, phase); same(row.VpcId, vpcId, phase);
      if (row.ResourceType !== 'SUBNET') fail(phase, 'unsupported source resource type');
      const sourceVswitchId = within(row.ResourceId, subnetIds, phase), subnet = subnets.find(value => value.SubnetId === sourceVswitchId)!;
      same(row.PrivateIpAddress, subnet.CidrBlock, phase);
      const publicIps = strings(row.PublicIpAddresses, phase); if (!publicIps.length || publicIps.some(value => !natGateways.find(nat => nat.natGatewayId === natGatewayId)!.ipAssociations.some(item => item.ipAddress === value))) fail(phase, 'SNAT EIP outside known gateway');
      snatEntries.push({ snatEntryId: `${natGatewayId}#${sourceVswitchId}`, providerRuleId: text(row.NatGatewaySnatId, phase), natGatewayId, sourceVswitchId, sourceCidr: cidr(row.PrivateIpAddress, phase), snatIp: publicIps.join(','), status: 'Observed' });
    }
  }
  exact(snatEntries.map(row => row.snatEntryId), summary.snatEntryIds ? strings(Object.values(summary.snatEntryIds), 'scope') : [], 'persisted SNAT');
  return { status: 'succeeded' as const, provider: 'tencent_cloud' as const, checkedAt: new Date().toISOString(), regionId: frozen.regionId,
    cloudAccountUid: frozen.cloudAccountUid, cloudAccountContextId: frozen.cloudAccountContextId, vpcId, instances, networkInterfaces, natGateways,
    forwardEntries, snatEntries, routeTables, networkAcls, securityGroups, evidence, guestConfigurationVerified: false,
    eipAddresses: addresses.map(row => ({ allocationId: row.AddressId as string, ipAddress: ip(row.AddressIp, 'DescribeAddresses'), status: text(row.AddressStatus, 'DescribeAddresses'), instanceId: row.InstanceId || null, networkInterfaceId: row.NetworkInterfaceId || null })),
    notes: ['Cloud observations do not verify guest NIC configuration or end-to-end connectivity.'] };
}
