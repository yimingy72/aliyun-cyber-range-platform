import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const authorizationHeader = request.headers.authorization ?? '';
    const configuredToken = process.env.ADMIN_TOKEN ?? 'dev-admin-token';

    if (authorizationHeader === `Bearer ${configuredToken}`) {
      return true;
    }

    throw new UnauthorizedException('Missing or invalid admin token');
  }
}
