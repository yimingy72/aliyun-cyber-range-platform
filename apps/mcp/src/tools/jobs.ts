import type { ToolDefinition } from './tool-context';
import { provisionJobGetInputSchema } from './input-schemas';
import { resourceOutputSchema } from './output-schemas';

export const jobTools: ToolDefinition[] = [
  {
    name: 'provision_job_get',
    title: '查询开通任务',
    description: '查询异步开通、更新、销毁或打包任务的状态与失败摘要。includeEvidence=true 可读取同来源资源 ID 库存、固定阶段状态、相关作业和计费台账释放时间；仅为平台记录，不是独立云 API 回执或最终账单。证据不返回原始日志、命令、状态文件或凭据。',
    requiredScopes: ['jobs:read'],
    readOnlyHint: true,
    inputSchema: provisionJobGetInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      const input = args as { provisionJobId: string; includeEvidence?: boolean };
      return context.client.getProvisionJob(input.provisionJobId, input.includeEvidence === undefined ? undefined : { includeEvidence: input.includeEvidence });
    },
  },
];
