import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { TencentCloudCatalogQueryDto, TencentCloudRegionsQueryDto } from './dto/tencent-cloud-catalog.dto';
import { TencentCloudCatalogService } from './tencent-cloud-catalog.service';

@Controller('admin/tencent-cloud')
@UseGuards(AdminAuthGuard)
export class TencentCloudCatalogController {
  constructor(private readonly catalog: TencentCloudCatalogService) {}

  @Post('regions/query')
  discoverRegions(@Body() input: TencentCloudRegionsQueryDto) {
    return this.catalog.discoverRegions(input);
  }

  @Get('contexts/:contextId/images')
  listImages(@Param('contextId') contextId: string, @Query() query: TencentCloudCatalogQueryDto) {
    return this.catalog.listImages(contextId, query);
  }
}
