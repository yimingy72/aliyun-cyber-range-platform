import type {
  RangeTemplateCompiledSpec,
  RangeTemplateHost,
  RangeTemplateNetworkZone,
  RangeTemplateTopologySpec,
} from '../admin/admin.repository';

type CompiledResource = RangeTemplateCompiledSpec['resources'][number];

type CompiledHostResource = CompiledResource & {
  type: 'host';
  config: {
    label?: string;
    zoneKey?: string;
    role?: string;
    privateIp?: string;
    exposePublic?: boolean;
  };
};

type CompiledSwitchResource = CompiledResource & {
  type: 'switch';
  config: {
    label?: string;
    zoneKey?: string;
    cidr?: string;
    purpose?: string;
  };
};

type CompiledNatGatewayResource = CompiledResource & {
  type: 'nat_gateway';
  config: {
    label?: string;
    zoneKey?: string;
    snatEnabled?: boolean;
  };
};

type CompiledEipResource = CompiledResource & {
  type: 'eip';
  config: {
    label?: string;
    bindTargetType?: string;
    bindTargetKey?: string;
    bandwidthMbps?: number;
  };
};

type CompiledSecurityGroupRuleResource = CompiledResource & {
  type: 'security_group_rule';
  config: {
    label?: string;
    targetHostKey?: string;
    direction?: string;
    policy?: string;
    protocol?: string;
    portRange?: string;
    sourceCidr?: string;
    priority?: number;
  };
};

type CompiledAclResource = CompiledResource & {
  type: 'acl';
  config: {
    label?: string;
    zoneKey?: string;
    direction?: string;
    policy?: string;
    protocol?: string;
    portRange?: string;
    sourceCidr?: string;
    priority?: number;
  };
};

export type EnterpriseProvisionPlan = {
  resourceNamePrefix: string;
  modulePath: string;
  entryHostKey: string;
  topologySummary: {
    vpcCidr: string;
    publicEntryHostKey: string;
    networkZoneKeys: string[];
    hostKeys: string[];
  };
  network: {
    vpcCidr: string;
    dmzCidr: string;
    officeCidr: string;
    serverCidr: string;
  };
  networkZones: Array<{
    key: string;
    name: string;
    cidr: string;
    purpose: string;
    isPublicEntry: boolean;
  }>;
  hostDefinitions: Array<{
    key: string;
    name: string;
    zoneKey: string;
    privateIp: string;
    role: string;
    exposePublic: boolean;
  }>;
  natGateways: Array<{
    key: string;
    name: string;
    zoneKey: string;
    snatEnabled: boolean;
  }>;
  eipDefinitions: Array<{
    key: string;
    name: string;
    bindTargetType: 'host' | 'nat_gateway';
    bindTargetKey: string;
    bandwidthMbps: number;
  }>;
  securityGroupRules: Array<{
    key: string;
    name: string;
    targetHostKey: string;
    direction: string;
    policy: string;
    protocol: string;
    portRange: string;
    sourceCidr: string;
    priority: number;
  }>;
  aclDefinitions: Array<{
    key: string;
    name: string;
    zoneKey: string;
    direction: string;
    policy: string;
    protocol: string;
    portRange: string;
    sourceCidr: string;
    priority: number;
  }>;
  hosts: {
    publicEntry: RangeTemplateHost;
    officePrimary: RangeTemplateHost;
    serverPrimary: RangeTemplateHost;
  };
};

