import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { readFile } from 'node:fs/promises';

import { AdminAuthGuard } from './admin-auth.guard';
import { CollectImageCatalogDto, DeleteCustomImageDto } from './dto/image-catalog.dto';
import { ImageCatalogService } from './image-catalog.service';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';

type MogongImage = { id: number; name: string; type: string; imageId: string | null; active: boolean; status: string };

async function readMogongImageCatalog(): Promise<{ capturedAt: string; items: MogongImage[] }> {
  try {
    const path = process.env.MOGONG_IMAGE_CATALOG_PATH?.trim() || '/var/lib/cyber-range/mogong/image-catalog.json';
    const catalog = JSON.parse(await readFile(path, 'utf8')) as { capturedAt: unknown; total: unknown; items: unknown };
    if (typeof catalog.capturedAt !== 'string' || !Number.isFinite(Date.parse(catalog.capturedAt)) ||
        !Array.isArray(catalog.items) || catalog.total !== catalog.items.length) throw new Error('Invalid catalog');
    const items = catalog.items.map((item: Partial<MogongImage>) => {
      if (!item || !Number.isSafeInteger(item.id) || typeof item.name !== 'string' || !item.name.trim() ||
          typeof item.type !== 'string' || typeof item.status !== 'string' || typeof item.active !== 'boolean' ||
          !(item.imageId === null || typeof item.imageId === 'string' && /^m-[a-z0-9]+$/i.test(item.imageId))) throw new Error('Invalid image');
      return { id: item.id!, name: item.name, type: item.type, imageId: item.imageId, active: item.active, status: item.status };
    });
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('Duplicate image');
    return { capturedAt: catalog.capturedAt, items };
  } catch {
    throw new ServiceUnavailableException('墨攻镜像目录快照不可用，请联系管理员更新快照。');
  }
}

export function isCollectableMogongImage(image: { name: string; type: string; imageId: string | null; active: boolean; status: string }) {
  return image.active && image.status === 'successful' && image.type === 'vm' && Boolean(image.imageId)
    && !/废弃|弃用|已淘汰|已废止/i.test(image.name);
}

@Controller('admin/image-catalog')
@UseGuards(AdminAuthGuard)
export class ImageCatalogController {
  constructor(private readonly imageCatalogService: ImageCatalogService, private readonly operationControl: OperationControlService) {}

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
    const items = catalog.items.filter((item) => item.imageId && imageIds.has(item.imageId));
    return { capturedAt: catalog.capturedAt, total: items.length, items };
  }

  @Post('mogong/:id/collect')
  async collectMogong(@Req() request: AuthenticatedPlatformRequest, @Param('id') id: string) {
    const catalog = await readMogongImageCatalog();
    const image = catalog.items.find((item) => String(item.id) === id);
    if (!image) throw new NotFoundException('墨攻镜像不存在');
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
