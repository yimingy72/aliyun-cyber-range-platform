import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { CollectPlatformImageDto, ListPlatformImagesDto, UpdatePlatformImageDto } from './dto/platform-image.dto';
import { SetPlatformImageTagsDto } from './dto/platform-image-tag.dto';
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

  @Put(':id/tags')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  setTags(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() body: SetPlatformImageTagsDto) {
    const execute = () => this.imageCatalogService.setPlatformAssetTags(id, body, request.adminUser);
    if (request.authContext.source !== 'mcp') return execute();
    return this.operationControlService.executeConfirmed({
      context: request.authContext, metadata: readOperationRequestMetadata(request),
      toolName: 'platform_image_tags_set', arguments: { platformImageAssetId: id, tagIds: body.tagIds }, targetType: 'platform_image', targetId: id,
      resolveConfirmation: async () => {
        const target = await this.imageCatalogService.preparePlatformAssetTags(id, body, request.adminUser);
        return { targetId: id, targetSnapshot: target, summary: { targetName: target.displayName, action: 'replace_all_image_tag_associations', tagIds: target.tagIds, destructive: false } };
      },
      execute: async () => ({ result: await execute() }),
    });
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
      metadata,
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
