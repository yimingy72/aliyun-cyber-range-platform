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
    return this.singleInstancesService.launch(body, request.adminUser.id);
  }

  @Post(':id/destroy')
  destroy(@Param('id') id: string, @Body() body: TriggerSingleInstanceDestroyDto) {
    return this.singleInstancesService.destroy(id, body.triggeredBy);
  }

  @Post('batches/:id/destroy-all')
  destroyBatch(@Param('id') id: string, @Body() body: TriggerSingleInstanceBatchDestroyDto) {
    return this.singleInstancesService.destroyBatch(id, body.triggeredBy);
  }

  @Post(':id/retry')
  retry(@Param('id') id: string, @Body() body: TriggerSingleInstanceDestroyDto) {
    return this.singleInstancesService.retry(id, body.triggeredBy);
  }

  @Post(':id/actions/:action')
  runAction(
    @Req() request: AuthenticatedAdminRequest,
    @Param('id') id: string,
    @Param('action') action: 'reboot' | 'open-vnc' | 'pack-image',
    @Body() body: TriggerSingleInstanceActionDto,
  ) {
    return this.singleInstancesService.runAction(id, action, {
      triggeredBy: body.triggeredBy,
      ownerUserId: request.adminUser.id,
      ...(body.displayName ? { displayName: body.displayName } : {}),
      ...(body.defaultHostName ? { defaultHostName: body.defaultHostName } : {}),
      ...(body.defaultPassword ? { defaultPassword: body.defaultPassword } : {}),
      ...(body.description ? { description: body.description } : {}),
    });
  }
}
