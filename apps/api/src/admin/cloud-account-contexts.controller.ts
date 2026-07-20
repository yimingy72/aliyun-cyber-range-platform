import { Controller, Get, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CloudAccountContextsService } from './cloud-account-contexts.service';

@Controller('admin/cloud-contexts')
@UseGuards(AdminAuthGuard)
export class CloudAccountContextsController {
  constructor(private readonly cloudAccountContextsService: CloudAccountContextsService) {}

  @Get()
  list() {
    return this.cloudAccountContextsService.list();
  }
}
