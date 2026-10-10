import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { BadGatewayException, ConflictException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { RangeInstanceRecord } from './admin.repository';
import type { SessionUserProfile } from './admin-user-auth';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { SystemConfigService } from './system-config.service';
import { readTencentRangeNetworkDiagnostics } from './tencent-network-diagnostics';

type Row = Record<string, any>;
type Context = { regionId: string; accountUid: string; accessKeyId: string; accessKeySecret: string };
type NatEntryId = { tableId: string | null; entryId: string };
const PAGE_SIZE = 50;
const PAGE_LIMIT = 20;
function fail(phase: string, reason: string): never { throw new BadGatewayException(`Network diagnostics failed at ${phase}: ${reason}`); }
function object(value: unknown, phase: string): Row { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(phase, 'invalid response object'); return value as Row; }
function string(value: unknown, phase: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 256) fail(phase, 'missing or invalid identity field'); return value; }
function number(value: unknown, phase: string, field = 'numeric value'): number { if (!['string','number'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail(phase, `invalid numeric field: ${field}`); return Number(value); }
function array(value: unknown, phase: string): Row[] { if (!Array.isArray(value)) fail(phase, 'missing response array'); return value.map((item) => object(item, phase)); }
function path(value: Row, names: string[], phase: string): any { let item: any = value; for (const name of names) item = object(item, phase)[name]; return item; }
function ids(value: unknown, phase: string): string[] { if (!Array.isArray(value)) fail(phase, 'missing identity array'); const result = value.map((item) => string(item, phase)); if (new Set(result).size !== result.length) fail(phase, 'duplicate identity'); return result; }
function mapIds(value: unknown, phase: string, required = false): string[] { if (value === null || value === undefined) { if (required) fail(phase, 'missing persisted resource IDs'); return []; } const result = ids(Object.values(object(value, phase)), phase); if (result.length > 100 || (required && !result.length)) fail(phase, 'unsupported resource count'); return result; }
function natEntryIds(value: unknown, tablePrefix: 'ftb' | 'stb', entryPrefix: 'fwd' | 'snat', phase: string): NatEntryId[] {
  const result = mapIds(value, phase).map((id) => {
    const parts = id.split(':'); const entryId = parts.at(-1)!; const tableId = parts.length === 2 ? parts[0] : null;
    if (parts.length > 2 || !new RegExp(`^${entryPrefix}-[a-z0-9]+$`, 'i').test(entryId) || (tableId !== null && !new RegExp(`^${tablePrefix}-[a-z0-9]+$`, 'i').test(tableId))) fail(phase, 'invalid persisted NAT entry identity');
    return { tableId, entryId };
  });
  ids(result.map((entry) => entry.entryId), phase); return result;
}
function checkNatTables(expected: NatEntryId[], tables: string[], prefix: 'ftb' | 'stb', phase: string) { ids(tables, phase); if (tables.some((id) => !new RegExp(`^${prefix}-[a-z0-9]+$`, 'i').test(id))) fail(phase, 'invalid NAT parent table identity'); if (expected.some((entry) => entry.tableId !== null && !tables.includes(entry.tableId))) fail(phase, 'persisted parent table outside range NAT'); }
function exactNatEntries(rows: Row[], key: string, expected: NatEntryId[], phase: string) {
  exactIds(rows, key, expected.map((entry) => entry.entryId), phase);
  for (const row of rows) { const entry = expected.find((item) => item.entryId === row[key])!; if (entry.tableId !== null) same(row.scopedTableId, entry.tableId, phase); }
}
function exactIds(rows: Row[], key: string, expected: string[], phase: string) { const actual = ids(rows.map((row) => row[key]), phase); if (actual.length !== expected.length || actual.some((id) => !expected.includes(id))) fail(phase, 'resource identity mismatch or incomplete response'); }
function same(actual: unknown, expected: string, phase: string) { if (actual !== expected) fail(phase, 'resource identity mismatch'); }
function ip(value: unknown, phase: string): string { const text = string(value, phase); if (!isIP(text)) fail(phase, 'invalid IP field'); return text; }
function optionalCidr(value: unknown, phase: string): string | null { if (value === null || value === undefined || value === '') return null; const text = string(value, phase); const pieces = text.split('/'); const version = isIP(pieces[0]); if (pieces.length !== 2 || !version || !/^\d+$/.test(pieces[1]) || Number(pieces[1]) > (version === 4 ? 32 : 128)) fail(phase, 'invalid CIDR field'); return text; }
function uid(value: unknown, phase: string): string { if (typeof value === 'number' && !Number.isSafeInteger(value)) fail(phase, 'unsafe account identity'); return string(typeof value === 'number' ? String(value) : value, phase); }

@Injectable()
export class RangeNetworkDiagnosticsService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly systemConfigService?: SystemConfigService) {}

  async get(instance: RangeInstanceRecord, user: Pick<SessionUserProfile, 'id' | 'role'>) {
    if (!user || (user.role !== 'admin' && instance.ownerUserId !== user.id)) throw new ForbiddenException('Range instance access denied');
    const summary = instance.resourceSummary;
    if (instance.instanceMode !== 'range' || !summary || summary.mode !== 'opentofu') throw new ConflictException('Network diagnostics require a provisioned OpenTofu range');
    if (instance.cloudProvider === 'tencent_cloud') {
      const frozen = summary.executionContext;
      if (!this.systemConfigService || !frozen || frozen.provider !== 'tencent_cloud') fail('context', 'missing frozen Tencent execution context');
      const hostIds = mapIds(summary.hostIds, 'scope', true);
      const ledgers = await this.prisma.billingLedgerResource.findMany({ where: { rangeInstanceId: instance.id, cloudProvider: 'tencent_cloud', cloudResourceType: 'ecs', releasedAt: null } });
      exactIds(ledgers, 'cloudResourceId', hostIds, 'ledger');
      if (ledgers.some(row => row.ownerUserId !== instance.ownerUserId || row.rangeInstanceId !== instance.id
        || row.cloudAccountUid !== frozen.cloudAccountUid || row.regionId !== frozen.regionId)) fail('ledger', 'inconsistent frozen owner/account/region');
      const account = await this.systemConfigService.getExecutionAccountContext({ cloudAccountContextId: frozen.cloudAccountContextId });
      try { return await readTencentRangeNetworkDiagnostics(instance, account); }
      catch (error) { if (error instanceof BadGatewayException) throw error; fail('Tencent read', 'cloud request unavailable or invalid'); }
    }
    if (summary.executionContext?.provider === 'tencent_cloud') fail('context', 'instance provider differs from frozen context');
    const vpcId = string(summary.vpcId, 'scope');
    const hostIds = mapIds(summary.hostIds, 'scope', true);
    const switchIds = mapIds(summary.subnetIds, 'scope', true);
    const secondaryIds = mapIds(summary.secondaryNetworkInterfaceIds, 'scope');
    const natIds = mapIds(summary.natGatewayIds, 'scope');
    const aclIds = mapIds(summary.networkAclIds, 'scope');
    const forwardIds = natEntryIds(summary.dnatEntryIds, 'ftb', 'fwd', 'DescribeForwardTableEntries');
    const snatIds = natEntryIds(summary.snatEntryIds, 'stb', 'snat', 'DescribeSnatTableEntries');
    const allocationIds = [...new Set([...mapIds(summary.eipAllocationIds, 'scope'), ...(summary.eipAllocationId ? [string(summary.eipAllocationId, 'scope')] : [])])];
    const ledgers = await this.prisma.billingLedgerResource.findMany({ where: { rangeInstanceId: instance.id, cloudProvider: 'alibaba_cloud', cloudResourceType: 'ecs', releasedAt: null } });
    exactIds(ledgers, 'cloudResourceId', hostIds, 'ledger');
    const accountUids = new Set(ledgers.map((row) => string(row.cloudAccountUid, 'ledger')));
    const regions = new Set(ledgers.map((row) => string(row.regionId, 'ledger')));
    if (accountUids.size !== 1 || regions.size !== 1 || ledgers.some((row) => row.ownerUserId !== instance.ownerUserId || row.rangeInstanceId !== instance.id)) fail('ledger', 'inconsistent owner/account/region');
    const accountUid = [...accountUids][0]; const regionId = [...regions][0];
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(regionId)) fail('ledger', 'invalid region');
    same(object(object(instance.runtimeScenarioTemplateSpec, 'snapshot').topology, 'snapshot').defaultRegion, regionId, 'snapshot');
    const context = await this.prisma.cloudAccountContext.findUnique({ where: { provider_accountUid_regionId: { provider: 'alibaba_cloud', accountUid, regionId } } });
    if (!context) fail('context', 'bound account context not found');
    same(context.accountUid, accountUid, 'context'); same(context.regionId, regionId, 'context');
    const credentials: Context = { accountUid, regionId, accessKeyId: string(context.accessKeyId, 'context'), accessKeySecret: string(context.accessKeySecret, 'context') };
    const caller = await this.rpc(credentials, 'sts', 'GetCallerIdentity', {});
    same(uid(caller.AccountId, 'GetCallerIdentity'), accountUid, 'GetCallerIdentity');

    const instanceRows = await this.pages(credentials, 'ecs', 'DescribeInstances', { InstanceIds: JSON.stringify(hostIds) }, ['Instances','Instance']);
    exactIds(instanceRows, 'InstanceId', hostIds, 'DescribeInstances');
    const interfacesByHost = new Map<string, string[]>();
    const instances = instanceRows.map((row) => {
      const phase = 'DescribeInstances'; same(row.RegionId, regionId, phase); const placement = object(row.VpcAttributes, phase); same(placement.VpcId, vpcId, phase);
      if (!switchIds.includes(string(placement.VSwitchId, phase))) fail(phase, 'unknown vSwitch');
      const interfaceIds = ids(array(path(row, ['NetworkInterfaces','NetworkInterface'], phase), phase).map((nic) => nic.NetworkInterfaceId), phase);
      if (!interfaceIds.length) fail(phase, 'missing attached ENIs'); interfacesByHost.set(row.InstanceId, interfaceIds);
      return { nodeId: Object.entries(summary.hostIds!).find(([, id]) => id === row.InstanceId)![0], instanceId: row.InstanceId as string, status: string(row.Status, phase), instanceType: string(row.InstanceType, phase), privateIp: ip(ids(path(placement, ['PrivateIpAddress','IpAddress'], phase), phase)[0], phase), vswitchId: placement.VSwitchId as string, securityGroupIds: ids(path(row, ['SecurityGroupIds','SecurityGroupId'], phase), phase), networkInterfaceIds: interfaceIds };
    });
    const eniIds = [...new Set([...interfacesByHost.values()].flat())];
    if (eniIds.length > 100 || secondaryIds.some((id) => !eniIds.includes(id))) fail('DescribeInstances', 'persisted secondary ENI missing from attached host');
    const eniRows = await this.tokens(credentials, 'ecs', 'DescribeNetworkInterfaces', { VpcId: vpcId, ...Object.fromEntries(eniIds.map((id, index) => [`NetworkInterfaceId.${index + 1}`, id])) }, ['NetworkInterfaceSets','NetworkInterfaceSet']);
    exactIds(eniRows, 'NetworkInterfaceId', eniIds, 'DescribeNetworkInterfaces');
    const networkInterfaces = eniRows.map((row) => {
      const phase = 'DescribeNetworkInterfaces'; same(row.VpcId, vpcId, phase); if (row.OwnerId !== undefined) same(uid(row.OwnerId, phase), accountUid, phase);
      const instanceId = string(row.InstanceId, phase); if (!interfacesByHost.get(instanceId)?.includes(row.NetworkInterfaceId)) fail(phase, 'ENI attached to another host');
      if (!switchIds.includes(string(row.VSwitchId, phase))) fail(phase, 'unknown ENI vSwitch');
      if (!['Primary','Secondary'].includes(row.Type)) fail(phase, 'invalid ENI type');
      const attachment = row.Attachment === undefined ? {} : object(row.Attachment, phase);
      const privateIps = array(path(row, ['PrivateIpSets','PrivateIpSet'], phase), phase).map((item) => ({ privateIp: ip(item.PrivateIpAddress, phase), primary: item.Primary === true }));
      if (!privateIps.length || privateIps.filter((item) => item.primary).length !== 1) fail(phase, 'invalid ENI private IP set');
      return { networkInterfaceId: row.NetworkInterfaceId as string, type: row.Type as string, instanceId, deviceIndex: attachment.DeviceIndex === undefined ? null : number(attachment.DeviceIndex, phase, 'Attachment.DeviceIndex'), privateIp: ip(row.PrivateIpAddress, phase), privateIps, vswitchId: row.VSwitchId as string, vpcId, securityGroupIds: ids(path(row, ['SecurityGroupIds','SecurityGroupId'], phase), phase), macAddress: string(row.MacAddress, phase), sourceDestCheck: typeof row.SourceDestCheck === 'boolean' ? row.SourceDestCheck : null };
    });
    const switches = await Promise.all(switchIds.map(async (id) => {
      const row = await this.rpc(credentials, 'vpc', 'DescribeVSwitchAttributes', { VSwitchId: id }); same(row.VSwitchId, id, 'DescribeVSwitchAttributes'); same(row.VpcId, vpcId, 'DescribeVSwitchAttributes');
      return { vswitchId: id, routeTableId: string(object(row.RouteTable, 'DescribeVSwitchAttributes').RouteTableId, 'DescribeVSwitchAttributes'), routeTableType: string(row.RouteTable.RouteTableType, 'DescribeVSwitchAttributes') };
    }));
    const routeIds = [...new Set(switches.map((row) => row.routeTableId))];
    const routeTables = await Promise.all(routeIds.map(async (id) => {
      const rows = await this.tokens(credentials, 'vpc', 'DescribeRouteEntryList', { RouteTableId: id }, ['RouteEntrys','RouteEntry'], 'MaxResult');
      return { routeTableId: id, vpcId, type: switches.find((row) => row.routeTableId === id)!.routeTableType, vswitchIds: switches.filter((row) => row.routeTableId === id).map((row) => row.vswitchId), routeEntries: rows.map((row) => { same(row.RouteTableId, id, 'DescribeRouteEntryList'); return { destinationCidrBlock: string(row.DestinationCidrBlock, 'DescribeRouteEntryList'), status: string(row.Status, 'DescribeRouteEntryList'), nextHops: array(path(row, ['NextHops','NextHop'], 'DescribeRouteEntryList'), 'DescribeRouteEntryList').map((hop) => ({ nextHopId: typeof hop.NextHopId === 'string' ? hop.NextHopId : null, nextHopType: string(hop.NextHopType, 'DescribeRouteEntryList') })) }; }) };
    }));
    const securityIds = [...new Set(networkInterfaces.flatMap((row) => row.securityGroupIds))];
    if (securityIds.length > 100 || mapIds(summary.securityGroupIds, 'scope').some((id) => !securityIds.includes(id))) fail('security groups', 'persisted group missing from NICs');
    const securityGroups = await Promise.all(securityIds.map(async (id) => {
      let innerAccessPolicy: string | null = null;
      const rows = await this.tokens(credentials, 'ecs', 'DescribeSecurityGroupAttribute', { SecurityGroupId: id, Direction: 'all', NicType: 'intranet' }, ['Permissions','Permission'], 'MaxResults', (row) => { same(row.SecurityGroupId, id, 'DescribeSecurityGroupAttribute'); same(row.VpcId, vpcId, 'DescribeSecurityGroupAttribute'); same(row.RegionId, regionId, 'DescribeSecurityGroupAttribute'); if (row.InnerAccessPolicy !== undefined) { if (!['Accept','Drop'].includes(row.InnerAccessPolicy)) fail('DescribeSecurityGroupAttribute', 'invalid inner-access policy'); if (innerAccessPolicy && innerAccessPolicy !== row.InnerAccessPolicy) fail('DescribeSecurityGroupAttribute', 'group policy changed between pages'); innerAccessPolicy = row.InnerAccessPolicy; } });
      return { securityGroupId: id, innerAccessPolicy, rules: rows.map((row) => ({ direction: string(row.Direction, 'DescribeSecurityGroupAttribute'), protocol: string(row.IpProtocol, 'DescribeSecurityGroupAttribute'), portRange: string(row.PortRange, 'DescribeSecurityGroupAttribute'), cidr: optionalCidr(row.Direction === 'egress' ? row.DestCidrIp : row.SourceCidrIp, 'DescribeSecurityGroupAttribute'), policy: string(row.Policy, 'DescribeSecurityGroupAttribute'), priority: number(row.Priority, 'DescribeSecurityGroupAttribute', 'Priority') })) };
    }));
    const networkAcls = await Promise.all(aclIds.map(async (id) => {
      const payload = await this.rpc(credentials, 'vpc', 'DescribeNetworkAclAttributes', { NetworkAclId: id }); const row = object(payload.NetworkAclAttribute, 'DescribeNetworkAclAttributes'); same(row.NetworkAclId, id, 'DescribeNetworkAclAttributes'); same(row.VpcId, vpcId, 'DescribeNetworkAclAttributes'); same(row.RegionId, regionId, 'DescribeNetworkAclAttributes'); if (row.OwnerId !== undefined) same(uid(row.OwnerId, 'DescribeNetworkAclAttributes'), accountUid, 'DescribeNetworkAclAttributes');
      const resources = array(path(row, ['Resources','Resource'], 'DescribeNetworkAclAttributes'), 'DescribeNetworkAclAttributes'); if (resources.some((entry) => entry.ResourceType !== 'VSwitch' || !switchIds.includes(entry.ResourceId))) fail('DescribeNetworkAclAttributes', 'ACL linked outside known switches');
      const project = (entry: Row, index: number, direction: 'inbound' | 'outbound') => ({ name: typeof entry.NetworkAclEntryName === 'string' ? entry.NetworkAclEntryName : null, entryType: string(entry.EntryType, 'DescribeNetworkAclAttributes'), evaluationOrder: index + 1, policy: string(entry.Policy, 'DescribeNetworkAclAttributes'), protocol: string(entry.Protocol, 'DescribeNetworkAclAttributes'), portRange: string(entry.Port, 'DescribeNetworkAclAttributes'), cidr: string(direction === 'inbound' ? entry.SourceCidrIp : entry.DestinationCidrIp, 'DescribeNetworkAclAttributes') });
      return { networkAclId: id, status: string(row.Status, 'DescribeNetworkAclAttributes'), vswitchIds: resources.map((entry) => entry.ResourceId as string), inboundRules: array(path(row, ['IngressAclEntries','IngressAclEntry'], 'DescribeNetworkAclAttributes'), 'DescribeNetworkAclAttributes').map((entry, index) => project(entry, index, 'inbound')), outboundRules: array(path(row, ['EgressAclEntries','EgressAclEntry'], 'DescribeNetworkAclAttributes'), 'DescribeNetworkAclAttributes').map((entry, index) => project(entry, index, 'outbound')) };
    }));
    const natRows = (await Promise.all(natIds.map((id) => this.pages(credentials, 'vpc', 'DescribeNatGateways', { NatGatewayId: id, VpcId: vpcId }, ['NatGateways','NatGateway'])))).flat(); exactIds(natRows, 'NatGatewayId', natIds, 'DescribeNatGateways');
    const natGateways = natRows.map((row) => {
      const phase = 'DescribeNatGateways'; same(row.VpcId, vpcId, phase); same(row.RegionId, regionId, phase);
      const privateInfo = row.NatGatewayPrivateInfo ? object(row.NatGatewayPrivateInfo, phase) : null;
      const gatewaySwitch = privateInfo?.VswitchId ?? privateInfo?.VSwitchId ?? null;
      if (gatewaySwitch && !switchIds.includes(gatewaySwitch)) fail(phase, 'NAT vSwitch outside range');
      const ipAssociations = array(path(row, ['IpLists','IpList'], phase), phase).map((item) => {
        if (!allocationIds.includes(string(item.AllocationId, phase))) fail(phase, 'unknown EIP association');
        return { allocationId: item.AllocationId as string, ipAddress: ip(item.IpAddress, phase), usingStatus: string(item.UsingStatus, phase) };
      });
      return { natGatewayId: row.NatGatewayId as string, status: string(row.Status, phase), natType: typeof row.NatType === 'string' ? row.NatType : null, vswitchId: gatewaySwitch as string | null, privateIp: privateInfo?.PrivateIpAddress ? ip(privateInfo.PrivateIpAddress, phase) : null, ipAssociations, forwardTableIds: ids(path(row, ['ForwardTableIds','ForwardTableId'], phase), phase), snatTableIds: ids(path(row, ['SnatTableIds','SnatTableId'], phase), phase) };
    });
    checkNatTables(forwardIds, natGateways.flatMap((gateway) => gateway.forwardTableIds), 'ftb', 'DescribeForwardTableEntries');
    checkNatTables(snatIds, natGateways.flatMap((gateway) => gateway.snatTableIds), 'stb', 'DescribeSnatTableEntries');
    const forwardRows: Row[] = []; const snatRows: Row[] = [];
    for (const gateway of natGateways) {
      for (const id of gateway.forwardTableIds) for (const row of await this.pages(credentials, 'vpc', 'DescribeForwardTableEntries', { ForwardTableId: id }, ['ForwardTableEntries','ForwardTableEntry'])) { if (row.ForwardTableId !== undefined) same(row.ForwardTableId, id, 'DescribeForwardTableEntries'); forwardRows.push({ ...row, scopedTableId: id, scopedGatewayId: gateway.natGatewayId }); }
      for (const id of gateway.snatTableIds) for (const row of await this.pages(credentials, 'vpc', 'DescribeSnatTableEntries', { SnatTableId: id }, ['SnatTableEntries','SnatTableEntry'])) { if (row.SnatTableId !== undefined) same(row.SnatTableId, id, 'DescribeSnatTableEntries'); snatRows.push({ ...row, scopedTableId: id, scopedGatewayId: gateway.natGatewayId }); }
    }
    exactNatEntries(forwardRows, 'ForwardEntryId', forwardIds, 'DescribeForwardTableEntries'); exactNatEntries(snatRows, 'SnatEntryId', snatIds, 'DescribeSnatTableEntries');
    const forwardEntries = forwardRows.map((row) => ({ forwardEntryId: row.ForwardEntryId as string, natGatewayId: row.scopedGatewayId as string, protocol: string(row.IpProtocol, 'DescribeForwardTableEntries'), externalIp: ip(row.ExternalIp, 'DescribeForwardTableEntries'), externalPort: string(row.ExternalPort, 'DescribeForwardTableEntries'), internalIp: ip(row.InternalIp, 'DescribeForwardTableEntries'), internalPort: string(row.InternalPort, 'DescribeForwardTableEntries'), status: string(row.Status, 'DescribeForwardTableEntries') }));
    const snatEntries = snatRows.map((row) => { if (!switchIds.includes(string(row.SourceVSwitchId, 'DescribeSnatTableEntries'))) fail('DescribeSnatTableEntries', 'source vSwitch outside range'); return { snatEntryId: row.SnatEntryId as string, natGatewayId: row.scopedGatewayId as string, sourceVswitchId: row.SourceVSwitchId as string, sourceCidr: string(row.SourceCIDR, 'DescribeSnatTableEntries'), snatIp: string(row.SnatIp, 'DescribeSnatTableEntries'), status: string(row.Status, 'DescribeSnatTableEntries') }; });
    return { status: 'succeeded' as const, checkedAt: new Date().toISOString(), regionId, cloudAccountUid: accountUid, vpcId, instances, networkInterfaces, natGateways, forwardEntries, snatEntries, routeTables, networkAcls, securityGroups };
  }

  private async rpc(context: Context, service: 'ecs' | 'vpc' | 'sts', action: string, parameters: Record<string,string>): Promise<Row> {
    const query = signAliyunRpcQuery({ Action: action, AccessKeyId: context.accessKeyId, Format: 'JSON', ...(service !== 'sts' ? { RegionId: context.regionId } : {}), Version: service === 'ecs' ? '2014-05-26' : service === 'vpc' ? '2016-04-28' : '2015-04-01', SignatureMethod: 'HMAC-SHA1', SignatureNonce: randomUUID(), SignatureVersion: '1.0', Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...parameters }, context.accessKeySecret);
    const endpoint = service === 'sts' ? 'sts.aliyuncs.com' : `${service}.${context.regionId}.aliyuncs.com`;
    let payload: Row;
    try { const response = await fetch(`https://${endpoint}/?${query}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) }); if (!response.ok) fail(action, 'cloud request rejected'); payload = object(await response.json(), action); } catch { fail(action, 'cloud request unavailable or invalid'); }
    if (payload.Code !== undefined || (payload.Success !== undefined && payload.Success !== true) || (payload.success !== undefined && payload.success !== true)) fail(action, 'cloud business failure'); string(payload.RequestId, action);
    return payload;
  }

  private async pages(context: Context, service: 'ecs' | 'vpc', action: string, parameters: Record<string,string>, listPath: string[]): Promise<Row[]> {
    const all: Row[] = []; let expected: number | null = null;
    for (let page = 1; page <= PAGE_LIMIT; page++) {
      const payload = await this.rpc(context, service, action, { ...parameters, PageNumber: String(page), PageSize: String(PAGE_SIZE) }); const total = number(payload.TotalCount, action, 'TotalCount'); same(String(payload.PageNumber), String(page), action); same(String(payload.PageSize), String(PAGE_SIZE), action);
      if (expected !== null && total !== expected) fail(action, 'pagination total changed'); expected = total;
      const rows = array(path(payload, listPath, action), action); if (rows.length !== Math.min(PAGE_SIZE, total - all.length)) fail(action, 'incomplete pagination response'); all.push(...rows);
      if (all.length === total) return all;
    }
    fail(action, 'pagination bound exceeded');
  }

  private async tokens(context: Context, service: 'ecs' | 'vpc', action: string, parameters: Record<string,string>, listPath: string[], sizeKey = 'MaxResults', validate?: (row: Row) => void): Promise<Row[]> {
    const all: Row[] = []; const seen = new Set<string>(); let token: string | undefined;
    for (let page = 0; page < PAGE_LIMIT; page++) {
      const payload = await this.rpc(context, service, action, { ...parameters, [sizeKey]: '100', ...(token ? { NextToken: token } : {}) }); validate?.(payload); const rows = array(path(payload, listPath, action), action); if (rows.length > 100) fail(action, 'oversized page'); all.push(...rows);
      if (payload.NextToken === undefined || payload.NextToken === null || payload.NextToken === '') {
        return all;
      }
      token = string(payload.NextToken, action); if (!rows.length || seen.has(token)) fail(action, 'invalid repeated pagination token'); seen.add(token);
    }
    fail(action, 'pagination bound exceeded');
  }
}
