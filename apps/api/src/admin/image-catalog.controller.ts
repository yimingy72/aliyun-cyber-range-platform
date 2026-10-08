import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CollectImageCatalogDto, DeleteCustomImageDto } from './dto/image-catalog.dto';
import { ImageCatalogService } from './image-catalog.service';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { OperationControlService, readOperationRequestMetadata } from '../operations/operation-control.service';

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
