import { RangesController } from '../src/admin/ranges.controller';
import { RangeInstancesService } from '../src/admin/range-instances.service';

const owner = { id: 'owner', role: 'user' } as any;

describe('runtime draft discard CAS', () => {
  it('requires an explicit positive version for MCP and keeps legacy web requests compatible', () => {
    const discardDraft = jest.fn();
    const controller = new RangesController({ discardDraft } as any, {} as any, {} as any);
    const mcp = { adminUser: owner, authContext: { source: 'mcp' } } as any;
    for (const version of [undefined, '0', '-1', '1.1', '1junk', '9007199254740992']) {
      expect(() => controller.discardDraft(mcp, 'range', version)).toThrow();
    }
    expect(discardDraft).not.toHaveBeenCalled();
    controller.discardDraft(mcp, 'range', '7');
    expect(discardDraft).toHaveBeenLastCalledWith('range', owner, 7);
    controller.discardDraft({ ...mcp, authContext: { source: 'web' } }, 'range');
    expect(discardDraft).toHaveBeenLastCalledWith('range', owner, undefined);
  });

  it('refuses stale caller revisions and other owners before clearing a newer draft', async () => {
    const repository = { getRangeInstanceById: jest.fn(async () => ({ id: 'range', instanceMode: 'range', ownerUserId: owner.id, status: 'running', draftRevision: 8 })), discardRangeInstanceDraft: jest.fn() };
    const service = new RangeInstancesService(repository as any, {} as any, {} as any, {} as any, {} as any);
    await expect(service.discardDraft('range', owner, 7)).rejects.toMatchObject({ status: 409 });
    await expect(service.discardDraft('range', { id: 'other', role: 'user' } as any, 8)).rejects.toMatchObject({ status: 403 });
    expect(repository.discardRangeInstanceDraft).not.toHaveBeenCalled();
  });

  it('uses the explicit version for atomic clearing and does not continue after a concurrent update', async () => {
    const repository = { getRangeInstanceById: jest.fn(async () => ({ id: 'range', instanceMode: 'range', ownerUserId: owner.id, status: 'running', draftRevision: 8 })), discardRangeInstanceDraft: jest.fn(async () => null) };
    const service = new RangeInstancesService(repository as any, {} as any, {} as any, {} as any, {} as any);
    await expect(service.discardDraft('range', owner, 8)).rejects.toMatchObject({ status: 409 });
    expect(repository.discardRangeInstanceDraft).toHaveBeenCalledWith('range', 8);
  });
});
