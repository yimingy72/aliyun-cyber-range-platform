import { isIP } from 'node:net';
import type { RangeInstanceRecord } from './admin.repository';
import type { AttachedDiskInventory } from './instance-disk-inventory';
import type { NormalizedInstanceDetail } from './single-instance-batch-execution.service';
import type { SystemCloudAccountContext } from './system-config.service';
import { requestTencentCloud, TencentCloudRequestError } from './tencent-cloud-client';

export type TencentResourceKind = 'ecs' | 'disk' | 'snapshot' | 'vpc' | 'vswitch' | 'security_group' | 'network_acl' | 'eni' | 'nat' | 'eip';
export type TencentResourceEvidence = { provider: 'tencent_cloud'; accountUid: string; cloudAccountContextId: string;
  regionId: string; action: string; requestIds: string[]; observedAt: string; errorCode?: 'ResourceNotFound' };
export type TencentResource = { id: string; kind: TencentResourceKind; tags: Record<string, string>; evidence: TencentResourceEvidence;
  instanceId: string | null; vpcId: string | null; diskUsage: string | null; deleteWithInstance: boolean | null;
  name?: string; state?: string; publicIp?: string; publicIpAddresses?: string[]; instanceType?: string; imageId?: string; zoneId?: string; subnetId?: string; natProductVersion?: number; bandwidth?: number; maxConcurrent?: number;
  shared: boolean; chargeType: string | null; createdAt?: string; detail?: NormalizedInstanceDetail;
  primary?: boolean; networkInterfaceId?: string; relatedEipIds?: string[]; relatedSubnetIds?: string[] };
type Query = { ids?: string[]; tags?: Record<string, string>; vpcId?: string; instanceId?: string; diskIds?: string[];
  onEvidence?: (evidence: TencentResourceEvidence) => void };
const TAG_KEYS = new Set(['CloudProvider', 'PlatformManaged', 'CreatedBy', 'PlatformScope', 'PlatformUserId', 'RangeInstanceId',
  'SingleInstanceBatchId', 'PlatformResourceType', 'PlatformHostKey', 'CloudAccountUid', 'CloudAccountContextId',
  'ExecutionBackend', 'PlatformCreateJobId', 'CreationIntentId', 'PlatformPackedImageArtifactId', 'PlatformImageImportJobId']);
const RESOURCES = {
  ecs: ['cvm', 'DescribeInstances', 'InstanceSet', 'InstanceId', 'InstanceIds', 'ins'],
  disk: ['cbs', 'DescribeDisks', 'DiskSet', 'DiskId', 'DiskIds', 'disk'],
  snapshot: ['cbs', 'DescribeSnapshots', 'SnapshotSet', 'SnapshotId', 'SnapshotIds', 'snap'],
  vpc: ['vpc', 'DescribeVpcs', 'VpcSet', 'VpcId', 'VpcIds', 'vpc'],
  vswitch: ['vpc', 'DescribeSubnets', 'SubnetSet', 'SubnetId', 'SubnetIds', 'subnet'],
  security_group: ['vpc', 'DescribeSecurityGroups', 'SecurityGroupSet', 'SecurityGroupId', 'SecurityGroupIds', 'sg'],
  network_acl: ['vpc', 'DescribeNetworkAcls', 'NetworkAclSet', 'NetworkAclId', 'NetworkAclIds', 'acl'],
  eni: ['vpc', 'DescribeNetworkInterfaces', 'NetworkInterfaceSet', 'NetworkInterfaceId', 'NetworkInterfaceIds', 'eni'],
  nat: ['vpc', 'DescribeNatGateways', 'NatGatewaySet', 'NatGatewayId', 'NatGatewayIds', 'nat'],
  eip: ['vpc', 'DescribeAddresses', 'AddressSet', 'AddressId', 'AddressIds', 'eip'],
} as const;
// These individual API contracts explicitly define literal ResourceNotFound as a missing resource.
const DOCUMENTED_NOT_FOUND_KINDS = new Set<TencentResourceKind>(['security_group', 'nat', 'network_acl']);

