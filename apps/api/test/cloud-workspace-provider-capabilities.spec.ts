import { CloudWorkspacesService } from '../src/admin/cloud-workspaces.service';

describe('workspace provider capability contract', () => {
  const manager = { id: 'manager', username: 'manager', role: 'admin' as const, isPlatformManager: true };
  const originalGate = process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED;
  afterEach(() => { if (originalGate === undefined) delete process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED; else process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED = originalGate; });

  async function capabilities(provider: 'alibaba_cloud' | 'tencent_cloud', options: { readOnly?: boolean; invalidContext?: boolean } = {}) {
    const space = { id: 'space', provider, accountUid: '123', displayName: 'fixture', isReadOnly: options.readOnly ?? false, activeCloudAccountContextId: 'context' };
    const context = { id: 'context', cloudWorkspaceId: space.id, provider, accountUid: options.invalidContext ? 'other-account' : '123',
      status: 'ready', regionId: 'fixture', zoneId: 'fixture', imageImportBucket: '', bucketStatus: 'unconfigured' };
    const db = { cloudWorkspace: { findMany: async () => [space] }, cloudAccountContext: { findMany: async () => [context] } };
    return (await new CloudWorkspacesService(db as never).list(manager))[0]!.capabilities;
  }

  it('keeps supported Tencent functionality while advertising only Alibaba-specific integrations as unavailable', async () => {
    delete process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED;
    expect(await capabilities('tencent_cloud')).toEqual({ provisioning: true, rangeProvisioning: false, imageImport: true,
      billingSync: true, ossBillingBinding: false, mogongCatalog: false });
    expect(await capabilities('alibaba_cloud')).toEqual({ provisioning: true, rangeProvisioning: true, imageImport: false,
      billingSync: true, ossBillingBinding: true, mogongCatalog: true });
    process.env.TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED = '1';
    expect((await capabilities('tencent_cloud')).rangeProvisioning).toBe(true);
  });

  it.each([{ readOnly: true }, { invalidContext: true }])('does not advertise writes for an unavailable account: %j', async options => {
    for (const provider of ['alibaba_cloud', 'tencent_cloud'] as const) expect(await capabilities(provider, options)).toMatchObject({
      provisioning: false, rangeProvisioning: false, imageImport: false, billingSync: false, ossBillingBinding: false,
    });
  });
});
