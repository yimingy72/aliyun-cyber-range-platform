import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RangeTemplatesService } from '../src/admin/range-templates.service';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';

const workspaceA = { cloudWorkspaceId: 'workspace-a', provider: 'alibaba_cloud' as const, accountUid: 'account-a' };
const workspaceB = { cloudWorkspaceId: 'workspace-b', provider: 'tencent_cloud' as const, accountUid: 'account-b' };
const admin = { id: 'admin', role: 'admin' as const };
const owner = { id: 'owner', role: 'user' as const };

it('lets administrators discover and manage other owners private drafts only in the selected workspace', async () => {
  const repository = createMemoryAdminRepository();
  const input = { name: 'test1-test1', slug: 'private-draft', version: 'v1', createdBy: owner.id,
    ownerUserId: owner.id, visibility: 'private' as const, modulePathOrRef: 'fixture-module',
    topologySpec: { vpcCidr: '10.0.0.0/16', networkZones: [], hosts: [], publicEntry: { hostKey: '', protocols: [] } } };
  const own = await runInCloudWorkspace(workspaceA, () => repository.createRangeTemplate({ ...input, slug: 'admin-owned', ownerUserId: admin.id }));
  const draft = await runInCloudWorkspace(workspaceA, () => repository.createRangeTemplate(input));
  const foreign = await runInCloudWorkspace(workspaceB, () => repository.createRangeTemplate(input));
  const service = new RangeTemplatesService(repository);

  await runInCloudWorkspace(workspaceA, async () => {
    const all = await service.list(admin, 'all');
    expect(all.map(item => item.id).sort()).toEqual([own.id, draft.id].sort());
    expect(all.find(item => item.id === draft.id)).toMatchObject({ name: 'test1-test1', visibility: 'private', status: 'private', canManage: true });
    expect(all.find(item => item.id === draft.id)).not.toHaveProperty('topologyGraph');
    expect((await service.list(admin, 'mine')).map(item => item.id)).toEqual([own.id]);
    expect(await service.list(admin, 'platform')).toEqual([]);
    await expect(service.getById(draft.id, admin)).resolves.toMatchObject({ id: draft.id, canManage: true });
    await expect(service.getById(foreign.id, admin)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.list(owner, 'all')).rejects.toBeInstanceOf(ForbiddenException);
    expect((await service.list(owner, 'mine')).map(item => item.id)).toEqual([draft.id]);
    await expect(service.getById(own.id, owner)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
