import { OidcAdminBootstrapService } from '../src/oidc-admin-bootstrap.service';

describe('OIDC administrator bootstrap', () => {
  const environment = { ...process.env };
  const issuer = 'https://test-issuer.example/realms/cyber-range';
  const seed = { cloudWorkspaceId: null, isPlatformManager: true, loginUsername: 'admin', id: 'admin', username: 'admin', role: 'admin', status: 'active', oidcIssuer: null, oidcSubject: null };

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.ADMIN_USERNAME = 'custom-admin';
    process.env.OIDC_ISSUER = issuer;
  });
  afterEach(() => { process.env = { ...environment }; });

  function setup(user: Record<string, unknown> | null, seedUser: Record<string, unknown> | null = null) {
    const prisma = { platformUser: {
      findUnique: jest.fn().mockResolvedValueOnce(user).mockResolvedValueOnce(seedUser),
      update: jest.fn(),
    } };
    const keycloak = { findUserSubjectByUsername: jest.fn().mockResolvedValue('custom-subject') };
    return { prisma, keycloak, service: new OidcAdminBootstrapService(prisma as never, keycloak as never) };
  }

  it('binds a custom username to the migration seed while retaining its resource owner ID', async () => {
    const { prisma, keycloak, service } = setup(null, seed);
    await service.initialize();
    expect(keycloak.findUserSubjectByUsername).toHaveBeenCalledWith('custom-admin');
    expect(prisma.platformUser.update).toHaveBeenCalledWith({
      where: { id: 'admin' }, data: { username: 'custom-admin', loginUsername: 'custom-admin', oidcIssuer: issuer, oidcSubject: 'custom-subject' },
    });
  });

  it('finds an existing administrator by username even when its ID is different', async () => {
    const { prisma, service } = setup({ ...seed, id: 'admin-uuid', username: 'custom-admin', loginUsername: 'custom-admin' });
    await service.initialize();
    expect(prisma.platformUser.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.platformUser.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'admin-uuid' } }));
  });

  it.each([{ role: 'user' }, { status: 'disabled' }, { isPlatformManager: false }, { cloudWorkspaceId: 'workspace-a' }])('does not grant access to an unsuitable configured account %j', async (patch) => {
    const { prisma, keycloak, service } = setup({ ...seed, username: 'custom-admin', ...patch });
    await service.initialize();
    expect(keycloak.findUserSubjectByUsername).not.toHaveBeenCalled();
    expect(prisma.platformUser.update).not.toHaveBeenCalled();
  });

  it('leaves an already bound identity unchanged', async () => {
    const { prisma, service } = setup({ ...seed, username: 'custom-admin', loginUsername: 'custom-admin', oidcIssuer: issuer, oidcSubject: 'custom-subject' });
    await service.initialize();
    expect(prisma.platformUser.update).not.toHaveBeenCalled();
  });
});
