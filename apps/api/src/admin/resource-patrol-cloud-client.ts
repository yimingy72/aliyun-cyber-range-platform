import { Injectable, Logger, Optional } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SystemCloudAccountContext } from './system-config.service';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { requestTencentCloud } from './tencent-cloud-client';
import { describeTencentResourceInventory, type TencentResourceKind } from './tencent-cloud-resources';
import type { PatrolResourceType, ResourceIdentity } from './resource-alert-types';
import { AliyunVpcReadPacingService, VpcReadBudgetTimeout, vpcReadGap } from './aliyun-vpc-read-pacing.service';

export type PatrolCloudResource = ResourceIdentity & { tags: Record<string, string>; parentId: string | null; attachedInstanceId: string | null; isPrimary?: boolean;
  systemDisk: boolean; raw: Record<string, unknown> };
const coreTypes: PatrolResourceType[] = ['ecs','disk','eip','nat_gateway','eni','vpc','vswitch','security_group','network_acl'];
function validRequestId(value: unknown,account: SystemCloudAccountContext): value is string {
  return typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value)
    && ![account.accessKeyId,account.accessKeySecret].some(secret => secret && value.includes(secret));
}
export class CloudPatrolReadError extends Error {
  constructor(readonly action: string, readonly status: number, readonly code: string, readonly requestId: string | null,
    readonly pagination?: { page:number; totalCount:number|null; rowCount:number|null; hasNextToken:boolean }, readonly attempts?: number) {
    super(`CLOUD_READ_FAILED:${action}:${status}:${code}`);
  }
}
const missingCodes: Partial<Record<PatrolResourceType,string[]>> = {
  vpc: ['InvalidVpcID.NotFound','InvalidVpcId.NotFound'], vswitch: ['InvalidVSwitchId.NotFound'],
  eni: ['InvalidNetworkInterfaceId.NotFound','InvalidEniId.NotFound'], security_group: ['InvalidSecurityGroupId.NotFound'],
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
  private readonly logger = new Logger(ResourcePatrolCloudClient.name);
  private readonly nextVpcReadAt = new Map<string,number>();
  private readonly trace = new AsyncLocalStorage<{ calls: Record<string,number>; aclExact: number; aclByVpc: number; retries: number }>();
  constructor(@Optional() private readonly pacing?: AliyunVpcReadPacingService) {}
  async findAliyunDefaultNetworkCandidates(account: SystemCloudAccountContext, input: { regionId: string; zoneId: string }) {
    if (account.provider !== 'alibaba_cloud' || account.defaultRegion !== input.regionId || account.defaultZoneId !== input.zoneId)
      throw new Error('Alibaba default network lookup requires its frozen region and zone');
    await this.verifyAccount(account);
    const tag = { 'Tag.1.Key': 'PlatformNetworkProfileKey', 'Tag.1.Value': `${input.regionId}:${input.zoneId}` };
    const rows = [
      ...await this.aliList(account,'vpc',{...tag,IsDefault:'false'}),
      ...await this.aliList(account,'vswitch',tag),
      ...await this.aliList(account,'security_group',tag),
    ];
    return [...new Map(rows.map(row => [`${row.type}:${row.id}`,row])).values()];
  }
  async mutate(account: SystemCloudAccountContext,service: 'ecs'|'cvm'|'vpc',action: string,parameters: Record<string,unknown>) {
    const allowed=new Set(['DeleteInstances','TerminateInstances','DetachNetworkInterface','DeleteNetworkInterface','UnassociateEipAddress',
      'ReleaseEipAddress','DisassociateAddress','ReleaseAddresses','DeleteNatGateway','DeleteSecurityGroup','DeleteNetworkAcl',
      'UnassociateNetworkAcl','DisassociateNetworkAclSubnets','DeleteVSwitch','DeleteSubnet','DeleteVpc','DeleteRouteTable',
      'DeleteSnatEntry','DeleteForwardEntry','DeleteNatGatewaySourceIpTranslationNatRule','DeleteNatGatewayDestinationIpPortTranslationNatRule']);
    if (!allowed.has(action)) throw new Error('UNSUPPORTED_RECLAIM_ACTION');
    const result=account.provider==='tencent_cloud'
      ? await requestTencentCloud<Record<string,unknown>>({service,version:'2017-03-12',action,regionId:account.defaultRegion,
        accessKeyId:account.accessKeyId,accessKeySecret:account.accessKeySecret,parameters})
      : await this.rpc(account,service,action,Object.fromEntries(Object.entries(parameters).map(([key,value])=>[key,String(value)])));
    if (!validRequestId(result.RequestId,account)) throw new Error('UNKNOWN_RECLAIM_RESPONSE');
    return {requestId:result.RequestId};
  }

  async exact(account: SystemCloudAccountContext,resources: ResourceIdentity[],parents: ResourceIdentity[]=[]): Promise<PatrolCloudResource[]> {
    const result: PatrolCloudResource[]=[];
    for (const type of coreTypes) result.push(...await this.list(account,type,resources.filter(row=>row.type===type).map(row=>row.id)));
    const rules=resources.filter(row=>['snat_entry','dnat_entry'].includes(row.type));
    if (rules.length) for (const parent of await this.list(account,'nat_gateway',parents.filter(row=>row.type==='nat_gateway').map(row=>row.id))) {
      result.push(...(await this.natRules(account,parent)).filter(row=>rules.some(rule=>rule.type===row.type&&rule.id===row.id)));
    }
    const routes=resources.filter(row=>row.type==='route_table');
    if (routes.length) result.push(...(await this.inspect(account,routes)).filter(row=>row.type==='route_table'));
    return result;
  }

  async attachedDisks(account: SystemCloudAccountContext,instanceId: string) {
    if (account.provider==='tencent_cloud') return (await describeTencentResourceInventory(account,'disk',{instanceId})).map(row=>this.tencent('disk',row));
    return this.aliList(account,'disk',{InstanceId:instanceId},true);
  }
  async attachedInterfaces(account:SystemCloudAccountContext,instanceId:string) {
    const rows=account.provider==='tencent_cloud'
      ? (await describeTencentResourceInventory(account,'eni',{instanceId})).map(row=>this.tencent('eni',row))
      : await this.aliList(account,'eni',{InstanceId:instanceId});
    if(rows.some(row=>row.attachedInstanceId!==instanceId)) throw new Error('UNREQUESTED_INTERFACE_ATTACHMENT');
    return rows;
  }
  async verifyAccount(account: SystemCloudAccountContext) {
    const payload = account.provider === 'tencent_cloud'
      ? await requestTencentCloud<Record<string, unknown>>({ service: 'sts', version: '2018-08-13', action: 'GetCallerIdentity',
        regionId: account.defaultRegion, accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret })
      : await this.rpc(account, 'sts', 'GetCallerIdentity', {});
    if (typeof payload.AccountId !== 'string' && typeof payload.AccountId !== 'number'
      || String(payload.AccountId) !== account.accountUid) throw new Error('CLOUD_ACCOUNT_IDENTITY_MISMATCH');
  }

  async inspect(account: SystemCloudAccountContext, known: ResourceIdentity[], candidateIds: ResourceIdentity[] = []): Promise<PatrolCloudResource[]> {
    const stats = { calls: {} as Record<string,number>, aclExact: 0, aclByVpc: 0, retries: 0 }, began = Date.now();
    return this.trace.run(stats, async () => {
      try { return await this.inspectInventory(account, known, candidateIds); }
      finally { this.logger.log(JSON.stringify({ event: 'patrol_read_summary', accountUid: account.accountUid, region: account.defaultRegion,
        knownAcls: new Set(known.filter(row=>row.type==='network_acl').map(row=>row.id)).size,
        knownVpcReferences: known.filter(row=>row.type==='vpc').length, uniqueVpcs: new Set(known.filter(row=>row.type==='vpc').map(row=>row.id)).size,
        ...stats, elapsedMs: Date.now()-began })); }
    });
  }

  private async inspectInventory(account: SystemCloudAccountContext, known: ResourceIdentity[], candidateIds: ResourceIdentity[]): Promise<PatrolCloudResource[]> {
    const inventory = new Map<string, PatrolCloudResource>();
    const presentKnownVpcs = new Set<string>();
    const remember = (rows: PatrolCloudResource[]) => rows.forEach(row => inventory.set(`${row.type}:${row.id}`, row));
    for (const type of coreTypes) {
      if (type === 'network_acl' && account.provider === 'alibaba_cloud') continue;
      // ACLs do not have a documented portable tag filter: only read proven IDs or parents.
      if (type !== 'network_acl') remember(await this.list(account, type));
      const exact = await this.list(account, type, [...known,...candidateIds].filter(resource => resource.type === type).map(resource => resource.id));
      remember(exact);
      if (type === 'vpc') {
        exact.forEach(resource => presentKnownVpcs.add(resource.id));
        if (known.some(resource => resource.type === 'vpc' && inventory.has(`vpc:${resource.id}`) && !presentKnownVpcs.has(resource.id))) {
          throw new Error('INCONSISTENT_PARENT_RESOURCE_LOOKUP');
        }
      }
    }
    const parents = [...inventory.values()].filter(resource => resource.type === 'nat_gateway');
    for (const parent of parents) {
      // Related rules are inspected only below a NAT with durable inventory, never below a tagged candidate.
      if (!known.some(resource => resource.type === parent.type && resource.id === parent.id)) continue;
      remember(await this.natRules(account, parent));
    }
    // An owned VPC may contain foreign/untagged dependants. Observe these as candidates,
    // so a whole-range cleanup cannot remove a network that another instance uses.
    const presentParents = [...new Map(known.filter(resource => resource.type === 'vpc' && presentKnownVpcs.has(resource.id)).map(row=>[row.id,row])).values()];
    for (const parent of presentParents) {
      for (const type of ['ecs','vswitch','eni','nat_gateway'] as PatrolResourceType[]) {
        if (account.provider === 'tencent_cloud') remember((await describeTencentResourceInventory(account,
          (type === 'nat_gateway' ? 'nat' : type) as TencentResourceKind, { vpcId: parent.id })).map(row => this.tencent(type, row)));
        else remember(await this.aliList(account, type, { VpcId: parent.id }));
      }
      if (account.provider === 'alibaba_cloud') remember(await this.aliList(account, 'security_group', { VpcId: parent.id }));
    }
    if (account.provider === 'tencent_cloud') {
      for (const parent of presentParents) {
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
      for (const parent of presentParents) {
        remember(await this.aliList(account, 'network_acl', { VpcId: parent.id }));
      }
      // Complete parent inventories already identify present ACLs. Missing entries still need
      // their exact-ID reads; an empty parent query must never prove a resource was deleted.
      remember(await this.list(account, 'network_acl', [...known,...candidateIds]
        .filter(row=>row.type==='network_acl'&&!inventory.has(`network_acl:${row.id}`)).map(row=>row.id)));
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
      const parameters = { [type==='eni'?'NetworkInterfaceId.1':config[5]]: pluralJson ? JSON.stringify([id]) : id };
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
      isPrimary:row.primary===true,systemDisk: row.diskUsage === 'SYSTEM_DISK', raw: row };
  }

  private async aliList(account: SystemCloudAccountContext, type: PatrolResourceType, parameters: Record<string, string>, exactIds = false) {
    const [service, action, container, setKey, idKey] = alibaba[type as keyof typeof alibaba];
    const rows = ['ecs','disk','eni','security_group'].includes(type)
      ? await this.tokenPages(account,action,parameters,[container,setKey],idKey)
      : await this.pages(account, service, action, parameters, [container, setKey]);
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
      return { type, id: String(row[idKey]), tags, parentId: typeof row.VpcId === 'string' ? row.VpcId
        : typeof (row.VpcAttributes as any)?.VpcId==='string'?(row.VpcAttributes as any).VpcId:null,
        attachedInstanceId: typeof row.InstanceId === 'string' ? row.InstanceId : typeof attachment?.InstanceId === 'string' ? attachment.InstanceId : null,
        isPrimary:type==='eni'&&row.Type==='Primary',systemDisk: type === 'disk' && row.Type === 'system', raw: row };
    });
  }

  private async tokenPages(account: SystemCloudAccountContext,action: string,parameters: Record<string,string>,path: readonly string[],idKey: string) {
    const result: Record<string,unknown>[]=[],seenIds=new Set<string>(),seenTokens=new Set<string>();
    const eni = action==='DescribeNetworkInterfaces';
    const incompleteCode = eni?'INCOMPLETE_ENI_PAGINATION':'INCOMPLETE_RESOURCE_PAGINATION';
    let token: string|undefined;
    for(let page=0;page<100;page++) {
      const body=await this.rpc(account,'ecs',action,{...parameters,MaxResults:'100',...(token?{NextToken:token}:{})});
      let rows:any=body;
      for(const key of path) rows=rows?.[key];
      const invalidPage = (code: string) => new CloudPatrolReadError(action,200,code,
        validRequestId(body.RequestId,account)?body.RequestId:null,
        {page:page+1,totalCount:Number.isSafeInteger(body.TotalCount)?Number(body.TotalCount):null,
          rowCount:Array.isArray(rows)?rows.length:null,hasNextToken:!!body.NextToken});
      if(!Array.isArray(rows)||rows.length>100) throw invalidPage(incompleteCode);
      for(const row of rows) {
        if(!row||typeof row[idKey]!=='string'||!row[idKey].trim()||seenIds.has(row[idKey]))
          throw invalidPage(eni?'DUPLICATED_OR_MALFORMED_ENI':'REPEATED_RESOURCE_PAGE');
        seenIds.add(row[idKey]);result.push(row);
      }
      // Alibaba documents TotalCount as meaningless with MaxResults/NextToken; only the cursor ends this read.
      if(body.NextToken===undefined||body.NextToken===null||body.NextToken==='') {
        return result;
      }
      if(typeof body.NextToken!=='string'||!rows.length||seenTokens.has(body.NextToken)) throw invalidPage(incompleteCode);
      token=body.NextToken;seenTokens.add(token);
    }
    throw new Error(eni?'ENI_PAGINATION_LIMIT':'RESOURCE_PAGINATION_LIMIT');
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
      const payload = await this.rpc(account, service, action, { ...parameters, PageNumber: String(page), PageSize: '50' });
      let set: any = payload;
      for (const key of path) set = set?.[key];
      const count=typeof payload.TotalCount==='number' || typeof payload.TotalCount==='string' && /^\d+$/.test(payload.TotalCount)
        ? Number(payload.TotalCount) : NaN;
      const invalidPage = (code: string) => new CloudPatrolReadError(action,200,code,
        validRequestId(payload.RequestId,account) ? payload.RequestId : null,
        { page,totalCount:Number.isSafeInteger(count)?count:null,rowCount:Array.isArray(set)?set.length:null,hasNextToken:!!payload.NextToken });
      if (!Array.isArray(set) || set.length>50 || !Number.isSafeInteger(count) || count < 0
        || payload.NextToken || total !== null && count !== total) throw invalidPage('INCOMPLETE_RESOURCE_PAGINATION');
      total = count;
      for (const row of set) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalidPage('MALFORMED_RESOURCE');
        const fingerprint = JSON.stringify(row);
        if (seen.has(fingerprint)) throw invalidPage('REPEATED_RESOURCE_PAGE');
        seen.add(fingerprint); rows.push(row);
      }
      if (rows.length === total) return rows;
      if (rows.length > total || !set.length) throw invalidPage('INCOMPLETE_RESOURCE_PAGINATION');
    }
    throw new Error('RESOURCE_PAGINATION_LIMIT');
  }

  private async rpc(account: SystemCloudAccountContext, service: string, action: string, parameters: Record<string,string>) {
    if (account.provider !== 'alibaba_cloud') throw new Error('CLOUD_PROVIDER_MISMATCH');
    const readOnly = action.startsWith('Describe') || action === 'GetCallerIdentity';
    const deadline = Date.now()+120_000;
    let lastThrottle: CloudPatrolReadError | null = null;
    for (let attempt=0;;attempt++) {
      if (readOnly && service==='vpc') {
        const key=String(account.accountUid);
        if (this.pacing) {
          try { await this.pacing.wait(key,action,deadline); }
          catch(error) { if(error instanceof VpcReadBudgetTimeout)throw lastThrottle??new CloudPatrolReadError(action,429,'PLATFORM_READ_PACING_TIMEOUT',null,undefined,attempt); throw error; }
        } else {
          if(process.env.NODE_ENV==='production')throw new Error('VPC_READ_PACING_NOT_CONFIGURED');
          const now=Date.now(),actionKey=`${key}:${action}`;
          const startAt=Math.max(now,this.nextVpcReadAt.get(key)??0,this.nextVpcReadAt.get(actionKey)??0);
          this.nextVpcReadAt.set(key,startAt+1000);this.nextVpcReadAt.set(actionKey,startAt+vpcReadGap(action));
          if(startAt>now)await sleep(startAt-now);
        }
      }
      const query = signAliyunRpcQuery({ Action: action, AccessKeyId: account.accessKeyId, Format: 'JSON',
        RegionId: account.defaultRegion, SignatureMethod: 'HMAC-SHA1', SignatureNonce: randomUUID(), SignatureVersion: '1.0',
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        Version: service === 'sts' ? '2015-04-01' : service === 'ecs' ? '2014-05-26' : '2016-04-28', ...parameters }, account.accessKeySecret);
      const remaining = deadline-Date.now();
      if(remaining<=0)throw lastThrottle??new CloudPatrolReadError(action,429,'PLATFORM_READ_PACING_TIMEOUT',null,undefined,attempt);
      const stats=this.trace.getStore();
      if(stats){stats.calls[action]=(stats.calls[action]??0)+1;if(action==='DescribeNetworkAcls'){if(parameters.NetworkAclId)stats.aclExact++;else if(parameters.VpcId)stats.aclByVpc++;}}
      const response = await fetch(`https://${service === 'sts' ? 'sts.aliyuncs.com' : `${service}.${account.defaultRegion}.aliyuncs.com`}/?${query}`,
        { signal: AbortSignal.timeout(Math.min(30_000,remaining)) });
      const payload = await response.json() as Record<string,unknown>;
      if (!response.ok || payload.Code || !validRequestId(payload.RequestId,account)) {
        const error = new CloudPatrolReadError(action,response.status,
          typeof payload.Code === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(payload.Code)
            && ![account.accessKeyId,account.accessKeySecret].some(secret => secret && String(payload.Code).includes(secret))
            ? payload.Code : 'UNKNOWN', validRequestId(payload.RequestId,account) ? payload.RequestId : null, undefined, attempt+1);
        // A cloud-identified throttled read is safe to retry; writes and uncertain responses are not.
        if (readOnly && error.requestId && /^Throttling(?:\.|$)/.test(error.code)) {
          lastThrottle=error;
          const after=response.headers?.get('retry-after');
          const afterMs=after&&/^\d+$/.test(after)?Number(after)*1000:after?Date.parse(after)-Date.now():0;
          const delay=Math.ceil(Math.max(Math.min(30_000,5000*2**attempt)+Math.random()*1000,Number.isFinite(afterMs)?Math.max(0,Math.min(86_400_000,afterMs)):0));
          if(service==='vpc') {
            if(this.pacing)await this.pacing.cooldown(String(account.accountUid),delay);
            else this.nextVpcReadAt.set(String(account.accountUid),Math.max(this.nextVpcReadAt.get(String(account.accountUid))??0,Date.now()+delay));
          }
          this.logger.warn(JSON.stringify({event:'patrol_read_throttled',accountUid:account.accountUid,region:account.defaultRegion,action,
            code:error.code,requestId:error.requestId,attempt:attempt+1,cooldownMs:delay,scope:this.trace.getStore()?'inventory':'exact_or_network_lookup'}));
          if(attempt<5&&delay<deadline-Date.now()){if(stats)stats.retries++;await sleep(delay);continue;}
        }
        throw error;
      }
      return payload;
    }
  }
}
