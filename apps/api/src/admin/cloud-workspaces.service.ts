import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@aliyun-cyber-range/database/generated/client';

import { PrismaService } from '../database/prisma.service';
import { getCurrentCloudWorkspaceScope, runInSystemCloudWorkspaceScope, type CloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import type { SessionUserProfile } from './admin-user-auth';

export const LEGACY_CLOUD_WORKSPACE_ID = 'legacy-unbound';

@Injectable()
export class CloudWorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: SessionUserProfile) {
    return runInSystemCloudWorkspaceScope(async () => {
      const spaces = await this.prisma.cloudWorkspace.findMany({
        where: { archivedAt: null, ...(user.isPlatformManager ? {} : { id: user.cloudWorkspaceId ?? '__no_workspace__' }) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return Promise.all(spaces.map(space => this.view(space)));
    });
  }

  async resolve(user: SessionUserProfile, requestedId?: string): Promise<CloudWorkspaceScope> {
    return runInSystemCloudWorkspaceScope(async () => {
      if (requestedId !== undefined && (!requestedId.trim() || requestedId.length > 192)) {
        throw new BadRequestException('云账号工作空间标识无效。');
      }
      let id = requestedId?.trim() || user.cloudWorkspaceId || null;
      if (!id && user.isPlatformManager) {
        const stored = await this.prisma.platformUser.findUnique({ where: { id: user.id } });
        id = stored?.selectedCloudWorkspaceId ?? null;
        if (!id) {
          const active = await this.prisma.cloudAccountContext.findFirst({ where: { isActive: true, status: 'ready' }, orderBy: { updatedAt: 'desc' } });
          id = active?.cloudWorkspaceId ?? LEGACY_CLOUD_WORKSPACE_ID;
        }
      }
      if (!id || (!user.isPlatformManager && id !== user.cloudWorkspaceId)) {
        throw new ForbiddenException('当前登录用户无权访问该云账号工作空间。');
      }
      const space = await this.prisma.cloudWorkspace.findUnique({ where: { id } });
      if (!space) throw new NotFoundException('云账号工作空间不存在，请重新选择。');
      if (space.archivedAt) throw new ConflictException('该云账号绑定已删除，请重新绑定相同账号以恢复数据。');
      return { cloudWorkspaceId: space.id, provider: space.provider, accountUid: space.accountUid,
        isReadOnly: space.isReadOnly, actorUserId: user.id, isPlatformManager: user.isPlatformManager === true };
    });
  }

  async current(user: SessionUserProfile, requestedId?: string) {
    const scope = await this.resolve(user, requestedId);
    return runInSystemCloudWorkspaceScope(async () => this.view(await this.prisma.cloudWorkspace.findUniqueOrThrow({ where: { id: scope.cloudWorkspaceId } })));
  }

  async switch(user: SessionUserProfile, id: string) {
    const scope = await this.resolve(user, id);
    return runInSystemCloudWorkspaceScope(async () => {
      await this.prisma.platformUser.update({ where: { id: user.id }, data: { selectedCloudWorkspaceId: scope.cloudWorkspaceId } });
      // Selecting data never replaces credentials or changes a running job's frozen context.
      return this.view(await this.prisma.cloudWorkspace.findUniqueOrThrow({ where: { id: scope.cloudWorkspaceId } }));
    });
  }

  async selectedAccountContextId(): Promise<string | null> {
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope || 'system' in scope) return null;
    const space = await runInSystemCloudWorkspaceScope(() => this.prisma.cloudWorkspace.findUnique({ where: { id: scope.cloudWorkspaceId } }));
    if (!space || space.archivedAt || space.provider !== scope.provider || space.accountUid !== scope.accountUid) throw new ForbiddenException('云账号工作空间已变化，请重新选择。');
    if (!space.activeCloudAccountContextId) return null;
    const context = await runInSystemCloudWorkspaceScope(() => this.prisma.cloudAccountContext.findUnique({ where: { id: space.activeCloudAccountContextId! } }));
    if (!context || context.cloudWorkspaceId !== space.id || context.provider !== space.provider || context.accountUid !== space.accountUid) {
      throw new ForbiddenException('云账号配置与当前工作空间不一致。');
    }
    return context.id;
  }

  async removalTarget(user: SessionUserProfile, id: string) {
    if (!user.isPlatformManager) throw new ForbiddenException('仅平台超管可删除云账号绑定。');
    if (!id.trim() || id.length > 192) throw new BadRequestException('云账号工作空间标识无效。');
    const scope = getCurrentCloudWorkspaceScope();
    if (scope && !('system' in scope) && scope.cloudWorkspaceId === id) throw new ConflictException('请先切换到其他账号或历史工作空间，再删除当前账号绑定。');
    return runInSystemCloudWorkspaceScope(async () => {
      const space = await this.prisma.cloudWorkspace.findUnique({ where: { id } });
      if (!space) throw new NotFoundException('云账号工作空间不存在。');
      if (space.isReadOnly || !space.accountUid || id === LEGACY_CLOUD_WORKSPACE_ID) throw new ConflictException('历史工作空间不能删除。');
      await this.assertNotSelected(this.prisma, user, id);
      return { id: space.id, displayName: space.displayName, provider: space.provider, accountUid: space.accountUid };
    });
  }

  async remove(user: SessionUserProfile, id: string) {
    await this.removalTarget(user, id);
    try {
      return await runInSystemCloudWorkspaceScope(() => this.prisma.$transaction(async tx => {
        // Existing APIs/workers do not all share one admission service. Protect
        // their ordinary DML too, and fail quickly instead of waiting on jobs.
        await tx.$executeRaw`LOCK TABLE "CloudWorkspace", "CloudAccountContext", "SystemCloudConfig", "PlatformUser", "RangeInstance", "ProvisionJob", "BillingLedgerResource", "ImageImportJob", "PackedImageArtifact", "CloudImageImportBucket", "SingleInstanceNetworkProfile" IN SHARE ROW EXCLUSIVE MODE NOWAIT`;
        const space = await tx.cloudWorkspace.findUniqueOrThrow({ where: { id } });
        if (space.isReadOnly || !space.accountUid) throw new ConflictException('历史工作空间不能删除。');
        await this.assertNotSelected(tx, user, id);
        if (!space.archivedAt) await this.assertRemovalSafe(tx, id);
        const deletedAt = space.archivedAt ?? new Date();
        const contexts = await tx.cloudAccountContext.findMany({ where: { cloudWorkspaceId: id }, select: { accessKeyId: true } });
        const config = await tx.systemCloudConfig.findUnique({ where: { id: 'default' } });
        if (config?.accessKeyId && contexts.some(context => context.accessKeyId === config.accessKeyId)) {
          await tx.systemCloudConfig.update({ where: { id: 'default' }, data: { accessKeyId: '', accessKeySecret: '' } });
        }
        await tx.cloudAccountContext.updateMany({ where: { cloudWorkspaceId: id }, data: { accessKeyId: '', accessKeySecret: '', isActive: false,
          status: 'disabled', bucketStatus: 'unconfigured', lastError: null, lastVerifiedAt: null } });
        await tx.cloudWorkspace.update({ where: { id }, data: { archivedAt: deletedAt, activeCloudAccountContextId: null } });
        await tx.platformUser.updateMany({ where: { selectedCloudWorkspaceId: id }, data: { selectedCloudWorkspaceId: null } });
        return { id: space.id, displayName: space.displayName, provider: space.provider, accountUid: space.accountUid, deletedAt, retainedData: true as const };
      }, { timeout: 10_000 }));
    } catch (error) {
      const value = error as { code?: string; meta?: { code?: string } };
      if (['55P03', '40P01'].includes(value.meta?.code ?? '') || value.code === 'P2034') {
        throw new ConflictException('账号或资源任务正在变化，请等待任务结束后重新删除。');
      }
      throw error;
    }
  }

  private async assertNotSelected(db: Prisma.TransactionClient | PrismaService, user: SessionUserProfile, id: string) {
    const scope = getCurrentCloudWorkspaceScope();
    const actor = await db.platformUser.findUnique({ where: { id: user.id } });
    if (user.cloudWorkspaceId === id || actor?.selectedCloudWorkspaceId === id || scope && !('system' in scope) && scope.cloudWorkspaceId === id) {
      throw new ConflictException('请先切换到其他账号或历史工作空间，再删除当前账号绑定。');
    }
  }

  private async assertRemovalSafe(db: Prisma.TransactionClient, cloudWorkspaceId: string) {
    const counts = await Promise.all([
      db.rangeInstance.count({ where: { cloudWorkspaceId, OR: [{ status: { not: 'destroyed' } }, { resourceSummary: { not: Prisma.AnyNull } }, { accessEntry: { not: Prisma.AnyNull } }] } }),
      db.provisionJob.count({ where: { cloudWorkspaceId, status: { in: ['pending', 'running'] } } }),
      db.billingLedgerResource.count({ where: { cloudWorkspaceId, releasedAt: null } }),
      db.imageImportJob.count({ where: { cloudWorkspaceId, OR: [{ status: { notIn: ['available', 'cancelled', 'failed'] } }, { temporaryObjectDeletedAt: null },
        { imageId: { not: null }, cloudImageDeletedAt: null }, { snapshotCleanupCompletedAt: null, backingSnapshotIds: { isEmpty: false } }] } }),
      db.packedImageArtifact.count({ where: { cloudWorkspaceId, OR: [{ status: { not: 'deleted' } }, { imageId: { not: null }, cloudImageDeletedAt: null }] } }),
      db.cloudImageImportBucket.count({ where: { cloudWorkspaceId, OR: [{ status: { not: 'deleted' } }, { deletedAt: null }] } }),
      db.singleInstanceNetworkProfile.count({ where: { cloudWorkspaceId, managedByPlatform: true, status: { not: 'deleted' } } }),
    ]);
    if (counts.some(count => count > 0)) throw new ConflictException('账号仍有未回收资源、失败实例或待清理任务。请完成回收并关闭资源台账后再删除绑定。');
  }

  private async view(space: { id: string; provider: 'alibaba_cloud' | 'tencent_cloud'; accountUid: string | null; displayName: string; isReadOnly: boolean; activeCloudAccountContextId: string | null }) {
    const contexts = await this.prisma.cloudAccountContext.findMany({ where: { cloudWorkspaceId: space.id }, orderBy: [{ regionId: 'asc' }, { id: 'asc' }] });
    const active = contexts.find(context => context.id === space.activeCloudAccountContextId && context.status === 'ready'
      && context.provider === space.provider && context.accountUid === space.accountUid);
    return {
      ...space,
      contexts: contexts.map(context => ({ id: context.id, cloudWorkspaceId: context.cloudWorkspaceId, provider: context.provider,
        displayName: context.displayName, accountUid: context.accountUid, regionId: context.regionId, zoneId: context.zoneId,
        imageImportBucket: context.imageImportBucket, isActive: context.id === space.activeCloudAccountContextId,
        status: context.status, bucketStatus: context.bucketStatus, lastVerifiedAt: context.lastVerifiedAt })),
      capabilities: { provisioning: !space.isReadOnly && Boolean(active),
        rangeProvisioning: !space.isReadOnly && Boolean(active)
          && (space.provider === 'alibaba_cloud' || process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED === '1'),
        imageImport: !space.isReadOnly && Boolean(active) && (space.provider === 'tencent_cloud'
          || Boolean(active?.imageImportBucket && active.bucketStatus === 'ready')),
        billingSync: !space.isReadOnly && Boolean(active) },
    };
  }
}
