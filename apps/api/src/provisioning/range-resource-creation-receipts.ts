import { isIPv4 } from 'node:net';
import type { OpenTofuResourceApplied } from '@aliyun-cyber-range/iac-runner';
import type { WorkspaceState } from './opentofu-state-evidence';
import type { RangeResourceCreatedEvent } from './provisioning.types';

const TYPES: Record<string, RangeResourceCreatedEvent['type']> = {
  alicloud_instance: 'ecs', tencentcloud_instance: 'ecs', alicloud_vpc: 'vpc', tencentcloud_vpc: 'vpc',
  alicloud_vswitch: 'vswitch', tencentcloud_subnet: 'vswitch', alicloud_security_group: 'security_group', tencentcloud_security_group: 'security_group',
  alicloud_network_acl: 'network_acl', tencentcloud_vpc_acl: 'network_acl', alicloud_network_interface: 'eni', tencentcloud_eni: 'eni',
  alicloud_nat_gateway: 'nat_gateway', tencentcloud_nat_gateway: 'nat_gateway', alicloud_eip_address: 'eip', tencentcloud_eip: 'eip',
  alicloud_route_table: 'route_table', tencentcloud_route_table: 'route_table',
  alicloud_snat_entry: 'snat_entry', tencentcloud_nat_gateway_snat: 'snat_entry', alicloud_forward_entry: 'dnat_entry', tencentcloud_dnat: 'dnat_entry',
};

export class RangeCreationReceiptPersistenceError extends Error {
  constructor() { super('Range creation receipts could not be persisted; original state requires recovery'); }
}

export function validRangeResourceCreatedEvent(event: RangeResourceCreatedEvent, provider: 'alibaba_cloud' | 'tencent_cloud') {
  const prefix = provider === 'alibaba_cloud' ? 'alicloud_' : 'tencentcloud_';
  if (!event || typeof event.providerResourceType !== 'string' || typeof event.address !== 'string'
    || !event.providerResourceType.startsWith(prefix) || TYPES[event.providerResourceType] !== event.type
    || !/^module\.range\.[a-z_]+\.[A-Za-z0-9_]+(?:\[(?:"[A-Za-z0-9][A-Za-z0-9:_-]{0,255}"|\d+)\])?$/.test(event.address)
    || !event.address.startsWith(`module.range.${event.providerResourceType}.`) || typeof event.id !== 'string' || event.id.length > 256) return false;
  if (provider === 'alibaba_cloud' && event.type === 'snat_entry') return /^stb-[A-Za-z0-9-]+:snat-[A-Za-z0-9-]+$/.test(event.id);
  if (provider === 'alibaba_cloud' && event.type === 'dnat_entry') return /^ftb-[A-Za-z0-9-]+:fwd-[A-Za-z0-9-]+$/.test(event.id);
  if (provider === 'tencent_cloud' && event.type === 'snat_entry') return /^nat-[a-z0-9]+#subnet-[a-z0-9]+$/.test(event.id);
  if (provider === 'tencent_cloud' && event.type === 'dnat_entry') {
    const match = event.id.match(/^(TCP|UDP):\/\/vpc-[a-z0-9]+:nat-[a-z0-9]+@([0-9.]+):([1-9]\d{0,4})$/);
    return Boolean(match && isIPv4(match[2]) && Number(match[3]) <= 65535);
  }
  const prefixes: Record<string, string> = { ecs: provider === 'alibaba_cloud' ? 'i' : 'ins', vpc: 'vpc', vswitch: provider === 'alibaba_cloud' ? 'vsw' : 'subnet',
    security_group: 'sg', network_acl: provider === 'alibaba_cloud' ? 'nacl' : 'acl', eni: 'eni', nat_gateway: provider === 'alibaba_cloud' ? 'ngw' : 'nat',
    eip: 'eip', route_table: provider === 'alibaba_cloud' ? 'vtb' : 'rtb', snat_entry: 'snat', dnat_entry: 'fwd' };
  return new RegExp(`^${prefixes[event.type]}-[A-Za-z0-9-]+$`).test(event.id);
}

/** Only completion hooks for approved create actions confer origin; observations never do. */
export function createRangeResourceReceiptObserver(input: { plan: unknown; priorState: WorkspaceState | null; provider: 'alibaba_cloud' | 'tencent_cloud';
  onCreated: (event: RangeResourceCreatedEvent) => Promise<void> }) {
  const creates = new Map<string, string>();
  for (const resource of (input.plan as any)?.resource_changes ?? []) if (resource?.mode === 'managed'
    && typeof resource.address === 'string' && TYPES[resource.type] && Array.isArray(resource.change?.actions)
    && resource.change.actions.includes('create')) creates.set(resource.address, resource.type);
  const priorIds = new Set(input.priorState?.instances.flatMap(resource => typeof resource.attributes.id === 'string' ? [resource.attributes.id] : []) ?? []);
  const seen = new Map<string, string>();
  let writes = Promise.resolve(), failed = false;
  return {
    onResourceApplied(event: OpenTofuResourceApplied) {
      if (event.action !== 'create' || creates.get(event.address) !== event.resourceType || priorIds.has(event.resourceId)) return;
      const indexed = event.address.match(/\[("(?:[^"\\]|\\.)*"|\d+)\]$/);
      const value: RangeResourceCreatedEvent = { address: event.address, providerResourceType: event.resourceType, type: TYPES[event.resourceType], id: event.resourceId,
        ...(indexed ? { logicalKey: String(JSON.parse(indexed[1])) } : {}) };
      if (!validRangeResourceCreatedEvent(value, input.provider)) return;
      if (seen.has(event.address)) { if (seen.get(event.address) !== event.resourceId) failed = true; return; }
      if ([...seen.values()].includes(event.resourceId)) { failed = true; return; }
      seen.set(event.address, event.resourceId);
      writes = writes.then(() => input.onCreated(value)).catch(() => { failed = true; });
    },
    async drain() { await writes; if (failed) throw new RangeCreationReceiptPersistenceError(); },
  };
}