export function assertTencentAccount(account: SystemCloudAccountContext) {
  if (account.provider !== 'tencent_cloud' || !account.accountUidResolved || !account.accountUid
    || !account.cloudAccountContextId || !account.defaultRegion || !account.accessKeyId || !account.accessKeySecret) {
    throw new Error('Tencent cloud query requires a verified frozen provider, account UID and context');
  }
}
function string(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tencent response contains a malformed object');
  return value as Record<string, unknown>;
}
function tags(value: unknown) {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) throw new Error('Tencent resource tags are malformed');
  const result: Record<string, string> = {}, seen = new Set<string>();
  for (const raw of value) {
    const row = object(raw);
    if (typeof row.Key !== 'string' || !row.Key || typeof row.Value !== 'string' || seen.has(row.Key)) throw new Error('Tencent resource tags are malformed or duplicated');
    seen.add(row.Key);
    if (TAG_KEYS.has(row.Key)) result[row.Key] = row.Value;
  }
  return result;
}
function ip(value: unknown) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || isIP(v) !== 4)) throw new Error('Tencent instance IP addresses are malformed');
  return string(value[0]);
}

// All list APIs use Offset/Limit, including a lookup by known IDs; never treat a truncated result as absence.
export async function describeTencentResourceInventory(account: SystemCloudAccountContext, kind: TencentResourceKind, query: Query): Promise<TencentResource[]> {
  assertTencentAccount(account);
  const [service, action, setKey, idKey, idsKey, prefix] = RESOURCES[kind];
  if (query.ids) {
    if (query.tags || query.vpcId || query.instanceId || query.diskIds) throw new Error('Tencent known-ID lookup cannot be combined with filters');
    const unique = [...new Set(query.ids)];
    if (unique.some(id => !new RegExp(`^${prefix}-[A-Za-z0-9]+$`).test(id))) throw new Error('Tencent resource identity has an invalid provider prefix');
    if (!unique.length) return [];
    if (unique.length > 100) {
      const result: TencentResource[] = [];
      for (let start = 0; start < unique.length; start += 100) result.push(...await describeTencentResourceInventory(account, kind, { ids: unique.slice(start, start + 100), onEvidence: query.onEvidence }));
      return result;
    }
    query = { ids: unique, onEvidence: query.onEvidence };
  } else if (!query.vpcId && !query.instanceId && !query.diskIds?.length && !Object.keys(query.tags ?? {}).length) throw new Error('Tencent inventory requires a bounded identity or ownership filter');
  if (kind === 'snapshot' && query.tags) throw new Error('Tencent snapshot inventory requires known IDs or source disks; the documented API has no tag filter');
  if (query.diskIds && (kind !== 'snapshot' || !query.diskIds.length || query.diskIds.length > 10 || query.diskIds.some(id => !/^disk-[A-Za-z0-9]+$/.test(id)))) throw new Error('Tencent snapshot disk filter exceeds the documented scope');
  if (Object.keys(query.tags ?? {}).some(key => !TAG_KEYS.has(key))) throw new Error('Unsupported Tencent ownership tag filter');
  if (query.vpcId && (!/^vpc-[A-Za-z0-9]+$/.test(query.vpcId) || !['ecs', 'vswitch', 'eni', 'nat', 'network_acl'].includes(kind))) throw new Error('Unsupported Tencent VPC inventory filter');
  if (query.instanceId && (!['disk','eni'].includes(kind) || !/^ins-[A-Za-z0-9]+$/.test(query.instanceId))) throw new Error('Unsupported Tencent attachment inventory filter');
  if (kind === 'network_acl' && !query.ids && !query.vpcId) throw new Error('Tencent ACL inventory requires a known ID or VPC; the API has no tag filter');
  const filters: Array<{ Name: string; Values: string[] }> = [];
  if (query.vpcId) filters.push({ Name: 'vpc-id', Values: [query.vpcId] });
  if (query.diskIds) filters.push({ Name: 'disk-id', Values: query.diskIds });
  if (query.instanceId) filters.push({ Name: kind==='eni'?'attachment.instance-id':'instance-id', Values: [query.instanceId] });
  if (kind === 'nat') {
    const key = Object.keys(query.tags ?? {})[0];
    if (key) filters.push({ Name: 'tag-key', Values: [key] });
  } else if (kind !== 'network_acl') for (const [key, value] of Object.entries(query.tags ?? {})) filters.push({ Name: `tag:${key}`, Values: [value] });
  if (filters.length > 10) throw new Error('Tencent inventory filter count exceeds the documented limit');
  const resources: TencentResource[] = [], seen = new Set<string>(), requestIds: string[] = [];
  let total: number | undefined;
  for (let page = 0; page < 100; page++) {
    const stringPaging = ['vpc', 'vswitch', 'security_group'].includes(kind);
    let response: Record<string, unknown>;
    try { response = object(await requestTencentCloud({ service, version: '2017-03-12', action, regionId: account.defaultRegion,
      accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret,
      parameters: { ...(query.ids ? { [idsKey]: query.ids } : { Filters: filters }), Offset: stringPaging ? String(resources.length) : resources.length,
        Limit: stringPaging ? '100' : 100 } })); }
    catch (error) {
      // Only documented known-ID absence is accepted, never an empty tag/filter search.
      // A multi-ID error cannot prove that every requested resource is absent.
      if (!DOCUMENTED_NOT_FOUND_KINDS.has(kind) || !query.ids?.length || page !== 0 || resources.length
        || !(error instanceof TencentCloudRequestError) || error.code !== 'ResourceNotFound'
        || error.service && error.service !== service || error.action && error.action !== action
        || !error.requestId || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(error.requestId)) throw error;
      const proofs: TencentResourceEvidence[] = [{ provider: 'tencent_cloud', accountUid: account.accountUid!, cloudAccountContextId: account.cloudAccountContextId!,
        regionId: account.defaultRegion, action, requestIds: [error.requestId], observedAt: new Date().toISOString(), errorCode: 'ResourceNotFound' }];
      const found: TencentResource[] = [];
      if (query.ids.length > 1) {
        for (const id of query.ids) found.push(...await describeTencentResourceInventory(account, kind, { ids: [id], onEvidence: value => proofs.push(value) }));
      }
      for (const proof of proofs) query.onEvidence?.(proof);
      return found;
    }
    const rows = response[setKey];
    if (response.Error || response.NextToken || typeof response.RequestId !== 'string' || !response.RequestId.trim()
      || !Number.isSafeInteger(response.TotalCount) || Number(response.TotalCount) < 0 || !Array.isArray(rows) || rows.length > 100
      || total !== undefined && total !== response.TotalCount) throw new Error('Tencent inventory response is incomplete or changed during pagination');
    total = Number(response.TotalCount); requestIds.push(response.RequestId);
    for (const raw of rows) {
      const row = object(raw), id = string(row[idKey]);
      if (!id || !new RegExp(`^${prefix}-[A-Za-z0-9]+$`).test(id) || seen.has(id) || query.ids && !query.ids.includes(id)) throw new Error('Tencent inventory contains duplicate or unrequested resource identities');
      seen.add(id);
      const resourceTags = tags(row.Tags ?? row.TagSet);
      const attachment = row.Attachment ? object(row.Attachment) : {};
      const vpc = row.VirtualPrivateCloud ? object(row.VirtualPrivateCloud) : {};
      const vpcId = string(row.VpcId ?? vpc.VpcId);
      if (query.vpcId && query.vpcId !== vpcId) throw new Error('Tencent inventory contains a resource in an unrequested VPC');
      if (query.instanceId && (row.InstanceId??attachment.InstanceId) !== query.instanceId) throw new Error('Tencent attachment inventory contains an unrequested attachment');
      if (kind === 'snapshot' && query.diskIds && !query.diskIds.includes(String(row.DiskId))) throw new Error('Tencent snapshot inventory returned an unrequested source disk');
      const resource: TencentResource = { id, kind, tags: resourceTags,
        evidence: { provider: 'tencent_cloud', accountUid: account.accountUid!, cloudAccountContextId: account.cloudAccountContextId!,
          regionId: account.defaultRegion, action, requestIds, observedAt: new Date().toISOString() },
        instanceId: string(row.InstanceId ?? attachment.InstanceId), vpcId, diskUsage: string(row.DiskUsage),
        deleteWithInstance: typeof row.DeleteWithInstance === 'boolean' ? row.DeleteWithInstance : null,
        shared: row.Shareable === true || Array.isArray(row.InstanceIdList) && row.InstanceIdList.length > 1,
        chargeType: string(row.InstanceChargeType ?? row.DiskChargeType),
        ...(typeof row.Primary==='boolean'?{primary:row.Primary}:{}),
        ...(typeof row.NetworkInterfaceId==='string'?{networkInterfaceId:row.NetworkInterfaceId}:{}),
        ...(Array.isArray(row.PublicIpAddressSet)?{relatedEipIds:row.PublicIpAddressSet.map(value=>string(object(value).AddressId)??'')}:{}),
        ...(Array.isArray(row.SubnetSet)?{relatedSubnetIds:row.SubnetSet.map(value=>string(object(value).SubnetId)??'')}:{}),
        ...(typeof (row.CreateTime ?? row.CreatedTime) === 'string' ? { createdAt: String(row.CreateTime ?? row.CreatedTime) } : {}),
        name: string(row.NatGatewayName ?? row.AddressName ?? row.InstanceName) ?? undefined, state: string(row.State ?? row.AddressStatus ?? row.InstanceState) ?? undefined, publicIp: string(row.AddressIp) ?? undefined,
        publicIpAddresses: Array.isArray(row.PublicIpAddressSet) ? row.PublicIpAddressSet.map(value => string(object(value).PublicIpAddress) ?? '') : undefined,
        instanceType: string(row.InstanceType) ?? undefined, imageId: string(row.ImageId) ?? undefined, zoneId: string(row.Zone ?? (row.Placement ? object(row.Placement).Zone : undefined)) ?? undefined, subnetId: string(row.SubnetId ?? vpc.SubnetId) ?? undefined,
        natProductVersion: typeof row.NatProductVersion === 'number' ? row.NatProductVersion : undefined, bandwidth: typeof row.InternetMaxBandwidthOut === 'number' ? row.InternetMaxBandwidthOut : undefined, maxConcurrent: typeof row.MaxConcurrentConnection === 'number' ? row.MaxConcurrentConnection : undefined };
      if (kind === 'ecs') {
        if (typeof row.InstanceState !== 'string' || !/^[A-Z_]+$/.test(row.InstanceState)) throw new Error('Tencent instance state is malformed');
        const systemDiskId = row.SystemDisk ? string(object(row.SystemDisk).DiskId) : null;
        if (systemDiskId && !/^disk-[A-Za-z0-9]+$/.test(systemDiskId)) throw new Error('Tencent system disk identity is malformed');
        resource.detail = { ...(systemDiskId ? { systemDiskId } : {}), instanceId: id, instanceName: string(row.InstanceName) ?? '', hostName: string(row.HostName) ?? '',
          privateIp: ip(row.PrivateIpAddresses), publicIp: ip(row.PublicIpAddresses), tags: resourceTags,
          status: ({ RUNNING: 'Running', STOPPED: 'Stopped', PENDING: 'Pending', STARTING: 'Starting', STOPPING: 'Stopping', REBOOTING: 'Rebooting', TERMINATING: 'Terminating', TERMINATED: 'Terminated' } as Record<string, string>)[row.InstanceState] ?? row.InstanceState };
      }
      resources.push(resource);
    }
    if (resources.length > total) throw new Error('Tencent inventory exceeds its declared total');
    if (resources.length === total) {
      if (kind !== 'nat' && kind !== 'network_acl' && resources.some(resource => Object.entries(query.tags ?? {}).some(([key, value]) => resource.tags[key] !== value))) throw new Error('Tencent inventory ownership filter does not match cloud tags');
      query.onEvidence?.({ provider: 'tencent_cloud', accountUid: account.accountUid!, cloudAccountContextId: account.cloudAccountContextId!,
        regionId: account.defaultRegion, action, requestIds: [...requestIds], observedAt: new Date().toISOString() });
      return kind === 'nat' || kind === 'network_acl' ? resources.filter(resource => Object.entries(query.tags ?? {}).every(([key, value]) => resource.tags[key] === value)) : resources;
    }
    if (!rows.length) throw new Error('Tencent inventory pagination ended before its declared total');
  }
  throw new Error('Tencent inventory exceeded its bounded pagination limit');
}

