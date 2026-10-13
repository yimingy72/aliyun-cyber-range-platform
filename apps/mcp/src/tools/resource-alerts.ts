import * as z from 'zod/v4';
import { resultOutputSchema } from './output-schemas';
import { operationSchema } from './input-schemas';
import type { ToolDefinition } from './tool-context';
import type { ResourceAlertStatus } from '@aliyun-cyber-range/platform-api-client';

const id = z.string().trim().min(1).max(192);
const status = z.enum(['pending', 'unverified', 'reclaiming', 'failed', 'resolved']);
const provider = z.enum(['alibaba_cloud', 'tencent_cloud']);
const resource = z.object({ type: z.string(), id });
const alert = z.object({ id, cloudWorkspaceId: id, provider, accountUid: z.string(), regionId: z.string(),
  type: z.string(), resourceId: id, rangeInstanceId: id.nullable(), rangeName: z.string().nullable(),
  reason: z.string(), status, firstSeenAt: z.string(), lastSeenAt: z.string(),
  evidenceSummary: z.object({ recordedInventory: z.boolean(), sourceJobIds: z.array(id), accountVerified: z.boolean() }),
  remainingResources: z.array(resource), errorSummary: z.string().nullable(), jobId: id.nullable() });
const patrol = z.object({ managerUserId: id.nullable(), managerUsername: z.string().nullable(),
  cloudWorkspaceId: id.nullable(), provider: provider.nullable(), accountUid: z.string().nullable(),
  status: z.enum(['not_configured', 'unavailable', 'failed', 'ready', 'pending']),
  lastScanAt: z.string().nullable(), lastScanError: z.string().nullable(), regions: z.array(z.string()),
  lastCompleted: z.object({ at: z.string(), regions: z.array(z.string()), succeeded: z.boolean() }).nullable() });
const preview = z.object({ alertId: id, cloudWorkspaceId: id, provider, accountUid: z.string(), regionId: z.string(),
  rangeInstanceId: id.nullable(), resources: z.array(resource), planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reclaimable: z.boolean(), reason: z.string().nullable() });
export const resourceAlertTools: ToolDefinition[] = [
  { name: 'resource_patrol_get', title: '查询后台资源巡检目标', adminOnly: true, readOnlyHint: true,
    description: '仅平台超管可查看后台巡检所跟随的指定超管、其当前账号及最近扫描完成度。浏览器关闭仍扫描。只巡检指定账号，已受理作业仍用原冻结账号；检查失败不能解释为没有残留。',
    requiredScopes: ['settings:read'], inputSchema: z.strictObject({}), outputSchema: resultOutputSchema(patrol),
    async call(context) { return patrol.parse(await context.client.getResourcePatrol()); } },
  { name: 'resource_patrol_manager_set', title: '指定后台巡检跟随的超管', adminOnly: true,
    description: '指定准确平台超管用户 ID，省略时使用当前经过认证的超管。后台每5分钟只扫描其持久化的当前工作账号及平台实际用过的地域。不修改云资源、期限或已受理作业。账号切换后旧扫描结果不算新账号检查结果。',
    requiredScopes: ['settings:write'], annotations: { idempotentHint: true }, inputSchema: z.strictObject({ managerUserId: id.optional() }),
    outputSchema: resultOutputSchema(patrol),
    async call(context, args) { return patrol.parse(await context.client.setResourcePatrolManager(args.managerUserId as string | undefined)); } },
  { name: 'resource_alert_list', title: '查询当前账号资源告警', adminOnly: true, readOnlyHint: true,
    description: '返回当前工作空间准确资源ID、账号、地域、关联实例、首次/最近发现时间及脱敏创建证明。标签只发现候选，unverified不允许回收。已解决仍保留历史证据，不返回密钥、状态文件或脚本。',
    requiredScopes: ['settings:read'], inputSchema: z.strictObject({ status: status.optional() }),
    outputSchema: resultOutputSchema(z.array(alert)),
    async call(context, args) { return z.array(alert).parse(await context.client.listResourceAlerts(args.status as ResourceAlertStatus | undefined)); } },
  { name: 'resource_alert_reclaim_preview', title: '预览残留资源回收清单', adminOnly: true, readOnlyHint: true,
    description: '以告警准确ID重新核验完整库存、冻结账号与活动占用，返回整套剩余资源的精确清单和planDigest。来源不足、共享池或活动实例拒绝回收；不会改变云资源。',
    requiredScopes: ['settings:read'], inputSchema: z.strictObject({ alertId: id }), outputSchema: resultOutputSchema(preview),
    async call(context, args) { return preview.parse(await context.client.previewResourceReclaim(args.alertId as string)); } },
  { name: 'resource_alert_reclaim', title: '确认回收准确残留资源', adminOnly: true,
    description: '用户审核完整预览清单后，传相同planDigest及稳定幂等键完成二阶段确认。服务端再次核验归属、占用、账号和清单；有变化拒绝并重新预览。只创建原冻结账号回收作业，不根据名称或标签批删，也不会重建主机。任务受理不等于已释放；核验完成才关闭告警。',
    requiredScopes: ['settings:write', 'ranges:destroy', 'instances:destroy'],
    annotations: { idempotentHint: true, destructiveHint: true },
    inputSchema: operationSchema.extend({ alertId: id, planDigest: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey: z.string().min(1).max(128) }).strict(),
    outputSchema: resultOutputSchema(z.object({ alertId: id, status: z.literal('reclaiming'), jobId: id })),
    call(context, args) { return context.client.reclaimResourceAlert(args.alertId as string, args.planDigest as string,
      { confirmationId: args.confirmationId as string | undefined, idempotencyKey: args.idempotencyKey as string }); } },
];
