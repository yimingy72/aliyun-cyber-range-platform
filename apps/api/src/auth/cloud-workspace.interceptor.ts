import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

import { runInCloudWorkspace, type CloudWorkspaceScope } from './cloud-workspace-scope';

@Injectable()
export class CloudWorkspaceInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{ cloudWorkspaceScope?: CloudWorkspaceScope }>();
    if (!request.cloudWorkspaceScope) return next.handle();
    return new Observable(subscriber => {
      const subscription = runInCloudWorkspace(request.cloudWorkspaceScope!, () => next.handle().subscribe(subscriber));
      return () => subscription.unsubscribe();
    });
  }
}
