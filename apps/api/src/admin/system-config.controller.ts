import { Controller, Get, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { SystemConfigService } from './system-config.service';

@Controller('admin/system-config')
@UseGuards(AdminAuthGuard)
export class SystemConfigController {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  @Get()
  getSnapshot() {
    return this.systemConfigService.getSnapshot();
  }
}