/** Exact-ID reads retain successful empty-response RequestIds as physical absence evidence. */
export async function describeTencentKnownResourcesWithEvidence(account: SystemCloudAccountContext, kind: TencentResourceKind, ids: string[]) {
  const evidence: TencentResourceEvidence[] = [];
  const resources = await describeTencentResourceInventory(account, kind, { ids, onEvidence: value => evidence.push(value) });
  return { resources, evidence };
}

export async function describeTencentInstances(account: SystemCloudAccountContext, query: { instanceIds?: string[]; tags?: Record<string, string>; vpcId?: string }) {
  return (await describeTencentResourceInventory(account, 'ecs', { ids: query.instanceIds, tags: query.tags, vpcId: query.vpcId })).map(resource => resource.detail!);
}

export function assertTencentOwnedInstance(instance: RangeInstanceRecord, account: SystemCloudAccountContext, detail: NormalizedInstanceDetail, hostKey?: string) {
  assertTencentAccount(account);
  const config = instance.instanceMode === 'single' ? instance.singleInstanceConfig : instance.resourceSummary?.executionContext;
  if (instance.cloudProvider !== 'tencent_cloud' || !config || config.cloudAccountContextId !== account.cloudAccountContextId
    || config.cloudAccountUid !== account.accountUid || config.regionId !== account.defaultRegion) throw new Error('Tencent instance does not match its frozen cloud identity');
  const expected = { CreatedBy: 'cyber-range-platform', PlatformManaged: 'true', ExecutionBackend: 'opentofu',
    CloudAccountUid: account.accountUid!, CloudAccountContextId: account.cloudAccountContextId!, RangeInstanceId: instance.id,
    PlatformScope: instance.ownerUserId ? 'user' : 'platform', PlatformResourceType: 'ecs',
    ...(instance.ownerUserId ? { PlatformUserId: instance.ownerUserId } : {}),
    ...(instance.singleInstanceBatchId ? { SingleInstanceBatchId: instance.singleInstanceBatchId } : {}), ...(hostKey ? { PlatformHostKey: hostKey } : {}) };
  if (Object.entries(expected).some(([key, value]) => detail.tags[key] !== value)
    || !instance.ownerUserId && detail.tags.PlatformUserId) throw new Error('Tencent cloud resource ownership cannot be verified');
}

