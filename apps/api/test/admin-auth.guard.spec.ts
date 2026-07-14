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

  it('does not treat cloud image source routes as authenticated-user routes', () => {
    const guard = new AdminAuthGuard({} as never, {} as never);

    expect(
      (guard as unknown as { isAuthenticatedUserRoute: (pathname: string, method: string) => boolean }).isAuthenticatedUserRoute(
        '/admin/image-catalog/public',
        'GET',
      ),
    ).toBe(false);

    expect(
      (guard as unknown as { isAuthenticatedUserRoute: (pathname: string, method: string) => boolean }).isAuthenticatedUserRoute(
        '/admin/image-catalog/custom',
        'GET',
      ),
    ).toBe(false);
  });
});
