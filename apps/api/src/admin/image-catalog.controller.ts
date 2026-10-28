import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CollectImageCatalogDto, DeleteCustomImageDto } from './dto/image-catalog.dto';
import { ImageCatalogService } from './image-catalog.service';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';
import { CollectMogongContainersDto } from './dto/mogong-container.dto';
import { containerReferenceStatus, isBoundMogongWorkspace, isCollectableMogongImage, readMogongImageCatalog } from './mogong-image-catalog';
import { PlatformContainerImagesService } from './platform-container-images.service';

export { isCollectableMogongImage } from './mogong-image-catalog';

@Controller('admin/image-catalog')
@UseGuards(AdminAuthGuard)
export class ImageCatalogController {
  constructor(private readonly imageCatalogService: ImageCatalogService, private readonly operationControl: OperationControlService,
    private readonly containerImages: PlatformContainerImagesService) {}

  @Get('public')
  listPublic() {
    return this.imageCatalogService.listPublic();
  }

  @Get('custom')
  listCustom() {
    return this.imageCatalogService.listCustom();
  }

  @Get('mogong')
  async listMogong() {
    const catalog = await readMogongImageCatalog();
    const { snapshots } = await this.imageCatalogService.listCustom();
    const imageIds = new Set(snapshots.filter((item) => item.provider === 'alibaba_cloud').map((item) => item.imageId));
    const bound = isBoundMogongWorkspace();
    const items = catalog.items.filter((item) => bound || item.imageId && imageIds.has(item.imageId)).map(({ containerReference, ...item }) => ({
      ...item, containerReferenceStatus: item.type === 'docker' ? containerReferenceStatus(containerReference) : null,
    }));
    return { capturedAt: catalog.capturedAt, total: items.length, containersCollectable: bound && catalog.version === 2, items };
  }

  @Get('mogong/containers/preview')
  previewMogongContainers() { return this.containerImages.preview(); }

  @Post('mogong/containers/collect-all')
  collectMogongContainers(@Req() request: AuthenticatedPlatformRequest, @Body() body: CollectMogongContainersDto) {
    const execute = () => this.containerImages.collectAll(body.catalogDigest, request.adminUser);
    if (request.authContext.source !== 'mcp') return execute();
    return this.operationControl.executeConfirmed({
      context: request.authContext, metadata: readOperationRequestMetadata(request),
      toolName: 'mogong_container_collect_all', arguments: { catalogDigest: body.catalogDigest }, targetType: 'container_catalog',
      resolveConfirmation: async () => {
        const preview = await this.containerImages.preview();
        if (preview.digest !== body.catalogDigest) throw new ConflictException('墨攻目录已变化，请重新预览。');
        return { targetId: null, targetSnapshot: { digest: preview.digest }, summary: preview };
      },
      execute: async () => ({ result: await execute() }),
    });
  }

  @Post('mogong/:id/collect')
  async collectMogong(@Req() request: AuthenticatedPlatformRequest, @Param('id') id: string) {
    const catalog = await readMogongImageCatalog();
    const image = catalog.items.find((item) => String(item.id) === id);
    if (!image) throw new NotFoundException('墨攻镜像不存在');
    if (image.type === 'docker') return this.containerImages.collectOne(image.id, request.adminUser);
    const { snapshots } = await this.imageCatalogService.listCustom();
    const snapshot = snapshots.find((item) => item.provider === 'alibaba_cloud' && item.imageId === image.imageId);
    if (!snapshot) throw new ConflictException('当前账号和地域的云镜像目录未匹配，请先同步云镜像');
    if (!isCollectableMogongImage(image)) throw new BadRequestException('该墨攻镜像已停用、废弃或不支持收录');
    return this.imageCatalogService.collectPlatformAsset(snapshot.id, image.name, request.adminUser);
  }

  @Post('public/sync')
  syncPublicImages() {
    return this.imageCatalogService.syncPublicImages();
  }

  @Post('custom/sync')
  syncCustomImages() {
    return this.imageCatalogService.syncCustomImages();
  }

  @Post('collect')
  collectFromSnapshot(@Body() body: CollectImageCatalogDto) {
    return this.imageCatalogService.collectFromSnapshot(body.snapshotId, body.displayName);
  }

  @Delete('custom/:snapshotId')
  @HttpCode(200)
  deleteCustomSnapshot(@Req() request: AuthenticatedPlatformRequest, @Param('snapshotId') snapshotId: string, @Query() query: DeleteCustomImageDto) {
    const execute = () => this.imageCatalogService.deleteCustomSnapshot(snapshotId, query, request.adminUser);
    if (request.authContext.source !== 'mcp') return execute();
    return this.operationControl.executeConfirmed({
      context: request.authContext, metadata: readOperationRequestMetadata(request),
      toolName: 'image_catalog_custom_delete', arguments: { snapshotId, deleteOwnedSnapshots: query.deleteOwnedSnapshots ?? false },
      targetType: 'custom_image', targetId: snapshotId,
      resolveConfirmation: async () => {
        const target = await this.imageCatalogService.prepareCustomDelete(snapshotId, request.adminUser, query.deleteOwnedSnapshots === true);
        return { targetId: snapshotId, targetSnapshot: target, summary: { targetName: target.imageId, destructive: true, deleteOwnedSnapshots: query.deleteOwnedSnapshots === true } };
      },
      execute: async () => ({ result: await execute() }),
    });
  }
}
