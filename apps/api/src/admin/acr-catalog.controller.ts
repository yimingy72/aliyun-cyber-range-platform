import { BadRequestException, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AcrCatalogService } from './acr-catalog.service';
import { AdminAuthGuard } from './admin-auth.guard';

@Controller('admin/image-catalog/acr')
@UseGuards(AdminAuthGuard)
export class AcrCatalogController {
  constructor(private readonly catalog: AcrCatalogService) {}

  @Get()
  list(@Query('page') page = '1', @Query('pageSize') pageSize = '20', @Query('search') search = '') {
    if (typeof page !== 'string' || !/^\d{1,6}$/.test(page) || Number(page) < 1 ||
        typeof pageSize !== 'string' || !['20', '50', '100'].includes(pageSize) ||
        typeof search !== 'string' || search.length > 253) throw new BadRequestException('无效的 ACR 目录查询条件。');
    return this.catalog.list(Number(page), Number(pageSize), search);
  }

  @Post('sync')
  sync() { return this.catalog.start(); }
}
