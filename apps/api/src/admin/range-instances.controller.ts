import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CreateRangeInstanceDto, TriggerProvisionJobDto } from './dto/range-instance.dto';
import { RangeInstancesService } from './range-instances.service';

@Controller('admin/range-instances')
@UseGuards(AdminAuthGuard)
export class RangeInstancesController {
  constructor(private readonly rangeInstancesService: RangeInstancesService) {}

  @Get()
  list() {
    return this.rangeInstancesService.list();
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.rangeInstancesService.getById(id);
  }

  @Post()
  create(@Body() body: CreateRangeInstanceDto) {
    return this.rangeInstancesService.create(body);
  }

  @Post(':id/create')
  triggerCreate(@Param('id') id: string, @Body() body: TriggerProvisionJobDto) {
    return this.rangeInstancesService.triggerCreate(id, body.triggeredBy);
  }

  @Post(':id/destroy')
  triggerDestroy(@Param('id') id: string, @Body() body: TriggerProvisionJobDto) {
    return this.rangeInstancesService.triggerDestroy(id, body.triggeredBy);
  }

  @Post(':id/retry')
  triggerRetry(@Param('id') id: string, @Body() body: TriggerProvisionJobDto) {
    return this.rangeInstancesService.triggerRetry(id, body.triggeredBy);
  }
}
