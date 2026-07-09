import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ADMIN_REPOSITORY, AdminRepository, PlatformUserRecord, UserRole, UserStatus } from './admin.repository';
import { hashPassword } from './admin-user-auth';
import { AdminUserDto, CreateAdminUserDto } from './dto/admin-user.dto';

@Injectable()
export class AdminUsersService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository) {}

  async listUsers(): Promise<AdminUserDto[]> {
    const users = await this.repository.listPlatformUsers();

    return users.map((user) => this.toAdminUserDto(user));
  }

  async createUser(input: CreateAdminUserDto): Promise<AdminUserDto> {
    const username = this.normalizeUsername(input.username);

    try {
      const user = await this.repository.createPlatformUser({
        id: randomUUID(),
        username,
        passwordHash: hashPassword(input.password),
        role: input.role,
        status: 'active',
      });

      return this.toAdminUserDto(user);
    } catch (error) {
      this.rethrowKnownUserWriteError(error);
    }
  }

  async updateUserRole(userId: string, role: UserRole): Promise<AdminUserDto> {
    const user = await this.getUserOrThrow(userId);

    if (user.role === role) {
      return this.toAdminUserDto(user);
    }

    if (user.role === 'admin' && user.status === 'active' && role !== 'admin') {
      const activeAdminCount = await this.repository.countActiveAdmins();

      if (activeAdminCount <= 1) {
        throw new ConflictException('Cannot demote the last active admin');
      }
    }

    try {
      const updatedUser = await this.repository.updatePlatformUser(userId, { role });

      return this.toAdminUserDto(updatedUser);
    } catch (error) {
      this.rethrowKnownUserWriteError(error);
    }
  }

  async updateUserStatus(userId: string, status: UserStatus): Promise<AdminUserDto> {
    const user = await this.getUserOrThrow(userId);

    if (user.status === status) {
      return this.toAdminUserDto(user);
    }

    if (user.role === 'admin' && user.status === 'active' && status !== 'active') {
      const activeAdminCount = await this.repository.countActiveAdmins();

      if (activeAdminCount <= 1) {
        throw new ConflictException('Cannot disable the last active admin');
      }
    }

    const updatedUser = await this.repository.updatePlatformUser(userId, { status });

    return this.toAdminUserDto(updatedUser);
  }

  async resetUserPassword(userId: string, password: string): Promise<AdminUserDto> {
    await this.getUserOrThrow(userId);

    const updatedUser = await this.repository.updatePlatformUser(userId, {
      passwordHash: hashPassword(password),
    });

    return this.toAdminUserDto(updatedUser);
  }

  private async getUserOrThrow(userId: string) {
    const user = await this.repository.getPlatformUserById(userId);

    if (!user) {
      throw new NotFoundException('Platform user not found');
    }

    return user;
  }

  private normalizeUsername(username: string) {
    const normalizedUsername = username.trim();

    if (normalizedUsername.length === 0) {
      throw new ConflictException('Username cannot be empty');
    }

    return normalizedUsername;
  }

  private toAdminUserDto(user: PlatformUserRecord): AdminUserDto {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private rethrowKnownUserWriteError(error: unknown): never {
    if (error instanceof Error) {
      const code = (error as { code?: string }).code;

      if (code === 'P2002' || error.message.includes('unique constraint')) {
        throw new ConflictException('Username already exists');
      }
    }

    throw error;
  }
}
