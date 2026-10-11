import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';

import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { AdminAuthGuard } from './admin-auth.guard';
import { CreatePlatformImageTagDto } from './dto/platform-image-tag.dto';
import { ImageCatalogService } from './image-catalog.service';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';

@Controller('admin/platform-image-tags')
@UseGuards(AdminAuthGuard)
export class PlatformImageTagsController {
  constructor(private readonly imageCatalogService: ImageCatalogService, private readonly operationControlService: OperationControlService) {}

  @Get()
  list() {
    return this.imageCatalogService.listPlatformImageTags();
  }

  @Post()
  create(@Req() request: AuthenticatedPlatformRequest, @Body() body: CreatePlatformImageTagDto) {
    const execute = () => this.imageCatalogService.createPlatformImageTag(body, request.adminUser);
    if (request.authContext.source !== 'mcp') return execute();
    return this.operationControlService.executeConfirmed({
      context: request.authContext, metadata: readOperationRequestMetadata(request),
      toolName: 'platform_image_tag_create', arguments: { name: body.name }, targetType: 'platform_image_tag', targetId: null,
      resolveConfirmation: async () => {
        const target = await this.imageCatalogService.preparePlatformImageTagCreation(body, request.adminUser);
        return { targetId: null, targetSnapshot: target, summary: { targetName: target.name, action: 'create_global_image_tag', destructive: false } };
      },
      execute: async () => ({ result: await execute() }),
    });
  }

  @Delete(':id')
  async remove(@Req() request: AuthenticatedPlatformRequest, @Param('id') id: string) {
    const execute = () => this.imageCatalogService.deletePlatformImageTag(id, request.adminUser);
    const metadata = readOperationRequestMetadata(request);
    if (request.authContext.source !== 'mcp') {
      await this.imageCatalogService.preparePlatformImageTagDeletion(id, request.adminUser);
      const audit = { operationId: metadata.requestId, requestId: metadata.requestId, actorUserId: request.adminUser.id,
        source: request.authContext.source, oauthClientId: request.authContext.oauthClientId,
        toolName: 'platform_image_tag_delete', targetType: 'platform_image_tag', targetId: id, sanitizedInput: { platformImageTagId: id } };
      await this.operationControlService.audit({ ...audit, phase: 'requested' });
      try {
        const result = await execute();
        await this.operationControlService.audit({ ...audit, phase: 'succeeded' });
        return result;
      } catch (error) {
        await this.operationControlService.audit({ ...audit, phase: 'failed', errorCode: 'TAG_DELETE_FAILED' });
        throw error;
      }
    }
    return this.operationControlService.executeConfirmed({
      context: request.authContext, metadata,
      toolName: 'platform_image_tag_delete', arguments: { platformImageTagId: id }, targetType: 'platform_image_tag', targetId: id,
      resolveConfirmation: async () => {
        const target = await this.imageCatalogService.preparePlatformImageTagDeletion(id, request.adminUser);
        return { targetId: id, targetSnapshot: target,
          summary: { targetName: target.name, action: 'delete_workspace_image_tag', destructive: true,
            impact: '删除当前工作空间的标签定义及全部镜像关联，保留镜像与云资源。' } };
      },
      execute: async () => ({ result: await execute() }),
    });
  }

}
