import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import type { SessionUserProfile } from './admin-user-auth';
import {
  LaunchSingleInstanceDto,
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
    @Body() body: Record<string, unknown>,
  ) {
    return this.singleInstancesService.runAction(id, action, {
      ownerUserId: request.adminUser.id,
      ...this.sanitizeActionPayload(body),
    });
  }

  private sanitizeActionPayload(body: Record<string, unknown>) {
    const keys = ['displayName', 'defaultHostName', 'defaultPassword', 'description'] as const;
    const payload: Record<string, string> = {};

    for (const key of keys) {
      const value = body[key];

      if (value === undefined) {
        continue;
      }

      if (typeof value !== 'string') {
        throw new BadRequestException(`${key} must be a string`);
      }

      payload[key] = value;
    }

    return payload;
  }
}
