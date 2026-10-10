import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

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
        where: user.isPlatformManager ? {} : { id: user.cloudWorkspaceId ?? '__no_workspace__' },
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
    if (!space || space.provider !== scope.provider || space.accountUid !== scope.accountUid) throw new ForbiddenException('云账号工作空间已变化，请重新选择。');
    if (!space.activeCloudAccountContextId) return null;
    const context = await runInSystemCloudWorkspaceScope(() => this.prisma.cloudAccountContext.findUnique({ where: { id: space.activeCloudAccountContextId! } }));
    if (!context || context.cloudWorkspaceId !== space.id || context.provider !== space.provider || context.accountUid !== space.accountUid) {
      throw new ForbiddenException('云账号配置与当前工作空间不一致。');
    }
    return context.id;
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
