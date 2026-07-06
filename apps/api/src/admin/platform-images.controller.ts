import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CollectPlatformImageDto, RenamePlatformImageDto } from './dto/platform-image.dto';
import { ImageCatalogService } from './image-catalog.service';

@Controller('admin/platform-images')
@UseGuards(AdminAuthGuard)
export class PlatformImagesController {
  constructor(private readonly imageCatalogService: ImageCatalogService) {}

  @Get()
  list() {
    return this.imageCatalogService.listPlatformAssets();
  }

  @Post()
  collect(@Body() body: CollectPlatformImageDto) {
    return this.imageCatalogService.collectPlatformAsset(body.snapshotId, body.displayName);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() body: RenamePlatformImageDto) {
    return this.imageCatalogService.renamePlatformAsset(id, body.displayName);
  }

  @Post(':id/enable')
  enable(@Param('id') id: string) {
    return this.imageCatalogService.setPlatformAssetEnabled(id, true);
  }

  @Post(':id/disable')
  disable(@Param('id') id: string) {
    return this.imageCatalogService.setPlatformAssetEnabled(id, false);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.imageCatalogService.removePlatformAsset(id);
  }
}
