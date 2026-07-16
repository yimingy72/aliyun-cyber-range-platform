import { UnauthorizedException } from '@nestjs/common';

import { OidcPrincipalResolver } from '../src/admin/oidc-principal-resolver';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('OidcPrincipalResolver', () => {
  it('resolves an active platform user from issuer and subject', async () => {
    const repository = createMemoryAdminRepository();
    const resolver = new OidcPrincipalResolver(repository);

    await repository.createPlatformUser({
      id: 'alice',
      username: 'alice',
      passwordHash: 'unused',
      oidcIssuer: 'https://issuer.example/realms/cyber-range',
      oidcSubject: 'alice-subject',
      role: 'user',
      status: 'active',
    });

    await expect(
      resolver.resolve({
        issuer: 'https://issuer.example/realms/cyber-range',
        subject: 'alice-subject',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'alice',
        username: 'alice',
        role: 'user',
        status: 'active',
      }),
    );
  });

  it('rejects unknown or disabled OIDC identities', async () => {
    const repository = createMemoryAdminRepository();
    const resolver = new OidcPrincipalResolver(repository);

    await repository.createPlatformUser({
      id: 'bob',
      username: 'bob',
      passwordHash: 'unused',
      oidcIssuer: 'https://issuer.example/realms/cyber-range',
      oidcSubject: 'bob-subject',
      role: 'user',
      status: 'disabled',
    });

    await expect(
      resolver.resolve({
        issuer: 'https://issuer.example/realms/cyber-range',
        subject: 'missing-subject',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      resolver.resolve({
        issuer: 'https://issuer.example/realms/cyber-range',
        subject: 'bob-subject',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
