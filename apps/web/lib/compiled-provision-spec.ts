import type {
  ScenarioTemplateImagePolicy,
  ScenarioTemplateInstanceTypePolicy,
} from './scenario-template-spec';

export type CompiledProvisionSpec = {
  schemaVersion: '1.0.0';
  identity: {
    templateSlug: string;
    templateVersion: string;
    cloudProvider: 'alibaba_cloud';
    iacType: 'opentofu' | 'terraform';
  };
  topology: {
    vpcCidr: string;
    entryHostKey: string;
  };
  networkZones: CompiledNetworkZone[];
  hosts: CompiledHost[];
  natGateways: CompiledNatGateway[];
  eips: CompiledEip[];
  snatEntries: CompiledSnatEntry[];
  dnatEntries: CompiledDnatEntry[];
  securityGroupRulesConfigured: true;
  securityGroupRules: CompiledSecurityGroupRule[];
  aclRules: CompiledAclRule[];
  bootstrapScripts: CompiledBootstrapScript[];
  runtimeSelections: {
    imagePolicies: Record<string, ScenarioTemplateImagePolicy>;
    instanceTypePolicies: Record<string, ScenarioTemplateInstanceTypePolicy>;
  };
};

export type CompiledNetworkZone = {
  key: string;
  name: string;
  cidr: string;
  purpose: string;
  isPublicEntry: boolean;
  routeRole: 'entry' | 'internal' | 'egress';
  natGatewayKey?: string;
};

export type CompiledHost = {
  key: string;
  name: string;
  role: string;
  zoneKey: string;
  primaryPrivateIp: string;
  exposePublic: boolean;
  networkInterfaces: Array<{
    deviceIndex: number;
    zoneKey: string;
    privateIp: string;
    description?: string;
  }>;
  bootstrapScriptKey?: string;
  imagePolicyKey?: string;
  instanceTypePolicyKey?: string;
  tags?: string[];
};

export type CompiledNatGateway = {
  key: string;
  name: string;
  zoneKey: string;
};

export type CompiledEip = {
  key: string;
  name: string;
  bindTargetType: 'host' | 'nat_gateway';
  bindTargetKey: string;
  bandwidthMbps: number;
};

export type CompiledSnatEntry = {
  key: string;
  zoneKey: string;
  natGatewayKey: string;
  eipKey: string;
};

export type CompiledDnatEntry = {
  key: string;
  hostKey: string;
  natGatewayKey: string;
  eipKey: string;
  protocol: 'tcp' | 'udp';
  externalPort: number;
  internalPort: number;
};

export type CompiledSecurityGroupRule = {
  key: string;
  targetHostKey: string;
  direction: 'ingress' | 'egress';
  protocol: string;
  portRange: string;
  sourceCidr: string;
  policy: 'accept' | 'drop';
  priority: number;
  derivedFromPortGroupKey?: string;
};

export type CompiledAclRule = {
  key: string;
  zoneKey: string;
  direction: 'inbound' | 'outbound';
  protocol: string;
  portRange: string;
  sourceCidr: string;
  policy: 'allow' | 'drop';
  priority: number;
};

export type CompiledBootstrapScript = {
  key: string;
  name: string;
  type: 'cloud-init' | 'shell';
  content: string;
  targetHostKeys: string[];
};
