import { Body, Controller, HttpCode, Post } from '@nestjs/common';

import { AdminSessionService } from './admin-session.service';

type LoginBody = {
  username: string;
  password: string;
};

@Controller('admin/session')
export class AdminSessionController {
  constructor(private readonly adminSessionService: AdminSessionService) {}

  @Post()
  @HttpCode(200)
  createSession(@Body() body: LoginBody) {
    return this.adminSessionService.createSession(body);
  }
}
