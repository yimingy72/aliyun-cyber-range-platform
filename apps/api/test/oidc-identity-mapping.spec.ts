import type { AdminRepository } from '../src/admin/admin.repository';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

type OidcIdentityRepository = AdminRepository & {
  getPlatformUserByOidcIdentity?: (
    issuer: string,
    subject: string,
  ) => ReturnType<AdminRepository['getPlatformUserById']>;
};

type OidcPlatformUserInput = Parameters<AdminRepository['createPlatformUser']>[0] & {
  oidcIssuer: string;
  oidcSubject: string;
};

describe('OIDC identity mapping', () => {
  it('finds a user by the exact issuer and subject', async () => {
    const repository = createMemoryAdminRepository() as OidcIdentityRepository;
    const issuer = 'https://identity.example/realms/cyber-range';
    const alice = await repository.createPlatformUser({
      id: 'alice',
      username: 'alice',
      passwordHash: 'unused-after-keycloak-migration',
      role: 'user',
      oidcIssuer: issuer,
      oidcSubject: 'keycloak-alice',
    } as OidcPlatformUserInput);
    await repository.createPlatformUser({
      id: 'bob',
      username: 'bob',
      passwordHash: 'unused-after-keycloak-migration',
      role: 'user',
      oidcIssuer: issuer,
      oidcSubject: 'keycloak-bob',
    } as OidcPlatformUserInput);

    const findByOidcIdentity = repository.getPlatformUserByOidcIdentity;

    expect(findByOidcIdentity).toEqual(expect.any(Function));

    if (!findByOidcIdentity) {
      return;
    }

    await expect(findByOidcIdentity(issuer, 'keycloak-alice')).resolves.toMatchObject({ id: alice.id });
    await expect(findByOidcIdentity(issuer, 'keycloak-unknown')).resolves.toBeNull();
  });
});
