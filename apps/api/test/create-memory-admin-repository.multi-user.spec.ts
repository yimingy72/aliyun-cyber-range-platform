import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

describe('createMemoryAdminRepository multi-user extensions', () => {
  it('persists platform users and supports lookup, update, and active-admin counting', async () => {
    const repository = createMemoryAdminRepository();

    const admin = await repository.createPlatformUser({
      id: 'admin',
      username: 'admin',
      passwordHash: 'hash-admin',
      role: 'admin',
      status: 'active',
    });
    const alice = await repository.createPlatformUser({
      id: 'user-alice',
      username: 'alice',
      passwordHash: 'hash-alice',
      role: 'user',
      status: 'active',
    });

    expect(admin).toEqual(
      expect.objectContaining({
        id: 'admin',
        username: 'admin',
        role: 'admin',
        status: 'active',
      }),
    );
    expect(alice).toEqual(
      expect.objectContaining({
        id: 'user-alice',
        username: 'alice',
        role: 'user',
        status: 'active',
      }),
    );

    await repository.updatePlatformUser(alice.id, {
      status: 'disabled',
      role: 'admin',
    });

    await expect(repository.getPlatformUserById(alice.id)).resolves.toEqual(
      expect.objectContaining({
        id: alice.id,
        username: 'alice',
        role: 'admin',
        status: 'disabled',
      }),
    );
    await expect(repository.getPlatformUserByUsername('admin')).resolves.toEqual(
      expect.objectContaining({
        id: admin.id,
      }),
    );
    await expect(repository.listPlatformUsers()).resolves.toEqual([
      expect.objectContaining({ id: alice.id }),
      expect.objectContaining({ id: admin.id }),
    ]);
    await expect(repository.countActiveAdmins()).resolves.toBe(1);
  });

  it('stores ownerUserId and visibility on platform image assets and filters by both', async () => {
    const repository = createMemoryAdminRepository();

    const alice = await repository.createPlatformUser({
      id: 'user-alice',
      username: 'alice',
      passwordHash: 'hash-alice',
      role: 'user',
      status: 'active',
    });
    const bob = await repository.createPlatformUser({
      id: 'user-bob',
      username: 'bob',
      passwordHash: 'hash-bob',
      role: 'user',
      status: 'active',
    });

    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: 'm-user-1',
          sourceImageName: 'alice-private-image',
          lastSyncedAt: new Date('2026-07-10T00:00:00.000Z'),
          isAvailable: true,
        },
        {
          imageId: 'm-user-2',
          sourceImageName: 'platform-image',
          lastSyncedAt: new Date('2026-07-10T00:00:01.000Z'),
          isAvailable: true,
        },
        {
          imageId: 'm-user-3',
          sourceImageName: 'bob-platform-image',
          lastSyncedAt: new Date('2026-07-10T00:00:02.000Z'),
          isAvailable: true,
        },
      ],
    });

    const snapshots = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: '1234567890',
      regionId: 'cn-hangzhou',
      scope: 'custom',
    });
    const snapshotByImageId = new Map(snapshots.map((snapshot) => [snapshot.imageId, snapshot]));

    const mine = await repository.collectPlatformImageAsset({
      snapshotId: snapshotByImageId.get('m-user-1')!.id,
      displayName: 'alice-private-image',
      ownerUserId: alice.id,
      visibility: 'private',
    });
    const platform = await repository.collectPlatformImageAsset({
      snapshotId: snapshotByImageId.get('m-user-2')!.id,
      displayName: 'platform-image',
      visibility: 'platform',
    });
    const bobPlatform = await repository.collectPlatformImageAsset({
      snapshotId: snapshotByImageId.get('m-user-3')!.id,
      displayName: 'bob-platform-image',
      ownerUserId: bob.id,
      visibility: 'platform',
    });

    expect(mine).toEqual(
      expect.objectContaining({
        ownerUserId: alice.id,
        visibility: 'private',
      }),
    );
    expect(platform).toEqual(
      expect.objectContaining({
        ownerUserId: null,
        visibility: 'platform',
      }),
    );

    await expect(
      repository.listPlatformImageAssets({
        ownerUserId: alice.id,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: mine.id })]);
    await expect(
      repository.listPlatformImageAssets({
        visibility: 'platform',
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: bobPlatform.id }),
      expect.objectContaining({ id: platform.id }),
    ]);
  });
});
