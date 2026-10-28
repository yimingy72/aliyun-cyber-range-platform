import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCurrentCloudWorkspaceId, runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { PlatformContainerImagesService } from '../src/admin/platform-container-images.service';

const a = { cloudWorkspaceId: 'container-space-a', provider: 'alibaba_cloud' as const, accountUid: '100001' };
const b = { cloudWorkspaceId: 'container-space-b', provider: 'alibaba_cloud' as const, accountUid: '100002' };
const admin = { id: 'admin', username: 'admin', role: 'admin' as const };
const ordinary = { id: 'user', username: 'user', role: 'user' as const };
const base = { imageId: null, creator: '张三', active: true, status: 'successful' };
const fixture = { capturedAt: '2026-10-28T00:00:00Z', version: 2, total: 6, items: [
  { ...base, id: 1, name: '容器一', type: 'docker', containerReference: 'registry.example/team/image:1' },
  { ...base, id: 2, name: '待核验容器', type: 'docker', containerReference: 'registry.example/team/bad name:1' },
  { ...base, id: 3, name: '停用容器', type: 'docker', active: false, containerReference: 'registry.example/team/off:1' },
  { ...base, id: 4, name: '已废弃容器', type: 'docker', containerReference: 'registry.example/team/old:1' },
  { ...base, id: 5, name: '未完成容器', type: 'docker', status: 'waiting_for_upload', containerReference: null },
  { ...base, id: 6, name: '未匹配虚拟机', type: 'vm', containerReference: null },
] };

describe('platform container catalog', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mogong-containers-'));
  const file = join(dir, 'catalog.json');
  const oldPath = process.env.MOGONG_IMAGE_CATALOG_PATH;
  const oldWorkspace = process.env.MOGONG_CATALOG_WORKSPACE_ID;
  let records: any[];
  let service: PlatformContainerImagesService;
  const scoped = () => records.filter(item => item.cloudWorkspaceId === getCurrentCloudWorkspaceId());

  beforeEach(() => {
    process.env.MOGONG_IMAGE_CATALOG_PATH = file;
    process.env.MOGONG_CATALOG_WORKSPACE_ID = a.cloudWorkspaceId;
    writeFileSync(file, JSON.stringify(fixture));
    records = [];
    const select = (row: any, fields: Record<string, boolean>) => Object.fromEntries(Object.keys(fields).map(key => [key, row[key]]));
    const prisma = { platformContainerImage: {
      findMany: jest.fn(async ({ select: fields }: any) => scoped().map(row => select(row, fields))),
      findFirst: jest.fn(async ({ where, select: fields }: any) => { const row = scoped().find(item => item.sourceId === where.sourceId); return row ? select(row, fields) : null; }),
      createMany: jest.fn(async ({ data }: any) => { let count = 0; for (const item of data) { if (records.some(row => row.cloudWorkspaceId === item.cloudWorkspaceId && row.sourceId === item.sourceId)) continue; records.push({ ...item, id: `asset-${item.sourceId}`, createdAt: new Date() }); count++; } return { count }; }),
      deleteMany: jest.fn(async ({ where }: any) => { const index = records.findIndex(item => item.id === where.id && item.cloudWorkspaceId === getCurrentCloudWorkspaceId()); if (index < 0) return { count: 0 }; records.splice(index, 1); return { count: 1 }; }),
    } };
    service = new PlatformContainerImagesService(prisma as never);
  });

  afterAll(() => {
    if (oldPath === undefined) delete process.env.MOGONG_IMAGE_CATALOG_PATH; else process.env.MOGONG_IMAGE_CATALOG_PATH = oldPath;
    if (oldWorkspace === undefined) delete process.env.MOGONG_CATALOG_WORKSPACE_ID; else process.env.MOGONG_CATALOG_WORKSPACE_ID = oldWorkspace;
    rmSync(dir, { recursive: true, force: true });
  });

  it('collects only active successful non-retired entries, safely records references, and survives source removal', async () => runInCloudWorkspace(a, async () => {
    const preview = await service.preview();
    expect(preview).toMatchObject({ eligible: 2, alreadyCollected: 0, toCollect: 2, needsReview: 1 });
    await expect(service.collectAll(preview.digest, admin)).resolves.toEqual({ added: 2, alreadyCollected: 0, eligible: 2 });
    await expect(service.collectAll(preview.digest, admin)).resolves.toEqual({ added: 0, alreadyCollected: 2, eligible: 2 });
    expect(records.map(item => item.referenceStatus)).toEqual(['recorded', 'needs_review']);
    expect(records[0].imageReference).toBe('registry.example/team/image:1');
    rmSync(file);
    const list = await service.list();
    expect(list.items).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain('registry.example');
  }));

  it('rejects stale previews, other workspaces, ordinary users, and disabled entries', async () => {
    await runInCloudWorkspace(a, async () => {
      const preview = await service.preview();
      writeFileSync(file, JSON.stringify({ ...fixture, items: fixture.items.map(item => item.id === 1 ? { ...item, name: '新名称' } : item) }));
      await expect(service.collectAll(preview.digest, admin)).rejects.toThrow('目录已变化');
      await expect(service.collectOne(3, admin)).rejects.toThrow('已停用');
      await expect(service.collectOne(1, ordinary)).rejects.toThrow('Admin access');
      expect(records).toHaveLength(0);
    });
    await runInCloudWorkspace(b, async () => {
      await expect(service.preview()).rejects.toThrow('未绑定');
      expect((await service.list()).items).toEqual([]);
    });
    await expect(runInCloudWorkspace({ ...a, isReadOnly: true }, () => service.collectOne(1, admin))).rejects.toThrow('不可写');
  });
});
