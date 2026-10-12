import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SystemCloudAccountContext } from './system-config.service';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { requestTencentCloud } from './tencent-cloud-client';
import { describeTencentResourceInventory, type TencentResourceKind } from './tencent-cloud-resources';
import type { PatrolResourceType, ResourceIdentity } from './resource-alert-types';

export type PatrolCloudResource = ResourceIdentity & { tags: Record<string, string>; parentId: string | null; attachedInstanceId: string | null;
  systemDisk: boolean; raw: Record<string, unknown> };
const coreTypes: PatrolResourceType[] = ['ecs','disk','eip','nat_gateway','eni','vpc','vswitch','security_group','network_acl'];
class CloudPatrolReadError extends Error {
  constructor(readonly action: string, readonly status: number, readonly code: string, readonly requestId: string | null) { super(`CLOUD_READ_FAILED:${action}:${status}`); }
}
const missingCodes: Partial<Record<PatrolResourceType,string[]>> = {
  vpc: ['InvalidVpcID.NotFound','InvalidVpcId.NotFound'], vswitch: ['InvalidVSwitchId.NotFound'],
  eni: ['InvalidNetworkInterfaceId.NotFound'], security_group: ['InvalidSecurityGroupId.NotFound'],
  eip: ['InvalidAllocationId.NotFound'], nat_gateway: ['InvalidNatGatewayId.NotFound'], network_acl: ['InvalidNetworkAclId.NotFound'],
};
const alibaba = {
  ecs: ['ecs','DescribeInstances','Instances','Instance','InstanceId','InstanceIds'],
  disk: ['ecs','DescribeDisks','Disks','Disk','DiskId','DiskIds'],
  eip: ['vpc','DescribeEipAddresses','EipAddresses','EipAddress','AllocationId','AllocationId'],
  nat_gateway: ['vpc','DescribeNatGateways','NatGateways','NatGateway','NatGatewayId','NatGatewayId'],
  eni: ['ecs','DescribeNetworkInterfaces','NetworkInterfaceSets','NetworkInterfaceSet','NetworkInterfaceId','NetworkInterfaceId'],
  vpc: ['vpc','DescribeVpcs','Vpcs','Vpc','VpcId','VpcId'],
  vswitch: ['vpc','DescribeVSwitches','VSwitches','VSwitch','VSwitchId','VSwitchId'],
  security_group: ['ecs','DescribeSecurityGroups','SecurityGroups','SecurityGroup','SecurityGroupId','SecurityGroupIds'],
  network_acl: ['vpc','DescribeNetworkAcls','NetworkAcls','NetworkAcl','NetworkAclId','NetworkAclId'],
} as const;

@Injectable()
export class ResourcePatrolCloudClient {
  async verifyAccount(account: SystemCloudAccountContext) {
    const payload = account.provider === 'tencent_cloud'
      ? await requestTencentCloud<Record<string, unknown>>({ service: 'sts', version: '2018-08-13', action: 'GetCallerIdentity',
        regionId: account.defaultRegion, accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret })
      : await this.rpc(account, 'sts', 'GetCallerIdentity', {});
    if (typeof payload.AccountId !== 'string' && typeof payload.AccountId !== 'number'
      || String(payload.AccountId) !== account.accountUid) throw new Error('CLOUD_ACCOUNT_IDENTITY_MISMATCH');
  }

