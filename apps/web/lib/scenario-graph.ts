export const PHASE_ONE_NODE_KINDS = ['router', 'switch', 'ecs'] as const;

export type TemplateNodeKind = (typeof PHASE_ONE_NODE_KINDS)[number];

export function isPhaseOneNodeKind(kind: unknown): kind is TemplateNodeKind {
  return typeof kind === 'string' && (PHASE_ONE_NODE_KINDS as readonly string[]).includes(kind);
}

export type TemplateNodeDnatMapping = {
  name: string;
  natGatewayKey: string;
  eipKey: string;
  externalPort: number;
  internalPort: number;
  protocol: string;
};

export type TemplateNodeNetworkInterface = {
  zoneKey: string;
  privateIp: string;
};

export type TemplateNodePortGroup = {
  name: string;
  protocol: string;
  portRange: string;
  sourceCidr: string;
};

export type TemplateNodeImageStrategy = {
  mode: 'fixed' | 'auto' | 'prefer-list';
  imageId?: string;
  preferredImageIds?: string[];
};

export type TemplateNodeInstanceTypeStrategy = {
  mode: 'fixed' | 'auto' | 'prefer-family' | 'prefer-list';
  instanceType?: string;
  preferredInstanceTypes?: string[];
};

export type ScenarioGraphAclRule = {
  key: string;
  direction: 'inbound' | 'outbound';
  protocol: string;
  portRange: string;
  sourceCidr: string;
  destinationCidr?: string;
  policy: 'allow' | 'drop';
  priority: number;
  description?: string;
};

export type ScenarioGraphSecurityGroupRule = {
  key: string;
  direction: 'ingress' | 'egress';
  protocol: string;
  portRange: string;
  sourceCidr: string;
  policy: 'accept' | 'drop';
  priority: number;
  description?: string;
};

export type SecurityGroupRulesMode = 'default' | 'custom';

export type ScenarioGraphNic = {
  id: string;
  switchId: string;
  zoneKey?: string;
  privateIp: string;
  secondaryIps: string[];
  securityGroupRules: ScenarioGraphSecurityGroupRule[];
  securityGroupRulesMode?: SecurityGroupRulesMode;
};

export function getPlatformDefaultSecurityGroupRules(nicId: string): ScenarioGraphSecurityGroupRule[] {
  return [
    {
      key: `${nicId}-default-ssh`,
      direction: 'ingress',
      protocol: 'tcp',
      portRange: '22/22',
      sourceCidr: '0.0.0.0/0',
      policy: 'accept',
      priority: 1,
      description: '平台默认 SSH 访问',
    },
    {
      key: `${nicId}-default-http`,
      direction: 'ingress',
      protocol: 'tcp',
      portRange: '80/80',
      sourceCidr: '0.0.0.0/0',
      policy: 'accept',
      priority: 1,
      description: '平台默认 HTTP 访问',
    },
  ];
}

export function resolveSecurityGroupRulesMode(nic: ScenarioGraphNic): SecurityGroupRulesMode {
  if (nic.securityGroupRulesMode) {
    return nic.securityGroupRulesMode;
  }

  return nic.securityGroupRules.length > 0 ? 'custom' : 'default';
}

export function getEffectiveSecurityGroupRules(nic: ScenarioGraphNic): ScenarioGraphSecurityGroupRule[] {
  return resolveSecurityGroupRulesMode(nic) === 'default'
    ? getPlatformDefaultSecurityGroupRules(nic.id)
    : nic.securityGroupRules;
}

export type ScenarioGraphSwitchDnatMapping = {
  key: string;
  targetHostId: string;
  externalPort: number;
  internalPort: number;
  protocol: 'tcp' | 'udp';
  description?: string;
};

export type ScenarioGraphSwitchNat = {
  snatEnabled: boolean;
  dnatMappings: ScenarioGraphSwitchDnatMapping[];
};

export type ScenarioGraphPosition = {
  x: number;
  y: number;
};

type TemplateNodeBase = {
  id: string;
  kind: TemplateNodeKind;
  label: string;
  position?: ScenarioGraphPosition;
};

export type EcsTemplateNode = TemplateNodeBase & {
  kind: 'ecs';
  zoneKey: string;
  role: string;
  privateIp: string;
  customPassword?: string;
  exposePublic: boolean;
  image: string;
  instanceName?: string;
  hostName?: string;
  imageName?: string;
  imageId?: string;
  cpu?: number;
  memory?: number;
  instanceType?: string;
  description?: string;
  bootPriority?: number;
  bootWaitSeconds?: number;
  dnatMappings: TemplateNodeDnatMapping[];
  networkInterfaces: TemplateNodeNetworkInterface[];
  portGroups: TemplateNodePortGroup[];
  nics?: ScenarioGraphNic[];
  initScript: string;
  imageStrategy: TemplateNodeImageStrategy;
  instanceTypeStrategy: TemplateNodeInstanceTypeStrategy;
};

export type SwitchTemplateNode = TemplateNodeBase & {
  kind: 'switch';
  zoneKey: string;
  cidr: string;
  purpose: string;
  description?: string;
  enableNat?: boolean;
  snatEnabled?: boolean;
  snatNatGatewayKey?: string;
  snatEipKey?: string;
  aclRules?: ScenarioGraphAclRule[];
  nat?: ScenarioGraphSwitchNat;
};

export type RouterTemplateNode = TemplateNodeBase & {
  kind: 'router';
  description?: string;
  routeRole: string;
  egressType: string;
  bindEip: boolean;
};

export type TemplateNode = EcsTemplateNode | SwitchTemplateNode | RouterTemplateNode;

export type DnatExternalPortUsage = {
  switchId: string;
  switchLabel: string;
  mappingKey: string;
  mappingIndex: number;
  externalPort: number;
};

export type DnatExternalPortConflict = {
  externalPort: number;
  usages: DnatExternalPortUsage[];
};

export function findDuplicateDnatExternalPorts(nodes: TemplateNode[]): DnatExternalPortConflict[] {
  const usagesByPort = new Map<number, DnatExternalPortUsage[]>();

  nodes.forEach((node) => {
    if (node.kind !== 'switch') {
      return;
    }

    (node.nat?.dnatMappings ?? []).forEach((mapping, index) => {
      if (!Number.isInteger(mapping.externalPort) || mapping.externalPort < 1 || mapping.externalPort > 65535) {
        return;
      }

      const usage: DnatExternalPortUsage = {
        switchId: node.id,
        switchLabel: node.label,
        mappingKey: mapping.key,
        mappingIndex: index,
        externalPort: mapping.externalPort,
      };
      const usages = usagesByPort.get(mapping.externalPort) ?? [];
      usages.push(usage);
      usagesByPort.set(mapping.externalPort, usages);
    });
  });

  return [...usagesByPort.entries()]
    .filter(([, usages]) => usages.length > 1)
    .map(([externalPort, usages]) => ({ externalPort, usages }));
}

export type ScenarioGraphEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: 'manual';
  label?: string;
};

export type ScenarioGraphDraft = {
  schemaVersion: string;
  nodes: TemplateNode[];
  edges: ScenarioGraphEdge[];
};
