import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';

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
}
