import type { ToolDefinition } from './tool-context';
import { provisionJobGetInputSchema } from './input-schemas';
import { resourceOutputSchema } from './output-schemas';

export const jobTools: ToolDefinition[] = [
  {
    name: 'provision_job_get',
    title: '查询开通任务',
    description: '查询异步开通、更新、销毁或打包任务。includeEvidence=true 返回同来源库存、阶段、相关作业和计费台账；这些是平台记录。includeCloudEvents=true 另按原生资源 ID、冻结账号和使用区间只读查询云审计事件，可用 cloudResourceIds 选择最多20项原创建资源。查询为空或删除请求成功均不单独证明实际释放；不修改云资源和计费时间，不返回原始日志、审计正文或凭据。',
    requiredScopes: ['jobs:read'],
    readOnlyHint: true,
    inputSchema: provisionJobGetInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      const { provisionJobId, ...options } = args as { provisionJobId: string; includeEvidence?: boolean; includeCloudEvents?: boolean; cloudResourceIds?: string[] };
      return context.client.getProvisionJob(provisionJobId, Object.keys(options).length ? options : undefined);
    },
  },
];
