import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';

jest.mock('node:fs/promises', () => ({ readFile: jest.fn() }));

const catalog = {
  capturedAt: '2026-10-28T00:00:00Z', total: 4, items: [
    { id: 1, name: '演练镜像', type: 'vm', imageId: 'm-fixture', active: true, status: 'successful', creator: '张三' },
    { id: 2, name: '已停用镜像', type: 'vm', imageId: 'm-disabled', active: false, status: 'successful' },
    { id: 3, name: '镜像-废弃', type: 'vm', imageId: 'm-retired', active: true, status: 'successful' },
    { id: 4, name: '容器镜像', type: 'docker', imageId: null, active: true, status: 'successful' },
  ],
};

import { ImageCatalogController } from '../src/admin/image-catalog.controller';
import { ImageCatalogService } from '../src/admin/image-catalog.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { OperationControlService } from '../src/operations/operation-control.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const admin = { id: 'admin', username: 'admin', role: 'admin' as const };
const request = { adminUser: admin } as never;
const snapshot = {
  id: 'cloud-snapshot', provider: 'alibaba_cloud', scope: 'custom', accountUid: '123', accountScopeKey: '123', regionId: 'cn-test',
  imageId: 'm-fixture', sourceImageName: '云镜像', osType: 'linux', platform: 'Ubuntu', architecture: 'x86_64',
  status: 'Available', isAvailable: true, lastSyncedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
};

function setup() {
  let stored: any;
  const repo = {
    listImageSnapshots: jest.fn().mockResolvedValue([snapshot]),
    listImageCatalogItems: jest.fn().mockResolvedValue([]),
    listPackedImageArtifacts: jest.fn().mockResolvedValue([]),
    getImageSnapshotById: jest.fn().mockResolvedValue(snapshot),
    hasActiveImageImportForArtifact: jest.fn().mockResolvedValue(false),
    listPlatformImageAssets: jest.fn().mockImplementation(async () => stored ? [stored] : []),
    collectPlatformImageAsset: jest.fn().mockImplementation(async (input) => {
      stored = { id: 'asset', provider: 'alibaba_cloud', accountUid: '123', accountScopeKey: '123', regionId: 'cn-test',
        sourceScope: 'custom', sourceSnapshotId: input.snapshotId, imageId: snapshot.imageId, displayName: input.displayName,
        defaultHostName: null, defaultPassword: null, description: null, ownerUserId: null, visibility: 'platform', enabled: true,
        tags: [], createdAt: new Date(), updatedAt: new Date() };
      return stored;
    }),
  };
  const config = { getSelectedAccountContext: jest.fn().mockResolvedValue({ provider: 'alibaba_cloud', accountUid: '123', defaultRegion: 'cn-test' }) };
  const service = new ImageCatalogService(repo as never, config as never);
  const containers = { collectOne: jest.fn().mockRejectedValue(new ConflictException('目录未绑定')) };
  return { controller: new ImageCatalogController(service, {} as never, containers as never), service, repo };
}

