import { BadRequestException, Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';

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
  getById(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Query('includeEvidence') includeEvidence?: string,
    @Query('includeCloudEvents') includeCloudEvents?: string, @Query('cloudResourceIds') cloudResourceIds?: string) {
    if (includeEvidence !== undefined && includeEvidence !== 'true' && includeEvidence !== 'false') throw new BadRequestException('includeEvidence must be true or false');
    if (includeCloudEvents !== undefined && includeCloudEvents !== 'true' && includeCloudEvents !== 'false') throw new BadRequestException('includeCloudEvents must be true or false');
    const ids = typeof cloudResourceIds === 'string' ? cloudResourceIds.split(',') : undefined;
    if (cloudResourceIds !== undefined && (!ids || !ids.length || ids.length > 20 || ids.some(value => !/^(i|d|ngw|eip)-[a-z0-9]+$/i.test(value))
      || new Set(ids).size !== ids.length || includeCloudEvents !== 'true')) throw new BadRequestException('Select 1 to 20 native resource IDs with includeCloudEvents');
    return this.provisionJobsService.getById(id, request.adminUser, includeEvidence === 'true', includeCloudEvents === 'true', ids);
  }

  @Get(':id/steps')
  listSteps(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string) {
    return this.provisionJobsService.listSteps(id, request.adminUser);
  }
}