export async function readTencentAttachedDiskInventory(account: SystemCloudAccountContext, instanceId: string, summary: { systemDiskIds?: string[]; dataDiskIds?: string[]; previouslyInventoried?: boolean }, expectedTags: Record<string, string>): Promise<AttachedDiskInventory> {
  const disks = await describeTencentResourceInventory(account, 'disk', { instanceId });
  const result: AttachedDiskInventory = { complete: summary.previouslyInventoried === true, systemDiskIds: [], dataDiskIds: [], unverifiedDisks: [], proofs: {} };
  for (const disk of disks) {
    if (!['SYSTEM_DISK', 'DATA_DISK'].includes(disk.diskUsage ?? '')) throw new Error('Tencent disk usage is malformed');
    const system = disk.diskUsage === 'SYSTEM_DISK', known = (system ? summary.systemDiskIds : summary.dataDiskIds)?.includes(disk.id);
    const conflict = Object.entries(expectedTags).some(([key, value]) => disk.tags[key] !== undefined && disk.tags[key] !== value)
      || expectedTags.PlatformScope === 'platform' && Boolean(disk.tags.PlatformUserId);
    // Only IDs persisted by the fenced OpenTofu state can be charged to a member; tags alone do not adopt external CBS.
    if (known && !conflict && !disk.shared) {
      (system ? result.systemDiskIds : result.dataDiskIds).push(disk.id);
      result.proofs[disk.id] = { instanceId, method: 'persisted', deleteWithInstance: disk.deleteWithInstance };
    } else result.unverifiedDisks.push({ id: disk.id, deleteWithInstance: disk.deleteWithInstance });
  }
  result.complete ||= result.systemDiskIds.length > 0;
  return result;
}

