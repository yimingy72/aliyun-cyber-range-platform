import type { WorkspaceState } from './opentofu-state-evidence';
import type { ResolvedProvisioningRuntimeConfig } from './provisioning.types';
import type { RangeChangeApproval } from '../admin/range-draft-change-policy';
import type { RangeResourceSummary } from '../admin/admin.repository';
export type { RangeChangeApproval } from '../admin/range-draft-change-policy';

type Variables = Record<string, any>;
type ResourceKind = 'fixed'|'host'|'nic'|'rule'|'acl'|'nat'|'eip'|'dnat'|'snat'|'subnet';
function rejected(reason: string): never { throw new Error(`Unsafe runtime topology plan: ${reason}; no cloud changes were applied`); }
const object = (value: unknown): value is Variables => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  if (object(a) && object(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => key in b && equal(a[key], b[key]));
  return false;
};
export function rangeResourceKey(address: string): string | null {
  const match = address.match(/\[("(?:[^"\\]|\\.)*")\]$/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}
const vmType = (account: ResolvedProvisioningRuntimeConfig) => account.provider === 'tencent_cloud' ? 'tencentcloud_instance' : 'alicloud_instance';
function ownedTags(value: unknown, account: ResolvedProvisioningRuntimeConfig, rangeId: string, tags?: Record<string,string>) {
  return object(value) && value.CreatedBy === 'cyber-range-platform' && value.CloudProvider === account.provider && value.CloudAccountUid === account.accountUid && value.CloudAccountContextId === account.cloudAccountContextId && (value.RangeInstanceId === rangeId || value.range_instance_id === rangeId) && ['RangeInstanceId','range_instance_id'].every(key => value[key] === undefined || value[key] === rangeId) && ['PlatformScope','PlatformUserId'].every(key => tags?.[key] === undefined || value[key] === tags[key]);
}

export function assertRangeStateOwnership(state: WorkspaceState, prior: Variables, account: ResolvedProvisioningRuntimeConfig, rangeId: string, tags?: Record<string, string>) {
  if (!account?.accountUid || !account.cloudAccountContextId || !['alibaba_cloud', 'tencent_cloud'].includes(account.provider ?? '') || !object(prior) || !Array.isArray(prior.hosts) || typeof prior.zone_id !== 'string' || !prior.zone_id.startsWith(`${account.defaultRegion}-`)) rejected('frozen cloud identity is incomplete');
  const owns = (value: unknown) => ownedTags(value, account, rangeId, tags);
  if (!owns(prior.tags) || account.provider === 'tencent_cloud' && (prior.region !== account.defaultRegion || prior.zone_id !== account.defaultZoneId)) rejected('Existing host startup data or frozen ownership cannot be verified');
  const seen = new Set<string>();
  for (const resource of state.instances) {
    if (resource.module !== 'module.range' || !resource.address.startsWith('module.range.') || resource.tainted || seen.has(resource.address)) rejected('state has foreign, duplicate or tainted resources');
    seen.add(resource.address);
    if (resource.attributes.tags !== undefined && !owns(resource.attributes.tags)) rejected('state resource ownership does not match the range');
    if (['alicloud_instance','tencentcloud_instance'].includes(resource.type)) {
      const key = rangeResourceKey(resource.address);
      if (resource.type !== vmType(account) || !owns(resource.attributes.tags) || resource.attributes.availability_zone !== prior.zone_id || !(account.provider === 'tencent_cloud' ? /^ins-[a-z0-9]+$/ : /^i-[a-z0-9]+$/).test(String(resource.attributes.id)) || prior.hosts.filter((host: any) => host?.key === key).length !== 1) rejected('native host identity is not proven');
    }
  }
}

export function assertRangeStateMatchesInventory(state: WorkspaceState, known: RangeResourceSummary | undefined, account: ResolvedProvisioningRuntimeConfig) {
  if (!known || known.mode !== 'opentofu' || !known.executionContext || known.retiredResources || known.executionContext.cloudAccountUid !== account.accountUid || known.executionContext.cloudAccountContextId !== account.cloudAccountContextId || known.executionContext.regionId !== account.defaultRegion || known.executionContext.zoneId !== account.defaultZoneId || known.executionContext.provider !== undefined && known.executionContext.provider !== account.provider) rejected('original platform resource inventory or execution context is missing');
  const fields: Record<string, keyof RangeResourceSummary> = { alicloud_instance:'hostIds',tencentcloud_instance:'hostIds',alicloud_vswitch:'subnetIds',tencentcloud_subnet:'subnetIds',alicloud_security_group:'securityGroupIds',tencentcloud_security_group:'securityGroupIds',alicloud_network_interface:'secondaryNetworkInterfaceIds',tencentcloud_eni:'secondaryNetworkInterfaceIds',alicloud_network_acl:'networkAclIds',tencentcloud_vpc_acl:'networkAclIds',alicloud_nat_gateway:'natGatewayIds',tencentcloud_nat_gateway:'natGatewayIds',alicloud_eip_address:'eipAllocationIds',tencentcloud_eip:'eipAllocationIds',tencentcloud_route_table:'routeTableIds',alicloud_snat_entry:'snatEntryIds',tencentcloud_nat_gateway_snat:'snatEntryIds',alicloud_forward_entry:'dnatEntryIds',tencentcloud_dnat:'dnatEntryIds' };
  const actual = new Map<keyof RangeResourceSummary, string[]>();
  for (const resource of state.instances) {
    if (['alicloud_vpc','tencentcloud_vpc'].includes(resource.type) && known.vpcId !== resource.attributes.id) rejected('state VPC differs from the platform inventory');
    const field = fields[resource.type]; if (!field) continue;
    actual.set(field,[...(actual.get(field) ?? []),resource.attributes.id as string]);
    if (field === 'hostIds') {
      const key = rangeResourceKey(resource.address)!;
      if (known.hostIds?.[key] !== resource.attributes.id) rejected('native host differs from the platform inventory');
      if (resource.attributes.system_disk_id !== undefined && known.systemDiskIds?.[key] !== resource.attributes.system_disk_id) rejected('native system disk differs from the platform inventory');
    }
  }
  for (const field of new Set(Object.values(fields))) {
    const expected = Object.values(known[field] ?? {}), ids = actual.get(field) ?? [];
    if (!equal([...new Set(expected)].sort(), [...new Set(ids)].sort()) || ids.length !== new Set(ids).size) rejected('state resource identities differ from the platform inventory');
  }
}

// Auto scheduling and changing renderer defaults must never alter a previously deployed VM.
export function preserveDeployedRangeHostFacts<T extends Variables>(state: WorkspaceState, prior: Variables, nextVariables: T, account: ResolvedProvisioningRuntimeConfig): T {
  const next: Variables = nextVariables;
  const deployed = new Set(state.instances.filter(resource => resource.type === vmType(account)).map(resource => rangeResourceKey(resource.address)));
  const oldHosts = new Map<string, Variables>(prior.hosts.map((host: Variables) => [host.key, host]));
  if (!Array.isArray(next.hosts) || !object(prior.host_passwords) || !object(next.host_passwords)) rejected('original host parameters are missing');
  for (const field of ['resource_name_prefix','zone_id','vpc_cidr','secondary_vpc_cidrs']) {
    if (prior[field] === undefined) rejected(`original ${field} is missing`);
    next[field] = structuredClone(prior[field]);
  }
  if (account.provider === 'tencent_cloud') next.region = prior.region;
  const oldZones = new Map<string, Variables>((prior.network_zones ?? []).map((zone: Variables) => [zone.key, zone]));
  if (!Array.isArray(next.network_zones) || !Array.isArray(prior.network_zones)) rejected('original network definitions are missing');
  for (const [key, zone] of oldZones) {
    const wanted = next.network_zones.find((value: Variables) => value.key === key);
    if (!wanted || wanted.cidr !== zone.cidr) rejected('existing subnet cannot be removed or change its CIDR');
  }
  next.hosts = next.hosts.map((wanted: Variables) => {
    if (!deployed.has(wanted.key)) return wanted;
    const original = oldHosts.get(wanted.key)!;
    if (['zone_key','private_ip'].some(key => original[key] === undefined || original[key] !== wanted[key])) rejected('existing host cannot move to another subnet or private IP');
    const retained = structuredClone(original);
    if (account.provider !== 'tencent_cloud') {
      retained.instance_type ??= prior.instance_type;
      retained.image_id ??= prior.image_id;
      retained.system_disk_size ??= prior.system_disk_size ?? 40;
    }
    if (typeof retained.image_id !== 'string' || !retained.image_id || typeof retained.instance_type !== 'string' || !retained.instance_type || !Number.isSafeInteger(retained.system_disk_size) || retained.system_disk_size < 20 || typeof prior.host_passwords[wanted.key] !== 'string') rejected('original image, instance type, disk or credentials are incomplete');
    next.host_passwords[wanted.key] = prior.host_passwords[wanted.key];
    return retained;
  });
  if (account.provider !== 'tencent_cloud') {
    for (const field of ['system_disk_category','system_disk_size','instance_password','instance_type','image_id']) if (prior[field] !== undefined) next[field] = prior[field];
    if (prior.system_disk_category === undefined) {
      const categories = new Set(state.instances.filter(resource => resource.type === 'alicloud_instance').map(resource => resource.attributes.system_disk_category));
      if (categories.size !== 1 || !categories.has(undefined) && typeof [...categories][0] !== 'string') rejected('original system disk category is incomplete');
      next.system_disk_category = [...categories][0] ?? 'cloud_essd';
    }
  }
  const nicField = account.provider === 'tencent_cloud' ? 'network_interfaces' : 'host_network_interfaces';
  if (!Array.isArray(prior[nicField]) || !Array.isArray(next[nicField])) rejected('original NIC definitions are missing');
  for (const key of deployed) {
    if (!next.hosts.some((host: Variables) => host.key === key)) continue;
    const oldNics = prior[nicField].filter((nic: Variables) => nic.host_key === key);
    const wantedNics = next[nicField].filter((nic: Variables) => nic.host_key === key);
    if (!equal(oldNics, wantedNics)) rejected('existing host NIC configuration cannot change during a topology update');
  }
  return nextVariables;
}

export function desiredResources(vars: Variables, tencent: boolean) {
  const addresses = new Map<string, { type: string; key: string | null; host?: string; kind: ResourceKind }>();
  const add = (type: string, name: string, key: string | null, kind: ResourceKind, host?: string) => {
    const address = `module.range.${type}.${name}${key === null ? '' : `[${JSON.stringify(key)}]`}`;
    if (addresses.has(address)) rejected('rendered resource addresses are duplicated');
    addresses.set(address, { type, key, kind, ...(host ? { host } : {}) });
  };
  const list = (field: string): Variables[] => {
    if (!Array.isArray(vars[field]) || vars[field].some((value: unknown) => !object(value) || typeof value.key !== 'string' && !['host_network_interfaces'].includes(field))) rejected(`rendered ${field} is incomplete`);
    return vars[field];
  };
  add(tencent ? 'tencentcloud_vpc' : 'alicloud_vpc', 'range', null, 'fixed');
  for (const zone of list('network_zones')) {
    add(tencent ? 'tencentcloud_subnet' : 'alicloud_vswitch', 'zones', zone.key, 'subnet');
    if (tencent) { add('tencentcloud_route_table','zones',zone.key,'subnet'); add('tencentcloud_route_table_association','zones',zone.key,'subnet'); }
  }
  for (const host of list('hosts')) {
    add(tencent ? 'tencentcloud_instance' : 'alicloud_instance','hosts',host.key,'host',host.key);
    if (!tencent) add('alicloud_security_group','hosts',host.key,'nic',host.key);
  }
  const nics: Variables[] = tencent ? list('network_interfaces') : list('host_network_interfaces').flatMap(item => item.interfaces.map((nic: Variables) => ({ ...nic, host_key: item.host_key, key: `${item.host_key}-${nic.device_index}` })));
  for (const nic of nics) {
    if (tencent) { add('tencentcloud_security_group','nics',nic.key,'nic',nic.host_key); add('tencentcloud_security_group_rule_set','nics',nic.key,'rule',nic.host_key); }
    if (nic.device_index > 0) {
      add(tencent ? 'tencentcloud_eni' : 'alicloud_network_interface','secondary',nic.key,'nic',nic.host_key);
      if (tencent || nic.device_index > 1) add(tencent ? 'tencentcloud_eni_attachment' : 'alicloud_network_interface_attachment','secondary',nic.key,'nic',nic.host_key);
      if (!tencent && nic.nic_id) {
        add('alicloud_security_group','network_interfaces',nic.key,'nic',nic.host_key);
        for (const rule of list('security_group_rules').filter(rule => rule.target_host_key === nic.host_key && rule.target_device_index === undefined || rule.target_host_key === nic.host_key && rule.target_device_index === null)) add('alicloud_security_group_rule','secondary_host_rules',`${nic.key}-${rule.key}`,'rule',nic.host_key);
      }
    } else if (tencent && nic.secondary_ips?.length) add('tencentcloud_eni_ipv4_address','primary',nic.key,'nic',nic.host_key);
  }
  if (!tencent) {
    for (const cidr of vars.secondary_vpc_cidrs ?? []) if (cidr !== vars.vpc_cidr) add('alicloud_vpc_ipv4_cidr_block','secondary',cidr,'fixed');
    for (const rule of list('security_group_rules')) add('alicloud_security_group_rule','compiled_rules',rule.key,'rule',rule.target_host_key);
  }
  const aclZones = new Set<string>(list('acls').map(rule => rule.zone_key));
  for (const zone of aclZones) { add(tencent ? 'tencentcloud_vpc_acl' : 'alicloud_network_acl',tencent ? 'zones' : 'zone_acls',zone,'acl'); if (tencent) add('tencentcloud_vpc_acl_attachment','zones',zone,'acl'); }
  for (const nat of list('nat_gateways')) add(tencent ? 'tencentcloud_nat_gateway' : 'alicloud_nat_gateway',tencent ? 'shared' : 'gateways',nat.key,'nat');
  for (const eip of list('eips')) {
    add(tencent ? 'tencentcloud_eip' : 'alicloud_eip_address',tencent ? 'range' : 'addresses',eip.key,'eip');
    if (!tencent) add('alicloud_eip_association',eip.bind_target_type === 'host' ? 'host_targets' : 'nat_targets',eip.key,'eip',eip.bind_target_type === 'host' ? eip.bind_target_key : undefined);
  }
  for (const rule of list('snat_entries')) { add(tencent ? 'tencentcloud_nat_gateway_snat' : 'alicloud_snat_entry',tencent ? 'zones' : 'entries',rule.key,'snat'); if (tencent) add('tencentcloud_route_table_entry','internet',rule.zone_key,'snat'); }
  for (const rule of list('dnat_entries')) add(tencent ? 'tencentcloud_dnat' : 'alicloud_forward_entry',tencent ? 'entry' : 'entries',rule.key,'dnat');
  return addresses;
}

export function assertApprovedRangeUpdatePlan(input: { plan: unknown; state: WorkspaceState; priorVariables: Variables; nextVariables: Variables; approval: RangeChangeApproval; account: ResolvedProvisioningRuntimeConfig; rangeInstanceId: string; billingTags?: Record<string,string>; knownResourceSummary?: RangeResourceSummary }) {
  const { approval, state, account, priorVariables: prior, nextVariables: next } = input;
  if (!approval || approval.version !== 1 || !['runtimeIdentityDigest','topologyDigest'].every(key => /^[A-Za-z0-9_-]{43}$/.test((approval as any)[key])) || ![approval.addedHostKeys,approval.deletedHostKeys].every(keys => Array.isArray(keys) && keys.every(key => typeof key === 'string' && key.length > 0) && new Set(keys).size === keys.length) || typeof approval.allowDnatRemoval !== 'boolean' || typeof approval.allowSnatRemoval !== 'boolean') rejected('approved preview is missing or malformed');
  assertRangeStateOwnership(state, prior, account, input.rangeInstanceId, input.billingTags);
  assertRangeStateMatchesInventory(state, input.knownResourceSummary, account);
  const tencent = account.provider === 'tencent_cloud';
  const desired = desiredResources(next, tencent), original = desiredResources(prior, tencent);
  const oldHosts = state.instances.filter(resource => resource.type === vmType(account)).map(resource => rangeResourceKey(resource.address));
  const nextHosts = next.hosts.map((host: Variables) => host.key);
  const added = nextHosts.filter((key: string) => !oldHosts.includes(key)).sort(), deleted = oldHosts.filter(key => !nextHosts.includes(key)).sort();
  if (!equal(added, [...approval.addedHostKeys].sort()) || !equal(deleted, [...approval.deletedHostKeys].sort())) rejected('host changes differ from the confirmed preview');
  const plan = input.plan as any;
  // OpenTofu 1.13 JSON omits `complete`; completeness is proved by both full address sets below.
  if (!object(plan) || plan.format_version !== '1.2' || typeof plan.terraform_version !== 'string' || !/^1\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(plan.terraform_version) || plan.errored !== false || plan.complete === false || !Array.isArray(plan.resource_changes) || plan.deferred_changes?.length || !object(plan.planned_values?.root_module)) rejected('OpenTofu plan is incomplete');
  const planned = new Set<string>();
  const collect = (module: any) => {
    if (!object(module) || module.resources !== undefined && !Array.isArray(module.resources) || module.child_modules !== undefined && !Array.isArray(module.child_modules)) rejected('planned resource graph is malformed');
    for (const resource of module.resources ?? []) if (resource.mode === 'managed') { if (typeof resource.address !== 'string' || planned.has(resource.address)) rejected('planned resource graph is duplicated'); planned.add(resource.address); }
    for (const child of module.child_modules ?? []) collect(child);
  };
  collect(plan.planned_values.root_module);
  if (planned.size !== desired.size || [...planned].some(address => !desired.has(address))) rejected('planned resources differ from the rendered approved topology');
  const stateByAddress = new Map(state.instances.map(resource => [resource.address, resource]));
  const seen = new Set<string>(), createdHosts = new Set<string>(), deletedHosts = new Set<string>();
  for (const resource of plan.resource_changes) {
    if (resource.mode === 'data') continue;
    if (resource.mode !== 'managed' || typeof resource.address !== 'string' || seen.has(resource.address) || resource.previous_address || resource.deposed) rejected('resource changes have ambiguous identities');
    seen.add(resource.address);
    const old = stateByAddress.get(resource.address), target = desired.get(resource.address), definition = target ?? original.get(resource.address);
    const actions = resource.change?.actions;
    if (!definition || definition.type !== resource.type || !Array.isArray(actions) || !actions.length || !actions.every((action: unknown) => ['no-op','create','update','delete'].includes(String(action))) || !object(resource.change)) rejected('unrecognized resource change');
    const creates = actions.includes('create'), deletes = actions.includes('delete');
    if (old && (!object(resource.change.before) || resource.change.before.id !== old.attributes.id)) rejected('plan native identity differs from the persisted state');
    if (old?.attributes.tags !== undefined && !ownedTags(resource.change.before?.tags, account, input.rangeInstanceId, input.billingTags)) rejected('plan resource belongs to another account or owner');
    if (creates && ['alicloud_vswitch','alicloud_instance','alicloud_security_group','alicloud_network_interface','alicloud_network_acl','alicloud_nat_gateway','alicloud_eip_address','tencentcloud_subnet','tencentcloud_instance','tencentcloud_security_group','tencentcloud_eni','tencentcloud_vpc_acl','tencentcloud_nat_gateway','tencentcloud_eip','tencentcloud_route_table'].includes(resource.type) && !ownedTags(resource.change.after?.tags, account, input.rangeInstanceId, input.billingTags)) rejected('new cloud resource attribution is incomplete');
    if (!old && object(resource.change.before) || old && !original.has(resource.address)) rejected('plan resource is outside the original owned topology');
    if (actions.length > 1 && !(creates && deletes && ['rule','acl','dnat','snat'].includes(definition.kind))) rejected('replacement of existing cloud infrastructure is forbidden');
    if (creates && old && !deletes || deletes && !old || !deletes && !target || deletes && !creates && target) rejected('plan action does not match the desired topology');
    if (definition.kind === 'host') {
      const key = definition.key!;
      if (creates) { if (old || !approval.addedHostKeys.includes(key) || deletes) rejected('existing host would be recreated'); createdHosts.add(key); }
      if (deletes) { if (!approval.deletedHostKeys.includes(key) || creates) rejected('host deletion was not confirmed'); deletedHosts.add(key); }
      if (old && !deletes && actions.includes('update')) for (const field of new Set([...Object.keys(resource.change.before ?? {}),...Object.keys(resource.change.after ?? {}),...Object.keys(resource.change.after_unknown ?? {})])) if (!['tags','tags_all'].includes(field) && (!equal(resource.change.before?.[field],resource.change.after?.[field]) || resource.change.after_unknown?.[field])) rejected('an existing host configuration would change');
    } else if (['fixed','subnet'].includes(definition.kind)) {
      if (deletes || creates && old || creates && definition.kind === 'fixed') rejected('existing VPC or subnet cannot be recreated or removed');
      if (old && actions.includes('update')) for (const field of new Set([...Object.keys(resource.change.before),...Object.keys(resource.change.after ?? {}),...Object.keys(resource.change.after_unknown ?? {})])) if (!['tags','tags_all','name','vswitch_name'].includes(field) && (!equal(resource.change.before[field],resource.change.after?.[field]) || resource.change.after_unknown?.[field])) rejected('existing VPC or subnet placement would change');
    } else if (definition.kind === 'nic') {
      if (creates && (!definition.host || !approval.addedHostKeys.includes(definition.host)) || deletes && (!definition.host || !approval.deletedHostKeys.includes(definition.host))) rejected('existing host NIC or security group cannot be replaced');
      if (old && actions.includes('update')) for (const field of new Set([...Object.keys(resource.change.before),...Object.keys(resource.change.after ?? {}),...Object.keys(resource.change.after_unknown ?? {})])) if (!['tags','tags_all','description','name','security_group_name'].includes(field) && (!equal(resource.change.before[field],resource.change.after?.[field]) || resource.change.after_unknown?.[field])) rejected('existing host NIC configuration would change');
    } else if (['nat','eip'].includes(definition.kind)) {
      if (deletes && (!approval.allowDnatRemoval && !approval.allowSnatRemoval || target)) rejected('NAT or EIP removal was not confirmed');
      if (creates && old) rejected('existing NAT or EIP would be replaced');
      if (old && actions.includes('update')) for (const field of new Set([...Object.keys(resource.change.before),...Object.keys(resource.change.after ?? {}),...Object.keys(resource.change.after_unknown ?? {})])) if (!['tags','tags_all','name','address_name','nat_gateway_name',...(definition.kind === 'nat' ? ['assigned_eip_set'] : [])].includes(field) && (!equal(resource.change.before[field],resource.change.after?.[field]) || resource.change.after_unknown?.[field])) rejected('existing NAT or EIP capacity, billing or placement would change');
    } else if (definition.kind === 'dnat' && deletes && !creates && !approval.allowDnatRemoval || definition.kind === 'snat' && deletes && !creates && !approval.allowSnatRemoval) rejected('network rule removal was not confirmed');
  }
  if (state.instances.some(resource => !seen.has(resource.address)) || [...planned].some(address => !seen.has(address)) || !equal([...createdHosts].sort(),added) || !equal([...deletedHosts].sort(),deleted)) rejected('resource or host action evidence is incomplete');
}
