import { PrismaService } from '../src/database/prisma.service';
import type { SystemConfigService } from '../src/admin/system-config.service';
import { TencentCosManagedBucketService } from '../src/admin/tencent-cos-managed-bucket.service';
import { ownedCosBucketProof } from '../src/admin/tencent-cos-proof';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { fakeCos } from './support/fake-cos';

const url = process.env.TENCENT_COS_TEST_DATABASE_URL;
if (url && (new URL(url).hostname !== 'cos-test-postgres' || new URL(url).pathname !== '/cos_test')) throw new Error('COS tests require isolated cos_test PostgreSQL');
const dbDescribe = url ? describe : describe.skip;
const scope = { cloudWorkspaceId: 'cos-fixture-workspace', provider: 'tencent_cloud' as const, accountUid: '100001', actorUserId: 'cos-fixture-owner' };
const input = { cloudAccountContextId: 'cos-fixture-context', creatorUserId: scope.actorUserId };

dbDescribe('owned COS bucket saga in isolated PostgreSQL', () => {
  const prisma = new PrismaService({ datasources: { db: { url: url ?? 'postgresql://fixture:fixture@cos-test-postgres:5432/cos_test' } } });
  const config = { getExecutionAccountContext: async ({ cloudAccountContextId }: { cloudAccountContextId: string }) => ({ provider: 'tencent_cloud', cloudAccountContextId, accountUid: '100001', accountUidResolved: true,
    defaultRegion: 'ap-shanghai', defaultZoneId: 'ap-shanghai-1', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' }),
    runInWorkspace: async (_id: string, work: () => Promise<unknown>) => runInCloudWorkspace(scope, work),
  } as unknown as SystemConfigService;
  const service = new TencentCosManagedBucketService(prisma, config);
  let cloud: ReturnType<typeof fakeCos>;
  async function cleanup() { await runInSystemCloudWorkspaceScope(async () => {
    await prisma.imageImportJob.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } });
    await prisma.billingLedgerResource.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } });
    await prisma.cloudImageImportBucket.deleteMany({ where: { cloudWorkspaceId: scope.cloudWorkspaceId } });
    await prisma.cloudWorkspace.deleteMany({ where: { id: scope.cloudWorkspaceId } });
  }); }
  beforeAll(async () => { await prisma.$connect(); });
  beforeEach(async () => { await cleanup(); await prisma.cloudWorkspace.create({ data: { id: scope.cloudWorkspaceId, provider: scope.provider, accountUid: scope.accountUid, displayName: 'COS fixture' } }); cloud = fakeCos(); });
  afterEach(async () => { cloud.restore(); await cleanup(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it.each([{ Uin: 100009 }, { Uin: ['100009'] }])('rejects a non-string CAM Uin $Uin before persisting any bucket intent', async ({ Uin }) => {
    cloud.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ Response: { OwnerUin: '100001', Uin, AppId: 1250000000, RequestId: 'fixture-iam' } }), { status: 200 }));
    await runInCloudWorkspace(scope, async () => {
      await expect(service.ensureImportBucket(input)).rejects.toThrow('官方 APPID 身份未核验');
      expect(await prisma.cloudImageImportBucket.count()).toBe(0); expect(cloud.creates).toBe(0);
    });
  });

  it('creates one private atomically tagged bucket, proves its creator, and persists the exact platform ledger', async () => {
    await runInCloudWorkspace(scope, async () => {
      const bucket = await service.ensureImportBucket(input);
      const row = (await prisma.cloudImageImportBucket.findUnique({ where: { id: bucket.id } }))!;
      expect(ownedCosBucketProof(row)).not.toBeNull();
      expect(cloud.creates).toBe(1);
      expect(await service.ensureImportBucket(input)).toEqual(bucket);
      expect(cloud.creates).toBe(1);
      const ledger = await prisma.billingLedgerResource.findFirst();
      expect(ledger).toMatchObject({ cloudProvider: 'tencent_cloud', cloudAccountUid: '100001', cloudResourceId: bucket.bucketName, cloudResourceType: 'oss_bucket', billingScope: 'platform', ownerUserId: null });
      await expect(service.getOwnedBucket({ bucketId: bucket.id, cloudAccountContextId: 'foreign-context', cloudAccountUid: '100001', regionId: 'ap-shanghai' })).rejects.toThrow('冻结身份');
      await expect(service.ensureImportBucket({ ...input, cloudAccountContextId: 'another-alias' })).rejects.toThrow('冻结配置');
      expect(cloud.creates).toBe(1);
    });
  });
  it('recovers a timed-out accepted creation with its original nonce and never sends a second PUT', async () => {
    await runInCloudWorkspace(scope, async () => {
      cloud.unknownCreate();
      await expect(service.ensureImportBucket(input)).rejects.toThrow('尚待核对');
      const uncertain = (await prisma.cloudImageImportBucket.findFirst())!;
      expect(uncertain.status).toBe('unknown'); expect(cloud.creates).toBe(1);
      const recovered = await service.ensureImportBucket(input);
      expect(recovered.id).toBe(uncertain.id); expect(recovered.bucketName).toBe(uncertain.bucketName);
      expect((await prisma.cloudImageImportBucket.findUnique({ where: { id: recovered.id } }))!.creationNonce).toBe(uncertain.creationNonce);
      expect(cloud.creates).toBe(1);
    });
  });
  it('holds the bucket lease through source-job registration and prevents idle cleanup in the callback gap', async () => {
    await runInCloudWorkspace(scope, async () => {
      let start!: (bucket: Awaited<ReturnType<typeof service.ensureImportBucket>>) => void; let release!: () => void;
      const started = new Promise<Awaited<ReturnType<typeof service.ensureImportBucket>>>(resolve => { start = resolve; });
      const first = service.withImportBucket(input, async bucket => { start(bucket); await new Promise<void>(resolve => { release = resolve; }); return bucket; });
      const bucket = await started;
      expect(await service.cleanupIfIdle({ bucketId: bucket.id, cloudAccountContextId: input.cloudAccountContextId, cloudAccountUid: '100001', regionId: 'ap-shanghai' })).toEqual({ status: 'busy' });
      expect(cloud.deletes).toBe(0); release(); await first;
    });
  });
  it('confirms an unknown DELETE only by HEAD absence and releases history without repeating DELETE', async () => {
    await runInCloudWorkspace(scope, async () => {
      const bucket = await service.ensureImportBucket(input); cloud.unknownDelete();
      const target = { bucketId: bucket.id, cloudAccountContextId: input.cloudAccountContextId, cloudAccountUid: '100001', regionId: 'ap-shanghai' };
      expect(await service.cleanupIfIdle(target)).toEqual({ status: 'deleting' }); expect(cloud.deletes).toBe(1);
      expect(await service.cleanupIfIdle(target)).toEqual({ status: 'deleted' }); expect(cloud.deletes).toBe(1);
      const row = (await prisma.cloudImageImportBucket.findUnique({ where: { id: bucket.id } }))!;
      expect(row.activeSlot).toBeNull(); expect(row.deletedAt).toBeInstanceOf(Date);
      expect((await prisma.billingLedgerResource.findFirst())!.releasedAt).toBeInstanceOf(Date);
    });
  });
  it('refuses public/mixed/nonempty buckets and invalidates a failed source proof instead of charging the whole bucket', async () => {
    await runInCloudWorkspace(scope, async () => {
      const bucket = await service.ensureImportBucket(input); const remote = cloud.buckets.get(bucket.bucketName)!;
      remote.objects.set('external-file', { owner: 'external', context: 'external', job: 'external', size: 1, etag: 'fixture-etag' });
      await expect(service.getOwnedBucket({ bucketId: bucket.id, cloudAccountContextId: input.cloudAccountContextId, cloudAccountUid: '100001', regionId: 'ap-shanghai' })).rejects.toThrow('整桶费用');
      expect(ownedCosBucketProof((await prisma.cloudImageImportBucket.findFirst())!)).toBeNull(); expect(cloud.deletes).toBe(0);
    });
  });
  it('invalidates mixed usage found by cleanup and never restores it when foreign objects later disappear', async () => {
    await runInCloudWorkspace(scope, async () => {
      const bucket = await service.ensureImportBucket(input); const remote = cloud.buckets.get(bucket.bucketName)!;
      remote.objects.set('external-file', { owner: 'external', context: 'external', job: 'external', size: 1, etag: 'fixture-etag' });
      await expect(service.cleanupIfIdle({ bucketId: bucket.id, cloudAccountContextId: input.cloudAccountContextId, cloudAccountUid: '100001', regionId: 'ap-shanghai' })).rejects.toThrow('整桶费用');
      expect(ownedCosBucketProof((await prisma.cloudImageImportBucket.findFirst())!)).toBeNull();
      remote.objects.clear();
      await expect(service.ensureImportBucket(input)).rejects.toThrow('不能重新接管');
      expect(cloud.creates).toBe(1); expect(cloud.deletes).toBe(0);
    });
  });
  it('keeps a transient remote verification failure pending and restores the same creation proof on the next getter', async () => {
    await runInCloudWorkspace(scope, async () => {
      const bucket = await service.ensureImportBucket(input);
      const original = cloud.fetch.getMockImplementation()!;
      cloud.fetch.mockImplementationOnce(original).mockImplementationOnce(original).mockRejectedValueOnce(new Error('transient verification fixture'));
      const target = { bucketId: bucket.id, cloudAccountContextId: input.cloudAccountContextId, cloudAccountUid: '100001', regionId: 'ap-shanghai' };
      await expect(service.getOwnedBucket(target)).rejects.toThrow('NETWORK_OR_TIMEOUT');
      const pending = (await prisma.cloudImageImportBucket.findUnique({ where: { id: bucket.id } }))!;
      expect(ownedCosBucketProof(pending)).toBeNull();
      expect((pending.ownershipProof as Record<string,unknown>).verificationPending).toBe(true);
      expect(await service.getOwnedBucket(target)).toEqual(bucket);
      expect(ownedCosBucketProof((await prisma.cloudImageImportBucket.findUnique({ where: { id: bucket.id } }))!)).not.toBeNull();
      expect(cloud.creates).toBe(1);
      cloud.fetch.mockImplementationOnce(original).mockImplementationOnce(original).mockRejectedValueOnce(new Error('second transient verification fixture'));
      await expect(service.getOwnedBucket(target)).rejects.toThrow('NETWORK_OR_TIMEOUT');
      await runInSystemCloudWorkspaceScope(() => service.refreshPendingBuckets());
      expect((await prisma.cloudImageImportBucket.findUnique({ where: { id: bucket.id } }))!.status).toBe('deleted');
      expect(cloud.creates).toBe(1); expect(cloud.deletes).toBe(1);
    });
  });

  it('releases a proven vanished bucket through the independent worker without recreating or deleting it', async () => {
    await runInCloudWorkspace(scope, async () => {
      const bucket = await service.ensureImportBucket(input); cloud.buckets.delete(bucket.bucketName);
      await expect(service.getOwnedBucket({ bucketId: bucket.id, cloudAccountContextId: input.cloudAccountContextId, cloudAccountUid: '100001', regionId: 'ap-shanghai' })).rejects.toThrow('BUCKET_NOT_FOUND');
      expect(ownedCosBucketProof((await prisma.cloudImageImportBucket.findFirst())!)).toBeNull();
      await runInSystemCloudWorkspaceScope(() => service.refreshPendingBuckets());
      const row = (await prisma.cloudImageImportBucket.findUnique({ where: { id: bucket.id } }))!;
      expect(row.status).toBe('deleted'); expect(row.activeSlot).toBeNull();
      expect((await prisma.billingLedgerResource.findFirst())!.releasedAt).toBeInstanceOf(Date);
      expect(cloud.creates).toBe(1); expect(cloud.deletes).toBe(0);
    });
  });

  it('recovers orphaned unknown creation via explicit system discovery and destroys the now-proven idle bucket', async () => {
    await runInCloudWorkspace(scope, async () => { cloud.unknownCreate(); await expect(service.ensureImportBucket(input)).rejects.toThrow(); });
    await runInSystemCloudWorkspaceScope(() => service.refreshPendingBuckets());
    const row = await runInCloudWorkspace(scope, () => prisma.cloudImageImportBucket.findFirst());
    expect(row?.status).toBe('deleted'); expect(cloud.creates).toBe(1); expect(cloud.deletes).toBe(1);
  });
  it.each(['PUT404', 'GET404', 'wrong-method', 'missing-metadata-headers', 'missing-origin'])('returns no browser upload session when CORS verification fails: %s', async failure => {
    await runInCloudWorkspace(scope, async () => {
      const bucket = await service.ensureImportBucket(input);
      const remote = cloud.buckets.get(bucket.bucketName)!;
      if (failure === 'PUT404') remote.corsPutStatus = 404;
      else if (failure === 'GET404') remote.corsReadStatus = 404;
      else remote.corsRead = `<CORSConfiguration><CORSRule><AllowedOrigin>${failure === 'missing-origin' ? 'https://external.invalid' : '*'}</AllowedOrigin><AllowedMethod>${failure === 'wrong-method' ? 'POST' : 'PUT'}</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>${failure === 'missing-metadata-headers' ? '' : '<AllowedHeader>*</AllowedHeader>'}<ExposeHeader>ETag</ExposeHeader></CORSRule></CORSConfiguration>`;
      const callback = jest.fn(async () => ({ upload: 'must-not-return' }));
      await expect(service.withImportBucket(input, callback)).rejects.toThrow();
      expect(callback).not.toHaveBeenCalled();
      expect((await prisma.billingLedgerResource.findFirst())!.releasedAt).toBeNull();
      expect(cloud.creates).toBe(1);
    });
  });
  it('persists the owned bucket fee identity even if the first CORS write fails', async () => {
    const fetch = cloud.fetch.getMockImplementation()!;
    cloud.fetch.mockImplementation(async (url, init) => new URL(String(url)).searchParams.has('cors') && init?.method === 'PUT'
      ? new Response('', { status: 404, headers: { 'x-cos-request-id': 'fixture-cors-failed' } }) : fetch(url, init));
    await runInCloudWorkspace(scope, async () => {
      const callback = jest.fn(); await expect(service.withImportBucket(input, callback)).rejects.toThrow('HTTP_404');
      const bucket = (await prisma.cloudImageImportBucket.findFirst())!;
      expect(ownedCosBucketProof(bucket)).not.toBeNull();
      expect((await prisma.billingLedgerResource.findFirst())!.cloudResourceId).toBe(bucket.bucketName);
      expect(callback).not.toHaveBeenCalled();
    });
  });

});