  async inspect(account: SystemCloudAccountContext, known: ResourceIdentity[], candidateIds: ResourceIdentity[] = []): Promise<PatrolCloudResource[]> {
    const inventory = new Map<string, PatrolCloudResource>();
    const remember = (rows: PatrolCloudResource[]) => rows.forEach(row => inventory.set(`${row.type}:${row.id}`, row));
    for (const type of coreTypes) {
      // ACLs do not have a documented portable tag filter: only read proven IDs or parents.
      if (type !== 'network_acl') remember(await this.list(account, type));
      remember(await this.list(account, type, [...known,...candidateIds].filter(resource => resource.type === type).map(resource => resource.id)));
    }
    const parents = [...inventory.values()].filter(resource => resource.type === 'nat_gateway');
    for (const parent of parents) {
      // Related rules are inspected only below a NAT with durable inventory, never below a tagged candidate.
      if (!known.some(resource => resource.type === parent.type && resource.id === parent.id)) continue;
      remember(await this.natRules(account, parent));
    }
    // An owned VPC may contain foreign/untagged dependants. Observe these as candidates,
    // so a whole-range cleanup cannot remove a network that another instance uses.
    for (const parent of known.filter(resource => resource.type === 'vpc')) {
      for (const type of ['ecs','vswitch','eni','nat_gateway'] as PatrolResourceType[]) {
        if (account.provider === 'tencent_cloud') remember((await describeTencentResourceInventory(account,
          (type === 'nat_gateway' ? 'nat' : type) as TencentResourceKind, { vpcId: parent.id })).map(row => this.tencent(type, row)));
        else remember(await this.aliList(account, type, { VpcId: parent.id }));
      }
      if (account.provider === 'alibaba_cloud') remember(await this.aliList(account, 'security_group', { VpcId: parent.id }));
    }
    if (account.provider === 'tencent_cloud') {
      for (const parent of known.filter(resource => resource.type === 'vpc')) {
        remember((await describeTencentResourceInventory(account, 'network_acl', { vpcId: parent.id })).map(row => this.tencent('network_acl', row)));
      }
      for (const resource of [...known,...candidateIds].filter(resource => resource.type === 'route_table')) {
        const payload = await requestTencentCloud<Record<string,unknown>>({ service:'vpc',version:'2017-03-12',action:'DescribeRouteTables',
          regionId:account.defaultRegion,accessKeyId:account.accessKeyId,accessKeySecret:account.accessKeySecret,
          parameters:{RouteTableIds:[resource.id],Offset:'0',Limit:'100'} });
        if (!Array.isArray(payload.RouteTableSet) || payload.TotalCount !== payload.RouteTableSet.length || !payload.RequestId
          || payload.RouteTableSet.length > 1) throw new Error('INCOMPLETE_ROUTE_TABLE_LOOKUP');
        for (const row of payload.RouteTableSet as Record<string,unknown>[]) {
          if (row.RouteTableId !== resource.id || typeof row.VpcId !== 'string') throw new Error('UNREQUESTED_ROUTE_TABLE');
          remember([{ type:'route_table',id:resource.id,parentId:row.VpcId,tags:{},attachedInstanceId:null,systemDisk:false,raw:row }]);
        }
      }
    } else {
      for (const parent of known.filter(resource => resource.type === 'vpc')) {
        remember(await this.aliList(account, 'network_acl', { VpcId: parent.id }));
      }
      for (const resource of [...known,...candidateIds].filter(resource => resource.type === 'route_table')) {
        const rows = await this.pages(account, 'vpc', 'DescribeRouteTableList', { RouteTableId: resource.id }, ['RouterTableList','RouterTableListType']);
        for (const row of rows) {
          if (row.RouteTableId !== resource.id) throw new Error('UNREQUESTED_ROUTE_TABLE');
          remember([{ type: 'route_table', id: resource.id, tags: {}, parentId: typeof row.VpcId === 'string' ? row.VpcId : null,
            attachedInstanceId: null, systemDisk: false, raw: row }]);
        }
      }
    }
    return [...inventory.values()];
  }

  private async list(account: SystemCloudAccountContext, type: PatrolResourceType, ids?: string[]) {
    if (ids && !ids.length) return [];
    if (account.provider === 'tencent_cloud') {
      const kind = (type === 'nat_gateway' ? 'nat' : type) as TencentResourceKind;
      const rows = ids ? await describeTencentResourceInventory(account,kind,{ids})
        : [...await describeTencentResourceInventory(account,kind,{tags:{CreatedBy:'cyber-range-platform'}}),
          ...await describeTencentResourceInventory(account,kind,{tags:{PlatformManaged:'true'}})];
      return rows.filter(row => ids || type !== 'disk' || row.diskUsage === 'SYSTEM_DISK').map(row => this.tencent(type, row));
    }
    if (!ids) return [...await this.aliList(account,type,{'Tag.1.Key':'CreatedBy','Tag.1.Value':'cyber-range-platform'}),
      ...await this.aliList(account,type,{'Tag.1.Key':'PlatformManaged','Tag.1.Value':'true'})];
    const config = alibaba[type as keyof typeof alibaba];
    const rows: PatrolCloudResource[] = [];
    // Exact single IDs avoid ambiguous multi-ID not-found responses and per-API batch limits.
    for (const id of [...new Set(ids)]) {
      const pluralJson = ['ecs','disk','security_group'].includes(type);
      const parameters = { [config[5]]: pluralJson ? JSON.stringify([id]) : id };
      let found: PatrolCloudResource[];
      try { found = await this.aliList(account, type, parameters, true); }
      catch (error) {
        // An exact persisted ID and a typed, request-identified not-found response are both required.
        if (error instanceof CloudPatrolReadError && error.status === 404 && error.requestId
          && missingCodes[type]?.includes(error.code)) found = [];
        else throw error;
      }
      if (found.some(row => row.id !== id)) throw new Error('UNREQUESTED_RESOURCE_ID');
      rows.push(...found);
    }
    return rows;
  }

