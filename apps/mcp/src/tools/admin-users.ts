import type { ToolDefinition } from './tool-context';

const operation = (args: { idempotencyKey?: string; confirmationId?: string }) => ({
  idempotencyKey: args.idempotencyKey,
  confirmationId: args.confirmationId,
});

export const adminUserTools: ToolDefinition[] = [
  {
    name: 'admin_user_list',
    description: 'List admin platform users.',
    requiredScopes: ['users:read'],
    readOnlyHint: true,
    call(context) {
      return context.client.listAdminUsers();
    },
  },
  {
    name: 'admin_user_create',
    description: 'Create a platform user.',
    requiredScopes: ['users:write'],
    call(context, args) {
      const input = args as { username: string; password: string; role: 'admin' | 'user'; idempotencyKey?: string; confirmationId?: string };
      return context.client.createAdminUser(input, operation(input));
    },
  },
  {
    name: 'admin_user_update_role',
    description: 'Update a platform user role.',
    requiredScopes: ['users:write'],
    call(context, args) {
      const input = args as { userId: string; role: 'admin' | 'user'; idempotencyKey?: string; confirmationId?: string };
      return context.client.updateAdminUserRole(input.userId, { role: input.role }, operation(input));
    },
  },
  {
    name: 'admin_user_update_status',
    description: 'Update a platform user status.',
    requiredScopes: ['users:write'],
    call(context, args) {
      const input = args as { userId: string; status: 'active' | 'disabled'; idempotencyKey?: string; confirmationId?: string };
      return context.client.updateAdminUserStatus(input.userId, { status: input.status }, operation(input));
    },
  },
  {
    name: 'admin_user_reset_password',
    description: 'Reset a platform user password.',
    requiredScopes: ['users:write'],
    call(context, args) {
      const input = args as { userId: string; password: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.resetAdminUserPassword(input.userId, { password: input.password }, operation(input));
    },
  },
];
