import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { getCurrentCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { PrismaService } from '../database/prisma.service';
import type { SessionUserProfile } from './admin-user-auth';
import { containerReferenceStatus, isBoundMogongWorkspace, isCollectableMogongContainer, mogongContainerDigest, readMogongImageCatalog, type MogongImage } from './mogong-image-catalog';

const publicFields = { id: true, sourceId: true, displayName: true, creator: true, referenceStatus: true, createdAt: true } as const;

@Injectable()
export class PlatformContainerImagesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope || 'system' in scope) throw new ForbiddenException('Cloud workspace scope is required');
    return { items: await this.prisma.platformContainerImage.findMany({ select: publicFields, orderBy: { createdAt: 'desc' } }) };
  }

  private async source() {
    const scope = getCurrentCloudWorkspaceScope();
    if (!isBoundMogongWorkspace() || !scope || 'system' in scope) throw new ForbiddenException('墨攻目录未绑定当前云账号工作空间。');
    const catalog = await readMogongImageCatalog();
    if (catalog.version !== 2) throw new ConflictException('请先更新墨攻目录快照，再收录容器镜像。');
    return catalog;
  }

  private toRecord(image: MogongImage, cloudWorkspaceId: string) {
    return { cloudWorkspaceId, sourceId: image.id, displayName: image.name, creator: image.creator,
      imageReference: image.containerReference, referenceStatus: containerReferenceStatus(image.containerReference) };
  }

  private writableWorkspace(currentUser: SessionUserProfile) {
    const scope = getCurrentCloudWorkspaceScope();
    if (currentUser.role !== 'admin') throw new ForbiddenException('Admin access required');
    if (!scope || 'system' in scope || scope.isReadOnly) throw new ForbiddenException('当前工作空间不可写。');
    return scope.cloudWorkspaceId;
  }

  async preview() {
    const catalog = await this.source();
    const eligible = catalog.items.filter(isCollectableMogongContainer);
    const existing = await this.prisma.platformContainerImage.findMany({ select: { sourceId: true } });
    const existingIds = new Set(existing.map(item => item.sourceId));
    return { digest: mogongContainerDigest(catalog.items), eligible: eligible.length,
      alreadyCollected: eligible.filter(item => existingIds.has(item.id)).length,
      toCollect: eligible.filter(item => !existingIds.has(item.id)).length,
      needsReview: eligible.filter(item => containerReferenceStatus(item.containerReference) === 'needs_review').length,
      capturedAt: catalog.capturedAt };
  }

  async collectAll(expectedDigest: string, currentUser: SessionUserProfile) {
    const workspaceId = this.writableWorkspace(currentUser);
    const catalog = await this.source();
    if (mogongContainerDigest(catalog.items) !== expectedDigest) throw new ConflictException('墨攻目录已变化，请重新预览。');
    const items = catalog.items.filter(isCollectableMogongContainer).map(image => this.toRecord(image, workspaceId));
    const result = items.length ? await this.prisma.platformContainerImage.createMany({ data: items, skipDuplicates: true }) : { count: 0 };
    return { added: result.count, alreadyCollected: items.length - result.count, eligible: items.length };
  }

  async collectOne(sourceId: number, currentUser: SessionUserProfile) {
    const workspaceId = this.writableWorkspace(currentUser);
    const catalog = await this.source();
    const image = catalog.items.find(item => item.id === sourceId);
    if (!image) throw new NotFoundException('墨攻镜像不存在。');
    if (!isCollectableMogongContainer(image)) throw new BadRequestException('该容器镜像已停用、废弃或尚未完成处理。');
    await this.prisma.platformContainerImage.createMany({ data: [this.toRecord(image, workspaceId)], skipDuplicates: true });
    const asset = await this.prisma.platformContainerImage.findFirst({ where: { sourceId }, select: publicFields });
    if (!asset) throw new ConflictException('容器镜像收录结果尚未确认。');
    return asset;
  }

  async remove(id: string, currentUser: SessionUserProfile) {
    this.writableWorkspace(currentUser);
    const result = await this.prisma.platformContainerImage.deleteMany({ where: { id } });
    if (!result.count) throw new NotFoundException('容器镜像资产不存在。');
    return { removed: true, id };
  }
}
