import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { ADMIN_REPOSITORY, AdminRepository } from './admin.repository';

type ResolveOidcPrincipalInput = {
  issuer: string;
  subject: string;
};

@Injectable()
export class OidcPrincipalResolver {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository) {}

  async resolve(input: ResolveOidcPrincipalInput) {
    const user = await this.repository.getPlatformUserByOidcIdentity(input.issuer, input.subject);

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('OIDC principal is not mapped to an active platform user');
    }

    return user;
  }
}
