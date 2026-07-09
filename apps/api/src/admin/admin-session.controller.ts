import { Body, Controller, HttpCode, Post } from '@nestjs/common';

import { LoginAdminSessionDto } from './dto/admin-user.dto';
import { AdminSessionService } from './admin-session.service';

@Controller('admin/session')
export class AdminSessionController {
  constructor(private readonly adminSessionService: AdminSessionService) {}

  @Post()
  @HttpCode(200)
  createSession(@Body() body: LoginAdminSessionDto) {
    return this.adminSessionService.createSession(body);
  }
}
