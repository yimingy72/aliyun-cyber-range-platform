import { AdminAuthGuard } from '../src/admin/admin-auth.guard';

describe('AdminAuthGuard OIDC path', () => {
  it('accepts a verified OIDC token on authenticated-user routes', async () => {
    const request: {
      headers: Record<string, string | undefined>;
      originalUrl: string;
      method: string;
      adminUser?: { id: string; username: string; role: 'admin' | 'user' };
    } = {
      headers: { authorization: 'Bearer header.payload.signature' },
      originalUrl: '/admin/scenarios',
      method: 'GET',
    };
    const verifier = {
      verifyAccessToken: jest.fn().mockResolvedValue({
        issuer: 'https://issuer.example/realms/cyber-range',
        subject: 'alice-subject',
        audience: ['platform-api'],
      }),
    };
    const resolver = {
      resolve: jest.fn().mockResolvedValue({
        id: 'alice',
        username: 'alice',
        role: 'user',
        status: 'active',
        cloudWorkspaceId: 'oidc-fixture-space',
        isPlatformManager: false,
        selectedCloudWorkspaceId: null,
      }),
    };
    const guard = new AdminAuthGuard(verifier as never, resolver as never);

    await expect(
      guard.canActivate({
        switchToHttp: () => ({
          getRequest: () => request,
        }),
      } as never),
    ).resolves.toBe(true);

    expect(request.adminUser).toEqual({
      id: 'alice',
      username: 'alice',
      role: 'user',
      cloudWorkspaceId: 'oidc-fixture-space',
      isPlatformManager: false,
      selectedCloudWorkspaceId: null,
    });
  });
});
