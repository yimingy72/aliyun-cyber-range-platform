import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@aliyun-cyber-range/database/generated/client';

import {
  ConflictException,
  ForbiddenException,
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
import { getCurrentCloudWorkspaceScope, requireCurrentCloudWorkspaceId, runInSystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';

type AdminUserLike = Pick<PlatformUserRecord, 'id' | 'username' | 'role' | 'status' | 'createdAt' | 'updatedAt'> & { loginUsername?: string };
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
    const cloudWorkspaceId = requireCurrentCloudWorkspaceId();
    const users = await this.repository.listPlatformUsers();

    return users.filter((user) => user.cloudWorkspaceId === cloudWorkspaceId && !user.isPlatformManager)
      .map((user) => this.toAdminUserDto(user));
  }

  async createUser(input: CreateAdminUserDto): Promise<AdminUserDto> {
    const cloudWorkspaceId = this.requireWritableWorkspace();
    const username = this.normalizeUsername(input.username);
    const loginUsername = `${username}~${createHash('sha256').update(cloudWorkspaceId).digest('hex')}`;
    const id = randomUUID();
    const passwordHash = hashPassword(input.password);

    return this.runLockedUserMutation(async (tx, recover) => {
      if (await tx.platformUser.findFirst({ where: { cloudWorkspaceId, username } })) {
        throw new ConflictException('Username already exists');
      }
      const oidcSubject = await this.keycloakAdminService.createUser({
        username,
        loginUsername,
        password: input.password,
        role: input.role,
        status: 'active',
      });
      recover(async (recoveryTx) => {
        const persisted = await recoveryTx.platformUser.findFirst({ where: { id, cloudWorkspaceId, isPlatformManager: false } });
        if (persisted?.oidcSubject === oidcSubject) {
          return this.toAdminUserDto(persisted);
        }
        await this.keycloakAdminService.deleteUser(oidcSubject);
      });
      const user = await tx.platformUser.create({ data: {
        id,
        username,
        loginUsername,
        cloudWorkspaceId,
        isPlatformManager: false,
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
    const cloudWorkspaceId = this.requireWritableWorkspace();
    return this.runLockedUserMutation(async (tx, recover) => {
      const user = await this.getUserOrThrowFromTransaction(tx, userId, cloudWorkspaceId);

      if (user.role === 'admin' && user.status === 'active' && role !== 'admin') {
        await this.assertAnotherActiveAdminExists(tx, cloudWorkspaceId, 'Cannot demote the last active admin');
      }

      const updatedUser = user.role === role ? user : await tx.platformUser.update({
        where: { id: userId, cloudWorkspaceId, isPlatformManager: false },
        data: { role },
      });
      if (user.oidcSubject) {
        recover(async (recoveryTx) => {
          const current = await this.getUserOrThrowFromTransaction(recoveryTx, userId, cloudWorkspaceId);
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
    const cloudWorkspaceId = this.requireWritableWorkspace();
    return this.runLockedUserMutation(async (tx, recover) => {
      const user = await this.getUserOrThrowFromTransaction(tx, userId, cloudWorkspaceId);

      if (user.role === 'admin' && user.status === 'active' && status !== 'active') {
        await this.assertAnotherActiveAdminExists(tx, cloudWorkspaceId, 'Cannot disable the last active admin');
      }

      const updatedUser = user.status === status ? user : await tx.platformUser.update({
        where: { id: userId, cloudWorkspaceId, isPlatformManager: false },
        data: { status },
      });
      if (user.oidcSubject) {
        recover(async (recoveryTx) => {
          const current = await this.getUserOrThrowFromTransaction(recoveryTx, userId, cloudWorkspaceId);
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
    const cloudWorkspaceId = this.requireWritableWorkspace();
    const scope = getCurrentCloudWorkspaceScope();
    const managerSelfReset = Boolean(scope && !('system' in scope) && scope.isPlatformManager && scope.actorUserId === userId);
    const user = managerSelfReset
      ? await runInSystemCloudWorkspaceScope(() => this.repository.getPlatformUserById(userId))
      : await this.getUserOrThrow(userId, cloudWorkspaceId);
    if (!user || (managerSelfReset && (!user.isPlatformManager || user.cloudWorkspaceId !== null))) {
      throw new NotFoundException('Platform user not found');
    }
    const passwordHash = hashPassword(password);

    if (user.oidcSubject) {
      await this.keycloakAdminService.resetUserPassword({
        subject: user.oidcSubject,
        password,
      });
    }

    try {
      const updated = managerSelfReset
        ? await runInSystemCloudWorkspaceScope(() => this.repository.updatePlatformUser(userId, { passwordHash }))
        : await this.repository.updatePlatformUser(userId, { passwordHash });
      return this.toAdminUserDto(updated);
    } catch (error) {
      if (!user.oidcSubject) {
        throw error;
      }
      this.logger.warn('Identity password was reset, but updating the unused local password hash failed');
      return this.toAdminUserDto(user);
    }
  }

  private async getUserOrThrow(userId: string, cloudWorkspaceId: string) {
    const user = await this.repository.getPlatformUserById(userId);

    if (!user || user.cloudWorkspaceId !== cloudWorkspaceId || user.isPlatformManager) {
      throw new NotFoundException('Platform user not found');
    }

    return user;
  }

  private async getUserOrThrowFromTransaction(tx: Prisma.TransactionClient, userId: string, cloudWorkspaceId: string) {
    const user = await tx.platformUser.findFirst({
      where: {
        id: userId,
        cloudWorkspaceId,
        isPlatformManager: false,
      },
    });

    if (!user || user.cloudWorkspaceId !== cloudWorkspaceId || user.isPlatformManager) {
      throw new NotFoundException('Platform user not found');
    }

    return user;
  }

  private normalizeUsername(username: string) {
    const normalizedUsername = username.trim();

    if (normalizedUsername.length === 0 || normalizedUsername.length > 128) {
      throw new ConflictException('Username must contain between 1 and 128 characters');
    }

    return normalizedUsername;
  }

  private toAdminUserDto(user: AdminUserLike): AdminUserDto {
    return {
      id: user.id,
      username: user.username,
      loginUsername: user.loginUsername ?? user.username,
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

  private async assertAnotherActiveAdminExists(tx: Prisma.TransactionClient, cloudWorkspaceId: string, message: string) {
    const activeAdminCount = await tx.platformUser.count({
      where: {
        role: 'admin',
        status: 'active',
        cloudWorkspaceId,
        isPlatformManager: false,
      },
    });

    if (activeAdminCount <= 1) {
      throw new ConflictException(message);
    }
  }

  private requireWritableWorkspace() {
    const cloudWorkspaceId = requireCurrentCloudWorkspaceId();
    const scope = getCurrentCloudWorkspaceScope();
    if (scope && !('system' in scope) && scope.isReadOnly) {
      throw new ForbiddenException('This cloud workspace is read-only');
    }
    return cloudWorkspaceId;
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
