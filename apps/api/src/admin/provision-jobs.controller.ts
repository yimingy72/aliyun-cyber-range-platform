import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { ProvisionJobsService } from './provision-jobs.service';

@Controller('admin/provision-jobs')
@UseGuards(AdminAuthGuard)
export class ProvisionJobsController {
  constructor(private readonly provisionJobsService: ProvisionJobsService) {}

  @Get()
  list() {
    return this.provisionJobsService.list();
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.provisionJobsService.getById(id);
  }

  @Get(':id/steps')
  listSteps(@Param('id') id: string) {
    return this.provisionJobsService.listSteps(id);
  }
}