  private tencent(type: PatrolResourceType, row: any): PatrolCloudResource {
    return { type, id: row.id, tags: row.tags, parentId: row.vpcId, attachedInstanceId: row.instanceId,
      systemDisk: row.diskUsage === 'SYSTEM_DISK', raw: row };
  }

  private async aliList(account: SystemCloudAccountContext, type: PatrolResourceType, parameters: Record<string, string>, exactIds = false) {
    const [service, action, container, setKey, idKey] = alibaba[type as keyof typeof alibaba];
    const rows = await this.pages(account, service, action, parameters, [container, setKey]);
    return rows.filter(row => exactIds || type !== 'disk' || row.Type === 'system').map((row): PatrolCloudResource => {
      if (typeof row[idKey] !== 'string' || !String(row[idKey]).trim()) throw new Error('MALFORMED_RESOURCE_ID');
      const rawTags = (row.Tags as any)?.Tag ?? (row.Tags as any)?.TagSet ?? [];
      if (!Array.isArray(rawTags)) throw new Error('MALFORMED_RESOURCE_TAGS');
      const tags: Record<string,string> = {};
      for (const tag of rawTags) {
        const key = tag.TagKey ?? tag.Key, value = tag.TagValue ?? tag.Value;
        if (typeof key !== 'string' || typeof value !== 'string' || key in tags) throw new Error('MALFORMED_RESOURCE_TAGS');
        tags[key] = value;
      }
      const attachment = row.Attachment as Record<string,unknown> | undefined;
      return { type, id: String(row[idKey]), tags, parentId: typeof row.VpcId === 'string' ? row.VpcId : null,
        attachedInstanceId: typeof row.InstanceId === 'string' ? row.InstanceId : typeof attachment?.InstanceId === 'string' ? attachment.InstanceId : null,
        systemDisk: type === 'disk' && row.Type === 'system', raw: row };
    });
  }

