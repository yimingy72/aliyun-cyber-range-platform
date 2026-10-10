import { assertTencentInstanceLogin } from './tencent-cloud-opentofu-renderer';
import { createHash } from 'node:crypto';
import type { EnterpriseProvisionPlan } from '../enterprise-provision-plan';
import type { ResolvedProvisioningRuntimeConfig } from '../provisioning.types';
import { buildWindowsDnsUserData } from './guest-dns-scripts';

export function tencentNicCapacity(cpu: number) {
  if (cpu === 1) return { nics: 2, ips: 6 };
  if (cpu >= 2 && cpu <= 4) return { nics: 4, ips: 10 };
  if (cpu >= 6 && cpu <= 8) return { nics: 6, ips: 20 };
  if (cpu === 12) return { nics: 8, ips: 30 };
  if (cpu >= 14 && cpu < 64) return { nics: 8, ips: 40 };
  if (cpu >= 64) return { nics: 16, ips: 40 };
  throw new Error('Tencent ENI capacity is not documented for this CPU count');
}

export function renderTencentRangeVariables(input: { plan: EnterpriseProvisionPlan; rangeInstanceId: string; account: ResolvedProvisioningRuntimeConfig;
  hostInstanceTypes: Record<string, { instanceType: string; cpu: number }>; hostImageIds: Record<string, string>; hostPasswords: Record<string, string>; tags: Record<string, string>; expiresAt: string;
  hostWindows?: Record<string,boolean>;
  systemDiskType?: string; systemDiskSize?: number }) {
  const { plan, account } = input;
  if (account.provider !== 'tencent_cloud' || !account.accountUid || !account.cloudAccountContextId || !account.defaultZoneId.startsWith(`${account.defaultRegion}-`))
    throw new Error('Tencent range requires a verified frozen cloud identity');
  if (!input.expiresAt || new Date(input.expiresAt).getTime() - Date.now() <= 5 * 60_000) throw new Error('Tencent scheduled termination must be more than five minutes in the future');
  if (!input.tags.PlatformCreateJobId) throw new Error('Tencent range requires a persisted creation job');
  const diskType = input.systemDiskType ?? 'CLOUD_PREMIUM';
  if (!['CLOUD_PREMIUM','CLOUD_SSD','CLOUD_BSSD','CLOUD_HSSD','CLOUD_TSSD'].includes(diskType)) throw new Error('Tencent range requires managed cloud system disks');
  const networkKeys = new Set(plan.networkZones.map(zone => zone.key));
  const hostKeys = new Set(plan.hostDefinitions.map(host => host.key));
  const eipKeys = new Set(plan.eipDefinitions.map(eip => eip.key));
  const natKeys = new Set(plan.natGateways.map(nat => nat.key));
  if (plan.natGateways.length > 1 || plan.eipDefinitions.some(eip => eip.bindTargetType !== 'nat_gateway') || plan.natGateways.some(nat => !networkKeys.has(nat.zoneKey)))
    throw new Error('Tencent range supports one shared NAT and its explicitly bound EIPs');
  if (plan.snatEntries.some(entry => !networkKeys.has(entry.sourceZoneKey) || !natKeys.has(entry.natGatewayKey) || !eipKeys.has(entry.eipKey)) || plan.dnatEntries.some(entry => !hostKeys.has(entry.backendHostKey) || !natKeys.has(entry.natGatewayKey) || !eipKeys.has(entry.eipKey) || !['tcp','udp'].includes(entry.protocol.toLowerCase()))) throw new Error('Tencent NAT rules contain an unsupported target or protocol');
  const snatZones = new Set(plan.snatEntries.map(entry => entry.sourceZoneKey));
  if (plan.dnatEntries.some(entry => !snatZones.has(plan.hostDefinitions.find(host => host.key === entry.backendHostKey)!.zoneKey))) throw new Error('Tencent DNAT entry network must explicitly enable SNAT; the provider cannot enforce strict SNAT mode');
  const interfaces = plan.hostDefinitions.flatMap(host => {
    const nics = plan.hostNetworkInterfaces.find(item => item.hostKey === host.key)?.interfaces ?? [{ deviceIndex: 0, zoneKey: host.zoneKey, privateIp: host.privateIp }];
    const selection = input.hostInstanceTypes[host.key];
    if (!selection || !input.hostImageIds[host.key]?.match(/^img-[a-z0-9]+$/)) throw new Error('Every Tencent host needs an exact saleable type and available image');
    const capacity = tencentNicCapacity(selection.cpu);
    if (nics.length > capacity.nics || new Set(nics.map(nic => nic.deviceIndex)).size !== nics.length || nics.filter(nic => nic.deviceIndex === 0).length !== 1) throw new Error(`Tencent host ${host.key} exceeds ENI capacity or has invalid primary NIC`);
    return nics.map(nic => {
      if (!networkKeys.has(nic.zoneKey) || 1 + (nic.secondaryIps?.length ?? 0) > Math.min(capacity.ips, nic.deviceIndex > 0 ? 30 : 11)) throw new Error(`Tencent NIC ${host.key}/${nic.deviceIndex} exceeds explicit provider/IP capacity`);
      return { key: `${host.key}-${nic.deviceIndex}`, host_key: host.key, device_index: nic.deviceIndex, zone_key: nic.zoneKey, private_ip: nic.privateIp, secondary_ips: nic.secondaryIps ?? [] };
    });
  });
  const rules = (values: EnterpriseProvisionPlan['securityGroupRules'] | EnterpriseProvisionPlan['aclDefinitions']) => values.map(rule => {
    const protocol = rule.protocol.toUpperCase();
    const all = ['-1/-1','1/65535'].includes(rule.portRange);
    if (!['TCP','UDP','ICMP','ALL'].includes(protocol) || ['ALL','ICMP'].includes(protocol) && !all || !/^\d+\/\d+$/.test(rule.portRange) && !all) throw new Error('Tencent security policies contain an unsupported protocol/port range');
    const isAcl = 'zoneKey' in rule;
    const [start, end] = rule.portRange.split('/').map(Number);
    if (!all && (start < 1 || end > 65535 || start > end)) throw new Error('Tencent security policies contain an invalid port range');
    const port = all ? (isAcl ? 'ALL' : 'all') : start === end ? String(start) : `${start}-${end}`;
    if (isAcl && /[#\r\n]/.test(rule.name)) throw new Error('Tencent ACL descriptions cannot contain rule delimiters');
    return { key: rule.key, ...('targetHostKey' in rule ? { host_key: rule.targetHostKey, device_index: rule.targetDeviceIndex ?? null } : { zone_key: rule.zoneKey }),
      direction: rule.direction, action: ['allow','accept'].includes(rule.policy) ? 'ACCEPT' : 'DROP', protocol, port, cidr_block: rule.sourceCidr, priority: rule.priority, description: isAcl ? rule.name.slice(0,60).toUpperCase() : rule.name.slice(0,60) };
  });
  const terminateAt = new Date(input.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const hosts = plan.hostDefinitions.map(host => {
    const scripts = plan.bootstrapScripts.filter(script => script.targetHostKeys.includes(host.key));
    const dns = host.dns;
    if (dns && input.hostWindows?.[host.key] !== true) throw new Error('Host DNS startup configuration currently requires a verified Windows image');
    if (!dns && new Set(scripts.map(script => script.type)).size > 1) throw new Error('Tencent user data cannot mix shell and cloud-init scripts');
    const dnsInterfaces = plan.hostNetworkInterfaces.find(item => item.hostKey === host.key)?.interfaces ?? [];
    const userData = dns ? buildWindowsDnsUserData({ provider: 'tencent_cloud', dns, interfaces: dnsInterfaces.filter(nic => nic.nicId).map(nic => ({ nicId: nic.nicId!, privateIp: nic.privateIp })), scripts }) : scripts.map(script => script.content).join('\n\n');
    if (Buffer.byteLength(userData) > 16 * 1024) throw new Error('Tencent user data exceeds 16 KiB');
    const primary = interfaces.find(nic => nic.host_key === host.key && nic.device_index === 0)!;
    const password = input.hostPasswords[host.key];
    assertTencentInstanceLogin(password,host.hostName ?? '',input.hostWindows?.[host.key]);
    const frozen = { image_id: input.hostImageIds[host.key], instance_type: input.hostInstanceTypes[host.key].instanceType, private_ip: primary.private_ip, zone_key: primary.zone_key, system_disk_type: diskType, system_disk_size: input.systemDiskSize ?? 40, terminate_at: terminateAt };
    const intent = createHash('sha256').update(JSON.stringify(['tencent_cloud',account.cloudAccountContextId,account.accountUid,account.defaultRegion,account.defaultZoneId,input.rangeInstanceId,host.key,frozen])).digest('hex').slice(0,32);
    return { key: host.key, name: Array.from(host.name).slice(0,60).join(''), host_name: host.hostName ?? '', ...frozen, creation_intent_id: intent, user_data: userData };
  });
  return { resource_name_prefix: plan.resourceNamePrefix.slice(0,35), range_instance_id: input.rangeInstanceId, region: account.defaultRegion, zone_id: account.defaultZoneId,
    vpc_cidr: plan.network.vpcCidr, secondary_vpc_cidrs: plan.network.secondaryVpcCidrs, entry_host_key: plan.entryHostKey,
    network_zones: plan.networkZones.map(zone => ({ key: zone.key, name: zone.name, cidr: zone.cidr })), hosts, network_interfaces: interfaces,
    host_passwords: input.hostPasswords, security_group_rules: rules(plan.securityGroupRules), acls: rules(plan.aclDefinitions),
    nat_gateways: plan.natGateways.map(nat => ({ key: nat.key, name: nat.name, zone_key: nat.zoneKey, creation_intent_id: createHash('sha256').update(JSON.stringify(['nat',account.cloudAccountContextId,account.accountUid,input.rangeInstanceId,input.tags.PlatformCreateJobId,nat.key])).digest('hex').slice(0,32) })),
    eips: plan.eipDefinitions.map(eip => ({ key: eip.key, name: eip.name, nat_key: eip.bindTargetKey, bandwidth: eip.bandwidthMbps, creation_intent_id: createHash('sha256').update(JSON.stringify(['eip',account.cloudAccountContextId,account.accountUid,input.rangeInstanceId,input.tags.PlatformCreateJobId,eip.key,eip.bandwidthMbps])).digest('hex').slice(0,32) })),
    snat_entries: plan.snatEntries.map(entry => ({ key: entry.key, nat_key: entry.natGatewayKey, zone_key: entry.sourceZoneKey, eip_key: entry.eipKey })),
    dnat_entries: plan.dnatEntries.map(entry => ({ key: entry.key, nat_key: entry.natGatewayKey, eip_key: entry.eipKey, host_key: entry.backendHostKey, external_port: entry.externalPort, internal_port: entry.internalPort, protocol: entry.protocol.toUpperCase() })),
    tags: { ...input.tags, CloudProvider: 'tencent_cloud', CloudAccountUid: account.accountUid, CloudAccountContextId: account.cloudAccountContextId, RangeInstanceId: input.rangeInstanceId, CreatedBy: 'cyber-range-platform', PlatformManaged: 'true' } };
}
