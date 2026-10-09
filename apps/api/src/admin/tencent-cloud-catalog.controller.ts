import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { TencentCloudCatalogQueryDto } from './dto/tencent-cloud-catalog.dto';
import { TencentCloudCatalogService } from './tencent-cloud-catalog.service';

@Controller('admin/tencent-cloud/contexts')
@UseGuards(AdminAuthGuard)
export class TencentCloudCatalogController {
  constructor(private readonly catalog: TencentCloudCatalogService) {}

  @Get(':contextId/images')
  listImages(@Param('contextId') contextId: string, @Query() query: TencentCloudCatalogQueryDto) {
    return this.catalog.listImages(contextId, query);
  }
}
