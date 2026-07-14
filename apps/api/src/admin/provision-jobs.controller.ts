import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { SessionUserProfile } from './admin-user-auth';
import { ProvisionJobsService } from './provision-jobs.service';

type AuthenticatedAdminRequest = {
  adminUser: SessionUserProfile;
};

@Controller('admin/provision-jobs')
@UseGuards(AdminAuthGuard)
export class ProvisionJobsController {
  constructor(private readonly provisionJobsService: ProvisionJobsService) {}

  @Get()
  list(@Req() request: AuthenticatedAdminRequest, @Query('instanceMode') instanceMode?: 'single' | 'range') {
    return this.provisionJobsService.list(request.adminUser, instanceMode);
  }

  @Get(':id')
  getById(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.provisionJobsService.getById(id, request.adminUser);
  }

  @Get(':id/steps')
  listSteps(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.provisionJobsService.listSteps(id, request.adminUser);
  }
}
