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
const templateNodePatchSchema = z.object({
  label: identifier.optional(),
  zoneKey: identifier.optional(),
  role: identifier.optional(),
  privateIp: identifier.optional(),
  exposePublic: z.boolean().optional(),
  image: identifier.optional(),
  nics: z.array(nicSchema).min(1).optional(),
  customPassword: z.string().optional(),
  position: positionSchema.optional(),
}).passthrough().refine((patch) => Object.keys(patch).length > 0, 'patch must contain at least one field');

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
  vpcCidr: identifier.optional(),
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
});
export const templateUpdateInputSchema = templateWriteSchema.extend({
  updates: z.object({
    ...templateMetadataSchema.partial().shape,
    topologyGraph: topologyGraphSchema.optional(),
    variableSchema: optionalRecord,
    outputSchema: optionalRecord,
    defaultNetworkPolicy: optionalRecord,
  }).strict(),
});
export const templateCloneInputSchema = templateWriteSchema;
export const templateValidateInputSchema = templateWriteSchema;
export const templateDetectInputSchema = operationSchema.extend({
  templateId: identifier.optional(),
  topologyGraph: topologyGraphSchema.optional(),
  ...templateMetadataSchema.partial().shape,
}).refine((input) => Boolean(input.templateId || input.topologyGraph), 'templateId or topologyGraph is required');
export const templateNodeAddInputSchema = templateWriteSchema.extend({ node: templateNodeSchema });
export const templateNodeUpdateInputSchema = templateWriteSchema.extend({ nodeId: identifier, patch: templateNodePatchSchema });
export const templateNodeRemoveInputSchema = templateWriteSchema.extend({ nodeId: identifier });
export const templateEdgeAddInputSchema = templateWriteSchema.extend({ edge: templateEdgeSchema });
export const templateEdgeRemoveInputSchema = templateWriteSchema.extend({ edgeId: identifier });
export const templateChangesetInputSchema = templateWriteSchema.extend({
  changes: z.array(
    z.union([
      z.object({ op: z.literal('add-node'), node: templateNodeSchema }),
      z.object({ op: z.literal('update-node'), nodeId: identifier, patch: templateNodePatchSchema }),
      z.object({ op: z.literal('remove-node'), nodeId: identifier }),
      z.object({ op: z.literal('add-edge'), edge: templateEdgeSchema }),
      z.object({ op: z.literal('remove-edge'), edgeId: identifier }),
    ]),
  ).min(1),
  vpcCidr: identifier.optional(),
  publicEntryProtocols: z.array(z.object({ protocol: identifier, port: z.number().int().min(1).max(65535) })).min(1).optional(),
});
export const templateLifecycleInputSchema = templateWriteSchema;
