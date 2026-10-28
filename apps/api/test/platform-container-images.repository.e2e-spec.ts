import { PrismaService } from '../src/database/prisma.service';
import { runInCloudWorkspace, runInSystemCloudWorkspaceScope } from '../src/auth/cloud-workspace-scope';
import { PlatformContainerImagesService } from '../src/admin/platform-container-images.service';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.WORKSPACE_TEST_DATABASE_URL;
const databaseDescribe = url ? describe : describe.skip;
const a = { cloudWorkspaceId: 'container-db-a', provider: 'alibaba_cloud' as const, accountUid: 'container-db-1' };
const b = { cloudWorkspaceId: 'container-db-b', provider: 'alibaba_cloud' as const, accountUid: 'container-db-2' };

databaseDescribe('container image workspace persistence', () => {
  const prisma = new PrismaService({ datasources: { db: { url } } });
  async function cleanup() {
    await runInSystemCloudWorkspaceScope(async () => {
      await prisma.platformContainerImage.deleteMany({ where: { cloudWorkspaceId: { in: [a.cloudWorkspaceId, b.cloudWorkspaceId] } } });
      await prisma.cloudWorkspace.deleteMany({ where: { id: { in: [a.cloudWorkspaceId, b.cloudWorkspaceId] } } });
    });
  }
  beforeAll(async () => {
    await cleanup();
    await runInSystemCloudWorkspaceScope(() => prisma.cloudWorkspace.createMany({ data: [a, b].map(({ cloudWorkspaceId, ...scope }) => ({ id: cloudWorkspaceId, ...scope, displayName: cloudWorkspaceId })) }));
  });
  afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

  it('isolates list and delete, permits the same source ID in two spaces, and forbids moving an asset', async () => {
    const data = { sourceId: 7, displayName: 'container fixture', creator: null, imageReference: 'registry.example/team/image:1', referenceStatus: 'recorded' };
    const first = await runInCloudWorkspace(a, () => prisma.platformContainerImage.create({ data: { ...data, cloudWorkspaceId: a.cloudWorkspaceId } }));
    await expect(runInCloudWorkspace(a, () => prisma.platformContainerImage.createMany({ data: [{ ...data, cloudWorkspaceId: a.cloudWorkspaceId }], skipDuplicates: true }))).resolves.toEqual({ count: 0 });
    const second = await runInCloudWorkspace(b, () => prisma.platformContainerImage.create({ data: { ...data, cloudWorkspaceId: b.cloudWorkspaceId } }));
    expect(first.id).not.toBe(second.id);
    await runInCloudWorkspace(a, async () => {
      expect((await prisma.platformContainerImage.findMany()).map(row => row.id)).toEqual([first.id]);
      expect(await prisma.platformContainerImage.deleteMany({ where: { id: second.id } })).toEqual({ count: 0 });
    });
    await expect(runInSystemCloudWorkspaceScope(() => prisma.platformContainerImage.update({ where: { id: first.id }, data: { cloudWorkspaceId: b.cloudWorkspaceId } }))).rejects.toThrow();
    expect((await runInCloudWorkspace(b, () => prisma.platformContainerImage.findMany())).map(row => row.id)).toEqual([second.id]);
  });

  it('persists eligible source entries through the real bulk service and keeps them after the source is removed', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'container-db-catalog-'));
    const file = join(folder, 'catalog.json');
    const oldPath = process.env.MOGONG_IMAGE_CATALOG_PATH;
    const oldWorkspace = process.env.MOGONG_CATALOG_WORKSPACE_ID;
    process.env.MOGONG_IMAGE_CATALOG_PATH = file;
    process.env.MOGONG_CATALOG_WORKSPACE_ID = a.cloudWorkspaceId;
    const base = { imageId: null, creator: '示例创建人', status: 'successful', type: 'docker' };
    writeFileSync(file, JSON.stringify({ version: 2, capturedAt: '2026-10-28T00:00:00Z', total: 3, items: [
      { ...base, id: 8, name: '容器', active: true, containerReference: 'registry.example/team/image:1' },
      { ...base, id: 9, name: '停用容器', active: false, containerReference: 'registry.example/team/off:1' },
      { ...base, id: 10, name: '容器-废弃', active: true, containerReference: 'registry.example/team/old:1' },
    ] }));
    try {
      await runInCloudWorkspace(a, async () => {
        const service = new PlatformContainerImagesService(prisma);
        const preview = await service.preview();
        expect(preview).toMatchObject({ eligible: 1, toCollect: 1 });
        const user = { id: 'admin', username: 'admin', role: 'admin' as const };
        await expect(service.collectAll(preview.digest, user)).resolves.toMatchObject({ added: 1, eligible: 1 });
        await expect(service.collectAll(preview.digest, user)).resolves.toMatchObject({ added: 0, alreadyCollected: 1 });
        rmSync(file);
        const items = (await service.list()).items;
        expect(items.find(item => item.sourceId === 8)).toMatchObject({ displayName: '容器', creator: '示例创建人' });
        expect(items.some(item => item.sourceId === 9 || item.sourceId === 10)).toBe(false);
        expect(JSON.stringify(items)).not.toContain('registry.example');
      });
    } finally {
      if (oldPath === undefined) delete process.env.MOGONG_IMAGE_CATALOG_PATH; else process.env.MOGONG_IMAGE_CATALOG_PATH = oldPath;
      if (oldWorkspace === undefined) delete process.env.MOGONG_CATALOG_WORKSPACE_ID; else process.env.MOGONG_CATALOG_WORKSPACE_ID = oldWorkspace;
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
