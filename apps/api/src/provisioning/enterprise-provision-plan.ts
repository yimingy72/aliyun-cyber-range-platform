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
    hostName?: string | null;
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

type CompiledSnatEntryResource = CompiledResource & {
  type: 'snat_entry';
  config: {
    label?: string;
    natGatewayKey?: string;
    sourceZoneKey?: string;
    eipKey?: string;
  };
};

type CompiledDnatEntryResource = CompiledResource & {
  type: 'dnat_entry';
  config: {
    label?: string;
    natGatewayKey?: string;
    eipKey?: string;
    backendHostKey?: string;
    externalPort?: number;
    internalPort?: number;
    protocol?: string;
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
    secondaryVpcCidrs: string[];
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
    hostName: string | null;
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
  snatEntries: Array<{
    key: string;
    name: string;
    natGatewayKey: string;
    sourceZoneKey: string;
    eipKey: string;
  }>;
  dnatEntries: Array<{
    key: string;
    name: string;
    natGatewayKey: string;
    eipKey: string;
    backendHostKey: string;
    externalPort: number;
    internalPort: number;
    protocol: string;
  }>;
  hostNetworkInterfaces: Array<{
    hostKey: string;
    interfaces: Array<{
      deviceIndex: number;
      zoneKey: string;
      privateIp: string;
      description?: string;
    }>;
  }>;
  bootstrapScripts: Array<{
    key: string;
    name: string;
    type: 'cloud-init' | 'shell';
    content: string;
    targetHostKeys: string[];
  }>;
  runtimeSelections: {
    imagePolicies: Record<string, unknown>;
    instanceTypePolicies: Record<string, unknown>;
  };
  hosts: {
    publicEntry: RangeTemplateHost;
    officePrimary: RangeTemplateHost;
    serverPrimary: RangeTemplateHost;
  };
};

type CompiledProvisionSpecRecord = Record<string, unknown>;

export function buildEnterpriseProvisionPlan(input: {
  rangeInstanceId: string;
  templateModulePath: string;
  topologySpec?: RangeTemplateTopologySpec | null;
  compiledProvisionSpec?: CompiledProvisionSpecRecord | null;
  compiledSpec?: RangeTemplateCompiledSpec | null;
  allocatedCidr: string | null;
}): EnterpriseProvisionPlan {
  const topologySpec =
    input.topologySpec ??
    buildTopologySpecFromCompiledProvisionSpec(input.compiledProvisionSpec) ??
    buildTopologySpecFromCompiledSpec(input.compiledSpec);

  if (!topologySpec) {
    throw new Error('Missing provisioning blueprint: topologySpec or compiledSpec.resources is required');
  }

  const vpcCidr = requireValue(
    resolveVpcCidr(topologySpec, input.compiledProvisionSpec, input.compiledSpec),
    'topologySpec.vpcCidr',
  );
  const secondaryVpcCidrs = resolveSecondaryVpcCidrs(input.compiledProvisionSpec);

  if (input.allocatedCidr && input.allocatedCidr !== vpcCidr) {
    throw new Error(
      `Allocated CIDR ${input.allocatedCidr} does not match template topology VPC CIDR ${vpcCidr}`,
    );
  }

  const publicEntry = findPublicEntryHost(topologySpec);
  const compatibilityZones = deriveCompatibilityZones(topologySpec, publicEntry.zoneKey);
  const compatibilityHosts = deriveCompatibilityHosts(topologySpec, publicEntry, compatibilityZones);
  const natGateways =
    buildNatGatewaysFromCompiledProvisionSpec(input.compiledProvisionSpec) ||
    buildNatGatewaysFromCompiledSpec(input.compiledSpec);
  const eipDefinitions =
    buildEipsFromCompiledProvisionSpec(input.compiledProvisionSpec) || buildEipsFromCompiledSpec(input.compiledSpec);
  const compiledProvisionSecurityGroupRules = buildSecurityGroupRulesFromCompiledProvisionSpec(
    input.compiledProvisionSpec,
  );
  const securityGroupRules = resolveSecurityGroupRules({
    compiledProvisionSecurityGroupRules,
    compiledProvisionSpec: input.compiledProvisionSpec,
    compiledSpec: input.compiledSpec,
    hosts: topologySpec.hosts,
  });
  const aclDefinitions =
    buildAclDefinitionsFromCompiledProvisionSpec(input.compiledProvisionSpec) ||
    buildAclDefinitionsFromCompiledSpec(input.compiledSpec);
  const snatEntries =
    buildSnatEntriesFromCompiledProvisionSpec(input.compiledProvisionSpec) ||
    buildSnatEntriesFromCompiledSpec(input.compiledSpec);
  const dnatEntries =
    buildDnatEntriesFromCompiledProvisionSpec(input.compiledProvisionSpec) ||
    buildDnatEntriesFromCompiledSpec(input.compiledSpec);
  const hostNetworkInterfaces = buildHostNetworkInterfacesFromCompiledProvisionSpec(input.compiledProvisionSpec);
  const bootstrapScripts = buildBootstrapScriptsFromCompiledProvisionSpec(input.compiledProvisionSpec);
  const runtimeSelections = buildRuntimeSelectionsFromCompiledProvisionSpec(input.compiledProvisionSpec);

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
      secondaryVpcCidrs,
      dmzCidr: compatibilityZones.dmz.cidr,
      officeCidr: compatibilityZones.office.cidr,
      serverCidr: compatibilityZones.server.cidr,
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
      hostName: host.hostName?.trim() ?? null,
      zoneKey: host.zoneKey,
      privateIp: host.privateIp,
      role: host.role,
      exposePublic: host.key === topologySpec.publicEntry.hostKey || Boolean(host.exposePublic),
    })),
    natGateways,
    eipDefinitions,
    securityGroupRules,
    aclDefinitions,
    snatEntries,
    dnatEntries,
    hostNetworkInterfaces,
    bootstrapScripts,
    runtimeSelections,
    hosts: {
      publicEntry,
      officePrimary: compatibilityHosts.officePrimary,
      serverPrimary: compatibilityHosts.serverPrimary,
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
    ...(typeof resource.config.hostName === 'string' && resource.config.hostName.trim()
      ? { hostName: resource.config.hostName.trim() }
      : {}),
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

function buildTopologySpecFromCompiledProvisionSpec(
  compiledProvisionSpec: CompiledProvisionSpecRecord | null | undefined,
): RangeTemplateTopologySpec | null {
  if (!compiledProvisionSpec) {
    return null;
  }

  const topology = readRecord(compiledProvisionSpec.topology);
  const networkZones = readArray(compiledProvisionSpec.networkZones);
  const hosts = readArray(compiledProvisionSpec.hosts);
  const vpcCidr = typeof topology?.vpcCidr === 'string' ? topology.vpcCidr : null;
  const entryHostKey = typeof topology?.entryHostKey === 'string' ? topology.entryHostKey : null;

  if (!vpcCidr || !entryHostKey || networkZones.length === 0 || hosts.length === 0) {
    return null;
  }

  return {
    vpcCidr,
    networkZones: networkZones.flatMap((zoneValue) => {
      const zone = readRecord(zoneValue);
      if (!zone || typeof zone.key !== 'string' || typeof zone.name !== 'string' || typeof zone.cidr !== 'string') {
        return [];
      }

      return [{
        key: zone.key,
        name: zone.name,
        purpose: typeof zone.purpose === 'string' ? zone.purpose : zone.key,
        cidr: zone.cidr,
        ...(zone.isPublicEntry === true ? { isPublicEntry: true } : {}),
      }];
    }),
    hosts: hosts.flatMap((hostValue) => {
      const host = readRecord(hostValue);
      if (
        !host ||
        typeof host.key !== 'string' ||
        typeof host.name !== 'string' ||
        typeof host.zoneKey !== 'string' ||
        typeof host.role !== 'string' ||
        typeof host.primaryPrivateIp !== 'string'
      ) {
        return [];
      }

      return [{
        key: host.key,
        name: host.name,
        ...(typeof host.hostName === 'string' && host.hostName.trim()
          ? { hostName: host.hostName.trim() }
          : {}),
        zoneKey: host.zoneKey,
        role: host.role,
        privateIp: host.primaryPrivateIp,
        ...(host.exposePublic === true ? { exposePublic: true } : {}),
      }];
    }),
    publicEntry: {
      hostKey: entryHostKey,
      protocols: [{ protocol: 'ssh', port: 22 }],
    },
  };
}

function resolveVpcCidr(
  topologySpec: RangeTemplateTopologySpec,
  compiledProvisionSpec: CompiledProvisionSpecRecord | null | undefined,
  compiledSpec: RangeTemplateCompiledSpec | null | undefined,
) {
  const topology = readRecord(compiledProvisionSpec?.topology);
  return topologySpec.vpcCidr || (typeof topology?.vpcCidr === 'string' ? topology.vpcCidr : '') || compiledSpec?.topology?.vpcCidr || '';
}

function resolveSecondaryVpcCidrs(compiledProvisionSpec: CompiledProvisionSpecRecord | null | undefined) {
  const topology = readRecord(compiledProvisionSpec?.topology);

  return [...new Set(
    readArray(topology?.secondaryVpcCidrs).filter(
      (cidr): cidr is string => typeof cidr === 'string' && cidr.trim().length > 0,
    ),
  )];
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

function isCompiledSnatEntryResource(resource: CompiledResource): resource is CompiledSnatEntryResource {
  return resource.type === 'snat_entry';
}

function isCompiledDnatEntryResource(resource: CompiledResource): resource is CompiledDnatEntryResource {
  return resource.type === 'dnat_entry';
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

function buildNatGatewaysFromCompiledProvisionSpec(compiledProvisionSpec: CompiledProvisionSpecRecord | null | undefined) {
  if (!compiledProvisionSpec) {
    return null;
  }

  return readArray(compiledProvisionSpec.natGateways).flatMap((value) => {
    const record = readRecord(value);
    if (!record || typeof record.key !== 'string' || typeof record.zoneKey !== 'string') {
      return [];
    }

    return [{
      key: record.key,
      name: typeof record.name === 'string' ? record.name : record.key,
      zoneKey: record.zoneKey,
      snatEnabled: true,
    }];
  });
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

function buildEipsFromCompiledProvisionSpec(compiledProvisionSpec: CompiledProvisionSpecRecord | null | undefined) {
  if (!compiledProvisionSpec) {
    return null;
  }

  return readArray(compiledProvisionSpec.eips).flatMap((value) => {
    const record = readRecord(value);
    if (!record || typeof record.key !== 'string' || typeof record.bindTargetKey !== 'string') {
      return [];
    }

    return [{
      key: record.key,
      name: typeof record.name === 'string' ? record.name : record.key,
      bindTargetType: record.bindTargetType === 'nat_gateway' ? ('nat_gateway' as const) : ('host' as const),
      bindTargetKey: record.bindTargetKey,
      bandwidthMbps: typeof record.bandwidthMbps === 'number' ? record.bandwidthMbps : 10,
    }];
  });
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

function buildSecurityGroupRulesFromCompiledProvisionSpec(
  compiledProvisionSpec: CompiledProvisionSpecRecord | null | undefined,
) {
  if (!compiledProvisionSpec) {
    return null;
  }

  return readArray(compiledProvisionSpec.securityGroupRules).flatMap((value) => {
    const record = readRecord(value);
    if (!record || typeof record.key !== 'string' || typeof record.targetHostKey !== 'string') {
      return [];
    }

    return [{
      key: record.key,
      name: typeof record.name === 'string' ? record.name : record.key,
      targetHostKey: record.targetHostKey,
      direction: typeof record.direction === 'string' ? record.direction : 'ingress',
      policy: typeof record.policy === 'string' ? record.policy : 'accept',
      protocol: typeof record.protocol === 'string' ? record.protocol : 'tcp',
      portRange: typeof record.portRange === 'string' ? record.portRange : '22/22',
      sourceCidr: typeof record.sourceCidr === 'string' ? record.sourceCidr : '0.0.0.0/0',
      priority: typeof record.priority === 'number' ? record.priority : 1,
    }];
  });
}

function resolveSecurityGroupRules(input: {
  compiledProvisionSecurityGroupRules: ReturnType<typeof buildSecurityGroupRulesFromCompiledProvisionSpec>;
  compiledProvisionSpec: CompiledProvisionSpecRecord | null | undefined;
  compiledSpec: RangeTemplateCompiledSpec | null | undefined;
  hosts: RangeTemplateHost[];
}) {
  const explicitRules = input.compiledProvisionSecurityGroupRules ?? buildSecurityGroupRulesFromCompiledSpec(input.compiledSpec);

  if (explicitRules.length > 0 || input.compiledProvisionSpec?.securityGroupRulesConfigured === true) {
    return explicitRules;
  }

  return input.hosts.flatMap((host) => [
    {
      key: `${host.key}-default-ssh`,
      name: `${host.key} default SSH`,
      targetHostKey: host.key,
      direction: 'ingress',
      policy: 'accept',
      protocol: 'tcp',
      portRange: '22/22',
      sourceCidr: '0.0.0.0/0',
      priority: 1,
    },
    {
      key: `${host.key}-default-http`,
      name: `${host.key} default HTTP`,
      targetHostKey: host.key,
      direction: 'ingress',
      policy: 'accept',
      protocol: 'tcp',
      portRange: '80/80',
      sourceCidr: '0.0.0.0/0',
      priority: 1,
    },
  ]);
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
    policy: normalizeNetworkAclPolicy(
      requireValue(resource.config.policy, `compiledSpec.resources[${resource.id}].config.policy`),
    ),
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

function buildAclDefinitionsFromCompiledProvisionSpec(compiledProvisionSpec: CompiledProvisionSpecRecord | null | undefined) {
  if (!compiledProvisionSpec) {
    return null;
  }

  return readArray(compiledProvisionSpec.aclRules).flatMap((value) => {
    const record = readRecord(value);
    if (!record || typeof record.key !== 'string' || typeof record.zoneKey !== 'string') {
      return [];
    }

    return [{
      key: record.key,
      name: typeof record.name === 'string' ? record.name : record.key,
      zoneKey: record.zoneKey,
      direction: typeof record.direction === 'string' ? record.direction : 'inbound',
      policy: normalizeNetworkAclPolicy(typeof record.policy === 'string' ? record.policy : 'accept'),
      protocol: typeof record.protocol === 'string' ? record.protocol : 'tcp',
      portRange: typeof record.portRange === 'string' ? record.portRange : '22/22',
      sourceCidr: typeof record.sourceCidr === 'string' ? record.sourceCidr : '0.0.0.0/0',
      priority: typeof record.priority === 'number' ? record.priority : 1,
    }];
  });
}

function normalizeNetworkAclPolicy(policy: string) {
  return policy === 'allow' ? 'accept' : policy;
}

function buildSnatEntriesFromCompiledSpec(compiledSpec: RangeTemplateCompiledSpec | null | undefined) {
  if (!compiledSpec) {
    return [];
  }

  return compiledSpec.resources.filter(isCompiledSnatEntryResource).map((resource) => ({
    key: resource.id,
    name: resource.config.label ?? resource.id,
    natGatewayKey: requireValue(
      resource.config.natGatewayKey,
      `compiledSpec.resources[${resource.id}].config.natGatewayKey`,
    ),
    sourceZoneKey: requireValue(
      resource.config.sourceZoneKey,
      `compiledSpec.resources[${resource.id}].config.sourceZoneKey`,
    ),
    eipKey: requireValue(resource.config.eipKey, `compiledSpec.resources[${resource.id}].config.eipKey`),
  }));
}

function buildSnatEntriesFromCompiledProvisionSpec(compiledProvisionSpec: CompiledProvisionSpecRecord | null | undefined) {
  if (!compiledProvisionSpec) {
    return null;
  }

  return readArray(compiledProvisionSpec.snatEntries).flatMap((value) => {
    const record = readRecord(value);
    if (!record || typeof record.key !== 'string' || typeof record.zoneKey !== 'string') {
      return [];
    }

    return [{
      key: record.key,
      name: typeof record.name === 'string' ? record.name : record.key,
      natGatewayKey: requireValue(
        typeof record.natGatewayKey === 'string' ? record.natGatewayKey : undefined,
        `compiledProvisionSpec.snatEntries[${record.key}].natGatewayKey`,
      ),
      sourceZoneKey: record.zoneKey,
      eipKey: requireValue(
        typeof record.eipKey === 'string' ? record.eipKey : undefined,
        `compiledProvisionSpec.snatEntries[${record.key}].eipKey`,
      ),
    }];
  });
}

function buildDnatEntriesFromCompiledSpec(compiledSpec: RangeTemplateCompiledSpec | null | undefined) {
  if (!compiledSpec) {
    return [];
  }

  return compiledSpec.resources.filter(isCompiledDnatEntryResource).map((resource) => ({
    key: resource.id,
    name: resource.config.label ?? resource.id,
    natGatewayKey: requireValue(
      resource.config.natGatewayKey,
      `compiledSpec.resources[${resource.id}].config.natGatewayKey`,
    ),
    eipKey: requireValue(resource.config.eipKey, `compiledSpec.resources[${resource.id}].config.eipKey`),
    backendHostKey: requireValue(
      resource.config.backendHostKey,
      `compiledSpec.resources[${resource.id}].config.backendHostKey`,
    ),
    externalPort:
      typeof resource.config.externalPort === 'number' && Number.isFinite(resource.config.externalPort)
        ? resource.config.externalPort
        : 0,
    internalPort:
      typeof resource.config.internalPort === 'number' && Number.isFinite(resource.config.internalPort)
        ? resource.config.internalPort
        : 0,
    protocol: requireValue(resource.config.protocol, `compiledSpec.resources[${resource.id}].config.protocol`),
  }));
}

function buildDnatEntriesFromCompiledProvisionSpec(compiledProvisionSpec: CompiledProvisionSpecRecord | null | undefined) {
  if (!compiledProvisionSpec) {
    return null;
  }

  return readArray(compiledProvisionSpec.dnatEntries).flatMap((value) => {
    const record = readRecord(value);
    if (!record || typeof record.key !== 'string' || typeof record.hostKey !== 'string') {
      return [];
    }

    return [{
      key: record.key,
      name: typeof record.name === 'string' ? record.name : record.key,
      natGatewayKey: requireValue(
        typeof record.natGatewayKey === 'string' ? record.natGatewayKey : undefined,
        `compiledProvisionSpec.dnatEntries[${record.key}].natGatewayKey`,
      ),
      eipKey: requireValue(
        typeof record.eipKey === 'string' ? record.eipKey : undefined,
        `compiledProvisionSpec.dnatEntries[${record.key}].eipKey`,
      ),
      backendHostKey: record.hostKey,
      externalPort: typeof record.externalPort === 'number' ? record.externalPort : 0,
      internalPort: typeof record.internalPort === 'number' ? record.internalPort : 0,
      protocol: typeof record.protocol === 'string' ? record.protocol : 'tcp',
    }];
  });
}

function buildHostNetworkInterfacesFromCompiledProvisionSpec(
  compiledProvisionSpec: CompiledProvisionSpecRecord | null | undefined,
) {
  if (!compiledProvisionSpec) {
    return [];
  }

  return readArray(compiledProvisionSpec.hosts).flatMap((value) => {
    const record = readRecord(value);
    if (!record || typeof record.key !== 'string') {
      return [];
    }

    const interfaces = readArray(record.networkInterfaces).flatMap((interfaceValue) => {
      const nic = readRecord(interfaceValue);
      if (!nic || typeof nic.zoneKey !== 'string' || typeof nic.privateIp !== 'string') {
        return [];
      }

      return [{
        deviceIndex: typeof nic.deviceIndex === 'number' ? nic.deviceIndex : 0,
        zoneKey: nic.zoneKey,
        privateIp: nic.privateIp,
        ...(typeof nic.description === 'string' ? { description: nic.description } : {}),
      }];
    });

    return [{
      hostKey: record.key,
      interfaces,
    }];
  });
}

function buildBootstrapScriptsFromCompiledProvisionSpec(
  compiledProvisionSpec: CompiledProvisionSpecRecord | null | undefined,
) {
  if (!compiledProvisionSpec) {
    return [];
  }

  return readArray(compiledProvisionSpec.bootstrapScripts).flatMap((value) => {
    const record = readRecord(value);
    if (!record || typeof record.key !== 'string' || typeof record.content !== 'string') {
      return [];
    }

    return [{
      key: record.key,
      name: typeof record.name === 'string' ? record.name : record.key,
      type: record.type === 'cloud-init' ? ('cloud-init' as const) : ('shell' as const),
      content: record.content,
      targetHostKeys: readArray(record.targetHostKeys).filter((item): item is string => typeof item === 'string'),
    }];
  });
}

function buildRuntimeSelectionsFromCompiledProvisionSpec(
  compiledProvisionSpec: CompiledProvisionSpecRecord | null | undefined,
) {
  if (!compiledProvisionSpec) {
    return {
      imagePolicies: {},
      instanceTypePolicies: {},
    };
  }

  const runtimeSelections = readRecord(compiledProvisionSpec.runtimeSelections);

  return {
    imagePolicies: readRecord(runtimeSelections?.imagePolicies) ?? {},
    instanceTypePolicies: readRecord(runtimeSelections?.instanceTypePolicies) ?? {},
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function createResourceNamePrefix(rangeInstanceId: string) {
  const normalized = rangeInstanceId.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();

  return `range-${normalized.slice(0, 9) || 'instance'}`;
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

function deriveCompatibilityZones(
  topologySpec: RangeTemplateTopologySpec,
  entryZoneKey: string,
): {
  dmz: RangeTemplateNetworkZone;
  office: RangeTemplateNetworkZone;
  server: RangeTemplateNetworkZone;
} {
  const entryZone = topologySpec.networkZones.find((item) => item.key === entryZoneKey) ?? topologySpec.networkZones[0];

  if (!entryZone) {
    throw new Error('Template topology does not define any network zone');
  }

  const remainingZones = topologySpec.networkZones.filter((item) => item.key !== entryZone.key);

  return {
    dmz: entryZone,
    office: remainingZones[0] ?? entryZone,
    server: remainingZones[1] ?? remainingZones[0] ?? entryZone,
  };
}

function deriveCompatibilityHosts(
  topologySpec: RangeTemplateTopologySpec,
  publicEntry: RangeTemplateHost,
  zones: {
    dmz: RangeTemplateNetworkZone;
    office: RangeTemplateNetworkZone;
    server: RangeTemplateNetworkZone;
  },
): {
  officePrimary: RangeTemplateHost;
  serverPrimary: RangeTemplateHost;
} {
  const nonEntryHosts = topologySpec.hosts.filter((item) => item.key !== publicEntry.key);
  const officePrimary =
    nonEntryHosts.find((item) => item.zoneKey === zones.office.key) ??
    nonEntryHosts[0] ??
    publicEntry;
  const serverPrimary =
    nonEntryHosts.find((item) => item.zoneKey === zones.server.key && item.key !== officePrimary.key) ??
    nonEntryHosts.find((item) => item.key !== officePrimary.key) ??
    officePrimary;

  return {
    officePrimary,
    serverPrimary,
  };
}

function requireValue(value: string | undefined, fieldName: string) {
  if (!value) {
    throw new Error(`Missing required topology field: ${fieldName}`);
  }

  return value;
}
