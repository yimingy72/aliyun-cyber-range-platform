import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from './admin-auth.guard';
import { CurrentAdminUser } from './current-admin-user.decorator';
import type { SessionUserProfile } from './admin-user-auth';
import { PackedImagesService } from './packed-images.service';

@Controller('admin/packed-images')
@UseGuards(AdminAuthGuard)
export class PackedImagesController {
  constructor(private readonly images: PackedImagesService) {}

  @Get()
  list(@CurrentAdminUser() user: SessionUserProfile, @Query('sourceRangeInstanceId') sourceId?: string) {
    return this.images.listTasks(user, sourceId);
  }

  @Get(':id')
  get(@CurrentAdminUser() user: SessionUserProfile, @Param('id') id: string) {
    return this.images.getTask(id, user);
  }

  @Post(':id/verify')
  verify(@CurrentAdminUser() user: SessionUserProfile, @Param('id') id: string) {
    return this.images.verifyTask(id, user);
  }
}
