import { resolveFixedInstanceType } from './instance-type-catalog';
import type { TemplateNode } from './scenario-graph';
import type {
  ScenarioTemplateAclRule,
  ScenarioTemplateAccessConfig,
  ScenarioTemplateBootstrapConfig,
  ScenarioTemplateDnatMapping,
  ScenarioTemplateHost,
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

function readResolvedInstanceTypePolicy(node: Extract<TemplateNode, { kind: 'ecs' }>) {
  const fixedInstanceType =
    readConfiguredInstanceType(node.instanceTypeStrategy.instanceType) ??
    resolveFixedInstanceType(node.cpu, node.memory);

  if (fixedInstanceType) {
    return {
      mode: 'fixed' as const,
      instanceType: fixedInstanceType,
      preferredInstanceTypes: undefined,
    };
  }

  return {
    mode: node.instanceTypeStrategy.mode === 'prefer-family' ? 'prefer-list' : node.instanceTypeStrategy.mode,
    instanceType: node.instanceTypeStrategy.instanceType,
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
  const entryHost = hostNodes.find((node) => node.exposePublic || node.role === 'entry') ?? hostNodes[0] ?? null;
  const entryHostPlacement = entryHost ? readHostPrimaryPlacement(entryHost, switchById, switchNodes) : null;

  const derivedNatSwitches = switchNodes.filter((node) => {
    const candidate = readRecord(node);
    const nat = readRecord(candidate?.nat) as SwitchNatDraft | null;
    const dnatMappings = Array.isArray(nat?.dnatMappings) ? nat.dnatMappings : [];
    return Boolean(nat?.snatEnabled) || dnatMappings.length > 0;
  });

  const nat: ScenarioTemplateNatConfig = {
    natGateways: [
      ...derivedNatSwitches.map((node) => ({
        key: `nat-${node.id}`,
        name: `${node.label} NAT`,
        zoneKey: node.zoneKey,
      })),
    ],
    eips: [
      ...derivedNatSwitches.map((node) => ({
        key: `eip-${node.id}`,
        name: `${node.label} EIP`,
        bindTargetType: 'nat_gateway' as const,
        bindTargetKey: `nat-${node.id}`,
        bandwidthMbps: 30,
      })),
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

        return nics.flatMap<ScenarioTemplateSecurityGroupRule>((nic) =>
          (nic.securityGroupRules ?? []).map((rule, index) => ({
            key: rule.key ?? `${host.id}-nic-sg-${index + 1}`,
            targetHostKey: host.id,
            direction: readIngressDirection(rule.direction),
            protocol: typeof rule.protocol === 'string' ? rule.protocol : 'all',
            portRange: typeof rule.portRange === 'string' ? rule.portRange : '-1/-1',
            sourceCidr: typeof rule.sourceCidr === 'string' ? rule.sourceCidr : '0.0.0.0/0',
            policy: readAcceptPolicy(rule.policy),
            priority: typeof rule.priority === 'number' ? rule.priority : 1,
          })),
        );
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
          portRange: typeof rule.portRange === 'string' ? rule.portRange : '-1/-1',
          sourceCidr: typeof rule.sourceCidr === 'string' ? rule.sourceCidr : '0.0.0.0/0',
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
      imageId: host.imageStrategy.imageId,
      preferredImageIds: host.imageStrategy.preferredImageIds,
    })),
    instanceTypePolicies: hostNodes.map((host) => {
      const resolvedPolicy = readResolvedInstanceTypePolicy(host);

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
      isPublicEntry: node.zoneKey === entryHostPlacement?.zoneKey,
      routeRole: node.zoneKey === entryHostPlacement?.zoneKey ? 'entry' : 'internal',
      snat: readRecord(node)?.nat
        ? {
            enabled: Boolean((readRecord(node)?.nat as SwitchNatDraft | null)?.snatEnabled),
            natGatewayKey: `nat-${node.id}`,
            eipKey: `eip-${node.id}`,
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
      const normalizedNetworkInterfaces =
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
                  deviceIndex: index,
                  zoneKey,
                  privateIp,
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
            natGatewayKey: `nat-${switchNode.id}`,
            eipKey: `eip-${switchNode.id}`,
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
        role: node.role,
        zoneKey: primaryPlacement.zoneKey,
        primaryPrivateIp: primaryPlacement.privateIp,
        exposePublic: node.exposePublic,
        image: node.image || node.imageId || node.imageName,
        networkInterfaces: normalizedNetworkInterfaces,
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
