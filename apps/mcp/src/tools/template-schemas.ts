import { isHostDnsIpv4, isHostDnsDomain } from '@aliyun-cyber-range/scenario-runtime';
import * as z from 'zod/v4';

const identifier = z.string().trim().min(1);
const optionalRecord = z.object({}).passthrough().optional();
const operationSchema = z.strictObject({
  idempotencyKey: identifier.optional().describe('Reuse only for an identical write request when the server requires it.'),
  confirmationId: identifier.optional().describe('Provide only after the platform returns CONFIRMATION_REQUIRED.'),
});

const positionSchema = z.object({ x: z.number(), y: z.number() });
const aclRuleSchema = z.object({
  key: identifier,
  direction: z.enum(['inbound', 'outbound']),
  protocol: identifier,
  portRange: identifier.describe('端口格式为起始端口/结束端口，例如 80/80。全端口填写 1/65535，平台会按当前云厂商转换端口范围。'),
  sourceCidr: identifier.describe('源网段 CIDR，例如 10.0.0.0/24。'),
  destinationCidr: identifier.optional(),
  policy: z.enum(['allow', 'drop']),
  priority: z.number().int(),
  description: z.string().optional(),
}).strict();
const securityRuleSchema = z.object({
  key: identifier,
  direction: z.enum(['ingress', 'egress']),
  protocol: identifier,
  portRange: identifier.describe('端口格式为起始端口/结束端口，例如 80/80。全端口填写 1/65535，平台会按当前云厂商转换端口范围。'),
  sourceCidr: identifier.describe('源网段 CIDR，例如 10.0.0.0/24。'),
  policy: z.enum(['accept', 'drop']),
  priority: z.number().int().optional(),
  description: z.string().optional(),
}).passthrough();
const dnatMappingSchema = z.object({
  key: identifier,
  targetHostId: identifier.describe('DNAT 目标 ECS ID。可映射多台 ECS；每个目标必须有连接所属交换机的网卡，映射作用于该网卡的私网 IP。'),
  externalPort: z.number().int().min(1).max(65535),
  internalPort: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'udp']),
  description: z.string().optional(),
}).strict();
const switchNatSchema = z.object({
  snatEnabled: z.boolean().describe('所有开启 SNAT 的交换机共享由编译器派生的 SNAT EIP。'),
  dnatMappings: z.array(dnatMappingSchema).describe('公网 DNAT 的权威定义；可为空以构建无公网映射的拓扑，不得把公网 NAT 映射写在 ECS 节点上。'),
}).strict();
const nicSchema = z.object({
  id: identifier,
  switchId: identifier.describe('The real network attachment. It must have a matching switch-to-ECS graph edge.'),
  zoneKey: identifier.optional(),
  privateIp: identifier.describe('An unused IPv4 address inside the linked switch CIDR.'),
  secondaryIps: z.array(identifier).optional(),
  securityGroupRules: z.array(securityRuleSchema).optional(),
  securityGroupRulesMode: z.enum(['default', 'custom']).optional().describe('使用平台默认规则或明确配置的完整自定义规则。'),
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
  cidr: identifier.describe('IPv4 CIDR contained by 10.0.0.0/16, 172.16.0.0/16, or 192.168.0.0/16 and not overlapping another switch.'),
  purpose: identifier,
  aclRules: z.array(aclRuleSchema).describe('交换机 ACL 规则；没有规则时传 []。'),
  nat: switchNatSchema.describe('交换机级共享 NAT 配置；即使 SNAT 和 DNAT 均关闭也必须传入。'),
  position: positionSchema.optional(),
}).passthrough();
const fixedImageStrategySchema = z.object({
  mode: z.literal('fixed'),
  imageId: identifier.describe('The current cloud provider imageId resolved from the selected platform image asset.'),
}).strict();
const autoInstanceTypeStrategySchema = z.object({
  mode: z.literal('auto'),
}).strict();
const hostDnsSchema = z.object({
  servers: z.array(z.string().refine(isHostDnsIpv4, 'DNS server must be an IPv4 address.')).min(1).max(4),
  nicIds: z.array(identifier).min(1),
  domain: z.string().refine(isHostDnsDomain, 'Use an ASCII AD DNS domain.').optional(),
}).strict();
const ecsNodeSchema = z.object({
  id: identifier,
  kind: z.literal('ecs'),
  label: identifier,
  zoneKey: identifier,
  role: identifier,
  privateIp: identifier.describe('Must equal the first NIC privateIp.'),
  exposePublic: z.boolean().optional().default(false),
  image: identifier.describe('Human-readable image displayName copied from the selected platform image asset. It is not the image identity.'),
  platformImageAssetId: identifier.describe('The unique enabled platform image asset selected by the conversion Skill.'),
  imageId: identifier.describe('The current cloud provider imageId resolved from platformImageAssetId.'),
  imageStrategy: fixedImageStrategySchema,
  instanceTypeStrategy: autoInstanceTypeStrategySchema,
  nics: z.array(nicSchema).min(1),
  dns: hostDnsSchema.optional().describe('Per-host guest DNS; nicIds must name this host’s attached NICs. Optional domain enables AD SRV verification.'),
  position: positionSchema.optional(),
  cpu: z.number().int().positive().optional().describe('CPU 核数；必须与 memory 共同满足平台支持的准确规格。'),
  memory: z.number().int().positive().optional().describe('内存 GiB；不接受派生云机型策略。'),
  hostName: z.string().optional(),
  instanceName: z.string().optional(),
  description: z.string().optional(),
  bootPriority: z.number().int().optional(),
  bootWaitSeconds: z.number().int().min(0).optional(),
  initScript: z.string().optional().describe('用户启动任务脚本，省略时为空；DNS 由独立 dns 配置内部生成，不写在此字段。'),
  customPassword: z.string().optional().describe('Sensitive. Only provide when explicitly requested; it is never returned by read tools.'),
}).passthrough().superRefine((node, context) => {
  if (node.dns) {
    if (new Set(node.dns.servers).size !== node.dns.servers.length) {
      context.addIssue({ code: 'custom', path: ['dns', 'servers'], message: 'DNS servers must be unique.' });
    }
    if (new Set(node.dns.nicIds).size !== node.dns.nicIds.length || node.dns.nicIds.some((id) => !node.nics.some((nic) => nic.id === id))) {
      context.addIssue({ code: 'custom', path: ['dns', 'nicIds'], message: 'DNS NIC IDs must be unique and attached to this host.' });
    }
  }
  if (node.imageStrategy.imageId !== node.imageId) {
    context.addIssue({
      code: 'custom',
      path: ['imageStrategy', 'imageId'],
      message: 'imageStrategy.imageId must equal the resolved imageId.',
    });
  }
});

