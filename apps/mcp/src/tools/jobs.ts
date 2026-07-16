import type { ToolDefinition } from './tool-context';

export const jobTools: ToolDefinition[] = [
  {
    name: 'provision_job_get',
    description: 'Get a provision job by id.',
    requiredScopes: ['jobs:read'],
    readOnlyHint: true,
    call(context, args) {
      return context.client.getProvisionJob((args as { provisionJobId: string }).provisionJobId);
    },
  },
];
