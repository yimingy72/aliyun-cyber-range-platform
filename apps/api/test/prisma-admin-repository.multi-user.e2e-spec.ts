import { randomUUID } from 'node:crypto';

import { PrismaAdminRepository } from '../src/database/prisma-admin.repository';
import { PrismaService } from '../src/database/prisma.service';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/cyber_range?schema=public';

describe('PrismaAdminRepository multi-user postgres integration', () => {
  let prisma: PrismaService;
  let repository: PrismaAdminRepository;
  let createdUserIds: string[] = [];
  let createdSnapshotIds: string[] = [];
  let createdAssetIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    repository = new PrismaAdminRepository(prisma);
  });

  afterEach(async () => {
    if (createdAssetIds.length > 0) {
      await prisma.platformImageAsset.deleteMany({
        where: {
          id: {
            in: createdAssetIds,
          },
        },
      });
      createdAssetIds = [];
    }

    if (createdSnapshotIds.length > 0) {
      await prisma.cloudImageSnapshot.deleteMany({
        where: {
          id: {
            in: createdSnapshotIds,
          },
        },
      });
      createdSnapshotIds = [];
    }

    if (createdUserIds.length > 0) {
      await prisma.platformUser.deleteMany({
        where: {
          id: {
            in: createdUserIds,
          },
        },
      });
      createdUserIds = [];
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('recovers abandoned claims without stealing a live heartbeat or accepting an old owner', async () => {
    const instance = await repository.createRangeInstance({ name: `heartbeat-${randomUUID()}`, status: 'creating' });
    try {
      const job = await repository.createProvisionJob({
        rangeInstanceId: instance.id, jobType: 'create', triggeredBy: 'admin',
      });
      const claimedAt = new Date(Date.now() - 10 * 60_000);
      await repository.claimProvisionJob(job.id, claimedAt);
      const heartbeatAt = new Date();
      await expect(repository.heartbeatProvisionJob(job.id, claimedAt, heartbeatAt)).resolves.toBe(true);
      await repository.requeueInterruptedProvisionJobs(new Date(heartbeatAt.getTime() - 5 * 60_000));
      await expect(repository.getProvisionJobById(job.id)).resolves.toEqual(expect.objectContaining({ status: 'running' }));

      await repository.heartbeatProvisionJob(job.id, claimedAt, new Date(heartbeatAt.getTime() - 6 * 60_000));
      await repository.requeueInterruptedProvisionJobs(new Date(heartbeatAt.getTime() - 5 * 60_000));
      await expect(repository.getProvisionJobById(job.id)).resolves.toEqual(expect.objectContaining({ status: 'pending', retryCount: 1 }));
      await repository.claimProvisionJob(job.id, heartbeatAt);
      await expect(repository.heartbeatProvisionJob(job.id, claimedAt, new Date())).resolves.toBe(false);
      await expect(repository.heartbeatProvisionJob(job.id, heartbeatAt, new Date())).resolves.toBe(true);
    } finally {
      await prisma.rangeInstance.delete({ where: { id: instance.id } });
    }
  });

  it('persists users and image asset ownership/visibility through the real prisma repository', async () => {
    const suffix = randomUUID();
    const ownerUser = await repository.createPlatformUser({
      id: `repo-owner-${suffix}`,
      username: `repo-owner-${suffix}`,
      passwordHash: `hash-owner-${suffix}`,
      role: 'user',
      status: 'active',
    });
    createdUserIds.push(ownerUser.id);

    await repository.upsertImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: `repo-account-${suffix}`,
      regionId: 'cn-hangzhou',
      scope: 'custom',
      snapshots: [
        {
          imageId: `repo-private-${suffix}`,
          sourceImageName: 'repo-private-image',
          lastSyncedAt: new Date('2026-07-10T00:00:00.000Z'),
          isAvailable: true,
        },
        {
          imageId: `repo-platform-${suffix}`,
          sourceImageName: 'repo-platform-image',
          lastSyncedAt: new Date('2026-07-10T00:00:01.000Z'),
          isAvailable: true,
        },
      ],
    });

    const snapshots = await repository.listImageSnapshots({
      provider: 'alibaba_cloud',
      accountUid: `repo-account-${suffix}`,
      regionId: 'cn-hangzhou',
      scope: 'custom',
    });
    const privateSnapshot = snapshots.find((snapshot) => snapshot.imageId === `repo-private-${suffix}`);
    const platformSnapshot = snapshots.find((snapshot) => snapshot.imageId === `repo-platform-${suffix}`);

    expect(privateSnapshot).toBeDefined();
    expect(platformSnapshot).toBeDefined();

    createdSnapshotIds.push(privateSnapshot!.id, platformSnapshot!.id);

    const privateAsset = await repository.collectPlatformImageAsset({
      snapshotId: privateSnapshot!.id,
      displayName: 'repo-private-image',
      ownerUserId: ownerUser.id,
      visibility: 'private',
    });
    const platformAsset = await repository.collectPlatformImageAsset({
      snapshotId: platformSnapshot!.id,
      displayName: 'repo-platform-image',
      visibility: 'platform',
    });

    createdAssetIds.push(privateAsset.id, platformAsset.id);

    expect(privateAsset).toEqual(
      expect.objectContaining({
        ownerUserId: ownerUser.id,
        visibility: 'private',
      }),
    );
    expect(platformAsset).toEqual(
      expect.objectContaining({
        ownerUserId: null,
        visibility: 'platform',
      }),
    );

    const ownerItems = await repository.listPlatformImageAssets({
      ownerUserId: ownerUser.id,
    });
    const platformItems = await repository.listPlatformImageAssets({
      visibility: 'platform',
    });

    expect(ownerItems.map((item) => item.id)).toContain(privateAsset.id);
    expect(ownerItems.map((item) => item.id)).not.toContain(platformAsset.id);
    expect(platformItems.map((item) => item.id)).toContain(platformAsset.id);
    expect(platformItems.map((item) => item.id)).not.toContain(privateAsset.id);
  });
});
