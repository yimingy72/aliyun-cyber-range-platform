import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { SessionUserProfile } from './admin-user-auth';

export const CurrentAdminUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ adminUser?: SessionUserProfile }>();

  return request.adminUser;
});