export function buildEnterpriseProvisionPlan(input: {
  rangeInstanceId: string;
  templateModulePath: string;
  topologySpec?: RangeTemplateTopologySpec | null;
  compiledSpec?: RangeTemplateCompiledSpec | null;
  allocatedCidr: string | null;
}): EnterpriseProvisionPlan {
  const topologySpec = input.topologySpec ?? buildTopologySpecFromCompiledSpec(input.compiledSpec);

  if (!topologySpec) {
    throw new Error('Missing provisioning blueprint: topologySpec or compiledSpec.resources is required');
  }

  const vpcCidr = requireValue(resolveVpcCidr(topologySpec, input.compiledSpec), 'topologySpec.vpcCidr');

  if (input.allocatedCidr && input.allocatedCidr !== vpcCidr) {
    throw new Error(
      `Allocated CIDR ${input.allocatedCidr} does not match template topology VPC CIDR ${vpcCidr}`,
    );
  }

  const dmzZone = findZone(topologySpec, 'dmz');
  const officeZone = findZone(topologySpec, 'office');
  const serverZone = findZone(topologySpec, 'server');
  const publicEntry = findPublicEntryHost(topologySpec);
  const officePrimary = findHostByZone(topologySpec, 'office');
  const serverPrimary = findHostByZone(topologySpec, 'server');
  const natGateways = buildNatGatewaysFromCompiledSpec(input.compiledSpec);
  const eipDefinitions = buildEipsFromCompiledSpec(input.compiledSpec);
  const securityGroupRules = buildSecurityGroupRulesFromCompiledSpec(input.compiledSpec);
  const aclDefinitions = buildAclDefinitionsFromCompiledSpec(input.compiledSpec);

  return {
    resourceNamePrefix: createResourceNamePrefix(input.rangeInstanceId),
    modulePath: input.templateModulePath,
    entryHostKey: topologySpec.publicEntry.hostKey,
    topologySummary: {
      vpcCidr,
      publicEntryHostKey: topologySpec.publicEntry.hostKey,
      networkZoneKeys: topologySpec.networkZones.map((zone) => zone.key),
      hostKeys: topologySpec.hosts.map((host) => host.key),
    },
    network: {
      vpcCidr,
      dmzCidr: dmzZone.cidr,
      officeCidr: officeZone.cidr,
      serverCidr: serverZone.cidr,
    },
    networkZones: topologySpec.networkZones.map((zone) => ({
      key: zone.key,
      name: zone.name,
      cidr: zone.cidr,
      purpose: zone.purpose,
      isPublicEntry: zone.key === publicEntry.zoneKey,
    })),
    hostDefinitions: topologySpec.hosts.map((host) => ({
      key: host.key,
      name: host.name,
      zoneKey: host.zoneKey,
      privateIp: host.privateIp,
      role: host.role,
      exposePublic: host.key === topologySpec.publicEntry.hostKey || Boolean(host.exposePublic),
    })),
    natGateways,
    eipDefinitions,
    securityGroupRules,
    aclDefinitions,
    hosts: {
      publicEntry,
      officePrimary,
      serverPrimary,
    },
  };
}

