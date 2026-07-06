import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CollectImageCatalogDto } from './dto/image-catalog.dto';
import { ImageCatalogService } from './image-catalog.service';

@Controller('admin/image-catalog')
@UseGuards(AdminAuthGuard)
export class ImageCatalogController {
  constructor(private readonly imageCatalogService: ImageCatalogService) {}

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
  deleteCustomSnapshot(@Param('snapshotId') snapshotId: string) {
    return this.imageCatalogService.deleteCustomSnapshot(snapshotId);
  }
}
