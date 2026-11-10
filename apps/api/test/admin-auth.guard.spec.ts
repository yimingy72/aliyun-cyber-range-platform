import { AdminAuthGuard } from '../src/admin/admin-auth.guard';

describe('AdminAuthGuard', () => {
  it('treats instance type availability as an authenticated-user route', () => {
    const guard = new AdminAuthGuard({} as never, {} as never);

    expect(
      (guard as unknown as { isAuthenticatedUserRoute: (pathname: string, method: string) => boolean }).isAuthenticatedUserRoute(
        '/admin/system-config/instance-type-availability',
        'GET',
      ),
    ).toBe(true);
  });

  it('keeps cloud source access admin-only while allowing users to browse and collect from 墨攻', () => {
    const guard = new AdminAuthGuard({} as never, {} as never);
    const allowsUser = (path: string, method: string) =>
      (guard as unknown as { isAuthenticatedUserRoute: (pathname: string, method: string) => boolean }).isAuthenticatedUserRoute(path, method);
    expect(allowsUser('/admin/image-catalog/public', 'GET')).toBe(false);
    expect(allowsUser('/admin/image-catalog/custom', 'GET')).toBe(false);
    expect(allowsUser('/admin/image-catalog/mogong', 'GET')).toBe(true);
    expect(allowsUser('/admin/image-catalog/mogong/12/collect', 'POST')).toBe(true);
    expect(allowsUser('/admin/image-catalog/mogong/sync', 'POST')).toBe(false);
  });

  it('rejects legacy non-jwt bearer tokens', async () => {
    const guard = new AdminAuthGuard({} as never, {} as never);

    await expect(
      guard.canActivate({
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: 'Bearer legacy-session-token' },
            originalUrl: '/admin/scenarios',
            method: 'GET',
          }),
        }),
      } as never),
    ).rejects.toThrow('Missing or invalid admin token');
  });
});
