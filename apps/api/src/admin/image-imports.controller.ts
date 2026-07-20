import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { AdminAuthGuard } from './admin-auth.guard';
import { CurrentAdminUser } from './current-admin-user.decorator';
import type { SessionUserProfile } from './admin-user-auth';
import { CreateImageImportDto } from './dto/image-import.dto';
import { ImageImportsService } from './image-imports.service';

@Controller('admin/image-imports')
@UseGuards(AdminAuthGuard)
export class ImageImportsController {
  constructor(private readonly imageImportsService: ImageImportsService) {}

  @Get()
  list(@CurrentAdminUser() currentUser: SessionUserProfile) {
    return this.imageImportsService.list(currentUser);
  }

  @Post()
  create(@Body() body: CreateImageImportDto, @CurrentAdminUser() currentUser: SessionUserProfile) {
    return this.imageImportsService.createUpload(body, currentUser);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentAdminUser() currentUser: SessionUserProfile) {
    return this.imageImportsService.get(id, currentUser);
  }

  @Post(':id/complete')
  complete(@Param('id') id: string, @CurrentAdminUser() currentUser: SessionUserProfile) {
    return this.imageImportsService.completeUpload(id, currentUser);
  }

  @Post(':id/retry')
  retry(@Param('id') id: string, @CurrentAdminUser() currentUser: SessionUserProfile) {
    return this.imageImportsService.retry(id, currentUser);
  }
}