export async function terminateTencentInstances(account: SystemCloudAccountContext, ids: string[]) {
  assertTencentAccount(account);
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !/^ins-[A-Za-z0-9]+$/.test(id))) throw new Error('Invalid Tencent instance termination identities');
  // Exactly one submission: a timeout can already have reached the provider. Reconcile before any later recovery.
  return requestTencentCloud<{ RequestId: string }>({ service: 'cvm', version: '2017-03-12', action: 'TerminateInstances', regionId: account.defaultRegion,
    accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret, parameters: { InstanceIds: ids, ReleaseAddress: false, ReleasePrepaidDataDisks: false } });
}

export async function resetTencentStoppedInstancePassword(account: SystemCloudAccountContext, instance: RangeInstanceRecord, hostKey: string, password: string, userName?: string) {
  const instanceId = instance.resourceSummary?.hostIds?.[hostKey];
  if (!instanceId) throw new Error('Tencent password reset requires its persisted platform node identity');
  const [detail] = await describeTencentInstances(account, { instanceIds: [instanceId] });
  if (detail) assertTencentOwnedInstance(instance, account, detail, hostKey);
  if (!detail || detail.status !== 'Stopped') throw new Error('Tencent password reset requires an observed stopped instance; no implicit forced shutdown');
  return requestTencentCloud<{ RequestId: string }>({ service: 'cvm', version: '2017-03-12', action: 'ResetInstancesPassword', regionId: account.defaultRegion,
    accessKeyId: account.accessKeyId, accessKeySecret: account.accessKeySecret, parameters: { InstanceIds: [instanceId], Password: password, ForceStop: false, ...(userName ? { UserName: userName } : {}) } });
}
