import { AdminUsersService } from '../src/admin/admin-users.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('AdminUsersService Keycloak sync', () => {
  it('stores the oidc identity returned by Keycloak when creating a user', async () => {
    const repository = createMemoryAdminRepository();
    const keycloakAdminService = {
      createUser: jest.fn().mockResolvedValue('keycloak-alice-subject'),
    };
    const service = new AdminUsersService(repository, {} as never, keycloakAdminService as never);

    await service.createUser({
      username: 'alice',
      password: 'TemporaryPassword123!',
      role: 'user',
    });

    await expect(repository.getPlatformUserByUsername('alice')).resolves.toEqual(
      expect.objectContaining({
        username: 'alice',
        oidcSubject: 'keycloak-alice-subject',
      }),
    );
    expect(keycloakAdminService.createUser).toHaveBeenCalledWith({
      username: 'alice',
      password: 'TemporaryPassword123!',
      role: 'user',
      status: 'active',
    });
  });
});
