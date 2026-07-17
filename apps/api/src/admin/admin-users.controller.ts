import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CurrentAdminUser } from './current-admin-user.decorator';
import type { SessionUserProfile } from './admin-user-auth';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { AdminUsersService } from './admin-users.service';
import {
  CreateAdminUserDto,
  ResetAdminUserPasswordDto,
  UpdateAdminUserRoleDto,
  UpdateAdminUserStatusDto,
} from './dto/admin-user.dto';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';

@Controller('admin/users')
@UseGuards(AdminAuthGuard)
export class AdminUsersController {
  constructor(
    private readonly adminUsersService: AdminUsersService,
    private readonly operationControlService: OperationControlService,
  ) {}

  @Get()
  listUsers(@CurrentAdminUser() currentUser: SessionUserProfile) {
    this.assertAdmin(currentUser);

    return this.adminUsersService.listUsers();
  }

  @Post()
  createUser(@Req() request: AuthenticatedPlatformRequest, @CurrentAdminUser() currentUser: SessionUserProfile, @Body() body: CreateAdminUserDto) {
    this.assertAdmin(currentUser);
    return this.mcpWrite(request, 'admin_user_create', body as unknown as Record<string, unknown>, body.username, () => this.adminUsersService.createUser(body));
  }

  @Patch(':userId/role')
  updateUserRole(
    @Req() request: AuthenticatedPlatformRequest,
    @CurrentAdminUser() currentUser: SessionUserProfile,
    @Param('userId') userId: string,
    @Body() body: UpdateAdminUserRoleDto,
  ) {
    this.assertAdmin(currentUser);

    return this.mcpWrite(request, 'admin_user_update_role', { userId, ...body }, userId, () => this.adminUsersService.updateUserRole(userId, body.role));
  }

  @Patch(':userId/status')
  updateUserStatus(
    @Req() request: AuthenticatedPlatformRequest,
    @CurrentAdminUser() currentUser: SessionUserProfile,
    @Param('userId') userId: string,
    @Body() body: UpdateAdminUserStatusDto,
  ) {
    this.assertAdmin(currentUser);

    return this.mcpWrite(request, 'admin_user_update_status', { userId, ...body }, userId, () => this.adminUsersService.updateUserStatus(userId, body.status));
  }

  @Post(':userId/reset-password')
  resetUserPassword(
    @Req() request: AuthenticatedPlatformRequest,
    @CurrentAdminUser() currentUser: SessionUserProfile,
    @Param('userId') userId: string,
    @Body() body: ResetAdminUserPasswordDto,
  ) {
    this.assertAdmin(currentUser);

    return this.mcpWrite(request, 'admin_user_reset_password', { userId, ...body }, userId, () => this.adminUsersService.resetUserPassword(userId, body.password));
  }

  private mcpWrite<TResult>(
    request: AuthenticatedPlatformRequest,
    toolName: string,
    argumentsValue: Record<string, unknown>,
    targetId: string,
    execute: () => Promise<TResult>,
  ) {
    if (request.authContext.source !== 'mcp') {
      return execute();
    }
    const metadata = readOperationRequestMetadata(request);
    return this.operationControlService.executeConfirmed({
      context: request.authContext,
      metadata: { ...metadata, idempotencyKey: metadata.idempotencyKey ?? `${toolName}:${targetId}` },
      toolName,
      arguments: argumentsValue,
      targetType: 'platform_user',
      targetId,
      resolveConfirmation: async () => ({
        targetId,
        targetSnapshot: { userId: targetId },
        summary: { targetName: targetId, destructive: toolName === 'admin_user_update_status' || toolName === 'admin_user_reset_password' },
      }),
      execute: async () => ({ result: await execute() }),
    });
  }

  private assertAdmin(currentUser: SessionUserProfile) {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }
  }
}
