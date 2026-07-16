import type { ToolDefinition } from './tool-context';

export const templateTools: ToolDefinition[] = [
  {
    name: 'range_template_list',
    description: 'List published or owned range templates.',
    requiredScopes: ['templates:read'],
    readOnlyHint: true,
    call(context, args) {
      return context.client.listRangeTemplates((args as { view?: 'platform' | 'mine' }).view ?? 'platform');
    },
  },
  {
    name: 'range_template_get',
    description: 'Get a range template by id.',
    requiredScopes: ['templates:read'],
    readOnlyHint: true,
    call(context, args) {
      return context.client.getRangeTemplate((args as { templateId: string }).templateId);
    },
  },
];
