import { validateHostDnsConfig } from './host-dns';
import { resolvePreferredInstanceTypes } from './instance-type-catalog';
import { normalizeAlibabaCloudPortRange } from './alibaba-cloud-port-range';
import {
  getPlatformDefaultSecurityGroupRules,
  resolveUniqueDnatEntryHost,
  type TemplateNode,
} from './scenario-graph';
import type {
  ScenarioTemplateAclRule,
  ScenarioTemplateAccessConfig,
  ScenarioTemplateBootstrapConfig,
  ScenarioTemplateDnatMapping,
  ScenarioTemplateHost,
  ScenarioTemplateHostNic,
  ScenarioTemplateMetadata,
  ScenarioTemplateNatConfig,
  ScenarioTemplateNetworkZone,
  ScenarioTemplateRuntimePreferences,
  ScenarioTemplateSecurityGroupRule,
  ScenarioTemplateSpec,
} from './scenario-template-spec';

export type TopologyGraphDraft = {
  schemaVersion: string;
  nodes: TemplateNode[];
  edges: Array<Record<string, unknown>>;
};

type SwitchNatDraft = {
  snatEnabled?: boolean;
  dnatMappings?: Array<{
    key?: string;
    targetHostId?: string;
    externalPort?: number;
    internalPort?: number;
    protocol?: string;
    description?: string;
  }>;
};

type SwitchAclRuleDraft = {
  key?: string;
  direction?: string;
  protocol?: string;
  portRange?: string;
  sourceCidr?: string;
  destinationCidr?: string;
  policy?: string;
  priority?: number;
  description?: string;
};

type HostNicSecurityRuleDraft = {
  key?: string;
  direction?: string;
  protocol?: string;
  portRange?: string;
  sourceCidr?: string;
  policy?: string;
  priority?: number;
  description?: string;
};

type HostNicDraft = {
  id?: string;
  switchId?: string;
  zoneKey?: string;
  privateIp?: string;
  secondaryIps?: string[];
  securityGroupRules?: HostNicSecurityRuleDraft[];
  securityGroupRulesMode?: 'default' | 'custom';
};

function readRecord(value: unknown) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readIngressDirection(value: string | undefined): 'ingress' | 'egress' {
  return value === 'egress' ? 'egress' : 'ingress';
}

function readInboundDirection(value: string | undefined): 'inbound' | 'outbound' {
  return value === 'outbound' ? 'outbound' : 'inbound';
}

function readAcceptPolicy(value: string | undefined): 'accept' | 'drop' {
  return value === 'drop' ? 'drop' : 'accept';
}

function readAllowPolicy(value: string | undefined): 'allow' | 'drop' {
  return value === 'drop' ? 'drop' : 'allow';
}

function readTransportProtocol(value: string | undefined): 'tcp' | 'udp' {
  return value === 'udp' ? 'udp' : 'tcp';
}

function readProvisionHostName(node: Extract<TemplateNode, { kind: 'ecs' }>) {
  return node.hostName?.trim() || node.label.trim() || node.id;
}

