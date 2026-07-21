import type { ToolDefinition } from './tool-context';
import { provisionJobGetInputSchema } from './input-schemas';

export const jobTools: ToolDefinition[] = [
  {
    name: 'provision_job_get',
    description: 'Get a provision job by id.',
    requiredScopes: ['jobs:read'],
    readOnlyHint: true,
    inputSchema: provisionJobGetInputSchema,
    call(context, args) {
      return context.client.getProvisionJob((args as { provisionJobId: string }).provisionJobId);
    },
  },
];
