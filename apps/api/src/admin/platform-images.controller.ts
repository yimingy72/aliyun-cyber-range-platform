import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { SessionUserProfile } from './admin-user-auth';
import { CollectPlatformImageDto, ListPlatformImagesDto, UpdatePlatformImageDto } from './dto/platform-image.dto';
import { ImageCatalogService } from './image-catalog.service';

type AuthenticatedAdminRequest = {
  headers: Record<string, string | undefined>;
  adminUser: SessionUserProfile;
};

@Controller('admin/platform-images')
export class PlatformImagesController {
  constructor(private readonly imageCatalogService: ImageCatalogService) {}

  @Get()
  @UseGuards(AdminAuthGuard)
  list(@Req() request: AuthenticatedAdminRequest, @Query() query: ListPlatformImagesDto) {
    return this.imageCatalogService.listPlatformAssets(request.adminUser.id, query.view);
  }

  @Post()
  @UseGuards(AdminAuthGuard)
  collect(@Body() body: CollectPlatformImageDto) {
    return this.imageCatalogService.collectPlatformAsset(body.snapshotId, body.displayName);
  }

  @Patch(':id')
  @UseGuards(AdminAuthGuard)
  update(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() body: UpdatePlatformImageDto) {
    return this.imageCatalogService.updatePlatformAsset(id, body, request.adminUser);
  }

  @Post(':id/enable')
  @UseGuards(AdminAuthGuard)
  enable(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.imageCatalogService.setPlatformAssetEnabled(id, true, request.adminUser);
  }

  @Post(':id/disable')
  @UseGuards(AdminAuthGuard)
  disable(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.imageCatalogService.setPlatformAssetEnabled(id, false, request.adminUser);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  async publish(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.imageCatalogService.updatePlatformAsset(id, { visibility: 'platform' }, request.adminUser);
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  async unpublish(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.imageCatalogService.updatePlatformAsset(id, { visibility: 'private' }, request.adminUser);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(AdminAuthGuard)
  remove(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.imageCatalogService.removePlatformAsset(id, request.adminUser);
  }
}
