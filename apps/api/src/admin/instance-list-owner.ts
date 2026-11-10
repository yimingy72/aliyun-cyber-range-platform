import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { SessionUserProfile } from './admin-user-auth';

export function listAllInstanceOwners(user?: Pick<SessionUserProfile, 'role'>, owner: string = 'mine') {
  if (owner === 'mine') return false;
  if (owner !== 'all') throw new BadRequestException('owner must be mine or all');
  if (user?.role !== 'admin') throw new ForbiddenException('Only administrators can list all users’ instances');
  return true;
}