describe('墨攻镜像收录', () => {
  beforeEach(() => {
    jest.mocked(readFile).mockImplementation(async () => JSON.stringify(catalog) as never);
  });

  it.each([['2', 'm-disabled'], ['3', 'm-retired']])('rejects an inactive or retired entry even if its cloud image is available (%s)', async (id, imageId) => {
    const { controller, repo } = setup();
    repo.listImageSnapshots.mockResolvedValueOnce([{ ...snapshot, imageId }]);
    await expect(controller.collectMogong(request, id)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.collectPlatformImageAsset).not.toHaveBeenCalled();
  });

  it('does not expose source records outside the current cloud catalog', async () => {
    const { controller } = setup();
    const result = await controller.listMogong();
    expect(result.items.map((item) => item.id)).toEqual([1]);
    expect(result.items[0].creator).toBe('张三');
    expect(result.total).toBe(1);
    await expect(controller.collectMogong(request, '4')).rejects.toBeInstanceOf(ConflictException);
  });

  it('shows all source records only in the bound workspace without exposing container references', async () => {
    const { controller } = setup();
    const previous = process.env.MOGONG_CATALOG_WORKSPACE_ID;
    process.env.MOGONG_CATALOG_WORKSPACE_ID = 'bound-space';
    jest.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ ...catalog, version: 2, items: catalog.items.map(item => ({ ...item, containerReference: item.type === 'docker' ? 'registry.example/team/private:1' : null })) }) as never);
    try {
      const result = await runInCloudWorkspace({ cloudWorkspaceId: 'bound-space', provider: 'alibaba_cloud', accountUid: '123' }, () => controller.listMogong());
      expect(result.total).toBe(catalog.items.length);
      expect(result.containersCollectable).toBe(true);
      expect(JSON.stringify(result)).not.toContain('registry.example');
    } finally {
      if (previous === undefined) delete process.env.MOGONG_CATALOG_WORKSPACE_ID; else process.env.MOGONG_CATALOG_WORKSPACE_ID = previous;
    }
  });

  it('accepts an older snapshot without creator information', async () => {
    const { controller } = setup();
    jest.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ ...catalog, items: catalog.items.map(({ creator: _creator, ...item }) => item) }) as never);
    expect((await controller.listMogong()).items[0].creator).toBeNull();
  });

  it('fails closed when the private source snapshot is missing or incomplete', async () => {
    const { controller, repo } = setup();
    jest.mocked(readFile).mockRejectedValueOnce(new Error('missing'));
    await expect(controller.listMogong()).rejects.toBeInstanceOf(ServiceUnavailableException);
    jest.mocked(readFile).mockResolvedValueOnce('{"capturedAt":"2026-10-28T00:00:00Z","total":2,"items":[]}' as never);
    await expect(controller.collectMogong(request, '1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repo.collectPlatformImageAsset).not.toHaveBeenCalled();
  });

  it('rejects an image that is not present in the current Alibaba Cloud catalog', async () => {
    const { controller, repo } = setup();
    repo.listImageSnapshots.mockResolvedValueOnce([{ ...snapshot, imageId: 'm-other' }]);
    await expect(controller.collectMogong(request, '1')).rejects.toBeInstanceOf(ConflictException);
    expect(repo.collectPlatformImageAsset).not.toHaveBeenCalled();
  });

  it('keeps a cloud-backed platform asset after the source catalog entry is removed', async () => {
    const { controller, service, repo } = setup();
    const result = await controller.collectMogong(request, '1');
    expect(result).toEqual(expect.objectContaining({ imageId: 'm-fixture', sourceSnapshotId: 'cloud-snapshot' }));
    expect(repo.collectPlatformImageAsset).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: 'cloud-snapshot', displayName: '演练镜像' }));

    const items = catalog.items.splice(0, catalog.items.length);
    try {
      expect((await service.listPlatformAssets(admin, 'platform')).items).toEqual([
        expect.objectContaining({ imageId: 'm-fixture', sourceSnapshotId: 'cloud-snapshot', sourceSnapshotAvailable: true }),
      ]);
    } finally {
      catalog.items.push(...items);
    }
  });

  it('requires a matching MCP confirmation and executes a bulk collection only once', async () => {
    const workspace = { cloudWorkspaceId: 'confirmation-space', provider: 'alibaba_cloud' as const, accountUid: '123' };
    const digest = 'a'.repeat(64);
    const containers = { preview: jest.fn().mockResolvedValue({ digest, eligible: 2, toCollect: 2 }),
      collectAll: jest.fn().mockResolvedValue({ added: 2, alreadyCollected: 0, eligible: 2 }) };
    const controller = new ImageCatalogController({} as never, new OperationControlService(createMemoryAdminRepository()), containers as never);
    const req = { headers: { 'x-idempotency-key': 'bulk-1' }, adminUser: admin,
      authContext: { user: admin, source: 'mcp' as const, oauthClientId: 'mcp-gateway' } };
    await runInCloudWorkspace(workspace, async () => {
      let confirmationId = '';
      try {
        await controller.collectMogongContainers(req as never, { catalogDigest: digest });
        throw new Error('Expected confirmation');
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        const response = (error as ConflictException).getResponse() as { code: string; confirmationId: string; summary: { toCollect: number } };
        expect(response.code).toBe('CONFIRMATION_REQUIRED');
        expect(response.summary.toCollect).toBe(2);
        confirmationId = response.confirmationId;
      }
      expect(containers.collectAll).not.toHaveBeenCalled();
      const confirmed = { ...req, headers: { ...req.headers, 'x-confirmation-id': confirmationId } };
      await expect(controller.collectMogongContainers(confirmed as never, { catalogDigest: 'b'.repeat(64) })).rejects.toThrow('does not match');
      await expect(controller.collectMogongContainers(confirmed as never, { catalogDigest: digest })).resolves.toMatchObject({ result: { added: 2 } });
      await controller.collectMogongContainers(confirmed as never, { catalogDigest: digest });
      expect(containers.collectAll).toHaveBeenCalledTimes(1);
    });
  });
});