  private async natRules(account: SystemCloudAccountContext, parent: PatrolCloudResource): Promise<PatrolCloudResource[]> {
    const result: PatrolCloudResource[] = [];
    if (account.provider === 'tencent_cloud') {
      for (const [type, action, setKey] of [
        ['dnat_entry','DescribeNatGatewayDestinationIpPortTranslationNatRules','NatGatewayDestinationIpPortTranslationNatRuleSet'],
        ['snat_entry','DescribeNatGatewaySourceIpTranslationNatRules','SourceIpTranslationNatRuleSet'],
      ] as const) {
        let total: number | null = null;
        const seen = new Set<string>();
        for (let offset = 0; offset < 10000; offset += 100) {
          const payload = await requestTencentCloud<Record<string,unknown>>({ service: 'vpc', version: '2017-03-12', action,
            regionId: account.defaultRegion, accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret,
            parameters: { ...(type === 'snat_entry' ? { NatGatewayId: parent.id } : { NatGatewayIds: [parent.id] }), Offset: offset, Limit: 100 } });
          if (!Array.isArray(payload[setKey]) || !Number.isSafeInteger(payload.TotalCount) || !payload.RequestId
            || total !== null && payload.TotalCount !== total) throw new Error('INCOMPLETE_RULE_PAGINATION');
          total = Number(payload.TotalCount);
          for (const row of payload[setKey] as Record<string,unknown>[]) {
            if (row.NatGatewayId !== parent.id || row.VpcId !== parent.parentId) throw new Error('UNREQUESTED_RULE_PARENT');
            const id = type === 'snat_entry' ? `${parent.id}#${row.ResourceId}`
              : `${String(row.IpProtocol).toUpperCase()}://${row.VpcId}:${parent.id}@${row.PublicIpAddress}:${row.PublicPort}`;
            if (seen.has(id)) throw new Error('DUPLICATED_RULE');
            seen.add(id); result.push({ type, id, tags: {}, parentId: parent.id, attachedInstanceId: null, systemDisk: false, raw: row });
          }
          if (seen.size === total) break;
          if (seen.size > total || !(payload[setKey] as unknown[]).length || offset >= 9900) throw new Error('INCOMPLETE_RULE_PAGINATION');
        }
      }
      return result;
    }
    for (const [type, tableContainer, tableSet, tableParameter, action, entriesContainer, entriesSet, idKey] of [
      ['snat_entry','SnatTableIds','SnatTableId','SnatTableId','DescribeSnatTableEntries','SnatTableEntries','SnatTableEntry','SnatEntryId'],
      ['dnat_entry','ForwardTableIds','ForwardTableId','ForwardTableId','DescribeForwardTableEntries','ForwardTableEntries','ForwardTableEntry','ForwardEntryId'],
    ] as const) {
      const tables = (parent.raw[tableContainer] as any)?.[tableSet];
      if (!Array.isArray(tables) || tables.some(table => typeof table !== 'string')) throw new Error('MALFORMED_NAT_TABLES');
      for (const table of tables) for (const row of await this.pages(account, 'vpc', action, { [tableParameter]: table }, [entriesContainer, entriesSet])) {
        if (typeof row[idKey] !== 'string') throw new Error('MALFORMED_RULE_ID');
        result.push({ type, id: `${table}:${row[idKey]}`, tags: {}, parentId: parent.id, attachedInstanceId: null, systemDisk: false, raw: row });
      }
    }
    return result;
  }

  private async pages(account: SystemCloudAccountContext, service: string, action: string, parameters: Record<string,string>, path: string[]) {
    const rows: Record<string,unknown>[] = [], seen = new Set<string>();
    let total: number | null = null;
    for (let page = 1; page <= 100; page++) {
      const payload = await this.rpc(account, service, action, { ...parameters, PageNumber: String(page), PageSize: '100' });
      let set: any = payload;
      for (const key of path) set = set?.[key];
      if (!Array.isArray(set) || !Number.isSafeInteger(payload.TotalCount) || Number(payload.TotalCount) < 0
        || payload.NextToken || !payload.RequestId || total !== null && payload.TotalCount !== total) throw new Error('INCOMPLETE_RESOURCE_PAGINATION');
      total = Number(payload.TotalCount);
      for (const row of set) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('MALFORMED_RESOURCE');
        const fingerprint = JSON.stringify(row);
        if (seen.has(fingerprint)) throw new Error('REPEATED_RESOURCE_PAGE');
        seen.add(fingerprint); rows.push(row);
      }
      if (rows.length === total) return rows;
      if (rows.length > total || !set.length) throw new Error('INCOMPLETE_RESOURCE_PAGINATION');
    }
    throw new Error('RESOURCE_PAGINATION_LIMIT');
  }

  private async rpc(account: SystemCloudAccountContext, service: string, action: string, parameters: Record<string,string>) {
    if (account.provider !== 'alibaba_cloud') throw new Error('CLOUD_PROVIDER_MISMATCH');
    const query = signAliyunRpcQuery({ Action: action, AccessKeyId: account.accessKeyId, Format: 'JSON',
      RegionId: account.defaultRegion, SignatureMethod: 'HMAC-SHA1', SignatureNonce: randomUUID(), SignatureVersion: '1.0',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: service === 'sts' ? '2015-04-01' : service === 'ecs' ? '2014-05-26' : '2016-04-28', ...parameters }, account.accessKeySecret);
    const response = await fetch(`https://${service === 'sts' ? 'sts.aliyuncs.com' : `${service}.${account.defaultRegion}.aliyuncs.com`}/?${query}`,
      { signal: AbortSignal.timeout(30_000) });
    const payload = await response.json() as Record<string,unknown>;
    if (!response.ok || payload.Code || !payload.RequestId) throw new CloudPatrolReadError(action,response.status,
      typeof payload.Code === 'string' ? payload.Code : 'UNKNOWN', typeof payload.RequestId === 'string' ? payload.RequestId : null);
    return payload;
  }
}
