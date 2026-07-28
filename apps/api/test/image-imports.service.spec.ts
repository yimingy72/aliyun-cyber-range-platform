import type { AdminRepository, CloudImageSnapshotRecord } from '../src/admin/admin.repository';
import {
  type CloudAccountContextCredentials,
  CloudAccountContextsService,
} from '../src/admin/cloud-account-contexts.service';
import { ImageImportsService } from '../src/admin/image-imports.service';
import { encryptPlatformImageDefaultPassword } from '../src/admin/platform-image-password';
import { PrismaService } from '../src/database/prisma.service';

const CONTEXT: CloudAccountContextCredentials = {
  id: 'context-1',
  provider: 'alibaba_cloud',
  accountUid: '1234567890',
  regionId: 'cn-hangzhou',
  zoneId: 'cn-hangzhou-h',
  accessKeyId: 'test-access-key',
  accessKeySecret: 'test-access-secret',
  imageImportBucket: 'cyber-range-image-test',
  status: 'ready',
};

const USER = { id: 'user-1', username: 'alice', role: 'user' as const };

function createResponse(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
    headers: new Headers(headers),
  } as unknown as Response;
}

function createImportJob(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-07-20T00:00:00.000Z');

  return {
    id: 'image-import-1',
    cloudAccountContextId: CONTEXT.id,
    ownerUserId: USER.id,
    displayName: 'Ubuntu Import',
    defaultHostName: 'ubuntu-import',
    defaultPassword: encryptPlatformImageDefaultPassword('SecretPass123!'),
    description: 'local image import',
    osType: 'linux',
    platform: 'Ubuntu',
    architecture: 'x86_64',
    bootMode: 'BIOS',
    imageFormat: 'qcow2',
    systemDiskSize: 40,
    sourceFileName: 'ubuntu.qcow2',
    sourceContentType: 'application/octet-stream',
    sourceSizeBytes: '4096',
    objectKey: 'image-imports/user-1/request-1/ubuntu.qcow2',
    uploadExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    uploadCompletedAt: null,
    status: 'awaiting_upload',
    imageId: null,
    taskId: null,
    sourceSnapshotId: null,
    platformImageAssetId: null,
    temporaryObjectDeletedAt: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('ImageImportsService', () => {
  const originalFetch = global.fetch;
  const originalImageSecret = process.env.PLATFORM_IMAGE_SECRET_KEY;
  const originalImportMaxDuration = process.env.IMAGE_IMPORT_MAX_DURATION_MS;

  beforeEach(() => {
    process.env.PLATFORM_IMAGE_SECRET_KEY = 'unit-test-image-encryption-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;

    if (originalImageSecret === undefined) {
      delete process.env.PLATFORM_IMAGE_SECRET_KEY;
    } else {
      process.env.PLATFORM_IMAGE_SECRET_KEY = originalImageSecret;
    }

    if (originalImportMaxDuration === undefined) {
      delete process.env.IMAGE_IMPORT_MAX_DURATION_MS;
    } else {
      process.env.IMAGE_IMPORT_MAX_DURATION_MS = originalImportMaxDuration;
    }
  });

  it('creates an active-context upload session without persisting or returning a plaintext password', async () => {
    const imageImportJob = {
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
        createImportJob({
          ...data,
          id: 'created-import-1',
          status: 'awaiting_upload',
        }),
      ),
    };
    const contextService = { getCredentials: jest.fn().mockResolvedValue(CONTEXT) };
    const service = new ImageImportsService(
      {} as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );

    const result = await service.createUpload(
      {
        cloudContextId: CONTEXT.id,
        displayName: 'Ubuntu Import',
        defaultHostName: 'ubuntu-import',
        defaultPassword: 'SecretPass123!',
        description: 'local image import',
        osType: 'linux',
        platform: 'Ubuntu',
        architecture: 'x86_64',
        bootMode: 'BIOS',
        imageFormat: 'qcow2',
        systemDiskSize: 40,
        sourceFileName: 'ubuntu.qcow2',
        sourceContentType: 'application/octet-stream',
        sourceSizeBytes: 4096,
      },
      USER,
    );

    const createInput = imageImportJob.create.mock.calls[0][0].data as { defaultPassword: string; objectKey: string };
    expect(contextService.getCredentials).toHaveBeenCalledWith(CONTEXT.id, {
      requireReady: true,
      requireActive: true,
      requireImageImportBucket: true,
    });
    expect(createInput.defaultPassword).toMatch(/^enc:v1:/);
    expect(createInput.defaultPassword).not.toContain('SecretPass123!');
    expect(result.job).not.toHaveProperty('defaultPassword');
    expect(result.job).not.toHaveProperty('objectKey');
    expect(result.upload.url).toContain('OSSAccessKeyId=test-access-key');
    expect(result.upload.url).not.toContain(CONTEXT.accessKeySecret);
  });

  it('completes an upload into a disabled private asset while retaining the encrypted password', async () => {
    const job = createImportJob();
    const snapshot: CloudImageSnapshotRecord = {
      id: 'snapshot-1',
      provider: 'alibaba_cloud',
      accountUid: CONTEXT.accountUid,
      regionId: CONTEXT.regionId,
      scope: 'custom',
      imageId: 'm-imported-image',
      sourceImageName: job.displayName,
      osType: 'linux',
      platform: 'Ubuntu',
      architecture: 'x86_64',
      status: 'Creating',
      isAvailable: false,
      lastSyncedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const adminRepositoryMock = {
      upsertImageSnapshots: jest.fn().mockResolvedValue(undefined),
      getImageSnapshotById: jest.fn().mockResolvedValue({
        id: 'snapshot-1',
        imageId: job.imageId,
      }),
      getPlatformImageAssetById: jest.fn().mockResolvedValue({
        id: 'asset-1',
        imageId: job.imageId,
        sourceSnapshotId: 'snapshot-1',
      }),
      listImageSnapshots: jest.fn().mockResolvedValue([snapshot]),
      collectPlatformImageAsset: jest.fn().mockResolvedValue({ id: 'asset-1' }),
      setPlatformImageAssetEnabled: jest.fn().mockResolvedValue({ id: 'asset-1', enabled: false }),
      findBillingLedgerResource: jest.fn().mockResolvedValue(null),
      createBillingLedgerResource: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    };
    const imageImportJob = {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return { ...job };
      }),
    };
    const contextService = { getCredentials: jest.fn().mockResolvedValue(CONTEXT) };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createResponse({}, 200, {
          'content-length': '4096',
          'content-type': 'application/octet-stream',
        }),
      )
      .mockResolvedValueOnce(createResponse({ ImageId: 'm-imported-image', TaskId: 'task-1' }, 200))
      .mockResolvedValueOnce(createResponse({}))
      .mockResolvedValueOnce(
        createResponse({
          Images: {
            Image: {
              ImageId: 'm-imported-image',
              DiskDeviceMappings: {
                DiskDeviceMapping: [{ SnapshotId: 's-imported-image-01' }],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(createResponse({}));
    const service = new ImageImportsService(
      adminRepositoryMock as unknown as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );

    const result = await service.completeUpload(job.id, USER);

    expect(adminRepositoryMock.collectPlatformImageAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: snapshot.id,
        ownerUserId: USER.id,
        visibility: 'private',
        defaultPassword: job.defaultPassword,
      }),
    );
    expect(adminRepositoryMock.setPlatformImageAssetEnabled).toHaveBeenCalledWith('asset-1', false);
    expect(adminRepositoryMock.createBillingLedgerResource).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudAccountUid: CONTEXT.accountUid,
        regionId: CONTEXT.regionId,
        cloudResourceId: 'm-imported-image',
        cloudResourceType: 'image',
        billingScope: 'platform',
        ownerUserId: null,
        platformImageAssetId: 'asset-1',
      }),
    );
    expect(adminRepositoryMock.createBillingLedgerResource).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudResourceId: 's-imported-image-01',
        cloudResourceType: 'snapshot',
        billingScope: 'platform',
        ownerUserId: null,
        platformImageAssetId: 'asset-1',
      }),
    );
    expect(result).not.toHaveProperty('defaultPassword');
    expect(String((global.fetch as jest.Mock).mock.calls[1][0])).not.toContain(CONTEXT.accessKeySecret);
  });

  it('enables the private asset and deletes the temporary OSS object after ECS reports Available', async () => {
    const job = createImportJob({
      status: 'importing',
      imageId: 'm-imported-image',
      sourceSnapshotId: 'snapshot-1',
      platformImageAssetId: 'asset-1',
    });
    const snapshot: CloudImageSnapshotRecord = {
      id: 'snapshot-1',
      provider: 'alibaba_cloud',
      accountUid: CONTEXT.accountUid,
      regionId: CONTEXT.regionId,
      scope: 'custom',
      imageId: job.imageId!,
      sourceImageName: job.displayName,
      osType: job.osType,
      platform: job.platform,
      architecture: job.architecture,
      status: 'Creating',
      isAvailable: false,
      lastSyncedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const adminRepositoryMock = {
      upsertImageSnapshots: jest.fn().mockResolvedValue(undefined),
      getImageSnapshotById: jest.fn().mockResolvedValue({
        id: 'snapshot-1',
        imageId: job.imageId,
      }),
      getPlatformImageAssetById: jest.fn().mockResolvedValue({
        id: 'asset-1',
        imageId: job.imageId,
        sourceSnapshotId: 'snapshot-1',
      }),
      listImageSnapshots: jest.fn().mockResolvedValue([snapshot]),
      collectPlatformImageAsset: jest.fn().mockResolvedValue({ id: 'asset-1' }),
      setPlatformImageAssetEnabled: jest.fn().mockResolvedValue({ id: 'asset-1', enabled: true }),
      findBillingLedgerResource: jest.fn().mockResolvedValue(null),
      createBillingLedgerResource: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    };
    const imageImportJob = {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return { ...job };
      }),
    };
    const contextService = { getCredentials: jest.fn().mockResolvedValue(CONTEXT) };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(createResponse({}))
      .mockResolvedValueOnce(
        createResponse({
          Images: {
            Image: {
              ImageId: job.imageId,
              ImageName: job.displayName,
              OSType: 'linux',
              Platform: 'Ubuntu',
              Architecture: 'x86_64',
              Status: 'Available',
              DiskDeviceMappings: {
                DiskDeviceMapping: [{ SnapshotId: 's-imported-image-01' }],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(createResponse({}))
      .mockResolvedValueOnce(
        createResponse({
          Images: {
            Image: {
              ImageId: job.imageId,
              ImageName: job.displayName,
              OSType: 'linux',
              Platform: 'Ubuntu',
              Architecture: 'x86_64',
              Status: 'Available',
              DiskDeviceMappings: {
                DiskDeviceMapping: [{ SnapshotId: 's-imported-image-01' }],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(createResponse({}, 204));
    const service = new ImageImportsService(
      adminRepositoryMock as unknown as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );

    const result = await service.refreshImport(job.id);

    expect(result).toEqual(expect.objectContaining({ status: 'available', imageId: job.imageId }));
    expect(adminRepositoryMock.setPlatformImageAssetEnabled).toHaveBeenCalledWith('asset-1', true);
    expect(adminRepositoryMock.collectPlatformImageAsset).not.toHaveBeenCalled();
    expect(adminRepositoryMock.createBillingLedgerResource).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls[4][1]).toEqual(
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('keeps the import job pollable when enabling its private asset fails', async () => {
    const job = createImportJob({
      status: 'importing',
      imageId: 'm-imported-image',
      sourceSnapshotId: 'snapshot-1',
      platformImageAssetId: 'asset-1',
    });
    const adminRepositoryMock = {
      upsertImageSnapshots: jest.fn().mockResolvedValue(undefined),
      getImageSnapshotById: jest.fn().mockResolvedValue({
        id: 'snapshot-1',
        imageId: job.imageId,
      }),
      getPlatformImageAssetById: jest.fn().mockResolvedValue({
        id: 'asset-1',
        imageId: job.imageId,
        sourceSnapshotId: 'snapshot-1',
      }),
      setPlatformImageAssetEnabled: jest.fn().mockRejectedValue(new Error('asset update unavailable')),
      findBillingLedgerResource: jest.fn().mockResolvedValue(null),
      createBillingLedgerResource: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    };
    const imageImportJob = {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return { ...job };
      }),
    };
    const contextService = { getCredentials: jest.fn().mockResolvedValue(CONTEXT) };
    global.fetch = jest.fn().mockResolvedValue(
      createResponse({
        Images: {
          Image: {
            ImageId: job.imageId,
            ImageName: job.displayName,
            OSType: 'linux',
            Platform: 'Ubuntu',
            Architecture: 'x86_64',
            Status: 'Available',
          },
        },
      }),
    );
    const service = new ImageImportsService(
      adminRepositoryMock as unknown as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );

    const result = await service.refreshImport(job.id);

    expect(result).toEqual(expect.objectContaining({ status: 'importing', errorMessage: 'asset update unavailable' }));
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(3);
  });

  it('stores Alibaba Cloud creating progress on the snapshot while the import is still running', async () => {
    const job = createImportJob({
      status: 'importing',
      imageId: 'm-imported-image',
      sourceSnapshotId: 'snapshot-1',
      platformImageAssetId: 'asset-1',
    });
    const snapshot: CloudImageSnapshotRecord = {
      id: 'snapshot-1',
      provider: 'alibaba_cloud',
      accountUid: CONTEXT.accountUid,
      regionId: CONTEXT.regionId,
      scope: 'custom',
      imageId: job.imageId!,
      sourceImageName: job.displayName,
      osType: job.osType,
      platform: job.platform,
      architecture: job.architecture,
      status: 'Creating',
      isAvailable: false,
      lastSyncedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const adminRepositoryMock = {
      upsertImageSnapshots: jest.fn().mockResolvedValue(undefined),
      getImageSnapshotById: jest.fn().mockResolvedValue({
        id: 'snapshot-1',
        imageId: job.imageId,
      }),
      getPlatformImageAssetById: jest.fn().mockResolvedValue({
        id: 'asset-1',
        imageId: job.imageId,
        sourceSnapshotId: 'snapshot-1',
      }),
      listImageSnapshots: jest.fn().mockResolvedValue([snapshot]),
      collectPlatformImageAsset: jest.fn().mockResolvedValue({ id: 'asset-1' }),
      setPlatformImageAssetEnabled: jest.fn().mockResolvedValue({ id: 'asset-1', enabled: false }),
      findBillingLedgerResource: jest.fn().mockResolvedValue(null),
      createBillingLedgerResource: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    };
    const imageImportJob = {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return { ...job };
      }),
    };
    const contextService = { getCredentials: jest.fn().mockResolvedValue(CONTEXT) };
    global.fetch = jest.fn().mockResolvedValue(
      createResponse({
        Images: {
          Image: {
            ImageId: job.imageId,
            ImageName: job.displayName,
            OSType: 'linux',
            Platform: 'Others Linux',
            Architecture: 'x86_64',
            Status: 'Creating',
            Progress: '65%',
          },
        },
      }),
    );
    const service = new ImageImportsService(
      adminRepositoryMock as unknown as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );

    const result = await service.refreshImport(job.id);

    expect(result).toEqual(expect.objectContaining({ status: 'importing', imageId: job.imageId }));
    expect(adminRepositoryMock.upsertImageSnapshots).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshots: [
          expect.objectContaining({
            imageId: job.imageId,
            status: 'Creating 65%',
            isAvailable: false,
          }),
        ],
      }),
    );
    expect(imageImportJob.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'available' }) }),
    );
  });

  it('keeps image import lists owner-scoped for administrators', async () => {
    const imageImportJob = {
      findMany: jest.fn().mockResolvedValue([createImportJob()]),
    };
    const service = new ImageImportsService(
      {} as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      {} as CloudAccountContextsService,
    );

    await service.list({ id: 'admin-1', username: 'admin', role: 'admin' });

    expect(imageImportJob.findMany).toHaveBeenCalledWith({
      where: { ownerUserId: 'admin-1' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('marks Alibaba Cloud Unavailable images as failed imports and starts cleanup', async () => {
    const job = createImportJob({
      status: 'importing',
      imageId: 'm-unavailable-image',
      sourceSnapshotId: 'snapshot-1',
      platformImageAssetId: 'asset-1',
    });
    const imageImportJob = {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return { ...job };
      }),
    };
    const adminRepositoryMock = {
      upsertImageSnapshots: jest.fn().mockResolvedValue(undefined),
      getImageSnapshotById: jest.fn().mockResolvedValue({
        id: 'snapshot-1',
        imageId: job.imageId,
      }),
      getPlatformImageAssetById: jest.fn().mockResolvedValue({
        id: 'asset-1',
        imageId: job.imageId,
        sourceSnapshotId: 'snapshot-1',
      }),
      findBillingLedgerResource: jest.fn().mockResolvedValue(null),
      createBillingLedgerResource: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
      listBillingLedgerResources: jest.fn().mockResolvedValue([]),
      updateBillingLedgerResource: jest.fn().mockResolvedValue({}),
      deletePlatformImageAssetsBySnapshotId: jest.fn().mockResolvedValue(undefined),
    };
    const contextService = { getCredentials: jest.fn().mockResolvedValue(CONTEXT) };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(createResponse({}))
      .mockResolvedValueOnce(
        createResponse({
          Images: {
            Image: {
              ImageId: job.imageId,
              Status: 'UnAvailable',
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        createResponse({
          Images: {
            Image: {
              ImageId: job.imageId,
              Status: 'UnAvailable',
            },
          },
        }),
      )
      .mockResolvedValue(createResponse({}, 204));
    const service = new ImageImportsService(
      adminRepositoryMock as unknown as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );

    const result = await service.refreshImport(job.id);

    expect(result).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('UnAvailable'),
        temporaryObjectDeletedAt: expect.any(Date),
      }),
    );
  });

  it('deletes a timed-out cloud image and releases its billing ledger before cleaning the OSS object', async () => {
    const job = createImportJob({
      status: 'importing',
      imageId: 'm-timeout-image',
      sourceSnapshotId: 'snapshot-1',
      platformImageAssetId: 'asset-1',
      uploadCompletedAt: new Date(Date.now() - 2_000),
    });
    const imageLedger = {
      id: 'ledger-image',
      cloudResourceId: job.imageId,
      cloudResourceType: 'image',
      releasedAt: null,
    };
    const snapshotLedger = {
      id: 'ledger-snapshot',
      cloudResourceId: job.imageId,
      cloudResourceType: 'snapshot',
      releasedAt: null,
    };
    const adminRepositoryMock = {
      listBillingLedgerResources: jest.fn().mockResolvedValue([imageLedger, snapshotLedger]),
      updateBillingLedgerResource: jest.fn().mockResolvedValue({}),
      deletePlatformImageAssetsBySnapshotId: jest.fn().mockResolvedValue(undefined),
    };
    const imageImportJob = {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return { ...job };
      }),
    };
    const contextService = { getCredentials: jest.fn().mockResolvedValue(CONTEXT) };
    const service = new ImageImportsService(
      adminRepositoryMock as unknown as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );
    process.env.IMAGE_IMPORT_MAX_DURATION_MS = '1000';
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(createResponse({ RequestId: 'delete-image-ok' }))
      .mockResolvedValueOnce(createResponse({}, 204));

    const result = await service.refreshImport(job.id);

    expect(result).toEqual(expect.objectContaining({ status: 'failed', imageId: job.imageId }));
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('Action=DeleteImage');
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('Force=true');
    expect(adminRepositoryMock.updateBillingLedgerResource).toHaveBeenCalledWith(
      imageLedger.id,
      expect.objectContaining({ releasedAt: expect.any(Date) }),
    );
    expect(adminRepositoryMock.updateBillingLedgerResource).toHaveBeenCalledWith(
      snapshotLedger.id,
      expect.objectContaining({ releasedAt: expect.any(Date) }),
    );
    expect(adminRepositoryMock.deletePlatformImageAssetsBySnapshotId).toHaveBeenCalledWith('snapshot-1');
    expect((global.fetch as jest.Mock).mock.calls[1][1]).toEqual(
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('fails an import that remains absent from DescribeImages beyond the maximum duration', async () => {
    process.env.IMAGE_IMPORT_MAX_DURATION_MS = '1';
    const job = createImportJob({
      status: 'importing',
      imageId: 'm-missing-image',
      sourceSnapshotId: 'snapshot-1',
      platformImageAssetId: 'asset-1',
      uploadCompletedAt: new Date(Date.now() - 10_000),
    });
    const imageImportJob = {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return { ...job };
      }),
    };
    const adminRepositoryMock = {
      getImageSnapshotById: jest.fn().mockResolvedValue({ id: 'snapshot-1' }),
      getPlatformImageAssetById: jest.fn().mockResolvedValue({ id: 'asset-1' }),
      listBillingLedgerResources: jest.fn().mockResolvedValue([]),
      updateBillingLedgerResource: jest.fn().mockResolvedValue({}),
      deletePlatformImageAssetsBySnapshotId: jest.fn().mockResolvedValue(undefined),
    };
    const contextService = { getCredentials: jest.fn().mockResolvedValue(CONTEXT) };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(createResponse({ Images: {} }))
      .mockResolvedValueOnce(createResponse({}, 204));
    const service = new ImageImportsService(
      adminRepositoryMock as unknown as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );

    const result = await service.refreshImport(job.id);

    expect(result).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('超过最大等待时长'),
        temporaryObjectDeletedAt: expect.any(Date),
      }),
    );
  });

  it('fails an overdue import even when its cloud account context is temporarily unavailable', async () => {
    process.env.IMAGE_IMPORT_MAX_DURATION_MS = '1';
    const job = createImportJob({
      status: 'importing',
      imageId: 'm-overdue-image',
      uploadCompletedAt: new Date(Date.now() - 10_000),
    });
    const imageImportJob = {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return { ...job };
      }),
    };
    const contextService = { getCredentials: jest.fn().mockRejectedValue(new Error('cloud account unavailable')) };
    const service = new ImageImportsService(
      {} as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );

    const result = await service.refreshImport(job.id);

    expect(result).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('超过最大等待时长'),
      }),
    );
    expect(contextService.getCredentials).toHaveBeenCalledTimes(1);
  });

  it('recreates a missing private asset before enabling an imported image', async () => {
    const job = createImportJob({
      status: 'importing',
      imageId: 'm-recovered-image',
      sourceSnapshotId: 'snapshot-1',
      platformImageAssetId: 'deleted-asset-1',
    });
    const snapshot: CloudImageSnapshotRecord = {
      id: 'snapshot-1',
      provider: 'alibaba_cloud',
      accountUid: CONTEXT.accountUid,
      regionId: CONTEXT.regionId,
      scope: 'custom',
      imageId: job.imageId!,
      sourceImageName: job.displayName,
      osType: job.osType,
      platform: job.platform,
      architecture: job.architecture,
      status: 'Creating',
      isAvailable: false,
      lastSyncedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const imageImportJob = {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return { ...job };
      }),
    };
    const adminRepositoryMock = {
      upsertImageSnapshots: jest.fn().mockResolvedValue(undefined),
      getImageSnapshotById: jest.fn().mockResolvedValue(snapshot),
      getPlatformImageAssetById: jest.fn().mockResolvedValue(null),
      listImageSnapshots: jest.fn().mockResolvedValue([snapshot]),
      collectPlatformImageAsset: jest.fn().mockResolvedValue({ id: 'recovered-asset-1' }),
      setPlatformImageAssetEnabled: jest.fn().mockResolvedValue({ id: 'recovered-asset-1', enabled: true }),
      findBillingLedgerResource: jest.fn().mockResolvedValue(null),
      createBillingLedgerResource: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    };
    const contextService = { getCredentials: jest.fn().mockResolvedValue(CONTEXT) };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(createResponse({}))
      .mockResolvedValueOnce(
        createResponse({
          Images: {
            Image: {
              ImageId: job.imageId,
              Status: 'Available',
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        createResponse({
          Images: {
            Image: {
              ImageId: job.imageId,
              Status: 'Available',
            },
          },
        }),
      )
      .mockResolvedValueOnce(createResponse({}, 204));
    const service = new ImageImportsService(
      adminRepositoryMock as unknown as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );

    const result = await service.refreshImport(job.id);

    expect(adminRepositoryMock.collectPlatformImageAsset).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: snapshot.id, ownerUserId: USER.id }),
    );
    expect(adminRepositoryMock.setPlatformImageAssetEnabled).toHaveBeenLastCalledWith('recovered-asset-1', true);
    expect(result).toEqual(
      expect.objectContaining({
        status: 'available',
        platformImageAssetId: 'recovered-asset-1',
      }),
    );
  });

  it('clears a resolved cleanup error after the temporary object is deleted', async () => {
    const job = createImportJob({
      status: 'available',
      imageId: 'm-available-image',
      temporaryObjectDeletedAt: null,
      errorMessage: '临时 OSS 文件清理失败：删除 OSS 临时镜像文件失败。',
    });
    const imageImportJob = {
      findMany: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.status === 'importing') {
          return [];
        }
        if ('OR' in where) {
          return [job];
        }
        return [];
      }),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(job, data);
        return { ...job };
      }),
    };
    const contextService = { getCredentials: jest.fn().mockResolvedValue(CONTEXT) };
    global.fetch = jest.fn().mockResolvedValue(createResponse({}, 204));
    const service = new ImageImportsService(
      {} as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );

    await service.refreshPendingImports();

    expect(job.temporaryObjectDeletedAt).toEqual(expect.any(Date));
    expect(job.errorMessage).toBeNull();
  });

  it('selects the least recently polled import so a twenty-first job is not starved', async () => {
    const jobs = Array.from({ length: 21 }, (_, index) =>
      createImportJob({
        id: `image-import-${index + 1}`,
        status: 'importing',
        imageId: `m-image-${index + 1}`,
        sourceSnapshotId: `snapshot-${index + 1}`,
        platformImageAssetId: `asset-${index + 1}`,
        lastPolledAt: new Date(index === 20 ? '2026-07-20T00:00:00.000Z' : '2026-07-20T01:00:00.000Z'),
        updatedAt: new Date(index === 20 ? '2026-07-20T01:00:00.000Z' : '2026-07-20T00:00:00.000Z'),
      }),
    );
    const imageImportJob = {
      findMany: jest.fn().mockImplementation(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy: unknown }) => {
        if (where.status === 'importing') {
          const firstOrderField = Array.isArray(orderBy) ? Object.keys(orderBy[0] ?? {})[0] : Object.keys(orderBy as object)[0];
          return firstOrderField === 'lastPolledAt' ? [jobs[20]] : jobs.slice(0, 20);
        }
        return [];
      }),
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) =>
        jobs.find((job) => job.id === where.id) ?? null,
      ),
      update: jest.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const job = jobs.find((item) => item.id === where.id)!;
        Object.assign(job, data);
        return { ...job };
      }),
    };
    const adminRepositoryMock = {
      upsertImageSnapshots: jest.fn().mockResolvedValue(undefined),
      getImageSnapshotById: jest.fn().mockResolvedValue({
        id: 'snapshot-21',
        imageId: 'm-image-21',
      }),
      getPlatformImageAssetById: jest.fn().mockResolvedValue({
        id: 'asset-21',
        imageId: 'm-image-21',
        sourceSnapshotId: 'snapshot-21',
      }),
      findBillingLedgerResource: jest.fn().mockResolvedValue(null),
      createBillingLedgerResource: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    };
    const contextService = { getCredentials: jest.fn().mockResolvedValue(CONTEXT) };
    global.fetch = jest.fn().mockResolvedValue(
      createResponse({
        Images: {
          Image: {
            ImageId: 'm-image-21',
            Status: 'Creating',
            Progress: '65%',
          },
        },
      }),
    );
    const service = new ImageImportsService(
      adminRepositoryMock as unknown as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );

    await service.refreshPendingImports();

    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('ImageId=m-image-21'));
    expect(imageImportJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'image-import-21' },
        data: expect.objectContaining({ lastPolledAt: expect.any(Date) }),
      }),
    );
  });

  it('rejects an object whose actual OSS size does not match the requested upload size', async () => {
    const job = createImportJob();
    const imageImportJob = {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...job, ...data })),
    };
    const contextService = { getCredentials: jest.fn().mockResolvedValue(CONTEXT) };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(createResponse({}, 200, { 'content-length': '8192' }))
      .mockResolvedValueOnce(createResponse({}, 204));
    const service = new ImageImportsService(
      {} as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );

    await expect(service.completeUpload(job.id, USER)).rejects.toThrow('上传文件大小与提交信息不一致');
    expect((global.fetch as jest.Mock).mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
  });

  it('keeps an importing job retryable when the initial ECS request fails before returning an ImageId', async () => {
    const job = createImportJob();
    const imageImportJob = {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...job, ...data })),
    };
    const contextService = { getCredentials: jest.fn().mockResolvedValue(CONTEXT) };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(createResponse({}, 200, { 'content-length': '4096' }))
      .mockResolvedValueOnce(createResponse({ Code: 'Throttling.User' }, 429));
    const service = new ImageImportsService(
      {} as AdminRepository,
      { imageImportJob } as unknown as PrismaService,
      contextService as unknown as CloudAccountContextsService,
    );

    const result = await service.completeUpload(job.id, USER);

    expect(result).toEqual(expect.objectContaining({ status: 'failed', imageId: null }));
    expect(imageImportJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });
});
