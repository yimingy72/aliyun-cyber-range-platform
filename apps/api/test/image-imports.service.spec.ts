import { ImageImportsService } from '../src/admin/image-imports.service';
import { CloudAccountContextsService, type CloudAccountContextCredentials } from '../src/admin/cloud-account-contexts.service';
import { PrismaService } from '../src/database/prisma.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { encryptPlatformImageDefaultPassword } from '../src/admin/platform-image-password';

const CONTEXT: CloudAccountContextCredentials = { id: 'context-1', provider: 'alibaba_cloud', accountUid: '1234567890', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', accessKeyId: 'test-access-key', accessKeySecret: 'test-access-secret', imageImportBucket: 'cyber-range-image-test', status: 'ready' };
const USER = { id: 'user-1', username: 'alice', role: 'user' as const };
const tags = (values: Record<string, string>) => ({ Tag: Object.entries(values).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) });
const response = (body: unknown, status = 200, headers?: HeadersInit) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, wanted]: [string, any]) => {
    if (key === 'OR') return wanted.some((condition: any) => matches(row, condition));
    if (key === 'AND') return wanted.every((condition: any) => matches(row, condition));
    const value = row[key];
    if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
      if ('in' in wanted && !wanted.in.includes(value)) return false;
      if ('not' in wanted && value === wanted.not) return false;
      if ('gt' in wanted && !(value > wanted.gt)) return false;
      if ('lt' in wanted && !(value < wanted.lt)) return false;
      if ('lte' in wanted && !(value <= wanted.lte)) return false;
      return true;
    }
    return value === wanted;
  });
}