const templateNodeSchema = z.discriminatedUnion('kind', [routerNodeSchema, switchNodeSchema, ecsNodeSchema]);

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

const templateTopologyMetadataSchema = z.object({
  publicEntryProtocols: z.array(z.object({ protocol: identifier, port: z.number().int().min(1).max(65535) })).min(1).optional(),
});
const templateWriteSchema = operationSchema.extend({ templateId: identifier });

export const templateListInputSchema = z.strictObject({ view: z.enum(['platform', 'mine', 'all']).optional() });
export const templateGetInputSchema = z.strictObject({ templateId: identifier });
export const templateCreateInputSchema = operationSchema.extend({
  name: identifier,
  description: z.string().optional(),
  ...templateTopologyMetadataSchema.shape,
  topologyGraph: topologyGraphSchema,
  variableSchema: optionalRecord,
  outputSchema: optionalRecord,
  defaultNetworkPolicy: optionalRecord,
}).strict();
export const templateUpdateInputSchema = templateWriteSchema.extend({
  expectedRevision: z.number().int().min(1).describe('用户编辑信息时读取的准确模板 revision，防止覆盖之后的改动。'),
  updates: z.object({
    name: identifier.optional(),
    description: z.string().optional(),
  }).strict().refine((updates) => updates.name !== undefined || updates.description !== undefined, '至少提供 name 或 description'),
});
export const templateCloneInputSchema = templateWriteSchema;
export const templateDetectAndSaveInputSchema = templateWriteSchema.extend({
  expectedRevision: z.number().int().min(1).describe('调用者编辑拓扑时读取的准确模板 revision；旧版本不得覆盖当前拓扑。'),
  topologyGraph: topologyGraphSchema.describe('待保存的完整拓扑图。必须由设计转换 Skill 产出，且包含 Router、交换机、ECS、NIC 与实际连线。'),
  ...templateTopologyMetadataSchema.shape,
}).strict();
export const templateLifecycleInputSchema = templateWriteSchema;
