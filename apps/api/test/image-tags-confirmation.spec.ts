import { ConflictException, NotFoundException } from '@nestjs/common';
import { ImageCatalogService } from '../src/admin/image-catalog.service';
import { PlatformImageTagsController } from '../src/admin/platform-image-tags.controller';
import { PlatformImagesController } from '../src/admin/platform-images.controller';
import { SystemConfigService } from '../src/admin/system-config.service';
import { OperationControlService } from '../src/operations/operation-control.service';
import type { AuthenticatedPlatformRequest } from '../src/auth/request-auth-context';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const admin = { id: 'tag-admin', username: 'tag-admin', role: 'admin' as const };
const owner = { id: 'tag-owner', username: 'tag-owner', role: 'user' as const };
const other = { id: 'tag-other', username: 'tag-other', role: 'user' as const };
const req = (user: { id: string; username: string; role: 'admin' | 'user' } = owner): AuthenticatedPlatformRequest => ({ headers: {}, adminUser: user, authContext: { user, source: 'mcp', oauthClientId: 'mcp-gateway' } });
async function required(action: () => unknown) {
  try { await action(); throw new Error('Expected confirmation'); }
  catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    const result = (error as ConflictException).getResponse() as { code: string; confirmationId: string; idempotencyKey: string };
    expect(result.code).toBe('CONFIRMATION_REQUIRED'); return result;
  }
}
const confirmed = (request: AuthenticatedPlatformRequest, info: { confirmationId: string; idempotencyKey: string }) => ({ ...request, headers: { 'x-confirmation-id': info.confirmationId, 'x-idempotency-key': info.idempotencyKey } });

describe('Image tag MCP confirmation and owner protection', () => {
  let repository: ReturnType<typeof createMemoryAdminRepository>;
  let service: ImageCatalogService;
  let definitions: PlatformImageTagsController;
  let assets: PlatformImagesController;
  let assetId: string;
  beforeEach(async () => {
    repository = createMemoryAdminRepository();
    for (const user of [admin, owner, other]) await repository.createPlatformUser({ ...user, passwordHash: 'mock' });
    service = new ImageCatalogService(repository, { getAccountContext: async () => ({ provider: 'alibaba_cloud', accountUid: '100001', defaultRegion: 'cn-hangzhou' }) } as unknown as SystemConfigService);
    const operation = new OperationControlService(repository);
    definitions = new PlatformImageTagsController(service, operation); assets = new PlatformImagesController(service, operation);
    await repository.upsertImageSnapshots({ provider: 'alibaba_cloud', accountUid: '100001', regionId: 'cn-hangzhou', scope: 'custom', snapshots: [{ imageId: 'm-owned', sourceImageName: 'owned', status: 'Available', isAvailable: true, lastSyncedAt: new Date() }] });
    const source = (await repository.listImageSnapshots({ imageId: 'm-owned' }))[0];
    assetId = (await repository.collectPlatformImageAsset({ snapshotId: source.id, displayName: 'owned-private', ownerUserId: owner.id, visibility: 'private', defaultPassword: 'hidden-test-secret' })).id;
  });
  it('does not create a global definition before confirmation and replays the confirmed write once', async () => {
    const request = req(admin);
    const info = await required(() => definitions.create(request, { name: 'Web' }));
    expect(await repository.listPlatformImageTags()).toEqual([]);
    const replay = confirmed(request, info);
    expect(await definitions.create(replay, { name: 'Web' })).toMatchObject({ result: { name: 'Web' } });
    await definitions.create(replay, { name: 'Web' });
    expect(await repository.listPlatformImageTags()).toHaveLength(1);
    await expect(definitions.create(req(other), { name: 'Other' })).rejects.toThrow('Admin access');
    await expect(definitions.create(req(admin), { name: 'ＷＥＢ' })).rejects.toThrow('已存在');
  });
  it('confirms complete association replacements and clearing without deleting global definitions or exposing passwords', async () => {
    const tag = await service.createPlatformImageTag({ name: 'Web' }, admin);
    const request = req(owner), input = { tagIds: [tag.id] };
    const update = jest.spyOn(repository, 'replacePlatformImageAssetTags');
    const info = await required(() => assets.setTags(request, assetId, input));
    expect(update).not.toHaveBeenCalled();
    const replay = confirmed(request, info);
    const result = await assets.setTags(replay, assetId, input);
    expect(JSON.stringify(result)).not.toContain('hidden-test-secret');
    await assets.setTags(replay, assetId, input); expect(update).toHaveBeenCalledTimes(1);
    expect((await repository.getPlatformImageAssetById(assetId))!.tags.map(t => t.id)).toEqual([tag.id]);
    const clearInfo = await required(() => assets.setTags(request, assetId, { tagIds: [] }));
    await assets.setTags(confirmed(request, clearInfo), assetId, { tagIds: [] });
    expect((await repository.getPlatformImageAssetById(assetId))!.tags).toEqual([]);
    expect(await repository.listPlatformImageTags()).toHaveLength(1);
  });
  it('rejects another private owner, unknown tags and changed or cross-user confirmation inputs', async () => {
    const tag = await service.createPlatformImageTag({ name: 'Web' }, admin);
    await expect(assets.setTags(req(other), assetId, { tagIds: [tag.id] })).rejects.toBeInstanceOf(NotFoundException);
    await expect(assets.setTags(req(owner), assetId, { tagIds: ['unknown'] })).rejects.toThrow('不存在');
    const info = await required(() => assets.setTags(req(owner), assetId, { tagIds: [tag.id] }));
    await expect(assets.setTags(confirmed(req(owner), info), assetId, { tagIds: [] })).rejects.toThrow('does not match');
    await expect(assets.setTags(confirmed(req(other), info), assetId, { tagIds: [tag.id] })).rejects.toThrow('does not match');
    expect((await repository.getPlatformImageAssetById(assetId))!.tags).toEqual([]);
  });
});
