import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';

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
  listUsers(@CurrentAdminUser() _currentUser: SessionUserProfile) {
    return this.adminUsersService.listUsers();
  }

  @Post()
  createUser(@Body() body: CreateAdminUserDto) {
    return this.adminUsersService.createUser(body);
  }

  @Patch(':userId/role')
  updateUserRole(@Param('userId') userId: string, @Body() body: UpdateAdminUserRoleDto) {
    return this.adminUsersService.updateUserRole(userId, body.role);
  }

  @Patch(':userId/status')
  updateUserStatus(@Param('userId') userId: string, @Body() body: UpdateAdminUserStatusDto) {
    return this.adminUsersService.updateUserStatus(userId, body.status);
  }

  @Post(':userId/reset-password')
  resetUserPassword(@Param('userId') userId: string, @Body() body: ResetAdminUserPasswordDto) {
    return this.adminUsersService.resetUserPassword(userId, body.password);
  }
}
