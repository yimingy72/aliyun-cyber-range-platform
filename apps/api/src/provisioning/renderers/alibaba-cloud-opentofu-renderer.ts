import type { EnterpriseProvisionPlan } from '../enterprise-provision-plan';

export type AlibabaCloudOpenTofuRenderedVariables = {
  resource_name_prefix: string;
  zone_id: string;
  vpc_cidr: string;
  entry_host_key: string;
  network_zones: Array<{
    key: string;
    name: string;
    cidr: string;
    purpose: string;
    is_public_entry: boolean;
  }>;
  hosts: Array<{
    key: string;
    name: string;
    zone_key: string;
    private_ip: string;
    role: string;
    expose_public: boolean;
    instance_type: string;
    image_id?: string;
  }>;
  host_network_interfaces: Array<{
    host_key: string;
    interfaces: Array<{
      device_index: number;
      zone_key: string;
      private_ip: string;
      description?: string;
    }>;
  }>;
  nat_gateways: Array<{
    key: string;
    name: string;
    zone_key: string;
    snat_enabled: boolean;
  }>;
  eips: Array<{
    key: string;
    name: string;
    bind_target_type: 'host' | 'nat_gateway';
    bind_target_key: string;
    bandwidth_mbps: number;
  }>;
  security_group_rules: Array<{
    key: string;
    name: string;
    target_host_key: string;
    direction: string;
    policy: string;
    protocol: string;
    port_range: string;
    source_cidr: string;
    priority: number;
  }>;
  acls: Array<{
    key: string;
    name: string;
    zone_key: string;
    direction: string;
    policy: string;
    protocol: string;
    port_range: string;
    source_cidr: string;
    priority: number;
  }>;
  snat_entries: Array<{
    key: string;
    name: string;
    nat_gateway_key: string;
    source_zone_key: string;
    eip_key: string;
  }>;
  dnat_entries: Array<{
    key: string;
    name: string;
    nat_gateway_key: string;
    eip_key: string;
    backend_host_key: string;
    external_port: number;
    internal_port: number;
    protocol: string;
  }>;
  bootstrap_scripts: Array<{
    key: string;
    name: string;
    type: 'cloud-init' | 'shell';
    content: string;
    target_host_keys: string[];
  }>;
  runtime_selections: {
    image_policies: Record<string, unknown>;
    instance_type_policies: Record<string, unknown>;
  };
  dmz_cidr: string;
  office_cidr: string;
  server_cidr: string;
  dmz_private_ip: string;
  office_private_ip: string;
  server_private_ip: string;
  instance_type: string;
  image_id: string;
  instance_password: string;
  allowed_ingress_cidr: string;
  internet_max_bandwidth_out?: number;
  system_disk_category?: string;
  system_disk_size?: number;
  tags: {
    range_instance_id: string;
  };
};

export type AlibabaCloudOpenTofuRendererInput = {
  plan: EnterpriseProvisionPlan;
  rangeInstanceId: string;
  zoneId: string;
  instanceType: string;
  hostInstanceTypes: Record<string, string>;
  imageId: string;
  hostImageIds?: Record<string, string>;
  instancePassword: string;
  allowedIngressCidr: string;
  internetMaxBandwidthOut?: number;
  systemDiskCategory?: string;
  systemDiskSize?: number;
};

