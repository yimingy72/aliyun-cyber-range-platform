import type { ToolDefinition } from './tool-context';
import { provisionJobGetInputSchema } from './input-schemas';
import { resourceOutputSchema } from './output-schemas';

export const jobTools: ToolDefinition[] = [
  {
    name: 'provision_job_get',
    title: '查询开通任务',
    description: '查询异步开通、更新、销毁或打包任务的状态与失败摘要。资源操作返回任务 ID 后，使用本工具跟踪至终态。',
    requiredScopes: ['jobs:read'],
    readOnlyHint: true,
    inputSchema: provisionJobGetInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      return context.client.getProvisionJob((args as { provisionJobId: string }).provisionJobId);
    },
  },
];
