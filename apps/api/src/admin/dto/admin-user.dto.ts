import { IsIn, IsNotEmpty, IsString } from 'class-validator';

import type { UserRole, UserStatus } from '../admin.repository';

const USER_ROLES: UserRole[] = ['admin', 'user'];
const USER_STATUSES: UserStatus[] = ['active', 'disabled'];

export class LoginAdminSessionDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class CreateAdminUserDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsIn(USER_ROLES)
  role!: UserRole;
}

export class UpdateAdminUserRoleDto {
  @IsIn(USER_ROLES)
  role!: UserRole;
}

export class UpdateAdminUserStatusDto {
  @IsIn(USER_STATUSES)
  status!: UserStatus;
}

export class ResetAdminUserPasswordDto {
  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class AdminUserDto {
  id!: string;
  username!: string;
  role!: UserRole;
  status!: UserStatus;
  createdAt!: Date;
  updatedAt!: Date;
}
