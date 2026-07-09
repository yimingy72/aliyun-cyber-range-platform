import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CurrentAdminUser } from './current-admin-user.decorator';
import type { SessionUserProfile } from './admin-user-auth';
import { AdminUsersService } from './admin-users.service';
import {
  CreateAdminUserDto,
  ResetAdminUserPasswordDto,
  UpdateAdminUserRoleDto,
  UpdateAdminUserStatusDto,
} from './dto/admin-user.dto';

@Controller('admin/users')
@UseGuards(AdminAuthGuard)
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  listUsers(@CurrentAdminUser() currentUser: SessionUserProfile) {
    this.assertAdmin(currentUser);

    return this.adminUsersService.listUsers();
  }

  @Post()
  createUser(@CurrentAdminUser() currentUser: SessionUserProfile, @Body() body: CreateAdminUserDto) {
    this.assertAdmin(currentUser);

    return this.adminUsersService.createUser(body);
  }

  @Patch(':userId/role')
  updateUserRole(
    @CurrentAdminUser() currentUser: SessionUserProfile,
    @Param('userId') userId: string,
    @Body() body: UpdateAdminUserRoleDto,
  ) {
    this.assertAdmin(currentUser);

    return this.adminUsersService.updateUserRole(userId, body.role);
  }

  @Patch(':userId/status')
  updateUserStatus(
    @CurrentAdminUser() currentUser: SessionUserProfile,
    @Param('userId') userId: string,
    @Body() body: UpdateAdminUserStatusDto,
  ) {
    this.assertAdmin(currentUser);

    return this.adminUsersService.updateUserStatus(userId, body.status);
  }

  @Post(':userId/reset-password')
  resetUserPassword(
    @CurrentAdminUser() currentUser: SessionUserProfile,
    @Param('userId') userId: string,
    @Body() body: ResetAdminUserPasswordDto,
  ) {
    this.assertAdmin(currentUser);

    return this.adminUsersService.resetUserPassword(userId, body.password);
  }

  private assertAdmin(currentUser: SessionUserProfile) {
    if (currentUser.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }
  }
}
