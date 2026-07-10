import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { SessionUserProfile } from './admin-user-auth';
import { CollectPlatformImageDto, ListPlatformImagesDto, RenamePlatformImageDto } from './dto/platform-image.dto';
import { ImageCatalogService } from './image-catalog.service';

type AuthenticatedAdminRequest = {
  adminUser: SessionUserProfile;
};

@Controller('admin/platform-images')
@UseGuards(AdminAuthGuard)
export class PlatformImagesController {
  constructor(private readonly imageCatalogService: ImageCatalogService) {}

  @Get()
  list(@Req() request: AuthenticatedAdminRequest, @Query() query: ListPlatformImagesDto) {
    return this.imageCatalogService.listPlatformAssets(request.adminUser.id, query.view);
  }

  @Post()
  collect(@Body() body: CollectPlatformImageDto) {
    return this.imageCatalogService.collectPlatformAsset(body.snapshotId, body.displayName);
  }

  @Patch(':id')
  rename(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() body: RenamePlatformImageDto) {
    return this.imageCatalogService.renamePlatformAsset(id, body.displayName, request.adminUser);
  }

  @Post(':id/enable')
  enable(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.imageCatalogService.setPlatformAssetEnabled(id, true, request.adminUser);
  }

  @Post(':id/disable')
  disable(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.imageCatalogService.setPlatformAssetEnabled(id, false, request.adminUser);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.imageCatalogService.removePlatformAsset(id, request.adminUser);
  }
}
