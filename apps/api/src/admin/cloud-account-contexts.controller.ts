import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CloudAccountContextsService } from './cloud-account-contexts.service';
import { SaveCloudAccountContextDto } from './dto/cloud-account-context.dto';
import { SystemConfigService } from './system-config.service';
import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';

@Controller('admin/cloud-contexts')
@UseGuards(AdminAuthGuard)
export class CloudAccountContextsController {
  constructor(
    private readonly cloudAccountContextsService: CloudAccountContextsService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedPlatformRequest, @Query('includeInactive') includeInactive?: string) {
    if (includeInactive !== undefined && !['true', 'false'].includes(includeInactive)) {
      throw new BadRequestException('includeInactive 必须为 true 或 false。');
    }
    if (includeInactive === 'true' && request.adminUser?.role !== 'admin') {
      throw new ForbiddenException('仅管理员可查看未启用的云账号。');
    }
    return this.cloudAccountContextsService.list({ includeInactive: includeInactive === 'true' });
  }

  @Post()
  save(@Body() payload: SaveCloudAccountContextDto) {
    return this.cloudAccountContextsService.saveTencentCloudContext(payload);
  }

  @Get(':id/instance-type-availability')
  async getInstanceTypeAvailability(@Param('id') id: string, @Query('cpu') cpuText?: string, @Query('memory') memoryText?: string) {
    const cpu = Number(cpuText);
    const memory = Number(memoryText);
    if (!cpuText || !memoryText || !/^\d+$/.test(cpuText) || !/^\d+$/.test(memoryText)
      || !Number.isSafeInteger(cpu) || cpu <= 0 || !Number.isSafeInteger(memory) || memory <= 0) {
      throw new BadRequestException('cpu 和 memory 必须是大于 0 的整数');
    }
    const context = await this.systemConfigService.getAccountContextById(id);
    return this.systemConfigService.getInstanceTypeAvailabilityInContext({ cpu, memory }, context);
  }
}