function buildTopologySpecFromCompiledSpec(
  compiledSpec: RangeTemplateCompiledSpec | null | undefined,
): RangeTemplateTopologySpec | null {
  if (!compiledSpec) {
    return null;
  }

  const switchResources = compiledSpec.resources.filter(isCompiledSwitchResource);
  const hostResources = compiledSpec.resources.filter(isCompiledHostResource);
  const vpcCidr = compiledSpec.topology?.vpcCidr;

  if (!vpcCidr || switchResources.length === 0 || hostResources.length === 0) {
    return null;
  }

  const publicEntryHostKey =
    compiledSpec.topology?.publicEntryHostKey ??
    hostResources.find((resource) => resource.config.exposePublic)?.id ??
    hostResources.find((resource) => resource.config.role === 'entry')?.id;

  if (!publicEntryHostKey) {
    return null;
  }

  const publicEntryHost = hostResources.find((resource) => resource.id === publicEntryHostKey);

  if (!publicEntryHost?.config.zoneKey) {
    return null;
  }

  const networkZones: RangeTemplateNetworkZone[] = switchResources.map((resource) => ({
    key: requireValue(resource.config.zoneKey, `compiledSpec.resources[${resource.id}].config.zoneKey`),
    name: resource.config.label ?? resource.id,
    purpose: resource.config.purpose ?? resource.config.zoneKey ?? resource.id,
    cidr: requireValue(resource.config.cidr, `compiledSpec.resources[${resource.id}].config.cidr`),
    ...(resource.config.zoneKey === publicEntryHost.config.zoneKey ? { isPublicEntry: true } : {}),
  }));

  const hosts: RangeTemplateHost[] = hostResources.map((resource) => ({
    key: resource.id,
    name: resource.config.label ?? resource.id,
    zoneKey: requireValue(resource.config.zoneKey, `compiledSpec.resources[${resource.id}].config.zoneKey`),
    role: requireValue(resource.config.role, `compiledSpec.resources[${resource.id}].config.role`),
    privateIp: requireValue(
      resource.config.privateIp,
      `compiledSpec.resources[${resource.id}].config.privateIp`,
    ),
    ...(resource.config.exposePublic !== undefined
      ? { exposePublic: resource.config.exposePublic }
      : {}),
  }));

  return {
    vpcCidr,
    networkZones,
    hosts,
    publicEntry: {
      hostKey: publicEntryHostKey,
      protocols: [{ protocol: 'ssh', port: 22 }],
    },
  };
}

function resolveVpcCidr(
  topologySpec: RangeTemplateTopologySpec,
  compiledSpec: RangeTemplateCompiledSpec | null | undefined,
) {
  return topologySpec.vpcCidr || compiledSpec?.topology?.vpcCidr || '';
}

function isCompiledHostResource(resource: CompiledResource): resource is CompiledHostResource {
  return resource.type === 'host';
}

function isCompiledSwitchResource(resource: CompiledResource): resource is CompiledSwitchResource {
  return resource.type === 'switch';
}

function isCompiledNatGatewayResource(resource: CompiledResource): resource is CompiledNatGatewayResource {
  return resource.type === 'nat_gateway';
}

function isCompiledEipResource(resource: CompiledResource): resource is CompiledEipResource {
  return resource.type === 'eip';
}

function isCompiledSecurityGroupRuleResource(
  resource: CompiledResource,
): resource is CompiledSecurityGroupRuleResource {
  return resource.type === 'security_group_rule';
}

function isCompiledAclResource(resource: CompiledResource): resource is CompiledAclResource {
  return resource.type === 'acl';
}

function buildNatGatewaysFromCompiledSpec(compiledSpec: RangeTemplateCompiledSpec | null | undefined) {
  if (!compiledSpec) {
    return [];
  }

  return compiledSpec.resources.filter(isCompiledNatGatewayResource).map((resource) => ({
    key: resource.id,
    name: resource.config.label ?? resource.id,
    zoneKey: requireValue(resource.config.zoneKey, `compiledSpec.resources[${resource.id}].config.zoneKey`),
    snatEnabled: Boolean(resource.config.snatEnabled),
  }));
}

function buildEipsFromCompiledSpec(compiledSpec: RangeTemplateCompiledSpec | null | undefined) {
  if (!compiledSpec) {
    return [];
  }

  return compiledSpec.resources.filter(isCompiledEipResource).map((resource) => ({
    key: resource.id,
    name: resource.config.label ?? resource.id,
    bindTargetType:
      resource.config.bindTargetType === 'nat_gateway' ? ('nat_gateway' as const) : ('host' as const),
    bindTargetKey: requireValue(
      resource.config.bindTargetKey,
      `compiledSpec.resources[${resource.id}].config.bindTargetKey`,
    ),
    bandwidthMbps:
      typeof resource.config.bandwidthMbps === 'number' && Number.isFinite(resource.config.bandwidthMbps)
        ? resource.config.bandwidthMbps
        : 10,
  }));
}

