import { ProvisionJobsService } from '../src/admin/provision-jobs.service';
import * as proof from '../src/admin/billing-platform-scope';
import * as cloud from '../src/admin/aliyun-resource-cloud-events';

const job: any = { id: 'job', rangeInstanceId: 'range', cloudWorkspaceId: 'workspace', status: 'succeeded' };
const ledger: any = { id: 'ledger', rangeInstanceId: 'range', cloudWorkspaceId: 'workspace', cloudResourceType: 'ecs',
  cloudResourceId: 'i-owned', tagsSnapshot: { CloudAccountContextId: 'original-context' } };
function fixture() {
  const repository: any = { getProvisionJobById: async () => job, getRangeInstanceById: async () => ({ ownerUserId: 'alice' }),
    listProvisionJobStepLogs: jest.fn(async () => []), listProvisionJobs: async () => [job], listBillingLedgerResources: async () => [ledger] };
  const config: any = { getAccountContextById: jest.fn(async () => ({ cloudAccountContextId: 'original-context' })) };
  jest.spyOn(proof, 'loadPlatformBillingProof').mockResolvedValue({ createdLedgerIds: new Set(['ledger']) } as any);
  const read = jest.spyOn(cloud, 'readAliyunResourceCloudEvents').mockResolvedValue({ cloudResourceId: 'i-owned', complete: true, events: [] } as any);
  return { service: new ProvisionJobsService(repository, config), repository, config, read };
}
afterEach(() => jest.restoreAllMocks());
describe('job cloud event authorization', () => {
  it('uses the saved account only for source-proven IDs in the selected job and includes the safe evidence', async () => {
    const f = fixture();
    expect(await f.service.getById('job', { id: 'alice', role: 'user' } as any, false, true, ['i-owned']))
      .toMatchObject({ evidence: { cloudEvents: [{ cloudResourceId: 'i-owned', complete: true }] } });
    expect(f.config.getAccountContextById).toHaveBeenCalledWith('original-context');
    expect(f.read).toHaveBeenCalledWith({ cloudAccountContextId: 'original-context' }, ledger);
  });
  it('rejects a foreign job owner before loading proofs, accounts or cloud events', async () => {
    const f = fixture();
    await expect(f.service.getById('job', { id: 'other', role: 'user' } as any, false, true)).rejects.toThrow('denied');
    expect(proof.loadPlatformBillingProof).not.toHaveBeenCalled(); expect(f.config.getAccountContextById).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each([['i-foreign'], ['i-owned', 'i-owned']])('rejects foreign or duplicate native IDs before any cloud query: %j', async (...ids) => {
    const f = fixture();
    await expect(f.service.getById('job', { id: 'alice', role: 'user' } as any, false, true, ids as string[])).rejects.toThrow('outside');
    expect(f.config.getAccountContextById).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it('does not accept observed inventory without original creation proof', async () => {
    const f = fixture(); jest.mocked(proof.loadPlatformBillingProof).mockResolvedValue({ createdLedgerIds: new Set() } as any);
    await expect(f.service.getById('job', { id: 'alice', role: 'user' } as any, false, true, ['i-owned'])).rejects.toThrow('outside');
    expect(f.read).not.toHaveBeenCalled();
  });
});
