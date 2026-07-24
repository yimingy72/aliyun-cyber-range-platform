import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { CollectPlatformImageDto, ListPlatformImagesDto, UpdatePlatformImageDto } from './dto/platform-image.dto';
import { ImageCatalogService } from './image-catalog.service';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';

type AuthenticatedAdminRequest = AuthenticatedPlatformRequest;

@Controller('admin/platform-images')
export class PlatformImagesController {
  constructor(
    private readonly imageCatalogService: ImageCatalogService,
    private readonly operationControlService: OperationControlService,
  ) {}

  @Get()
  @UseGuards(AdminAuthGuard)
  list(@Req() request: AuthenticatedAdminRequest, @Query() query: ListPlatformImagesDto) {
    return this.imageCatalogService.listPlatformAssets(request.adminUser, query.view);
  }

  @Post()
  @UseGuards(AdminAuthGuard)
  collect(@Req() request: AuthenticatedAdminRequest, @Body() body: CollectPlatformImageDto) {
    return this.mcpWrite(request, 'platform_image_collect', body as unknown as Record<string, unknown>, body.snapshotId, () =>
      this.imageCatalogService.collectPlatformAsset(body.snapshotId, body.displayName, request.adminUser),
    );
  }

  @Patch(':id')
  @UseGuards(AdminAuthGuard)
  update(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() body: UpdatePlatformImageDto) {
    return this.mcpWrite(request, 'platform_image_rename', { platformImageAssetId: id, ...body }, id, () =>
      this.imageCatalogService.updatePlatformAsset(id, body, request.adminUser),
    );
  }

  @Post(':id/enable')
  @UseGuards(AdminAuthGuard)
  enable(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.mcpWrite(request, 'platform_image_enable', { platformImageAssetId: id }, id, () =>
      this.imageCatalogService.setPlatformAssetEnabled(id, true, request.adminUser),
    );
  }

  @Post(':id/disable')
  @UseGuards(AdminAuthGuard)
  disable(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.mcpWrite(request, 'platform_image_disable', { platformImageAssetId: id }, id, () =>
      this.imageCatalogService.setPlatformAssetEnabled(id, false, request.adminUser),
    );
  }

  @Post(':id/publish')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  publish(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.mcpWrite(request, 'platform_image_publish', { platformImageAssetId: id }, id, () =>
      this.imageCatalogService.updatePlatformAsset(id, { visibility: 'platform' }, request.adminUser),
    );
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  unpublish(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.mcpWrite(request, 'platform_image_unpublish', { platformImageAssetId: id }, id, () =>
      this.imageCatalogService.updatePlatformAsset(id, { visibility: 'private' }, request.adminUser),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(AdminAuthGuard)
  remove(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.mcpWrite(request, 'platform_image_remove', { platformImageAssetId: id }, id, () =>
      this.imageCatalogService.removePlatformAsset(id, request.adminUser),
    );
  }

  private mcpWrite<TResult>(
    request: AuthenticatedAdminRequest,
    toolName: string,
    argumentsValue: Record<string, unknown>,
    targetId: string,
    execute: () => Promise<TResult>,
  ) {
    if (request.authContext.source !== 'mcp') {
      return execute();
    }
    const metadata = readOperationRequestMetadata(request);
    return this.operationControlService.executeConfirmed({
      context: request.authContext,
      metadata: { ...metadata, idempotencyKey: metadata.idempotencyKey ?? `${toolName}:${targetId}:${metadata.requestId}` },
      toolName,
      arguments: argumentsValue,
      targetType: 'platform_image',
      targetId,
      resolveConfirmation: async () => ({
        targetId,
        targetSnapshot: { platformImageAssetId: targetId },
        summary: { targetName: targetId, destructive: toolName === 'platform_image_remove' },
      }),
      execute: async () => ({ result: await execute() }),
    });
  }
}
