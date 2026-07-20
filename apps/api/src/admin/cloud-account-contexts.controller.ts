import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CloudAccountContextsService } from './cloud-account-contexts.service';
import { CurrentAdminUser } from './current-admin-user.decorator';
import { CreateCloudAccountContextDto } from './dto/cloud-account-context.dto';
import type { SessionUserProfile } from './admin-user-auth';

@Controller('admin/cloud-contexts')
@UseGuards(AdminAuthGuard)
export class CloudAccountContextsController {
  constructor(private readonly cloudAccountContextsService: CloudAccountContextsService) {}

  @Get()
  list(@CurrentAdminUser() currentUser: SessionUserProfile) {
    return this.cloudAccountContextsService.list({ includeInactive: currentUser.role === 'admin' });
  }

  @Post()
  create(@Body() body: CreateCloudAccountContextDto) {
    return this.cloudAccountContextsService.create(body);
  }

  @Post(':id/ensure-bucket')
  ensureBucket(@Param('id') id: string) {
    return this.cloudAccountContextsService.ensureBucket(id);
  }

  @Post(':id/activate')
  activate(@Param('id') id: string) {
    return this.cloudAccountContextsService.activate(id);
  }
}