describe('Image import resource ownership and recovery', () => {
  let repository: ReturnType<typeof createMemoryAdminRepository>;
  let service: ImageImportsService;
  let job: any;
  let image: any;
  let snapshots: Map<string, any>;
  let calls: Array<{ action: string; parameters: URLSearchParams }>;
  let credentials: jest.Mock;
  let imageImportJob: any;
  let fault: ((action: string, parameters: URLSearchParams) => Promise<Response | undefined> | Response | undefined) | undefined;
  const originalSecret = process.env.PLATFORM_IMAGE_SECRET_KEY;
  const originalMaxDuration = process.env.IMAGE_IMPORT_MAX_DURATION_MS;
  const ownership = () => ({ CreatedBy: 'cyber-range-platform', PlatformImageImportJobId: job.id, CyberRangeOwnerUserId: USER.id, CyberRangeCloudContextId: CONTEXT.id });
  const actions = () => calls.map(call => call.action);
  const cloudWrites = () => actions().filter(action => ['ImportImage', 'DeleteImage', 'DeleteSnapshot', 'OSS_DELETE', 'TagResources'].includes(action));

  beforeEach(() => {
    process.env.PLATFORM_IMAGE_SECRET_KEY = 'unit-test-image-encryption-key';
    repository = createMemoryAdminRepository();
    job = { id: 'image-import-1', cloudAccountContextId: CONTEXT.id, cloudAccountUid: CONTEXT.accountUid, regionId: CONTEXT.regionId, imageImportBucket: CONTEXT.imageImportBucket, ownerUserId: USER.id, displayName: 'Ubuntu Import', defaultHostName: 'ubuntu-import', defaultPassword: encryptPlatformImageDefaultPassword('SecretPass123!'), description: 'local image import', osType: 'linux', platform: 'Ubuntu', architecture: 'x86_64', bootMode: 'BIOS', imageFormat: 'qcow2', systemDiskSize: 40, sourceFileName: 'ubuntu.qcow2', sourceContentType: 'application/octet-stream', sourceSizeBytes: '4096', objectKey: 'image-imports/user-1/request-1/ubuntu.qcow2', uploadExpiresAt: new Date(Date.now() + 1800000), uploadCompletedAt: null, submissionRejected: false, lastPolledAt: null, status: 'awaiting_upload', imageId: null, taskId: null, sourceSnapshotId: null, platformImageAssetId: null, cloudImageDeletedAt: null, backingSnapshotIds: [], deletedSnapshotIds: [], snapshotCleanupCompletedAt: null, temporaryObjectDeletedAt: null, leaseToken: null, leaseExpiresAt: null, errorMessage: null, createdAt: new Date(), updatedAt: new Date() };
    image = null; snapshots = new Map(); calls = []; fault = undefined;
    imageImportJob = {
      create: jest.fn(async ({ data }) => ({ ...job, ...data })),
      findUnique: jest.fn(async ({ where }) => where.id === job.id ? { ...job } : null),
      findMany: jest.fn(async ({ where, take }) => matches(job, where) ? [{ ...job }].slice(0, take) : []),
      updateMany: jest.fn(async ({ where, data }) => { if (!matches(job, where)) return { count: 0 }; Object.assign(job, data, { updatedAt: new Date() }); return { count: 1 }; }),
      update: jest.fn(async ({ where, data }) => { if (!matches(job, where)) throw new Error('Lost image import lease'); Object.assign(job, data, { updatedAt: new Date() }); return { ...job }; }),
    };
    credentials = jest.fn().mockResolvedValue(CONTEXT);
    service = new ImageImportsService(repository, { imageImportJob } as unknown as PrismaService, { getCredentials: credentials } as unknown as CloudAccountContextsService);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); const p = url.searchParams;
      const action = p.get('Action') ?? `OSS_${init?.method}`;
      calls.push({ action, parameters: p });
      const override = await fault?.(action, p); if (override) return override;
      if (action === 'OSS_HEAD') return response({}, 200, { 'content-length': '4096' });
      if (action === 'OSS_DELETE') return response({}, 204);
      if (action === 'ImportImage') {
        expect(job.status).toBe('importing'); expect(job.uploadCompletedAt).toBeInstanceOf(Date);
        image = { ImageId: 'm-imported', ImageName: job.displayName, Status: 'Creating', Tags: tags(ownership()), DiskDeviceMappings: { DiskDeviceMapping: [{ SnapshotId: 's-system' }] } };
        snapshots.set('s-system', { SnapshotId: 's-system', Usage: 'image', Tags: tags({}) });
        return response({ ImageId: image.ImageId, TaskId: 'task-1' });
      }
      if (action === 'DescribeImages') {
        const result = image && (!p.get('SnapshotId') || image.DiskDeviceMappings.DiskDeviceMapping.some((mapping: any) => mapping.SnapshotId === p.get('SnapshotId'))) ? [image] : [];
        return response({ TotalCount: result.length, Images: { Image: result } });
      }
      if (action === 'DescribeSnapshots') {
        const sid = JSON.parse(p.get('SnapshotIds')!)[0]; const result = snapshots.has(sid) ? [snapshots.get(sid)] : [];
        return response({ TotalCount: result.length, Snapshots: { Snapshot: result } });
      }
      if (action === 'TagResources') {
        const target = p.get('ResourceType') === 'image' ? image : snapshots.get(p.get('ResourceId.1')!);
        const values = Object.fromEntries(target.Tags.Tag.map((item: any) => [item.TagKey, item.TagValue]));
        for (let index = 1; p.has(`Tag.${index}.Key`); index++) values[p.get(`Tag.${index}.Key`)!] = p.get(`Tag.${index}.Value`)!;
        target.Tags = tags(values);
      }
      if (action === 'DeleteImage') { expect(p.get('Force')).toBe('false'); image = null; }
      if (action === 'DeleteSnapshot') { expect(p.get('Force')).toBe('false'); snapshots.delete(p.get('SnapshotId')!); }
      return response({ RequestId: 'mock-request' });
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalSecret === undefined) delete process.env.PLATFORM_IMAGE_SECRET_KEY; else process.env.PLATFORM_IMAGE_SECRET_KEY = originalSecret;
    if (originalMaxDuration === undefined) delete process.env.IMAGE_IMPORT_MAX_DURATION_MS; else process.env.IMAGE_IMPORT_MAX_DURATION_MS = originalMaxDuration;
  });

  async function submitted() { const result = await service.completeUpload(job.id, USER); expect(result).toMatchObject({ status: 'importing', imageId: 'm-imported' }); return result; }
  async function failAndClean() { image.Status = 'UnAvailable'; job.uploadExpiresAt = new Date(0); return service.refreshImport(job.id); }

  it('keeps completed imports pollable until their reusable upload grant and drain window expire', async () => {
    await submitted(); image.Status = 'Available';
    await service.refreshImport(job.id);
    expect(job.status).toBe('available');
    expect(job.temporaryObjectDeletedAt).toBeNull();
    expect(actions()).not.toContain('OSS_DELETE');
    job.uploadExpiresAt = new Date(Date.now() - 60_000);
    await service.refreshPendingImports();
    expect(job.temporaryObjectDeletedAt).toBeNull();
    job.uploadExpiresAt = new Date(Date.now() - 6 * 60_000);
    await service.refreshPendingImports();
    expect(job.temporaryObjectDeletedAt).toBeInstanceOf(Date);
    expect(actions().filter(action => action === 'OSS_DELETE')).toHaveLength(1);
  });

  it('creates a scoped upload session without exposing passwords or persisting unbound cloud identities', async () => {
    const result = await service.createUpload({ cloudContextId: CONTEXT.id, displayName: job.displayName, defaultHostName: job.defaultHostName, defaultPassword: 'SecretPass123!', osType: 'linux', platform: 'Ubuntu', architecture: 'x86_64', bootMode: 'BIOS', imageFormat: 'qcow2', systemDiskSize: 40, sourceFileName: 'ubuntu.qcow2', sourceContentType: job.sourceContentType, sourceSizeBytes: 4096 }, USER);
    expect(imageImportJob.create.mock.calls[0][0].data).toMatchObject({ cloudAccountUid: CONTEXT.accountUid, regionId: CONTEXT.regionId, imageImportBucket: CONTEXT.imageImportBucket, defaultPassword: expect.stringMatching(/^enc:v1:/) });
    expect(result.job).not.toHaveProperty('defaultPassword'); expect(result.job).not.toHaveProperty('objectKey'); expect(result.job).not.toHaveProperty('leaseToken');
    expect(result.upload.url).not.toContain(CONTEXT.accessKeySecret);
  });
  it('creates a disabled private asset and durable image/snapshot ledgers before returning accepted', async () => {
    const result = await submitted();
    expect(await repository.getPlatformImageAssetById(job.platformImageAssetId)).toMatchObject({ enabled: false, ownerUserId: USER.id, visibility: 'private', defaultPassword: job.defaultPassword });
    expect(job.backingSnapshotIds).toEqual(['s-system']);
    expect((await repository.listBillingLedgerResources()).map(row => [row.cloudResourceType, row.cloudAccountUid, row.tagsSnapshot.PlatformImageImportJobId]).sort()).toEqual([['image', CONTEXT.accountUid, job.id], ['snapshot', CONTEXT.accountUid, job.id]]);
    expect(result).not.toHaveProperty('leaseToken');
  });
  it('only enables Available images with a complete snapshot binding and removes their temporary OSS object', async () => {
    await submitted(); image.Status = 'Available'; job.uploadExpiresAt = new Date(0);
    expect(await service.refreshImport(job.id)).toMatchObject({ status: 'available', temporaryObjectDeletedAt: expect.any(Date) });
    expect(await repository.getPlatformImageAssetById(job.platformImageAssetId)).toMatchObject({ enabled: true });
    expect(actions()).not.toContain('DeleteSnapshot');
    expect((await repository.listBillingLedgerResources()).every(row => row.releasedAt === null)).toBe(true);
  });
  it('retains pollable state when enabling the private asset fails and recovers later', async () => {
    await submitted(); image.Status = 'Available';
    const spy = jest.spyOn(repository, 'setPlatformImageAssetEnabled').mockRejectedValueOnce(new Error('asset unavailable'));
    expect(await service.refreshImport(job.id)).toMatchObject({ status: 'importing', errorMessage: 'asset unavailable' });
    spy.mockRestore(); expect(await service.refreshImport(job.id)).toMatchObject({ status: 'available' });
  });
  it('stores Creating progress and recreates a removed private asset before making it usable', async () => {
    await submitted(); image.Progress = '65%';
    await service.refreshImport(job.id);
    expect(await repository.getImageSnapshotById(job.sourceSnapshotId)).toMatchObject({ status: 'Creating 65%', isAvailable: false });
    await repository.deletePlatformImageAsset(job.platformImageAssetId); image.Status = 'Available';
    expect(await service.refreshImport(job.id)).toMatchObject({ status: 'available' });
    expect(await repository.getPlatformImageAssetById(job.platformImageAssetId)).toMatchObject({ enabled: true, ownerUserId: USER.id });
  });
  it('keeps the image and all backing snapshots accounted after a tagging failure', async () => {
    fault = action => action === 'TagResources' ? response({ Code: 'Forbidden' }, 403) : undefined;
    await submitted();
    expect(job.backingSnapshotIds).toEqual(['s-system']);
    expect((await repository.listBillingLedgerResources()).map(row => row.cloudResourceId).sort()).toEqual(['m-imported', 's-system']);
    expect(job.errorMessage).toContain('Forbidden');
  });
  it('reclaims failed import image then snapshots, confirming each disappearance before releasing ledgers', async () => {
    await submitted();
    expect(await failAndClean()).toMatchObject({ status: 'failed', cloudImageDeletedAt: expect.any(Date), snapshotCleanupCompletedAt: expect.any(Date), deletedSnapshotIds: ['s-system'], temporaryObjectDeletedAt: expect.any(Date) });
    expect(cloudWrites().filter(action => action.startsWith('Delete') || action === 'OSS_DELETE')).toEqual(['DeleteImage', 'DeleteSnapshot', 'OSS_DELETE']);
    expect((await repository.listBillingLedgerResources()).every(row => row.releasedAt)).toBe(true);
    expect(await repository.getPlatformImageAssetById(job.platformImageAssetId)).toBeNull();
    expect(await repository.getImageSnapshotById(job.sourceSnapshotId)).toMatchObject({ status: 'Deleted', isAvailable: false });
  });
  it('preserves multi-disk cleanup progress across a failed snapshot delete and restart', async () => {
    await submitted(); image.DiskDeviceMappings.DiskDeviceMapping.push({ SnapshotId: 's-data' }); snapshots.set('s-data', { SnapshotId: 's-data', Usage: 'image', Tags: tags({}) });
    await service.refreshImport(job.id);
    fault = (action, p) => action === 'DeleteSnapshot' && p.get('SnapshotId') === 's-data' ? response({ Code: 'SnapshotBusy' }, 409) : undefined;
    await failAndClean();
    expect(job).toMatchObject({ cloudImageDeletedAt: expect.any(Date), deletedSnapshotIds: ['s-system'], snapshotCleanupCompletedAt: null, temporaryObjectDeletedAt: null });
    expect((await repository.listBillingLedgerResources()).find(row => row.cloudResourceId === 's-data')?.releasedAt).toBeNull();
    fault = undefined; service = new ImageImportsService(repository, { imageImportJob } as unknown as PrismaService, { getCredentials: credentials } as unknown as CloudAccountContextsService);
    await service.refreshPendingImports();
    expect(job.snapshotCleanupCompletedAt).toBeInstanceOf(Date); expect(job.deletedSnapshotIds).toEqual(['s-system', 's-data']); expect(actions().filter(action => action === 'DeleteImage')).toHaveLength(1);
    const count = calls.length; await service.refreshPendingImports(); expect(calls).toHaveLength(count);
  });
  it.each(['image still present', 'snapshot still present', 'malformed image result', 'malformed snapshot result', 'cross-account snapshot', 'shared snapshot', 'disk dependency'])('does not falsely finish cleanup for %s', async reason => {
    await submitted();
    fault = (action, p) => {
      if (reason === 'image still present' && action === 'DeleteImage') return response({});
      if (reason === 'snapshot still present' && action === 'DeleteSnapshot') return response({});
      if (reason === 'malformed image result' && action === 'DescribeImages') return response({ Images: { Image: [] }, TotalCount: 1 });
      if (reason === 'malformed snapshot result' && action === 'DescribeSnapshots') return response({ Snapshots: { Snapshot: [] }, TotalCount: 1 });
      if (reason === 'shared snapshot' && action === 'DescribeImages' && p.has('SnapshotId')) return response({ TotalCount: 1, Images: { Image: [{ ImageId: 'm-shared', Status: 'Available' }] } });
      return undefined;
    };
    if (reason === 'cross-account snapshot') snapshots.get('s-system').Tags = tags({ ...ownership(), PlatformImageImportJobId: 'other-job' });
    if (reason === 'disk dependency') snapshots.get('s-system').Usage = 'image_disk';
    await failAndClean();
    expect(job.snapshotCleanupCompletedAt).toBeNull();
    expect((await repository.listBillingLedgerResources()).find(row => row.cloudResourceId === 's-system')?.releasedAt).toBeNull();
  });
  it('scopes release to exact account, region and import identity', async () => {
    await submitted();
    await repository.createBillingLedgerResource({ cloudAccountUid: 'other-account', regionId: 'cn-beijing', cloudResourceId: 'm-imported', cloudResourceType: 'image', billingScope: 'platform', billingStartAt: new Date(), tagsSnapshot: { PlatformImageImportJobId: job.id } });
    await failAndClean();
    expect((await repository.listBillingLedgerResources()).find(row => row.cloudAccountUid === 'other-account')?.releasedAt).toBeNull();
  });
  it.each(['account', 'region'])('rejects %s changes before cloud operations', async mismatch => {
    await submitted(); calls.length = 0;
    credentials.mockResolvedValue({ ...CONTEXT, ...(mismatch === 'account' ? { accountUid: 'other-account' } : { regionId: 'cn-beijing' }) });
    await service.refreshImport(job.id); expect(calls).toHaveLength(0); expect(job.errorMessage).toContain('不匹配');
  });
  it('retains the originally frozen OSS bucket when configuration later changes', async () => {
    await submitted(); image.Status = 'Available'; credentials.mockResolvedValue({ ...CONTEXT, imageImportBucket: 'replacement-bucket' });
    await service.refreshImport(job.id);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('https://cyber-range-image-test.oss-cn-hangzhou.aliyuncs.com/'), expect.objectContaining({ method: 'DELETE' }));
  });
  it('persists intent before an unknown submission and recovers its existing cloud image without another ImportImage call', async () => {
    fault = action => { if (action === 'ImportImage') { image = { ImageId: 'm-unknown', Status: 'Creating', Tags: tags(ownership()), DiskDeviceMappings: { DiskDeviceMapping: [{ SnapshotId: 's-unknown' }] } }; snapshots.set('s-unknown', { SnapshotId: 's-unknown', Usage: 'image', Tags: tags({}) }); throw new Error('socket disconnected'); } return undefined; };
    expect(await service.completeUpload(job.id, USER)).toMatchObject({ status: 'importing', imageId: null });
    job.uploadExpiresAt = new Date(0); fault = undefined;
    await service.refreshPendingImports();
    expect(job.imageId).toBe('m-unknown'); expect(job.status).toBe('importing'); expect(actions().filter(action => action === 'ImportImage')).toHaveLength(1); expect(actions()).not.toContain('OSS_DELETE');
  });
  it('never cancels or recreates a temporarily invisible unknown submission even after the upload expires', async () => {
    fault = action => action === 'ImportImage' ? Promise.reject(new Error('timeout')) : undefined;
    await service.completeUpload(job.id, USER); fault = undefined; job.uploadExpiresAt = new Date(0);
    await service.refreshPendingImports(); await service.refreshPendingImports();
    expect(job.status).toBe('importing'); expect(job.imageId).toBeNull(); expect(actions().filter(action => action === 'ImportImage')).toHaveLength(1); expect(actions()).not.toContain('OSS_DELETE');
  });
  it('recovers a legacy failed submission before considering retry and never resubmits it', async () => {
    await submitted(); job.status = 'failed'; job.imageId = null; calls.length = 0;
    expect(await service.retry(job.id, USER)).toMatchObject({ status: 'importing', imageId: 'm-imported' }); expect(actions()).not.toContain('ImportImage');
  });
  it.each(['multiple matches', 'foreign owner', 'wrong image id', 'HTTP-200 business failure'])('rejects recovery/query %s rather than tagging or deleting another resource', async reason => {
    await submitted(); calls.length = 0;
    if (reason === 'multiple matches') { job.imageId = null; fault = action => action === 'DescribeImages' ? response({ TotalCount: 2, Images: { Image: [image, { ...image, ImageId: 'm-other' }] } }) : undefined; }
    if (reason === 'foreign owner') image.Tags = tags({ ...ownership(), CyberRangeOwnerUserId: 'other-owner' });
    if (reason === 'wrong image id') image.ImageId = 'm-other';
    if (reason === 'HTTP-200 business failure') fault = action => action === 'DescribeImages' ? response({ Code: 'Forbidden', Message: CONTEXT.accessKeySecret }) : undefined;
    await service.refreshImport(job.id); expect(cloudWrites()).toEqual([]); expect(job.errorMessage).not.toContain(CONTEXT.accessKeySecret);
  });
  it('allows explicit retry only for a proven cloud rejection with identical client token and billing tags', async () => {
    fault = action => action === 'ImportImage' ? response({ Code: 'Throttling.User' }, 429) : undefined;
    expect(await service.completeUpload(job.id, USER)).toMatchObject({ status: 'failed', submissionRejected: true });
    await service.refreshPendingImports(); expect(actions().filter(action => action === 'ImportImage')).toHaveLength(1);
    fault = undefined; expect(await service.retry(job.id, USER)).toMatchObject({ status: 'importing', imageId: 'm-imported' });
    const requests = calls.filter(call => call.action === 'ImportImage').map(call => Object.fromEntries([...call.parameters].filter(([key]) => key.startsWith('Tag.') || key === 'ClientToken')));
    expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
  });
  it('cleans expired uploads after a proven rejected submission without issuing any create or image delete', async () => {
    fault = action => action === 'ImportImage' ? response({ Code: 'Forbidden' }, 403) : undefined;
    await service.completeUpload(job.id, USER); job.uploadExpiresAt = new Date(0); calls.length = 0;
    await service.refreshPendingImports(); expect(job.status).toBe('cancelled'); expect(cloudWrites()).toEqual(['OSS_DELETE']);
  });
  it('does not delete a failed image whose backing snapshot mapping is incomplete', async () => {
    await submitted(); image.DiskDeviceMappings.DiskDeviceMapping = [];
    await failAndClean(); expect(actions()).not.toContain('DeleteImage'); expect(job.snapshotCleanupCompletedAt).toBeNull();
  });
  it('serializes concurrent submission and refuses stale leases after takeover', async () => {
    let unblock!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; }); const atHead = new Promise<void>(resolve => { entered = resolve; });
    fault = async action => { if (action === 'OSS_HEAD') { entered(); await gate; } return undefined; };
    const first = service.completeUpload(job.id, USER); await atHead;
    await service.completeUpload(job.id, USER); expect(actions()).toEqual(['OSS_HEAD']);
    job.leaseToken = 'replacement-worker'; job.leaseExpiresAt = new Date(Date.now() + 300000); unblock();
    await expect(first).rejects.toThrow('Lost image import lease'); expect(actions()).not.toContain('ImportImage'); expect(job.leaseToken).toBe('replacement-worker');
  });
  it('fails overdue known imports and preserves all recovery material while cloud credentials are unavailable', async () => {
    await submitted(); process.env.IMAGE_IMPORT_MAX_DURATION_MS = '1'; job.uploadCompletedAt = new Date(Date.now() - 10000);
    credentials.mockRejectedValueOnce(new Error('credentials unavailable'));
    await service.refreshImport(job.id); expect(job.imageId).toBe('m-imported'); expect(job.snapshotCleanupCompletedAt).toBeNull();
    await service.refreshImport(job.id); expect(job.status).toBe('failed'); expect(job.snapshotCleanupCompletedAt).toBeInstanceOf(Date);
  });
  it('keeps an absent image with no saved snapshot proof unresolved instead of claiming complete cleanup', async () => {
    await submitted(); image = null; job.backingSnapshotIds = []; job.status = 'failed';
    await service.refreshPendingImports(); expect(job.cloudImageDeletedAt).toBeNull(); expect(job.snapshotCleanupCompletedAt).toBeNull(); expect(job.temporaryObjectDeletedAt).toBeNull();
  });
  it('does not declare legacy image-only cleanup complete without a real snapshot manifest', async () => {
    await submitted(); image = null; job.status = 'failed'; job.cloudImageDeletedAt = new Date(); job.backingSnapshotIds = [];
    await service.refreshPendingImports(); expect(job.snapshotCleanupCompletedAt).toBeNull(); expect(job.errorMessage).toContain('真实快照清单');
    expect((await repository.listBillingLedgerResources()).find(row => row.cloudResourceType === 'snapshot')?.releasedAt).toBeNull();
  });
  it('retries temporary object cleanup and clears resolved errors', async () => {
    await submitted(); image.Status = 'Available'; job.uploadExpiresAt = new Date(0); fault = action => action === 'OSS_DELETE' ? response({}, 500) : undefined;
    await service.refreshImport(job.id); expect(job.status).toBe('available'); expect(job.temporaryObjectDeletedAt).toBeNull();
    fault = undefined; await service.refreshPendingImports(); expect(job.temporaryObjectDeletedAt).toBeInstanceOf(Date); expect(job.errorMessage).toBeNull();
  });
  it('cancels only never-submitted expired uploads and validates actual upload size', async () => {
    fault = action => action === 'OSS_HEAD' ? response({}, 200, { 'content-length': '8192' }) : undefined;
    await expect(service.completeUpload(job.id, USER)).rejects.toThrow('大小'); expect(actions()).not.toContain('ImportImage');
    fault = undefined; job.uploadExpiresAt = new Date(0); await service.refreshPendingImports(); expect(job.status).toBe('cancelled'); expect(job.temporaryObjectDeletedAt).toBeInstanceOf(Date);
  });
  it('keeps lists owner-scoped even for administrators and polls oldest jobs first', async () => {
    await service.list({ id: 'admin', username: 'admin', role: 'admin' });
    expect(imageImportJob.findMany).toHaveBeenCalledWith({ where: { ownerUserId: 'admin' }, orderBy: { createdAt: 'desc' } });
    await service.refreshPendingImports();
    expect(imageImportJob.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true, cloudWorkspaceId: true, cloudAccountUid: true, cloudProvider: true }, take: 20, orderBy: [{ lastPolledAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }] }));
  });
});
