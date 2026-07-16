import { randomUUID } from 'node:crypto';
import { Prisma } from '@aliyun-cyber-range/database/generated/client';

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ADMIN_REPOSITORY, AdminRepository, PlatformUserRecord, UserRole, UserStatus } from './admin.repository';
import { hashPassword } from './admin-user-auth';
import { AdminUserDto, CreateAdminUserDto } from './dto/admin-user.dto';
import { PrismaService } from '../database/prisma.service';
import { KeycloakAdminService } from './keycloak-admin.service';

const SERIALIZABLE_RETRY_LIMIT = 3;

type AdminUserLike = Pick<PlatformUserRecord, 'id' | 'username' | 'role' | 'status' | 'createdAt' | 'updatedAt'>;

@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository,
    private readonly prisma: PrismaService,
    private readonly keycloakAdminService: KeycloakAdminService,
  ) {}

  async listUsers(): Promise<AdminUserDto[]> {
    const users = await this.repository.listPlatformUsers();

    return users.map((user) => this.toAdminUserDto(user));
  }

  async createUser(input: CreateAdminUserDto): Promise<AdminUserDto> {
    const username = this.normalizeUsername(input.username);

    try {
      const oidcSubject = await this.keycloakAdminService.createUser({
        username,
        password: input.password,
        role: input.role,
        status: 'active',
      });
      const user = await this.repository.createPlatformUser({
        id: randomUUID(),
        username,
        passwordHash: hashPassword(input.password),
        oidcIssuer: process.env.OIDC_ISSUER?.trim() || 'http://localhost:8080/realms/cyber-range',
        oidcSubject,
        role: input.role,
        status: 'active',
      });

      return this.toAdminUserDto(user);
    } catch (error) {
      this.rethrowKnownUserWriteError(error);
    }
  }

  async updateUserRole(userId: string, role: UserRole): Promise<AdminUserDto> {
    return this.runSerializableUserMutation(async (tx) => {
      const user = await this.getUserOrThrowFromTransaction(tx, userId);

      if (user.role === role) {
        return this.toAdminUserDto(user);
      }

      if (user.role === 'admin' && user.status === 'active' && role !== 'admin') {
        await this.assertAnotherActiveAdminExists(tx, 'Cannot demote the last active admin');
      }

      if (user.oidcSubject) {
        await this.keycloakAdminService.updateUserRole({
          subject: user.oidcSubject,
          role,
        });
      }

      const updatedUser = await tx.platformUser.update({
        where: { id: userId },
        data: { role },
      });

      return this.toAdminUserDto(updatedUser);
    });
  }

  async updateUserStatus(userId: string, status: UserStatus): Promise<AdminUserDto> {
    return this.runSerializableUserMutation(async (tx) => {
      const user = await this.getUserOrThrowFromTransaction(tx, userId);

      if (user.status === status) {
        return this.toAdminUserDto(user);
      }

      if (user.role === 'admin' && user.status === 'active' && status !== 'active') {
        await this.assertAnotherActiveAdminExists(tx, 'Cannot disable the last active admin');
      }

      if (user.oidcSubject) {
        await this.keycloakAdminService.updateUserStatus({
          subject: user.oidcSubject,
          status,
        });
      }

      const updatedUser = await tx.platformUser.update({
        where: { id: userId },
        data: { status },
      });

      return this.toAdminUserDto(updatedUser);
    });
  }

  async resetUserPassword(userId: string, password: string): Promise<AdminUserDto> {
    const user = await this.getUserOrThrow(userId);

    if (user.oidcSubject) {
      await this.keycloakAdminService.resetUserPassword({
        subject: user.oidcSubject,
        password,
      });
    }

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

  private async getUserOrThrowFromTransaction(tx: Prisma.TransactionClient, userId: string) {
    const user = await tx.platformUser.findUnique({
      where: {
        id: userId,
      },
    });

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

  private toAdminUserDto(user: AdminUserLike): AdminUserDto {
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

      if (error.message === 'Username already exists') {
        throw new ConflictException('Username already exists');
      }
    }

    throw error;
  }

  private async assertAnotherActiveAdminExists(tx: Prisma.TransactionClient, message: string) {
    const activeAdminCount = await tx.platformUser.count({
      where: {
        role: 'admin',
        status: 'active',
      },
    });

    if (activeAdminCount <= 1) {
      throw new ConflictException(message);
    }
  }

  private async runSerializableUserMutation(
    operation: (tx: Prisma.TransactionClient) => Promise<AdminUserDto>,
  ): Promise<AdminUserDto> {
    for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => operation(tx), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (this.isRetryableSerializationError(error) && attempt + 1 < SERIALIZABLE_RETRY_LIMIT) {
          continue;
        }

        throw error;
      }
    }

    throw new Error('Unreachable');
  }

  private isRetryableSerializationError(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
  }
}
