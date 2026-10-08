import { randomUUID } from 'node:crypto';
import { Prisma } from '@aliyun-cyber-range/database/generated/client';

import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { ADMIN_REPOSITORY, AdminRepository, PlatformUserRecord, UserRole, UserStatus } from './admin.repository';
import { hashPassword } from './admin-user-auth';
import { AdminUserDto, CreateAdminUserDto } from './dto/admin-user.dto';
import { PrismaService } from '../database/prisma.service';
import { KeycloakAdminService } from './keycloak-admin.service';

type AdminUserLike = Pick<PlatformUserRecord, 'id' | 'username' | 'role' | 'status' | 'createdAt' | 'updatedAt'>;
type UserWriteRecovery = (tx: Prisma.TransactionClient) => Promise<AdminUserDto | void>;

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);
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
    const id = randomUUID();
    const passwordHash = hashPassword(input.password);

    return this.runLockedUserMutation(async (tx, recover) => {
      if (await tx.platformUser.findUnique({ where: { username } })) {
        throw new ConflictException('Username already exists');
      }
      const oidcSubject = await this.keycloakAdminService.createUser({
        username,
        password: input.password,
        role: input.role,
        status: 'active',
      });
      recover(async (recoveryTx) => {
        const persisted = await recoveryTx.platformUser.findUnique({ where: { id } });
        if (persisted?.oidcSubject === oidcSubject) {
          return this.toAdminUserDto(persisted);
        }
        await this.keycloakAdminService.deleteUser(oidcSubject);
      });
      const user = await tx.platformUser.create({ data: {
        id,
        username,
        passwordHash,
        oidcIssuer: process.env.OIDC_ISSUER?.trim() || 'http://localhost:8080/realms/cyber-range',
        oidcSubject,
        role: input.role,
        status: 'active',
      } });

      return this.toAdminUserDto(user);
    });
  }

  async updateUserRole(userId: string, role: UserRole): Promise<AdminUserDto> {
    return this.runLockedUserMutation(async (tx, recover) => {
      const user = await this.getUserOrThrowFromTransaction(tx, userId);

      if (user.role === 'admin' && user.status === 'active' && role !== 'admin') {
        await this.assertAnotherActiveAdminExists(tx, 'Cannot demote the last active admin');
      }

      const updatedUser = user.role === role ? user : await tx.platformUser.update({
        where: { id: userId },
        data: { role },
      });
      if (user.oidcSubject) {
        recover(async (recoveryTx) => {
          const current = await this.getUserOrThrowFromTransaction(recoveryTx, userId);
          await this.keycloakAdminService.updateUserRole({ subject: user.oidcSubject!, role: current.role });
          if (current.role === role) {
            return this.toAdminUserDto(current);
          }
        });
        await this.keycloakAdminService.updateUserRole({
          subject: user.oidcSubject,
          role,
        });
      }

      return this.toAdminUserDto(updatedUser);
    });
  }

  async updateUserStatus(userId: string, status: UserStatus): Promise<AdminUserDto> {
    return this.runLockedUserMutation(async (tx, recover) => {
      const user = await this.getUserOrThrowFromTransaction(tx, userId);

      if (user.role === 'admin' && user.status === 'active' && status !== 'active') {
        await this.assertAnotherActiveAdminExists(tx, 'Cannot disable the last active admin');
      }

      const updatedUser = user.status === status ? user : await tx.platformUser.update({
        where: { id: userId },
        data: { status },
      });
      if (user.oidcSubject) {
        recover(async (recoveryTx) => {
          const current = await this.getUserOrThrowFromTransaction(recoveryTx, userId);
          await this.keycloakAdminService.updateUserStatus({ subject: user.oidcSubject!, status: current.status });
          if (current.status === status) {
            return this.toAdminUserDto(current);
          }
        });
        await this.keycloakAdminService.updateUserStatus({
          subject: user.oidcSubject,
          status,
        });
      }

      return this.toAdminUserDto(updatedUser);
    });
  }

  async resetUserPassword(userId: string, password: string): Promise<AdminUserDto> {
    const user = await this.getUserOrThrow(userId);
    const passwordHash = hashPassword(password);

    if (user.oidcSubject) {
      await this.keycloakAdminService.resetUserPassword({
        subject: user.oidcSubject,
        password,
      });
    }

    try {
      return this.toAdminUserDto(await this.repository.updatePlatformUser(userId, { passwordHash }));
    } catch (error) {
      if (!user.oidcSubject) {
        throw error;
      }
      this.logger.warn('Identity password was reset, but updating the unused local password hash failed');
      return this.toAdminUserDto(user);
    }
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

  private async runLockedUserMutation(
    operation: (tx: Prisma.TransactionClient, recover: (callback: UserWriteRecovery) => void) => Promise<AdminUserDto>,
  ): Promise<AdminUserDto> {
    let recovery: UserWriteRecovery | undefined;
    try {
      return await this.withUserWriteLock((tx) => operation(tx, (callback) => { recovery = callback; }));
    } catch (error) {
      if (recovery) {
        // Re-read under the lock so compensation cannot overwrite a newer successful change.
        const callback = recovery;
        let recovered: AdminUserDto | void;
        try {
          recovered = await this.withUserWriteLock(callback);
        } catch {
          this.logger.error('Failed to restore user identity after a platform user write failure');
          throw new ServiceUnavailableException('User identity recovery failed; retry when the database and identity service are available');
        }
        if (recovered) {
          return recovered;
        }
      }
      this.rethrowKnownUserWriteError(error);
    }
  }

  private withUserWriteLock<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // ReadCommitted observes the prior writer after waiting; external writes must never be retried.
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`LOCK TABLE "PlatformUser" IN SHARE ROW EXCLUSIVE MODE`;
      return operation(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 60_000 });
  }
}
