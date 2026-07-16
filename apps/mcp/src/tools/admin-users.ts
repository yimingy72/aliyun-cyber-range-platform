import type { ToolDefinition } from './tool-context';

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
      const input = args as { username: string; password: string; role: 'admin' | 'user' };
      return context.client.createAdminUser(input);
    },
  },
  {
    name: 'admin_user_update_role',
    description: 'Update a platform user role.',
    requiredScopes: ['users:write'],
    call(context, args) {
      const input = args as { userId: string; role: 'admin' | 'user' };
      return context.client.updateAdminUserRole(input.userId, { role: input.role });
    },
  },
  {
    name: 'admin_user_update_status',
    description: 'Update a platform user status.',
    requiredScopes: ['users:write'],
    call(context, args) {
      const input = args as { userId: string; status: 'active' | 'disabled' };
      return context.client.updateAdminUserStatus(input.userId, { status: input.status });
    },
  },
  {
    name: 'admin_user_reset_password',
    description: 'Reset a platform user password.',
    requiredScopes: ['users:write'],
    call(context, args) {
      const input = args as { userId: string; password: string };
      return context.client.resetAdminUserPassword(input.userId, { password: input.password });
    },
  },
];