function readConfiguredInstanceType(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readResolvedInstanceTypePolicy(node: Extract<TemplateNode, { kind: 'ecs' }>, provider: ScenarioTemplateMetadata['cloudProvider']) {
  const fixedInstanceType = readConfiguredInstanceType(node.instanceTypeStrategy.instanceType);

  if (node.instanceTypeStrategy.mode === 'fixed' && fixedInstanceType) {
    return {
      mode: 'fixed' as const,
      instanceType: fixedInstanceType,
      preferredInstanceTypes: undefined,
    };
  }

  const configuredPreferredInstanceTypes =
    node.instanceTypeStrategy.preferredInstanceTypes?.filter((item) => item.trim().length > 0) ?? [];
  const preferredInstanceTypes =
    configuredPreferredInstanceTypes.length > 0
      ? configuredPreferredInstanceTypes
      : provider === 'alibaba_cloud' ? resolvePreferredInstanceTypes(node.cpu, node.memory) : [];

  if (preferredInstanceTypes.length > 0) {
    return {
      mode: 'prefer-list' as const,
      instanceType: undefined,
      preferredInstanceTypes: [...preferredInstanceTypes],
    };
  }

  return {
    mode: node.instanceTypeStrategy.mode === 'prefer-family' ? 'prefer-list' : node.instanceTypeStrategy.mode,
    instanceType: fixedInstanceType,
    preferredInstanceTypes: node.instanceTypeStrategy.preferredInstanceTypes,
  };
}

function readHostPrimaryPlacement(
  node: Extract<TemplateNode, { kind: 'ecs' }>,
  switchById: Map<string, Extract<TemplateNode, { kind: 'switch' }>>,
  switchNodes: Array<Extract<TemplateNode, { kind: 'switch' }>>,
) {
  const candidate = readRecord(node);
  const nics = Array.isArray(candidate?.nics) ? (candidate.nics as HostNicDraft[]) : [];
  const primaryNic = nics[0];
  const resolvedSwitch =
    primaryNic && typeof primaryNic.switchId === 'string' ? switchById.get(primaryNic.switchId) : null;
  const fallbackSwitch =
    !resolvedSwitch && typeof primaryNic?.zoneKey === 'string'
      ? switchNodes.find((switchCandidate) => switchCandidate.zoneKey === primaryNic.zoneKey)
      : null;

  return {
    zoneKey: resolvedSwitch?.zoneKey ?? fallbackSwitch?.zoneKey ?? primaryNic?.zoneKey ?? node.zoneKey,
    privateIp: primaryNic?.privateIp ?? node.privateIp,
  };
}

export function buildScenarioTemplateSpecFromTopologyGraph(input: {
  topologyGraph: TopologyGraphDraft;
  metadata: ScenarioTemplateMetadata;
  defaults?: {
    vpcCidr?: string;
    defaultRegion?: string;
    defaultZoneId?: string;
  };
}): ScenarioTemplateSpec {
  const switchNodes = input.topologyGraph.nodes.filter(
    (node): node is Extract<TemplateNode, { kind: 'switch' }> => node.kind === 'switch',
  );
  const hostNodes = input.topologyGraph.nodes.filter(
    (node): node is Extract<TemplateNode, { kind: 'ecs' }> => node.kind === 'ecs',
  );
  const switchById = new Map(switchNodes.map((node) => [node.id, node]));
  const entryResolution = resolveUniqueDnatEntryHost(input.topologyGraph.nodes);
  const dnatHostIds = new Set(entryResolution.kind === 'single' ? [entryResolution.targetHostId] : entryResolution.kind === 'multiple' ? entryResolution.targetHostIds : []);
  // Keep a management host for legacy access summaries without implying a public mapping.
  const entryHostId = [...dnatHostIds][0] ?? hostNodes[0]?.id;
  const entryHost = hostNodes.find((node) => node.id === entryHostId) ?? null;

  const derivedNatSwitches = switchNodes.filter((node) => {
    const candidate = readRecord(node);
    const nat = readRecord(candidate?.nat) as SwitchNatDraft | null;
    const dnatMappings = Array.isArray(nat?.dnatMappings) ? nat.dnatMappings : [];
    return Boolean(nat?.snatEnabled) || dnatMappings.length > 0;
  });
  const snatEnabled = switchNodes.some((node) => Boolean(node.nat?.snatEnabled));
  const dnatEnabled = switchNodes.some((node) => (node.nat?.dnatMappings?.length ?? 0) > 0);
  const sharedNatGatewayKey = 'nat-shared';
  const sharedSnatEipKey = 'eip-snat-shared';
  const sharedDnatEipKey = 'eip-dnat-shared';

  const nat: ScenarioTemplateNatConfig = {
    natGateways: [
      ...(derivedNatSwitches[0]
        ? [
            {
              key: sharedNatGatewayKey,
              name: '共享 NAT',
              zoneKey: derivedNatSwitches[0].zoneKey,
            },
          ]
        : []),
    ],
    eips: [
      ...(snatEnabled
        ? [
            {
              key: sharedSnatEipKey,
              name: '共享 SNAT EIP',
              bindTargetType: 'nat_gateway' as const,
              bindTargetKey: sharedNatGatewayKey,
              bandwidthMbps: 30,
            },
          ]
        : []),
      ...(dnatEnabled
        ? [
            {
              key: sharedDnatEipKey,
              name: '共享 DNAT EIP',
              bindTargetType: 'nat_gateway' as const,
              bindTargetKey: sharedNatGatewayKey,
              bandwidthMbps: 30,
            },
          ]
        : []),
    ],
  };

  const access: ScenarioTemplateAccessConfig = {
    portGroups: hostNodes.flatMap((host) =>
      (host.portGroups ?? []).map((group, index) => ({
        key: `${host.id}-port-group-${index + 1}`,
        name: group.name,
        rules: [group],
      })),
    ),
    securityGroupRules: [
      ...hostNodes.flatMap((host) => {
        const candidate = readRecord(host);
        const nics = Array.isArray(candidate?.nics) ? (candidate.nics as HostNicDraft[]) : [];

        return nics.flatMap<ScenarioTemplateSecurityGroupRule>((nic, nicIndex) => {
          const storedRules = nic.securityGroupRules ?? [];
          const usePlatformDefaults =
            nicIndex === 0 &&
            (nic.securityGroupRulesMode === 'default' ||
              (nic.securityGroupRulesMode === undefined && storedRules.length === 0));
          const rules = usePlatformDefaults
            ? getPlatformDefaultSecurityGroupRules(nic.id ?? `${host.id}-nic-${nicIndex + 1}`)
            : storedRules;

          return rules.map((rule, index) => ({
            key: `${host.id}-${nic.id ?? nicIndex}-${rule.key ?? index + 1}`,
            targetHostKey: host.id,
            targetDeviceIndex: nicIndex,
            direction: readIngressDirection(rule.direction),
            protocol: typeof rule.protocol === 'string' ? rule.protocol : 'all',
            portRange: normalizeAlibabaCloudPortRange(
              typeof rule.portRange === 'string' ? rule.portRange : '-1/-1',
              typeof rule.protocol === 'string' ? rule.protocol : 'all',
            ),
            sourceCidr: typeof rule.sourceCidr === 'string' ? rule.sourceCidr : '0.0.0.0/0',
            policy: readAcceptPolicy(rule.policy),
            priority: typeof rule.priority === 'number' ? rule.priority : 1,
          }));
        });
      }),
    ],
    aclRules: [
      ...switchNodes.flatMap<ScenarioTemplateAclRule>((node) => {
        const candidate = readRecord(node);
        const aclRules = Array.isArray(candidate?.aclRules) ? (candidate.aclRules as SwitchAclRuleDraft[]) : [];

        return aclRules.map((rule, index) => ({
          key: rule.key ?? `${node.id}-acl-${index + 1}`,
          zoneKey: node.zoneKey,
          direction: readInboundDirection(rule.direction),
          protocol: typeof rule.protocol === 'string' ? rule.protocol : 'all',
          portRange: normalizeAlibabaCloudPortRange(
            typeof rule.portRange === 'string' ? rule.portRange : '-1/-1',
            typeof rule.protocol === 'string' ? rule.protocol : 'all',
          ),
          sourceCidr: rule.direction === 'outbound' && rule.destinationCidr
            ? rule.destinationCidr
            : typeof rule.sourceCidr === 'string' ? rule.sourceCidr : '0.0.0.0/0',
          policy: readAllowPolicy(rule.policy),
          priority: typeof rule.priority === 'number' ? rule.priority : 1,
        }));
      }),
    ],
  };

  const bootstrapScripts: ScenarioTemplateBootstrapConfig = {
    scripts: hostNodes
      .filter((host) => host.initScript.trim().length > 0)
      .map((host) => ({
        key: `${host.id}-bootstrap`,
        name: `${host.label} 初始化脚本`,
        type: 'shell' as const,
        content: host.initScript,
      })),
  };

  const runtimePreferences: ScenarioTemplateRuntimePreferences = {
    imagePolicies: hostNodes.map((host) => ({
      key: `${host.id}-image-policy`,
      mode: host.imageStrategy.mode,
      platformImageAssetId: host.platformImageAssetId,
      imageId: host.imageStrategy.imageId,
      preferredImageIds: host.imageStrategy.preferredImageIds,
    })),
    instanceTypePolicies: hostNodes.map((host) => {
      const resolvedPolicy = readResolvedInstanceTypePolicy(host, input.metadata.cloudProvider);

      return {
        key: `${host.id}-instance-type-policy`,
        mode: resolvedPolicy.mode,
        instanceType: resolvedPolicy.instanceType,
        preferredInstanceTypes: resolvedPolicy.preferredInstanceTypes,
      };
    }),
  };

  return {
    schemaVersion: '1.0.0',
    metadata: input.metadata,
    topology: {
      vpcCidr: input.defaults?.vpcCidr ?? '10.0.0.0/16',
      entryHostKey: entryHost?.id ?? '',
      defaultRegion: input.defaults?.defaultRegion,
      defaultZoneId: input.defaults?.defaultZoneId,
    },
    networkZones: switchNodes.map<ScenarioTemplateNetworkZone>((node) => ({
      key: node.zoneKey,
      name: node.label,
      cidr: node.cidr,
      purpose: node.purpose,
      isPublicEntry: (node.nat?.dnatMappings?.length ?? 0) > 0,
      routeRole: (node.nat?.dnatMappings?.length ?? 0) > 0 ? 'entry' : 'internal',
      snat: readRecord(node)?.nat
        ? {
            enabled: Boolean((readRecord(node)?.nat as SwitchNatDraft | null)?.snatEnabled),
            ...(Boolean((readRecord(node)?.nat as SwitchNatDraft | null)?.snatEnabled)
              ? {
                  natGatewayKey: sharedNatGatewayKey,
                  eipKey: sharedSnatEipKey,
                }
              : {}),
          }
        : {
            enabled: Boolean(node.snatEnabled),
            natGatewayKey: node.snatNatGatewayKey || undefined,
            eipKey: node.snatEipKey || undefined,
          },
    })),
    hosts: hostNodes.map<ScenarioTemplateHost>((node) => {
      const candidate = readRecord(node);
      const nics = Array.isArray(candidate?.nics) ? (candidate.nics as HostNicDraft[]) : [];
      const legacyNetworkInterfaces = node.networkInterfaces ?? [];
      const normalizedNetworkInterfaces: ScenarioTemplateHostNic[] =
        nics.length > 0
          ? nics.flatMap((nic, index) => {
              const switchNode =
                (typeof nic.switchId === 'string' ? switchById.get(nic.switchId) : null) ??
                (typeof nic.zoneKey === 'string'
                  ? switchNodes.find((switchCandidate) => switchCandidate.zoneKey === nic.zoneKey)
                  : null);
              const zoneKey = switchNode?.zoneKey ?? nic.zoneKey;
              const privateIp = typeof nic.privateIp === 'string' ? nic.privateIp : '';

              if (!zoneKey || !privateIp) {
                return [];
              }

              return [
                {
                  nicId: nic.id,
                  deviceIndex: index,
                  zoneKey,
                  privateIp,
                  secondaryIps: nic.secondaryIps ?? [],
                },
              ];
            })
          : legacyNetworkInterfaces.map((networkInterface, index) => ({
              deviceIndex: index,
              zoneKey: networkInterface.zoneKey,
              privateIp: networkInterface.privateIp,
            }));

      const syntheticDnatMappings = switchNodes.flatMap((switchNode) => {
        const nat = readRecord(switchNode)?.nat as SwitchNatDraft | null;
        const dnatMappings = Array.isArray(nat?.dnatMappings) ? nat.dnatMappings : [];

        return dnatMappings
          .filter((mapping) => mapping.targetHostId === node.id)
          .map((mapping, index) => ({
            name: mapping.key ?? mapping.description ?? `${node.id}-dnat-${index + 1}`,
            natGatewayKey: sharedNatGatewayKey,
            eipKey: sharedDnatEipKey,
            backendPrivateIp: node.nics?.find((nic) => nic.switchId === switchNode.id)?.privateIp,
            backendZoneKey: switchNode.zoneKey,
            externalPort: typeof mapping.externalPort === 'number' ? mapping.externalPort : 0,
            internalPort: typeof mapping.internalPort === 'number' ? mapping.internalPort : 0,
            protocol: readTransportProtocol(mapping.protocol),
          }))
          .filter((mapping) => mapping.externalPort > 0 && mapping.internalPort > 0);
      });

      const normalizedDnatConfig =
        syntheticDnatMappings.length > 0
          ? {
              natGatewayKey: syntheticDnatMappings[0]?.natGatewayKey,
              eipKey: syntheticDnatMappings[0]?.eipKey,
              mappings: syntheticDnatMappings.map<ScenarioTemplateDnatMapping>((mapping) => ({
                name: mapping.name,
                ...(mapping.backendPrivateIp ? { backendPrivateIp: mapping.backendPrivateIp, backendZoneKey: mapping.backendZoneKey } : {}),
                externalPort: mapping.externalPort,
                internalPort: mapping.internalPort,
                protocol: mapping.protocol,
              })),
            }
          : {
              natGatewayKey: node.dnatMappings[0]?.natGatewayKey,
              eipKey: node.dnatMappings[0]?.eipKey,
              mappings: (node.dnatMappings ?? []).map<ScenarioTemplateDnatMapping>((mapping) => ({
                name: mapping.name,
                externalPort: mapping.externalPort,
                internalPort: mapping.internalPort,
                protocol: readTransportProtocol(mapping.protocol),
              })),
            };

      const primaryPlacement = readHostPrimaryPlacement(node, switchById, switchNodes);

      return {
        key: node.id,
        name: readProvisionHostName(node),
        hostName: node.hostName?.trim() || undefined,
        role: node.role,
        zoneKey: primaryPlacement.zoneKey,
        primaryPrivateIp: primaryPlacement.privateIp,
        exposePublic: dnatHostIds.has(node.id),
        image: node.image || node.imageId || node.imageName,
        platformImageAssetId: node.platformImageAssetId,
        imageId: node.imageId,
        networkInterfaces: normalizedNetworkInterfaces,
        ...(node.dns !== undefined ? { dns: validateHostDnsConfig(node.dns, normalizedNetworkInterfaces.flatMap((nic) => nic.nicId ? [nic.nicId] : []), `ECS ${node.id}.dns`) } : {}),
        portGroupRefs: (node.portGroups ?? []).map((_, index) => `${node.id}-port-group-${index + 1}`),
        dnat: {
          enabled: normalizedDnatConfig.mappings.length > 0,
          natGatewayKey: normalizedDnatConfig.natGatewayKey,
          eipKey: normalizedDnatConfig.eipKey,
          mappings: normalizedDnatConfig.mappings,
        },
        bootstrapRef: node.initScript.trim().length > 0 ? `${node.id}-bootstrap` : undefined,
        imagePolicyRef: `${node.id}-image-policy`,
        instanceTypePolicyRef: `${node.id}-instance-type-policy`,
        accountPreset:
          typeof node.customPassword === 'string' && node.customPassword.length > 0
            ? {
                password: node.customPassword,
              }
            : undefined,
      };
    }),
    nat,
    access,
    bootstrap: bootstrapScripts,
    runtimePreferences,
  };
}