function buildSecurityGroupRulesFromCompiledSpec(compiledSpec: RangeTemplateCompiledSpec | null | undefined) {
  if (!compiledSpec) {
    return [];
  }

  return compiledSpec.resources.filter(isCompiledSecurityGroupRuleResource).map((resource) => ({
    key: resource.id,
    name: resource.config.label ?? resource.id,
    targetHostKey: requireValue(
      resource.config.targetHostKey,
      `compiledSpec.resources[${resource.id}].config.targetHostKey`,
    ),
    direction: requireValue(
      resource.config.direction,
      `compiledSpec.resources[${resource.id}].config.direction`,
    ),
    policy: requireValue(resource.config.policy, `compiledSpec.resources[${resource.id}].config.policy`),
    protocol: requireValue(
      resource.config.protocol,
      `compiledSpec.resources[${resource.id}].config.protocol`,
    ),
    portRange: requireValue(
      resource.config.portRange,
      `compiledSpec.resources[${resource.id}].config.portRange`,
    ),
    sourceCidr: requireValue(
      resource.config.sourceCidr,
      `compiledSpec.resources[${resource.id}].config.sourceCidr`,
    ),
    priority:
      typeof resource.config.priority === 'number' && Number.isFinite(resource.config.priority)
        ? resource.config.priority
        : 1,
  }));
}

function buildAclDefinitionsFromCompiledSpec(compiledSpec: RangeTemplateCompiledSpec | null | undefined) {
  if (!compiledSpec) {
    return [];
  }

  return compiledSpec.resources.filter(isCompiledAclResource).map((resource) => ({
    key: resource.id,
    name: resource.config.label ?? resource.id,
    zoneKey: requireValue(resource.config.zoneKey, `compiledSpec.resources[${resource.id}].config.zoneKey`),
    direction: requireValue(
      resource.config.direction,
      `compiledSpec.resources[${resource.id}].config.direction`,
    ),
    policy: requireValue(resource.config.policy, `compiledSpec.resources[${resource.id}].config.policy`),
    protocol: requireValue(
      resource.config.protocol,
      `compiledSpec.resources[${resource.id}].config.protocol`,
    ),
    portRange: requireValue(
      resource.config.portRange,
      `compiledSpec.resources[${resource.id}].config.portRange`,
    ),
    sourceCidr: requireValue(
      resource.config.sourceCidr,
      `compiledSpec.resources[${resource.id}].config.sourceCidr`,
    ),
    priority:
      typeof resource.config.priority === 'number' && Number.isFinite(resource.config.priority)
        ? resource.config.priority
        : 1,
  }));
}

function createResourceNamePrefix(rangeInstanceId: string) {
  const normalized = rangeInstanceId.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();

  return `range-${normalized.slice(0, 9) || 'instance'}`;
}

function findZone(topologySpec: RangeTemplateTopologySpec, key: string): RangeTemplateNetworkZone {
  const zone = topologySpec.networkZones.find((item) => item.key === key);

  if (!zone) {
    throw new Error(`Template topology is missing required network zone: ${key}`);
  }

  return zone;
}

function findPublicEntryHost(topologySpec: RangeTemplateTopologySpec): RangeTemplateHost {
  const host = topologySpec.hosts.find((item) => item.key === topologySpec.publicEntry.hostKey);

  if (!host) {
    throw new Error(
      `Template topology public entry host not found: ${topologySpec.publicEntry.hostKey}`,
    );
  }

  return host;
}

function findHostByZone(topologySpec: RangeTemplateTopologySpec, zoneKey: string): RangeTemplateHost {
  const host = topologySpec.hosts.find((item) => item.zoneKey === zoneKey);

  if (!host) {
    throw new Error(`Template topology is missing required host in zone: ${zoneKey}`);
  }

  return host;
}

function requireValue(value: string | undefined, fieldName: string) {
  if (!value) {
    throw new Error(`Missing required topology field: ${fieldName}`);
  }

  return value;
}