export class AlibabaCloudOpenTofuRenderer {
  render(input: AlibabaCloudOpenTofuRendererInput): AlibabaCloudOpenTofuRenderedVariables {
    const { plan } = input;

    return {
      resource_name_prefix: plan.resourceNamePrefix,
      zone_id: input.zoneId,
      vpc_cidr: plan.network.vpcCidr,
      entry_host_key: plan.entryHostKey,
      network_zones: plan.networkZones.map((zone) => ({
        key: zone.key,
        name: zone.name,
        cidr: zone.cidr,
        purpose: zone.purpose,
        is_public_entry: zone.isPublicEntry,
      })),
      hosts: plan.hostDefinitions.map((host) => {
        const hostInstanceType = input.hostInstanceTypes[host.key] ?? input.instanceType;
        const hostImageId = input.hostImageIds?.[host.key];

        return {
          key: host.key,
          name: host.name,
          zone_key: host.zoneKey,
          private_ip: host.privateIp,
          role: host.role,
          expose_public: host.exposePublic,
          instance_type: hostInstanceType,
          ...(hostImageId ? { image_id: hostImageId } : {}),
        };
      }),
      host_network_interfaces: plan.hostNetworkInterfaces.map((item) => ({
        host_key: item.hostKey,
        interfaces: item.interfaces.map((networkInterface) => ({
          device_index: networkInterface.deviceIndex,
          zone_key: networkInterface.zoneKey,
          private_ip: networkInterface.privateIp,
          ...(networkInterface.description ? { description: networkInterface.description } : {}),
        })),
      })),
      nat_gateways: plan.natGateways.map((natGateway) => ({
        key: natGateway.key,
        name: natGateway.name,
        zone_key: natGateway.zoneKey,
        snat_enabled: natGateway.snatEnabled,
      })),
      eips: plan.eipDefinitions.map((eip) => ({
        key: eip.key,
        name: eip.name,
        bind_target_type: eip.bindTargetType,
        bind_target_key: eip.bindTargetKey,
        bandwidth_mbps: eip.bandwidthMbps,
      })),
      security_group_rules: plan.securityGroupRules.map((rule) => ({
        key: rule.key,
        name: rule.name,
        target_host_key: rule.targetHostKey,
        direction: rule.direction,
        policy: rule.policy,
        protocol: rule.protocol,
        port_range: rule.portRange,
        source_cidr: rule.sourceCidr,
        priority: rule.priority,
      })),
      acls: plan.aclDefinitions.map((acl) => ({
        key: acl.key,
        name: acl.name,
        zone_key: acl.zoneKey,
        direction: acl.direction,
        policy: acl.policy,
        protocol: acl.protocol,
        port_range: acl.portRange,
        source_cidr: acl.sourceCidr,
        priority: acl.priority,
      })),
      snat_entries: plan.snatEntries.map((entry) => ({
        key: entry.key,
        name: entry.name,
        nat_gateway_key: entry.natGatewayKey,
        source_zone_key: entry.sourceZoneKey,
        eip_key: entry.eipKey,
      })),
      dnat_entries: plan.dnatEntries.map((entry) => ({
        key: entry.key,
        name: entry.name,
        nat_gateway_key: entry.natGatewayKey,
        eip_key: entry.eipKey,
        backend_host_key: entry.backendHostKey,
        external_port: entry.externalPort,
        internal_port: entry.internalPort,
        protocol: entry.protocol,
      })),
      bootstrap_scripts: plan.bootstrapScripts.map((script) => ({
        key: script.key,
        name: script.name,
        type: script.type,
        content: script.content,
        target_host_keys: script.targetHostKeys,
      })),
      runtime_selections: {
        image_policies: plan.runtimeSelections.imagePolicies,
        instance_type_policies: plan.runtimeSelections.instanceTypePolicies,
      },
      dmz_cidr: plan.network.dmzCidr,
      office_cidr: plan.network.officeCidr,
      server_cidr: plan.network.serverCidr,
      dmz_private_ip: plan.hosts.publicEntry.privateIp,
      office_private_ip: plan.hosts.officePrimary.privateIp,
      server_private_ip: plan.hosts.serverPrimary.privateIp,
      instance_type: input.instanceType,
      image_id: input.imageId,
      instance_password: input.instancePassword,
      allowed_ingress_cidr: input.allowedIngressCidr,
      ...(input.internetMaxBandwidthOut !== undefined
        ? { internet_max_bandwidth_out: input.internetMaxBandwidthOut }
        : {}),
      ...(input.systemDiskCategory ? { system_disk_category: input.systemDiskCategory } : {}),
      ...(input.systemDiskSize !== undefined ? { system_disk_size: input.systemDiskSize } : {}),
      tags: {
        range_instance_id: input.rangeInstanceId,
      },
    };
  }
}
