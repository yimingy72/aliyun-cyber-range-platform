import * as z from 'zod/v4';

const identifier = z.string().trim().min(1);
const optionalRecord = z.object({}).passthrough().optional();
const operationSchema = z.object({
  idempotencyKey: identifier.optional().describe('Reuse only for an identical write request when the server requires it.'),
  confirmationId: identifier.optional().describe('Provide only after the platform returns CONFIRMATION_REQUIRED.'),
});

const positionSchema = z.object({ x: z.number(), y: z.number() });
const securityRuleSchema = z.object({
  key: identifier,
  direction: z.enum(['ingress', 'egress']),
  protocol: identifier,
  portRange: identifier,
  sourceCidr: identifier,
  policy: z.enum(['accept', 'drop']),
  priority: z.number().int().optional(),
  description: z.string().optional(),
}).passthrough();
const nicSchema = z.object({
  id: identifier,
  switchId: identifier.describe('The real network attachment. It must have a matching switch-to-ECS graph edge.'),
  zoneKey: identifier.optional(),
  privateIp: identifier.describe('An unused IPv4 address inside the linked switch CIDR.'),
  secondaryIps: z.array(identifier).optional(),
  securityGroupRules: z.array(securityRuleSchema).optional(),
}).passthrough();
const routerNodeSchema = z.object({
  id: identifier,
  kind: z.literal('router'),
  label: identifier,
  position: positionSchema.optional(),
}).passthrough();
const switchNodeSchema = z.object({
  id: identifier,
  kind: z.literal('switch'),
  label: identifier,
  zoneKey: identifier,
  cidr: identifier.describe('IPv4 CIDR contained by the template VPC CIDR and not overlapping another switch.'),
  purpose: identifier,
  position: positionSchema.optional(),
}).passthrough();
const ecsNodeSchema = z.object({
  id: identifier,
  kind: z.literal('ecs'),
  label: identifier,
  zoneKey: identifier,
  role: identifier,
  privateIp: identifier.describe('Must equal the first NIC privateIp.'),
  exposePublic: z.boolean(),
  image: identifier,
  nics: z.array(nicSchema).min(1),
  position: positionSchema.optional(),
  customPassword: z.string().optional().describe('Sensitive. Only provide when explicitly requested; it is never returned by read tools.'),
}).passthrough();

const templateNodeSchema = z.union([routerNodeSchema, switchNodeSchema, ecsNodeSchema]);

export const templateEdgeSchema = z.object({
  id: identifier,
  fromNodeId: identifier,
  toNodeId: identifier,
  relationType: z.literal('manual'),
  label: z.string().optional(),
});
export const topologyGraphSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  nodes: z.array(templateNodeSchema).min(2),
  edges: z.array(templateEdgeSchema),
});

const templateMetadataSchema = z.object({
  name: identifier,
  slug: identifier,
  version: identifier,
  description: z.string().optional(),
  cloudProvider: z.literal('alibaba_cloud'),
  iacType: z.enum(['opentofu', 'terraform']),
  modulePathOrRef: identifier,
  primaryVpcCidr: identifier.optional().describe('Primary IPv4 CIDR used to create the VPC.'),
  secondaryVpcCidrs: z.array(identifier).max(4).optional().describe('Additional, non-overlapping IPv4 CIDRs attached to the same VPC.'),
  vpcCidr: identifier.optional().describe('Deprecated alias for primaryVpcCidr.'),
  defaultRegion: identifier.optional(),
  defaultZoneId: identifier.optional(),
  publicEntryProtocols: z.array(z.object({ protocol: identifier, port: z.number().int().min(1).max(65535) })).min(1).optional(),
});
const templateWriteSchema = operationSchema.extend({ templateId: identifier });

export const templateListInputSchema = z.object({ view: z.enum(['platform', 'mine']).optional() });
export const templateGetInputSchema = z.object({ templateId: identifier });
export const templateCreateInputSchema = operationSchema.extend({
  ...templateMetadataSchema.shape,
  topologyGraph: topologyGraphSchema,
  variableSchema: optionalRecord,
  outputSchema: optionalRecord,
  defaultNetworkPolicy: optionalRecord,
}).strict();
export const templateUpdateInputSchema = templateWriteSchema.extend({
  updates: z.object({
    name: identifier.optional(),
    slug: identifier.optional(),
    version: identifier.optional(),
    description: z.string().optional(),
    cloudProvider: z.literal('alibaba_cloud').optional(),
    iacType: z.enum(['opentofu', 'terraform']).optional(),
    modulePathOrRef: identifier.optional(),
    defaultRegion: identifier.optional(),
    defaultZoneId: identifier.optional(),
    variableSchema: optionalRecord,
    outputSchema: optionalRecord,
    defaultNetworkPolicy: optionalRecord,
  }).strict(),
});
export const templateCloneInputSchema = templateWriteSchema;
export const templateDetectAndSaveInputSchema = templateWriteSchema.extend({
  topologyGraph: topologyGraphSchema.describe('待保存的完整拓扑图。必须由设计转换 Skill 产出，且包含 Router、交换机、ECS、NIC 与实际连线。'),
  ...templateMetadataSchema.partial().shape,
});
export const templateLifecycleInputSchema = templateWriteSchema;
