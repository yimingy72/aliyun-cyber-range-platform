import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { SessionUserProfile } from './admin-user-auth';
import {
  LaunchSingleInstanceDto,
  TriggerSingleInstanceActionDto,
  TriggerSingleInstanceBatchDestroyDto,
  TriggerSingleInstanceDestroyDto,
} from './dto/single-instance.dto';
import { SingleInstancesService } from './single-instances.service';

type AuthenticatedAdminRequest = {
  adminUser: SessionUserProfile;
};

@Controller('admin/instances')
@UseGuards(AdminAuthGuard)
export class SingleInstancesController {
  constructor(private readonly singleInstancesService: SingleInstancesService) {}

  @Get()
  list() {
    return this.singleInstancesService.list();
  }

  @Post('launch')
  launch(@Req() request: AuthenticatedAdminRequest, @Body() body: LaunchSingleInstanceDto) {
    return this.singleInstancesService.launch(
      {
        ...body,
        triggeredBy: request.adminUser.id,
      },
      request.adminUser.id,
    );
  }

  @Post(':id/destroy')
  destroy(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() _body: TriggerSingleInstanceDestroyDto) {
    return this.singleInstancesService.destroy(id, request.adminUser.id);
  }

  @Post('batches/:id/destroy-all')
  destroyBatch(
    @Req() request: AuthenticatedAdminRequest,
    @Param('id') id: string,
    @Body() _body: TriggerSingleInstanceBatchDestroyDto,
  ) {
    return this.singleInstancesService.destroyBatch(id, request.adminUser.id);
  }

  @Post(':id/retry')
  retry(@Req() request: AuthenticatedAdminRequest, @Param('id') id: string, @Body() _body: TriggerSingleInstanceDestroyDto) {
    return this.singleInstancesService.retry(id, request.adminUser.id);
  }

  @Post(':id/actions/:action')
  runAction(
    @Req() request: AuthenticatedAdminRequest,
    @Param('id') id: string,
    @Param('action') action: 'reboot' | 'open-vnc' | 'pack-image',
    @Body() body: TriggerSingleInstanceActionDto,
  ) {
    return this.singleInstancesService.runAction(id, action, {
      triggeredBy: request.adminUser.id,
      ownerUserId: request.adminUser.id,
      ...(body.displayName ? { displayName: body.displayName } : {}),
      ...(body.defaultHostName ? { defaultHostName: body.defaultHostName } : {}),
      ...(body.defaultPassword ? { defaultPassword: body.defaultPassword } : {}),
      ...(body.description ? { description: body.description } : {}),
    });
  }
}
