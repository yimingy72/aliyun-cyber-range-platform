export type ScenarioTemplateMetadata = {
  name: string;
  slug: string;
  version: string;
  cloudProvider: 'alibaba_cloud';
  iacType: 'opentofu' | 'terraform';
  description?: string;
  tags?: string[];
};

export type ScenarioTemplateTopology = {
  vpcCidr: string;
  entryHostKey: string;
  defaultRegion?: string;
  defaultZoneId?: string;
};

export type ScenarioTemplateSnatConfig = {
  enabled: boolean;
  natGatewayKey?: string;
  eipKey?: string;
};

export type ScenarioTemplateNetworkZone = {
  key: string;
  name: string;
  cidr: string;
  purpose: string;
  isPublicEntry?: boolean;
  routeRole?: 'entry' | 'internal' | 'egress';
  natGatewayKey?: string;
  snat?: ScenarioTemplateSnatConfig;
  aclPolicyRefs?: string[];
};

export type ScenarioTemplateHostNic = {
  deviceIndex: number;
  zoneKey: string;
  privateIp: string;
  description?: string;
};

export type ScenarioTemplateDnatMapping = {
  name: string;
  protocol: 'tcp' | 'udp';
  externalPort: number;
  internalPort: number;
};

export type ScenarioTemplateDnatConfig = {
  enabled: boolean;
  natGatewayKey?: string;
  eipKey?: string;
  mappings?: ScenarioTemplateDnatMapping[];
};

export type ScenarioTemplateAccountPreset = {
  username?: string;
  password?: string;
  passwordSecretRef?: string;
};

export type ScenarioTemplateHost = {
  key: string;
  name: string;
  role: string;
  zoneKey: string;
  primaryPrivateIp: string;
  exposePublic?: boolean;
  image?: string;
  platformImageAssetId?: string;
  imageId?: string;
  networkInterfaces?: ScenarioTemplateHostNic[];
  portGroupRefs?: string[];
  dnat?: ScenarioTemplateDnatConfig;
  bootstrapRef?: string;
  imagePolicyRef?: string;
  instanceTypePolicyRef?: string;
  accountPreset?: ScenarioTemplateAccountPreset;
  tags?: string[];
};

export type ScenarioTemplateNatGateway = {
  key: string;
  name: string;
  zoneKey: string;
};

export type ScenarioTemplateEip = {
  key: string;
  name: string;
  bindTargetType: 'host' | 'nat_gateway';
  bindTargetKey: string;
  bandwidthMbps: number;
};

export type ScenarioTemplateNatConfig = {
  natGateways: ScenarioTemplateNatGateway[];
  eips: ScenarioTemplateEip[];
};

export type ScenarioTemplatePortRule = {
  protocol: string;
  portRange: string;
  sourceCidr: string;
  description?: string;
};

export type ScenarioTemplatePortGroup = {
  key: string;
  name: string;
  rules: ScenarioTemplatePortRule[];
};

export type ScenarioTemplateSecurityGroupRule = {
  key: string;
  targetHostKey: string;
  direction: 'ingress' | 'egress';
  protocol: string;
  portRange: string;
  sourceCidr: string;
  policy: 'accept' | 'drop';
  priority?: number;
};

export type ScenarioTemplateAclRule = {
  key: string;
  zoneKey: string;
  direction: 'inbound' | 'outbound';
  protocol: string;
  portRange: string;
  sourceCidr: string;
  policy: 'allow' | 'drop';
  priority?: number;
};

export type ScenarioTemplateAccessConfig = {
  portGroups: ScenarioTemplatePortGroup[];
  securityGroupRules?: ScenarioTemplateSecurityGroupRule[];
  aclRules?: ScenarioTemplateAclRule[];
};

export type ScenarioTemplateBootstrapScript = {
  key: string;
  name: string;
  type: 'cloud-init' | 'shell';
  content: string;
};

export type ScenarioTemplateBootstrapConfig = {
  scripts: ScenarioTemplateBootstrapScript[];
};

export type ScenarioTemplateImagePolicy = {
  key: string;
  mode: 'fixed' | 'auto' | 'prefer-list';
  platformImageAssetId?: string;
  imageId?: string;
  preferredImageIds?: string[];
};

export type ScenarioTemplateInstanceTypePolicy = {
  key: string;
  mode: 'fixed' | 'auto' | 'prefer-list';
  instanceType?: string;
  preferredInstanceTypes?: string[];
};

export type ScenarioTemplateRuntimePreferences = {
  imagePolicies: ScenarioTemplateImagePolicy[];
  instanceTypePolicies: ScenarioTemplateInstanceTypePolicy[];
};

export type ScenarioTemplateSpec = {
  schemaVersion: '1.0.0';
  metadata: ScenarioTemplateMetadata;
  topology: ScenarioTemplateTopology;
  networkZones: ScenarioTemplateNetworkZone[];
  hosts: ScenarioTemplateHost[];
  nat: ScenarioTemplateNatConfig;
  access: ScenarioTemplateAccessConfig;
  bootstrap: ScenarioTemplateBootstrapConfig;
  runtimePreferences: ScenarioTemplateRuntimePreferences;
  extensions?: Record<string, unknown>;
};
