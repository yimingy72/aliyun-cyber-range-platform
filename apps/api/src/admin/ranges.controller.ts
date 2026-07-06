import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { SaveRangeInstanceDraftDto } from './dto/range-instance-draft.dto';
import { CreateRangeInstanceDto, LaunchRangeInstanceDto, TriggerProvisionJobDto } from './dto/range-instance.dto';
import { RangeInstancesService } from './range-instances.service';

@Controller('admin/ranges')
@UseGuards(AdminAuthGuard)
export class RangesController {
  constructor(private readonly rangeInstancesService: RangeInstancesService) {}

  @Get()
  list() {
    return this.rangeInstancesService.list();
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.rangeInstancesService.getById(id);
  }

  @Patch(':id/draft')
  saveDraft(@Param('id') id: string, @Body() body: SaveRangeInstanceDraftDto) {
    return this.rangeInstancesService.saveDraft(id, body);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.rangeInstancesService.delete(id);
  }

  @Delete(':id/draft')
  discardDraft(@Param('id') id: string) {
    return this.rangeInstancesService.discardDraft(id);
  }

  @Post()
  create(@Body() body: CreateRangeInstanceDto) {
    return this.rangeInstancesService.create(body);
  }

  @Post('launch')
  launch(@Body() body: LaunchRangeInstanceDto) {
    return this.rangeInstancesService.launch(body);
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

  @Post(':id/apply')
  applyDraft(@Param('id') id: string, @Body() body: TriggerProvisionJobDto) {
    return this.rangeInstancesService.applyDraft(id, body.triggeredBy);
  }
}
