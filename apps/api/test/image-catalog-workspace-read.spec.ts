import { ImageCatalogService } from '../src/admin/image-catalog.service';
import { SystemConfigService } from '../src/admin/system-config.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const actor = { id: 'manager', username: 'admin', role: 'admin' as const, isPlatformManager: true, cloudWorkspaceId: null };
const a = { cloudWorkspaceId: 'space-a', provider: 'alibaba_cloud' as const, accountUid: '111', actorUserId: actor.id, isPlatformManager: true };
const b = { ...a, cloudWorkspaceId: 'space-b', accountUid: '222' };

describe('workspace provenance in historical catalog reads', () => {
  it('keeps proven workspace records visible with legacy null UID, excludes other workspaces, and refuses their account-sensitive writes', async () => {
    const repo = createMemoryAdminRepository();
    async function seed(scope: typeof a, name: string) {
      return runInCloudWorkspace(scope, async () => {
        await repo.upsertImageSnapshots({ provider: 'alibaba_cloud', accountUid: null, regionId: 'cn-hangzhou', scope: 'custom', snapshots: [{ imageId: 'same-image', sourceImageName: name, platform: 'Ubuntu', status: 'Available', isAvailable: true, lastSyncedAt: new Date() }] });
        const [snapshot] = await repo.listImageSnapshots({});
        await repo.collectImageCatalogItem({ displayName: name, imageId: 'same-image', provider: 'alibaba_cloud', accountUid: null, regionId: 'cn-hangzhou', scope: 'custom', sourceSnapshotId: snapshot.id });
        return repo.collectPlatformImageAsset({ snapshotId: snapshot.id, displayName: name, ownerUserId: actor.id, visibility: 'platform' });
      });
    }
    const alpha = await seed(a, '阿里空间 A 历史镜像'); const beta = await seed(b, '阿里空间 B 历史镜像');
    const system = { getSelectedAccountContext: jest.fn(async () => ({ provider: 'alibaba_cloud', accountUid: '111', defaultRegion: 'cn-hangzhou', defaultZoneId: 'cn-hangzhou-h', accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret' })) };
    const service = new ImageCatalogService(repo, system as unknown as SystemConfigService);
    await runInCloudWorkspace(a, async () => {
      const assets = await service.listPlatformAssets(actor); const catalog = await service.listCustom();
      expect(assets.items.map(asset => asset.id)).toEqual([alpha.id]); expect(assets.items.some(asset => asset.id === beta.id)).toBe(false);
      expect(catalog.snapshots.map(snapshot => snapshot.sourceImageName)).toEqual(['阿里空间 A 历史镜像']);
      expect(catalog.catalogItems.map(item => item.displayName)).toEqual(['阿里空间 A 历史镜像']);
      await expect(service.updatePlatformAsset(alpha.id, { displayName: '不应保存' }, actor)).rejects.toThrow('not found');
      expect((await repo.getPlatformImageAssetById(alpha.id))?.displayName).toBe('阿里空间 A 历史镜像');
    });
  });
});
