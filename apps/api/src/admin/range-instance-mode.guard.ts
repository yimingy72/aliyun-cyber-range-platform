import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ADMIN_REPOSITORY, type AdminRepository } from './admin.repository';
import { runInCloudWorkspace, type CloudWorkspaceScope } from '../auth/cloud-workspace-scope';

// Range and standalone IDs share a table, but not delegated permission namespaces.
// Keep this at the external route boundary: the internal node executor also serves singles.
@Injectable()
export class RangeInstanceModeGuard implements CanActivate {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ params?: { id?: string }; cloudWorkspaceScope?: CloudWorkspaceScope }>();
    const id = request.params?.id;
    if (!id) return true;
    const check = async () => {
      const instance = await this.repository.getRangeInstanceById(id);
      if (!instance || instance.instanceMode !== 'range') throw new NotFoundException('Range instance not found');
      return true;
    };
    // Guards precede interceptors; use the scope already verified by AdminAuthGuard.
    return request.cloudWorkspaceScope ? runInCloudWorkspace(request.cloudWorkspaceScope, check) : check();
  }
}
