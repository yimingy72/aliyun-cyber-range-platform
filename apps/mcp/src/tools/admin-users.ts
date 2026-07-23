import type { ToolDefinition } from './tool-context';
import {
  adminUserCreateInputSchema,
  adminUserListInputSchema,
  adminUserResetPasswordInputSchema,
  adminUserRoleInputSchema,
  adminUserStatusInputSchema,
} from './input-schemas';
import { resourceListOutputSchema, resourceOutputSchema } from './output-schemas';

const operation = (args: { idempotencyKey?: string; confirmationId?: string }) => ({
  idempotencyKey: args.idempotencyKey,
  confirmationId: args.confirmationId,
});

export const adminUserTools: ToolDefinition[] = [
  {
    name: 'admin_user_list',
    title: '查询平台用户',
    description: '对应用户管理页的用户列表。仅返回当前管理员可管理的平台用户；后续修改必须使用返回的用户 ID。',
    requiredScopes: ['users:read'],
    readOnlyHint: true,
    inputSchema: adminUserListInputSchema,
    outputSchema: resourceListOutputSchema,
    call(context) {
      return context.client.listAdminUsers();
    },
  },
  {
    name: 'admin_user_create',
    title: '创建平台用户',
    description: '对应用户管理页的“创建用户”。创建管理员或普通用户；密码是敏感输入，调用前必须取得用户确认。',
    requiredScopes: ['users:write'],
    inputSchema: adminUserCreateInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      const input = args as { username: string; password: string; role: 'admin' | 'user'; idempotencyKey?: string; confirmationId?: string };
      return context.client.createAdminUser(input, operation(input));
    },
  },
  {
    name: 'admin_user_update_role',
    title: '修改平台用户角色',
    description: '对应用户管理页的角色调整。将指定用户设为 admin 或 user，会改变权限范围，调用前必须取得用户确认。',
    requiredScopes: ['users:write'],
    inputSchema: adminUserRoleInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      const input = args as { userId: string; role: 'admin' | 'user'; idempotencyKey?: string; confirmationId?: string };
      return context.client.updateAdminUserRole(input.userId, { role: input.role }, operation(input));
    },
  },
  {
    name: 'admin_user_update_status',
    title: '启用或禁用平台用户',
    description: '对应用户管理页的账号状态调整。将指定用户设为 active 或 disabled，会影响登录访问，调用前必须取得用户确认。',
    requiredScopes: ['users:write'],
    inputSchema: adminUserStatusInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      const input = args as { userId: string; status: 'active' | 'disabled'; idempotencyKey?: string; confirmationId?: string };
      return context.client.updateAdminUserStatus(input.userId, { status: input.status }, operation(input));
    },
  },
  {
    name: 'admin_user_reset_password',
    title: '重置平台用户密码',
    description: '对应用户管理页的“重置密码”。设置指定用户的新密码；密码是敏感输入，调用前必须取得用户确认。',
    requiredScopes: ['users:write'],
    inputSchema: adminUserResetPasswordInputSchema,
    outputSchema: resourceOutputSchema,
    call(context, args) {
      const input = args as { userId: string; password: string; idempotencyKey?: string; confirmationId?: string };
      return context.client.resetAdminUserPassword(input.userId, { password: input.password }, operation(input));
    },
  },
];
