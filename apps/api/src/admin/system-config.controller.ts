import { BadRequestException, Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import {
  maskSystemCloudConfig,
  SystemConfigService,
  type SystemCloudConfig,
} from './system-config.service';

@Controller('admin/system-config')
@UseGuards(AdminAuthGuard)
export class SystemConfigController {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  @Get()
  async getSnapshot() {
    return maskSystemCloudConfig(await this.systemConfigService.getSnapshot());
  }

  @Get('instance-type-availability')
  async getInstanceTypeAvailability(@Query('cpu') cpuText?: string, @Query('memory') memoryText?: string) {
    const cpu = Number.parseInt(cpuText ?? '', 10);
    const memory = Number.parseInt(memoryText ?? '', 10);

    if (!Number.isInteger(cpu) || cpu <= 0 || !Number.isInteger(memory) || memory <= 0) {
      throw new BadRequestException('cpu 和 memory 必须是大于 0 的整数');
    }

    return this.systemConfigService.getInstanceTypeAvailability({
      cpu,
      memory,
    });
  }

  @Patch()
  async updateSnapshot(@Body() payload: Partial<SystemCloudConfig>) {
    return maskSystemCloudConfig(await this.systemConfigService.updateSnapshot(payload));
  }
}
