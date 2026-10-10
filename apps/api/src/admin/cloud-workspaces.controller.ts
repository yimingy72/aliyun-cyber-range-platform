import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';

import type { AuthenticatedPlatformRequest } from '../auth/request-auth-context';
import { AdminAuthGuard } from './admin-auth.guard';
import { CloudWorkspacesService } from './cloud-workspaces.service';

@Controller('admin/cloud-workspaces')
@UseGuards(AdminAuthGuard)
export class CloudWorkspacesController {
  constructor(private readonly spaces: CloudWorkspacesService) {}

  @Get()
  list(@Req() request: AuthenticatedPlatformRequest) { return this.spaces.list(request.adminUser); }

  @Get('current')
  current(@Req() request: AuthenticatedPlatformRequest) {
    return this.spaces.current(request.adminUser, request.headers['x-cloud-workspace-id']);
  }

  @Post(':id/switch')
  switch(@Req() request: AuthenticatedPlatformRequest, @Param('id') id: string) {
    return this.spaces.switch(request.adminUser, id);
  }
}

@Controller('admin/session')
@UseGuards(AdminAuthGuard)
export class PlatformSessionController {
  @Get()
  get(@Req() request: AuthenticatedPlatformRequest) { return request.adminUser; }
}
