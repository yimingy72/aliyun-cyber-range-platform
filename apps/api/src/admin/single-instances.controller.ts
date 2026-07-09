import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import {
  LaunchSingleInstanceDto,
  TriggerSingleInstanceActionDto,
  TriggerSingleInstanceBatchDestroyDto,
  TriggerSingleInstanceDestroyDto,
} from './dto/single-instance.dto';
import { SingleInstancesService } from './single-instances.service';

@Controller('admin/instances')
@UseGuards(AdminAuthGuard)
export class SingleInstancesController {
  constructor(private readonly singleInstancesService: SingleInstancesService) {}

  @Get()
  list() {
    return this.singleInstancesService.list();
  }

  @Post('launch')
  launch(@Body() body: LaunchSingleInstanceDto) {
    return this.singleInstancesService.launch(body);
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
    @Param('id') id: string,
    @Param('action') action: 'reboot' | 'open-vnc' | 'pack-image',
    @Body() body: TriggerSingleInstanceActionDto,
  ) {
    return this.singleInstancesService.runAction(id, action, {
      triggeredBy: body.triggeredBy,
      ...(body.displayName ? { displayName: body.displayName } : {}),
    });
  }
}
